// The gate-4-validated verify-before-merge protocol as a ledger-driven step
// machine. Driven by CASE state (not engine state): if the bridge dies after
// GitHub accepts the merge, the engine reaches DONE on its own and only the
// ledger knows which steps remain. Every external step is a runOp.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { createDocument, datasetExists, resolveIncident } from "./datahub.ts";
import {
  type CaseRow,
  getCase,
  recordMetric,
  recordRunMarker,
  runOp,
  transitionCase,
} from "./cases.ts";
import { checkExpectation, type Expectation } from "./detector.ts";
import { closeGateAfterExternalMerge, observeWorkItem, rejectGate } from "./engine.ts";

const cfg = () => loadConfig();

function gh(args: string[], timeout = 60_000): string {
  return execFileSync("gh", args, { encoding: "utf8", timeout }).trim();
}

function sh(cmd: string, args: string[], opts: { cwd: string; env?: Record<string, string>; timeout?: number }): void {
  execFileSync(cmd, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    timeout: opts.timeout ?? 300_000,
    stdio: "pipe",
  });
}

/** Single global mutex: Spark runs never overlap (16 GB discipline). */
let sparkBusy: Promise<void> = Promise.resolve();
function withSpark<T>(fn: () => Promise<T>): Promise<T> {
  const run = sparkBusy.then(fn);
  sparkBusy = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function ghHeadOid(pr: number): string {
  return JSON.parse(gh(["pr", "view", String(pr), "--repo", cfg().demoRepoSlug, "--json", "headRefOid"])).headRefOid;
}

export function ghMerged(pr: number): boolean {
  return JSON.parse(gh(["pr", "view", String(pr), "--repo", cfg().demoRepoSlug, "--json", "state"])).state === "MERGED";
}

function ghChecksGreen(pr: number): boolean {
  try {
    const out = gh(["pr", "checks", String(pr), "--repo", cfg().demoRepoSlug]);
    return !/fail|pending|expected/i.test(out);
  } catch {
    return false; // gh exits non-zero while checks are pending/failing
  }
}

/** Insert a platformInstance prefix into a dataset urn's name segment. */
export function verifyNamespaceUrn(canonicalUrn: string, instance: string): string {
  return canonicalUrn.replace(
    /^(urn:li:dataset:\(urn:li:dataPlatform:[^,]+,)(.+)(,[A-Z]+\))$/,
    (_m, a: string, name: string, c: string) => `${a}${instance}.${name}${c}`,
  );
}

export interface VerifyOutcome {
  healed: boolean;
  failedStep?: string;
  detail?: string;
}

/**
 * Candidate validation: fresh clone at the exact OID, run WITHOUT DATA_DIR so
 * the repo's own default decides the data root (that IS the fix under test),
 * metadata isolated via platformInstance. The fix is correct iff the verify-
 * namespaced dataset URNs come out canonical-shaped.
 */
async function candidateValidate(c: CaseRow, exp: Expectation, oid: string): Promise<void> {
  const conf = cfg();
  const tmp = mkdtempSync(join(tmpdir(), `alx-cand-`));
  try {
    sh("git", ["clone", "-q", `git@github.com:${conf.demoRepoSlug}.git`, "checkout"], { cwd: tmp });
    const co = join(tmp, "checkout");
    sh("git", ["checkout", "-q", oid], { cwd: co });
    const instance = `verify-${c.id}`;
    const env = {
      VENV_DIR: join(conf.demoRepoPath, ".venv"),
      DATAHUB_GMS_TOKEN: conf.gmsToken,
    };
    const extra = [
      "--conf",
      `spark.datahub.metadata.dataset.platformInstance=${instance}`,
    ];
    await withSpark(async () => {
      sh("./run.sh", ["jobs/seed_raw.py", ...extra], { cwd: co, env });
      sh("./run.sh", ["jobs/merge_upsert.py", ...extra], { cwd: co, env });
    });
    // Poll for the canonical-shaped verify URN (index lag aware).
    const expected = verifyNamespaceUrn(exp.downstream, instance);
    const deadline = Date.now() + conf.indexLagGraceMs + 30_000;
    while (Date.now() < deadline) {
      if (await datasetExists(expected)) return;
      await new Promise((r) => setTimeout(r, 5000));
    }
    throw new Error(`candidate did not produce canonical-shaped URN ${expected}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Post-merge confirmation on merged main, canonical namespace, fresh marker. */
async function postMergeConfirm(c: CaseRow, exp: Expectation): Promise<void> {
  const conf = cfg();
  const repo = conf.demoRepoPath;
  sh("git", ["fetch", "-q", "origin"], { cwd: repo });
  sh("git", ["checkout", "-q", "main"], { cwd: repo });
  sh("git", ["reset", "-q", "--hard", "origin/main"], { cwd: repo });
  await withSpark(async () => {
    sh("make", ["reset-data"], { cwd: repo });
    sh("./run.sh", ["jobs/seed_raw.py"], { cwd: repo, env: { DATAHUB_GMS_TOKEN: conf.gmsToken } });
    sh("./run.sh", ["jobs/merge_upsert.py"], { cwd: repo, env: { DATAHUB_GMS_TOKEN: conf.gmsToken } });
  });
  recordRunMarker(exp.pipeline);
  const deadline = Date.now() + conf.indexLagGraceMs + 60_000;
  while (Date.now() < deadline) {
    const res = await checkExpectation(exp, Date.now() + conf.indexLagGraceMs + 1); // skip grace: we own this run
    if (res === null) return;
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error("post-merge run did not turn the canonical expectation fresh-green");
}

function caseFileText(c: CaseRow, exp: Expectation, prUrl: string, prBody: string): string {
  const ev = c.evidence_json;
  return [
    `# AutoLineage case ${c.id}`,
    ``,
    `**Expectation**: ${exp.id} — ${exp.description}`,
    `**Incident**: ${c.incident_urn}`,
    `**Fix PR**: ${prUrl} (verified SHA \`${c.verified_sha}\`, attempts: ${c.attempts})`,
    ``,
    `## Detector evidence`,
    "```json",
    ev,
    "```",
    ``,
    `## Agent diagnosis (from the PR body)`,
    prBody.slice(0, 4000),
    ``,
    `_Resolved automatically by [AutoLineage](https://github.com/alucaptej/autolineage): candidate validated pre-merge in an isolated namespace, merged by exact SHA, canonical graph confirmed post-merge._`,
  ].join("\n");
}

/** Advance one VERIFYING case through its remaining ledger steps. */
export async function driveVerification(caseId: string, exp: Expectation): Promise<VerifyOutcome> {
  const c = getCase(caseId);
  if (!c || c.state !== "VERIFYING") return { healed: false, failedStep: "state", detail: c?.state };
  const pr = c.pr_number!;
  const attempt = c.attempts;

  try {
    // 1) immutable SHA binding
    const oid = (await runOp(c.id, "oid", `oid:${c.id}:${attempt}`, async () => {
      const live = ghHeadOid(pr);
      if (c.verified_sha && live !== c.verified_sha) throw new Error(`head moved: ${live} != ${c.verified_sha}`);
      return live;
    }))!;

    // 2) CI green for that OID (checks are head-bound; oid just verified)
    await runOp(c.id, "ci", `ci:${c.id}:${oid}`, async () => {
      if (ghHeadOid(pr) !== oid) throw new Error("head moved during CI check");
      if (!ghChecksGreen(pr)) throw new Error("CI not green for verified OID");
      return "green";
    });

    // 3) candidate validation in isolated namespace
    await runOp(c.id, "candidate", `candidate:${c.id}:${oid}`, async () => {
      await candidateValidate(c, exp, oid);
      return "valid";
    });

    // 4) merge exactly the verified SHA (idempotent through gh state)
    await runOp(c.id, "merge", `merge:${c.id}:${oid}`, async () => {
      if (!ghMerged(pr)) {
        gh(["pr", "merge", String(pr), "--repo", cfg().demoRepoSlug, "--squash", "--match-head-commit", oid]);
      }
      return JSON.parse(gh(["pr", "view", String(pr), "--repo", cfg().demoRepoSlug, "--json", "mergeCommit"]))
        ?.mergeCommit?.oid ?? "merged";
    });

    // 5) close the gate row (direct update — item reaches DONE via pr.merged)
    await runOp(c.id, "gate-close", `gate-close:${c.id}`, async () => {
      const view = observeWorkItem(c.work_item_id!);
      if (view.pendingMergeGateId) closeGateAfterExternalMerge(view.pendingMergeGateId);
      return view.pendingMergeGateId ?? "already-closed";
    });

    // 6) post-merge confirmation in the canonical namespace
    await runOp(c.id, "postmerge", `postmerge:${c.id}:${oid}`, async () => {
      await postMergeConfirm(c, exp);
      return "fresh-green";
    });

    // 7) resolve incident + 8) case Document
    await runOp(c.id, "resolve", `resolve:${c.id}`, async () => {
      await resolveIncident(c.incident_urn!, `[autolineage:${c.id}] canonical lineage confirmed post-merge (PR #${pr})`);
      return c.incident_urn;
    });
    const prInfo = JSON.parse(gh(["pr", "view", String(pr), "--repo", cfg().demoRepoSlug, "--json", "url,body"]));
    await runOp(c.id, "document", `document:${c.id}`, async () =>
      createDocument({
        title: `[autolineage:${c.id}] Case file: ${exp.id}`,
        text: caseFileText(getCase(c.id)!, exp, prInfo.url, prInfo.body ?? ""),
        relatedAssets: [exp.downstream],
      }),
    );

    transitionCase(c.id, "HEALED");
    recordMetric(c.id, "time_to_heal_ms", Date.now() - Date.parse(c.created_at));
    recordMetric(c.id, "attempts", c.attempts);
    return { healed: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return await handleVerifyFailure(c, msg);
  }
}

async function handleVerifyFailure(c: CaseRow, detail: string): Promise<VerifyOutcome> {
  const conf = cfg();
  const pr = c.pr_number;
  // Never orphan the failed item: reject ITS gate through the real event path.
  const view = c.work_item_id ? observeWorkItem(c.work_item_id) : null;
  if (view?.pendingMergeGateId && c.work_item_id) {
    await runOp(c.id, "gate-reject", `gate-reject:${c.id}:${c.attempts}`, async () => {
      rejectGate(view.pendingMergeGateId!, c.work_item_id!, detail);
      return view.pendingMergeGateId;
    });
  }
  if (pr) {
    await runOp(c.id, "fail-comment", `fail-comment:${c.id}:${c.attempts}`, async () => {
      gh(["pr", "comment", String(pr), "--repo", conf.demoRepoSlug, "--body",
        `AutoLineage verification failed (attempt ${c.attempts}): ${detail}\n\nThis PR will not be merged by the doctor.`]);
      return "commented";
    });
  }
  if (c.attempts >= conf.attemptsCap) {
    transitionCase(c.id, "FAILED");
    return { healed: false, failedStep: "cap", detail };
  }
  // below cap: back to INJECTED via a fresh enqueue (done by the tick driver)
  transitionCase(c.id, "INJECTED", { attempts: c.attempts + 1, work_item_id: null, assignment_id: null, pr_number: null, verified_sha: null });
  return { healed: false, failedStep: "retry", detail };
}
