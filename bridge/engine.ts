// Engine integration: transactional enqueue via the engine's own CLI (write
// path), read-only SQL over the engine DB (observation path), and the two
// sanctioned gate mutations (approve-close after external merge; reject via the
// real gate.decided event). Documented in docs/engine-interface.md.
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { loadConfig } from "./config.ts";

export interface EnqueueResult {
  work_item_id: string;
  assignment_id: string;
}

export function enqueueWorkItem(input: {
  caseId: string;
  title: string;
  objective: string;
  allow: string[];
  accept: string[];
}): EnqueueResult {
  const cfg = loadConfig();
  const args = ["bin/enqueue.ts", "--json", "--title", `[autolineage:${input.caseId}] ${input.title}`, "--objective", input.objective];
  for (const a of input.allow) args.push("--allow", a);
  for (const a of input.accept) args.push("--accept", a);
  const out = execFileSync("bun", args, {
    cwd: cfg.enginePath,
    env: { ...process.env, WORKGRAPH_DB: cfg.engineDb },
    encoding: "utf8",
    timeout: 30_000,
  });
  const line = out.trim().split("\n").pop() ?? "";
  return JSON.parse(line) as EnqueueResult;
}

// ---- read-only observation ---------------------------------------------------

let ro: Database | null = null;

function engineDb(): Database {
  if (ro) return ro;
  ro = new Database(loadConfig().engineDb, { readonly: true });
  return ro;
}

export function resetEngineDbForTests(): void {
  ro?.close();
  ro = null;
}

export interface EngineView {
  workflowState: string | null;
  prNumber: number | null;
  headSha: string | null;
  pendingMergeGateId: string | null;
}

export function observeWorkItem(workItemId: string): EngineView {
  const d = engineDb();
  const wf = d.query(`SELECT state FROM workflow WHERE work_item_id = ?`).get(workItemId) as { state: string } | null;
  const cs = d
    .query(`SELECT pr_number, head_sha FROM change_sets WHERE work_item_id = ? ORDER BY rowid DESC LIMIT 1`)
    .get(workItemId) as { pr_number: number | null; head_sha: string | null } | null;
  const gate = d
    .query(`SELECT id FROM operator_gates WHERE work_item_id = ? AND kind = 'merge_approval' AND status = 'pending' ORDER BY rowid DESC LIMIT 1`)
    .get(workItemId) as { id: string } | null;
  return {
    workflowState: wf?.state ?? null,
    prNumber: cs?.pr_number ?? null,
    headSha: cs?.head_sha ?? null,
    pendingMergeGateId: gate?.id ?? null,
  };
}

/** Work items created by us, found by title marker — reconciliation. */
export function findWorkItemByMarker(caseId: string): string | null {
  const d = engineDb();
  const row = d
    .query(`SELECT id FROM work_items WHERE title LIKE ? ORDER BY created_at DESC LIMIT 1`)
    .get(`%[autolineage:${caseId}]%`) as { id: string } | null;
  return row?.id ?? null;
}

export const TERMINAL_FAILURES = new Set(["RETRY_EXHAUSTED", "OPERATOR_REJECTED", "BUDGET_EXHAUSTED"]);

// ---- gate mutations (the only engine-DB writes the bridge performs) ----------

function engineDbRw(): Database {
  // Short-lived RW handle; the engine tolerates concurrent writers via WAL.
  return new Database(loadConfig().engineDb);
}

const now = () => new Date().toISOString();

/** After an EXTERNAL merge: close the gate row directly. The item reaches DONE
 * via pr.merged; emitting gate.decided here would hit a terminal state. */
export function closeGateAfterExternalMerge(gateId: string): boolean {
  const d = engineDbRw();
  try {
    const res = d
      .query(`UPDATE operator_gates SET status = 'approved', decided_at = ? WHERE id = ? AND status = 'pending'`)
      .run(now(), gateId);
    return res.changes > 0;
  } finally {
    d.close();
  }
}

/** Reject a failed item's gate through the REAL event path so the FSM
 * terminates it (OPERATOR_REJECTED) — mirrors telegram.ts recordDecision(). */
export function rejectGate(gateId: string, workItemId: string, reason: string): boolean {
  const d = engineDbRw();
  try {
    const res = d
      .query(`UPDATE operator_gates SET status = 'rejected', decided_at = ? WHERE id = ? AND status = 'pending'`)
      .run(now(), gateId);
    if (res.changes === 0) return false;
    d.query(
      `INSERT INTO engine_events (id, work_item_id, kind, payload_json, dedupe_key, created_at)
       VALUES (?, ?, 'gate.decided', ?, ?, ?) ON CONFLICT(dedupe_key) DO NOTHING`,
    ).run(
      `eev_al${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      workItemId,
      JSON.stringify({ gateId, decision: "rejected", kind: "merge_approval", action: `autolineage: ${reason.slice(0, 120)}` }),
      `gate-decided:${gateId}`,
      now(),
    );
    return true;
  } finally {
    d.close();
  }
}
