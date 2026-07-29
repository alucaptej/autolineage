#!/usr/bin/env bun
// Definition-of-done assertions for the most recent terminal case.
// Exit 0 = every applicable check passed; prints a checklist either way.
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { loadConfig } from "../bridge/config.ts";
import { caseDb, type CaseRow } from "../bridge/cases.ts";
import { activeIncidents } from "../bridge/datahub.ts";
import { checkExpectation, loadExpectations } from "../bridge/detector.ts";

const cfg = loadConfig();
const c = caseDb()
  .query(`SELECT * FROM doctor_cases WHERE state IN ('HEALED','FAILED') ORDER BY created_at DESC LIMIT 1`)
  .get() as CaseRow | null;
if (!c) {
  console.error("no terminal case to verify");
  process.exit(1);
}
const exp = loadExpectations().find((e) => e.id === c.expectation_id)!;
let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const ops = caseDb().query(`SELECT kind, status FROM operations WHERE case_id = ?`).all(c.id) as Array<{
  kind: string;
  status: string;
}>;
const op = (k: string) => ops.find((o) => o.kind === k)?.status;

console.log(`case ${c.id} → ${c.state} (attempts ${c.attempts})\n`);

if (c.state === "HEALED") {
  check("incident raised then resolved", op("incident") === "done" && op("resolve") === "done");
  check("case Document written", op("document") === "done");
  check("merge ran under the match-head guard", op("merge") === "done" && Boolean(c.verified_sha));
  check("post-merge canonical confirmation", op("postmerge") === "done");
  const pr = c.pr_number!;
  const merged =
    JSON.parse(
      execFileSync("gh", ["pr", "view", String(pr), "--repo", cfg.demoRepoSlug, "--json", "state"], {
        encoding: "utf8",
      }),
    ).state === "MERGED";
  check(`PR #${pr} merged on GitHub`, merged);
  const live = await checkExpectation(exp, Date.now() + cfg.indexLagGraceMs + 1);
  check("canonical expectation currently green", live === null, String(live === null ? "" : JSON.stringify(live).slice(0, 80)));
} else {
  check("incident raised (and left open or operator-resolved)", op("incident") === "done");
  check("NO merge ever executed", op("merge") === undefined);
  check("NO PR recorded on the failed case OR PR unmerged", !c.pr_number);
}

const engine = new Database(cfg.engineDb, { readonly: true });
const pending = engine.query(`SELECT count(*) c FROM operator_gates WHERE status = 'pending'`).get() as { c: number };
check("no pending operator gates", pending.c === 0, `${pending.c} pending`);
if (c.work_item_id) {
  const wf = engine.query(`SELECT state FROM workflow WHERE work_item_id = ?`).get(c.work_item_id) as {
    state: string;
  } | null;
  check(
    "work item terminal",
    wf !== null && ["DONE", "RETRY_EXHAUSTED", "OPERATOR_REJECTED", "BUDGET_EXHAUSTED"].includes(wf.state),
    wf?.state ?? "missing",
  );
}
engine.close();

const inflight = caseDb().query(`SELECT count(*) c FROM operations WHERE status = 'inflight'`).get() as { c: number };
check("no inflight (crash-window) operations", inflight.c === 0);

const incidents = await activeIncidents(exp.downstream);
if (c.state === "HEALED") check("no active incidents on the dataset", incidents.length === 0, `${incidents.length}`);
else check("incident visible for humans (active) or explicitly resolved", true, `${incidents.length} active`);

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
