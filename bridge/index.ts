#!/usr/bin/env bun
// AutoLineage bridge daemon: detector tick (freshness contract) + case driver
// (engine observation → verification → write-back). Case FSM and ledger live in
// cases.ts; this file only sequences them.
import { execFileSync } from "node:child_process";
import { loadConfig } from "./config.ts";
import { raiseIncident } from "./datahub.ts";
import {
  type CaseRow,
  caseDb,
  casesInState,
  createCase,
  runOp,
  transitionCase,
} from "./cases.ts";
import { checkExpectation, type Expectation, loadExpectations } from "./detector.ts";
import { enqueueWorkItem, observeWorkItem, rejectGate, TERMINAL_FAILURES } from "./engine.ts";
import { reconcile } from "./reconcile.ts";
import { driveVerification } from "./verifier.ts";

const cfg = loadConfig();

function expFor(c: CaseRow): Expectation {
  const exp = loadExpectations().find((e) => e.id === c.expectation_id);
  if (!exp) throw new Error(`expectation ${c.expectation_id} vanished from expectations.json`);
  return exp;
}

function objective(c: CaseRow, exp: Expectation, failureContext?: string): string {
  return [
    `A lineage contract in DataHub is violated and the pipeline in this repository is the suspected cause.`,
    ``,
    `Contract '${exp.id}': dataset ${exp.downstream} must be lineage-connected to ${exp.upstream} via the '${exp.job_name}' Spark job, refreshed on every pipeline run.`,
    `Detector evidence (observed after the last run): ${c.evidence_json}`,
    `Incident: ${c.incident_urn}`,
    failureContext ? `\nPrevious attempt failed verification: ${failureContext}\n` : ``,
    `Investigate with the datahub MCP tools (search, get_lineage, get_entities) and follow the playbook at skills/datahub-lineage-debug/SKILL.md.`,
    `Your PR body must state the evidence you observed, the failure signature you matched, and why your change repairs emission for future runs.`,
    `If no documented failure mode matches the evidence, call work_finish with status "blocked" and describe what a human should check — do NOT guess.`,
  ].join("\n");
}

async function detectorTick(): Promise<void> {
  for (const exp of loadExpectations()) {
    const res = await checkExpectation(exp);
    if (res === null || res === "pending") continue;
    const c = createCase(exp.id, res);
    console.log(`[detector] violation of '${exp.id}' → case ${c.id} (${res.observed.signature_hint})`);
    const incidentUrn = await runOp(c.id, "incident", `incident:${c.id}`, async () =>
      raiseIncident({
        title: `[autolineage:${c.id}] Lineage contract '${exp.id}' violated`,
        description: `${exp.description}\n\nSignature: ${res.observed.signature_hint}\nEvidence: ${JSON.stringify(res.observed)}\nRun marker: ${res.run_marker}`,
        resourceUrn: exp.downstream,
      }),
    );
    transitionCase(c.id, "INCIDENT_RAISED", { incident_urn: incidentUrn });
  }
}

async function driverTick(): Promise<void> {
  // INCIDENT_RAISED → enqueue the work item
  for (const c of casesInState("INCIDENT_RAISED")) {
    const exp = expFor(c);
    const wid = await runOp(c.id, "enqueue", `enqueue:${c.id}:${c.attempts}`, async () => {
      const r = enqueueWorkItem({
        caseId: c.id,
        title: `repair lineage contract ${exp.id}`,
        objective: objective(c, exp),
        allow: ["run.sh", "conf/**", "jobs/**", "README.md"],
        accept: [
          `The canonical lineage edge ${exp.upstream} -> ${exp.downstream} is refreshed on a pipeline run`,
          "CI (tests + lint) green on the PR",
        ],
      });
      return JSON.stringify(r);
    });
    const parsed = JSON.parse(wid!) as { work_item_id: string; assignment_id: string };
    transitionCase(c.id, "INJECTED", { work_item_id: parsed.work_item_id, assignment_id: parsed.assignment_id });
  }

  // INJECTED: retry path may have cleared work_item_id → fresh enqueue
  for (const c of casesInState("INJECTED")) {
    if (!c.work_item_id) {
      const exp = expFor(c);
      const failCtx = lastFailure(c);
      const wid = await runOp(c.id, "enqueue", `enqueue:${c.id}:${c.attempts}`, async () => {
        const r = enqueueWorkItem({
          caseId: c.id,
          title: `repair lineage contract ${exp.id} (attempt ${c.attempts})`,
          objective: objective(c, exp, failCtx),
          allow: ["run.sh", "conf/**", "jobs/**", "README.md"],
          accept: [
            `The canonical lineage edge ${exp.upstream} -> ${exp.downstream} is refreshed on a pipeline run`,
            "CI (tests + lint) green on the PR",
          ],
        });
        return JSON.stringify(r);
      });
      const parsed = JSON.parse(wid!) as { work_item_id: string; assignment_id: string };
      transitionCase(c.id, "AWAITING_FIX", { work_item_id: parsed.work_item_id, assignment_id: parsed.assignment_id });
      continue;
    }
    transitionCase(c.id, "AWAITING_FIX");
  }

  // AWAITING_FIX: watch the engine
  for (const c of casesInState("AWAITING_FIX")) {
    if (wallClockExceeded(c)) continue;
    const view = observeWorkItem(c.work_item_id!);
    if (view.workflowState && TERMINAL_FAILURES.has(view.workflowState)) {
      console.error(`[driver] case ${c.id}: engine terminal ${view.workflowState} — case FAILED, incident stays open`);
      transitionCase(c.id, "FAILED");
      continue;
    }
    if (view.pendingMergeGateId && view.workflowState === "WAITING_OPERATOR" && view.prNumber) {
      transitionCase(c.id, "VERIFYING", { pr_number: view.prNumber, verified_sha: view.headSha });
    }
  }

  // VERIFYING: ledger-driven; resumable across restarts and past engine DONE
  for (const c of casesInState("VERIFYING")) {
    if (wallClockExceeded(c)) continue;
    const exp = expFor(c);
    const out = await driveVerification(c.id, exp);
    if (out.healed) console.log(`[driver] case ${c.id} HEALED`);
    else console.error(`[driver] case ${c.id} verification: ${out.failedStep} — ${out.detail ?? ""}`);
  }
}

function lastFailure(c: CaseRow): string | undefined {
  const row = caseDb()
    .query(`SELECT error FROM operations WHERE case_id = ? AND status = 'failed' ORDER BY finished_at DESC LIMIT 1`)
    .get(c.id) as { error: string | null } | null;
  return row?.error ?? undefined;
}

function wallClockExceeded(c: CaseRow): boolean {
  if (Date.now() - Date.parse(c.created_at) < cfg.caseWallClockMs) return false;
  console.error(`[driver] case ${c.id}: wall clock exceeded — FAILED, incident stays open`);
  const view = c.work_item_id ? observeWorkItem(c.work_item_id) : null;
  if (view?.pendingMergeGateId && c.work_item_id) rejectGate(view.pendingMergeGateId, c.work_item_id, "case wall clock exceeded");
  transitionCase(c.id, "FAILED");
  return true;
}

async function main(): Promise<void> {
  execFileSync("bun", ["bridge/doctor-check.ts"], { stdio: "inherit" });
  const settled = await reconcile();
  if (settled) console.log(`[bridge] reconciled ${settled} inflight op(s)`);
  console.log(`[bridge] up — detector every ${cfg.detectorIntervalMs / 1000}s, driver every ${cfg.verifierIntervalMs / 1000}s`);
  let stop = false;
  process.on("SIGINT", () => (stop = true));
  process.on("SIGTERM", () => (stop = true));
  let lastDetector = 0;
  while (!stop) {
    try {
      if (Date.now() - lastDetector >= cfg.detectorIntervalMs) {
        lastDetector = Date.now();
        await detectorTick();
      }
      await driverTick();
    } catch (e) {
      console.error(`[bridge] tick error: ${e instanceof Error ? (e.stack ?? e.message) : e}`);
    }
    await new Promise((r) => setTimeout(r, cfg.verifierIntervalMs));
  }
  console.log("[bridge] stopped");
}

if (import.meta.main) await main();
