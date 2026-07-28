// Case store: doctor.db owns the case FSM + the operations ledger that makes
// external mutations effectively exactly-once (inflight-row-before-call +
// deterministic remote markers + startup reconciliation).
import { Database } from "bun:sqlite";
import { loadConfig } from "./config.ts";

export type CaseState =
  | "DETECTED"
  | "INCIDENT_RAISED"
  | "INJECTED"
  | "AWAITING_FIX"
  | "VERIFYING"
  | "HEALED"
  | "FAILED";

/** Legal transitions — everything else is a bug, loudly. */
const LEGAL: Record<CaseState, CaseState[]> = {
  DETECTED: ["INCIDENT_RAISED", "FAILED"],
  INCIDENT_RAISED: ["INJECTED", "FAILED"],
  INJECTED: ["AWAITING_FIX", "FAILED"],
  AWAITING_FIX: ["VERIFYING", "INJECTED", "FAILED"],
  VERIFYING: ["HEALED", "AWAITING_FIX", "INJECTED", "FAILED"],
  HEALED: [],
  FAILED: [],
};

export interface CaseRow {
  id: string;
  expectation_id: string;
  state: CaseState;
  incident_urn: string | null;
  work_item_id: string | null;
  assignment_id: string | null;
  pr_number: number | null;
  verified_sha: string | null;
  attempts: number;
  evidence_json: string;
  created_at: string;
  updated_at: string;
}

export type OpStatus = "inflight" | "done" | "failed";

export interface OpRow {
  id: string;
  case_id: string;
  kind: string;
  idem_key: string;
  external_ref: string | null;
  status: OpStatus;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

let handle: Database | null = null;

export function caseDb(): Database {
  if (handle) return handle;
  const path = process.env.DOCTOR_DB ?? loadConfig().doctorDb;
  handle = new Database(path, { create: true });
  handle.run("PRAGMA journal_mode = WAL");
  handle.run(`CREATE TABLE IF NOT EXISTS doctor_cases (
    id TEXT PRIMARY KEY, expectation_id TEXT NOT NULL, state TEXT NOT NULL,
    incident_urn TEXT, work_item_id TEXT, assignment_id TEXT, pr_number INTEGER,
    verified_sha TEXT, attempts INTEGER NOT NULL DEFAULT 0,
    evidence_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  handle.run(`CREATE TABLE IF NOT EXISTS operations (
    id TEXT PRIMARY KEY, case_id TEXT NOT NULL, kind TEXT NOT NULL,
    idem_key TEXT NOT NULL UNIQUE, external_ref TEXT,
    status TEXT NOT NULL, error TEXT,
    created_at TEXT NOT NULL, finished_at TEXT)`);
  handle.run(`CREATE TABLE IF NOT EXISTS run_markers (
    id INTEGER PRIMARY KEY AUTOINCREMENT, pipeline TEXT NOT NULL,
    marked_at TEXT NOT NULL)`);
  handle.run(`CREATE TABLE IF NOT EXISTS metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT, case_id TEXT NOT NULL,
    name TEXT NOT NULL, value REAL NOT NULL, recorded_at TEXT NOT NULL)`);
  return handle;
}

/** Test hook: point at a fresh DB. */
export function resetCaseDbForTests(): void {
  handle?.close();
  handle = null;
}

const now = () => new Date().toISOString();
const rid = (p: string) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

// ---- cases -------------------------------------------------------------------

export function createCase(expectationId: string, evidence: unknown): CaseRow {
  const d = caseDb();
  const id = rid("case");
  d.query(
    `INSERT INTO doctor_cases (id, expectation_id, state, evidence_json, created_at, updated_at)
     VALUES (?, ?, 'DETECTED', ?, ?, ?)`,
  ).run(id, expectationId, JSON.stringify(evidence ?? {}), now(), now());
  return getCase(id)!;
}

export function getCase(id: string): CaseRow | null {
  return (caseDb().query(`SELECT * FROM doctor_cases WHERE id = ?`).get(id) as CaseRow | null) ?? null;
}

export function openCaseFor(expectationId: string): CaseRow | null {
  return (
    (caseDb()
      .query(
        `SELECT * FROM doctor_cases WHERE expectation_id = ? AND state NOT IN ('HEALED','FAILED')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(expectationId) as CaseRow | null) ?? null
  );
}

export function casesInState(...states: CaseState[]): CaseRow[] {
  const q = states.map(() => "?").join(",");
  return caseDb()
    .query(`SELECT * FROM doctor_cases WHERE state IN (${q}) ORDER BY created_at`)
    .all(...states) as CaseRow[];
}

export function transitionCase(id: string, to: CaseState, patch: Partial<CaseRow> = {}): void {
  const d = caseDb();
  const cur = getCase(id);
  if (!cur) throw new Error(`case ${id} not found`);
  if (!LEGAL[cur.state].includes(to)) {
    throw new Error(`illegal case transition ${cur.state} → ${to} (case ${id})`);
  }
  const fields: string[] = ["state = ?", "updated_at = ?"];
  const vals: unknown[] = [to, now()];
  for (const k of ["incident_urn", "work_item_id", "assignment_id", "pr_number", "verified_sha", "attempts", "evidence_json"] as const) {
    if (patch[k] !== undefined) {
      fields.push(`${k} = ?`);
      vals.push(patch[k]);
    }
  }
  vals.push(id);
  d.query(`UPDATE doctor_cases SET ${fields.join(", ")} WHERE id = ?`).run(...(vals as never[]));
}

// ---- operations ledger -------------------------------------------------------

/**
 * Effectively-exactly-once execution of an external mutation.
 * - done row for idemKey → returns its external_ref without re-executing.
 * - inflight row for idemKey → crash window: caller must reconcile first
 *   (throws; startupReconcile settles these).
 * - otherwise: inflight row is written BEFORE fn runs; fn's return value is the
 *   external ref persisted on completion.
 */
export async function runOp(caseId: string, kind: string, idemKey: string, fn: () => Promise<string | null>): Promise<string | null> {
  const d = caseDb();
  const existing = d.query(`SELECT * FROM operations WHERE idem_key = ?`).get(idemKey) as OpRow | null;
  if (existing?.status === "done") return existing.external_ref;
  if (existing?.status === "inflight") {
    throw new Error(`op ${idemKey} is inflight (crash window) — reconcile before executing`);
  }
  if (!existing) {
    d.query(
      `INSERT INTO operations (id, case_id, kind, idem_key, status, created_at) VALUES (?, ?, ?, ?, 'inflight', ?)`,
    ).run(rid("op"), caseId, kind, idemKey, now());
  } else {
    // previous attempt failed — retry under the same key
    d.query(`UPDATE operations SET status = 'inflight', error = NULL, created_at = ? WHERE idem_key = ?`).run(now(), idemKey);
  }
  try {
    const ref = await fn();
    d.query(`UPDATE operations SET status = 'done', external_ref = ?, finished_at = ? WHERE idem_key = ?`).run(ref, now(), idemKey);
    return ref;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    d.query(`UPDATE operations SET status = 'failed', error = ?, finished_at = ? WHERE idem_key = ?`).run(msg.slice(0, 400), now(), idemKey);
    throw e;
  }
}

export function inflightOps(): OpRow[] {
  return caseDb().query(`SELECT * FROM operations WHERE status = 'inflight'`).all() as OpRow[];
}

/** Settle an inflight op after reconciliation established the remote truth. */
export function settleOp(idemKey: string, outcome: { done: true; externalRef: string | null } | { done: false; error: string }): void {
  const d = caseDb();
  if (outcome.done) {
    d.query(`UPDATE operations SET status = 'done', external_ref = ?, finished_at = ? WHERE idem_key = ?`).run(outcome.externalRef, now(), idemKey);
  } else {
    d.query(`UPDATE operations SET status = 'failed', error = ?, finished_at = ? WHERE idem_key = ?`).run(outcome.error.slice(0, 400), now(), idemKey);
  }
}

// ---- run markers & metrics ---------------------------------------------------

export function recordRunMarker(pipeline: string): void {
  caseDb().query(`INSERT INTO run_markers (pipeline, marked_at) VALUES (?, ?)`).run(pipeline, now());
}

export function latestRunMarker(pipeline: string): string | null {
  const row = caseDb()
    .query(`SELECT marked_at FROM run_markers WHERE pipeline = ? ORDER BY id DESC LIMIT 1`)
    .get(pipeline) as { marked_at: string } | null;
  return row?.marked_at ?? null;
}

export function recordMetric(caseId: string, name: string, value: number): void {
  caseDb().query(`INSERT INTO metrics (case_id, name, value, recorded_at) VALUES (?, ?, ?, ?)`).run(caseId, name, value, now());
}
