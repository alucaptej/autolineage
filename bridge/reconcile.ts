// Startup reconciliation: settle every inflight ledger row (crash window) by
// asking the remote system of record, keyed on deterministic markers.
import { activeIncidents, searchDocumentsByTitle } from "./datahub.ts";
import { getCase, inflightOps, settleOp } from "./cases.ts";
import { findWorkItemByMarker } from "./engine.ts";
import { loadExpectations } from "./detector.ts";
import { ghMerged } from "./verifier.ts";

export async function reconcile(): Promise<number> {
  const ops = inflightOps();
  const exps = loadExpectations();
  for (const op of ops) {
    const c = getCase(op.case_id);
    const exp = exps.find((e) => e.id === c?.expectation_id);
    try {
      switch (op.kind) {
        case "incident": {
          const marker = `[autolineage:${op.case_id}]`;
          const hits = exp ? await activeIncidents(exp.downstream) : [];
          const mine = hits.find((i) => i.title.includes(marker));
          settleOp(op.idem_key, mine ? { done: true, externalRef: mine.urn } : { done: false, error: "not found remotely — re-execute" });
          break;
        }
        case "enqueue": {
          const wid = findWorkItemByMarker(op.case_id);
          settleOp(op.idem_key, wid ? { done: true, externalRef: wid } : { done: false, error: "not found in engine — re-execute" });
          break;
        }
        case "merge": {
          const pr = c?.pr_number;
          settleOp(op.idem_key, pr && ghMerged(pr) ? { done: true, externalRef: "merged" } : { done: false, error: "not merged — re-execute" });
          break;
        }
        case "document": {
          const urns = await searchDocumentsByTitle(`[autolineage:${op.case_id}]`);
          settleOp(op.idem_key, urns.length ? { done: true, externalRef: urns[0] } : { done: false, error: "not found — re-execute" });
          break;
        }
        default:
          // Non-mutating or safely re-executable steps (oid/ci/candidate/postmerge/
          // gate-close/resolve/comments): mark failed so runOp re-runs them.
          settleOp(op.idem_key, { done: false, error: "crashed mid-step — re-execute" });
      }
    } catch (e) {
      // Leave the row inflight; a later reconcile retries. Never guess.
      console.error(`[reconcile] ${op.idem_key}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return ops.length;
}
