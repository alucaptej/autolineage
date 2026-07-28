import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  caseDb,
  casesInState,
  createCase,
  getCase,
  inflightOps,
  latestRunMarker,
  openCaseFor,
  recordRunMarker,
  resetCaseDbForTests,
  runOp,
  settleOp,
  transitionCase,
} from "./cases.ts";

beforeEach(() => {
  resetCaseDbForTests();
  process.env.DOCTOR_DB = join(mkdtempSync(join(tmpdir(), "doctor-")), "doctor.db");
});

test("case FSM: legal path DETECTED→…→HEALED", () => {
  const c = createCase("exp-1", { note: "e" });
  transitionCase(c.id, "INCIDENT_RAISED", { incident_urn: "urn:li:incident:x" });
  transitionCase(c.id, "INJECTED", { work_item_id: "WORK_1" });
  transitionCase(c.id, "AWAITING_FIX");
  transitionCase(c.id, "VERIFYING", { pr_number: 7, verified_sha: "abc" });
  transitionCase(c.id, "HEALED");
  const done = getCase(c.id)!;
  expect(done.state).toBe("HEALED");
  expect(done.incident_urn).toBe("urn:li:incident:x");
  expect(done.pr_number).toBe(7);
});

test("case FSM: illegal transition throws; terminal states are sealed", () => {
  const c = createCase("exp-2", {});
  expect(() => transitionCase(c.id, "VERIFYING")).toThrow(/illegal case transition/);
  transitionCase(c.id, "FAILED");
  expect(() => transitionCase(c.id, "INCIDENT_RAISED")).toThrow(/illegal case transition/);
});

test("retry loop VERIFYING→INJECTED is legal (failed validation below cap)", () => {
  const c = createCase("exp-3", {});
  transitionCase(c.id, "INCIDENT_RAISED");
  transitionCase(c.id, "INJECTED");
  transitionCase(c.id, "AWAITING_FIX");
  transitionCase(c.id, "VERIFYING");
  transitionCase(c.id, "INJECTED", { attempts: 2 });
  expect(getCase(c.id)!.attempts).toBe(2);
});

test("openCaseFor dedupes on non-terminal cases only", () => {
  const c = createCase("exp-4", {});
  expect(openCaseFor("exp-4")!.id).toBe(c.id);
  transitionCase(c.id, "FAILED");
  expect(openCaseFor("exp-4")).toBeNull();
});

test("runOp: done ops never re-execute; failed ops retry; return value persisted", async () => {
  const c = createCase("exp-5", {});
  let calls = 0;
  const fn = async () => {
    calls++;
    return "urn:li:incident:once";
  };
  expect(await runOp(c.id, "incident", "inc:exp-5", fn)).toBe("urn:li:incident:once");
  expect(await runOp(c.id, "incident", "inc:exp-5", fn)).toBe("urn:li:incident:once");
  expect(calls).toBe(1);

  let failures = 0;
  await expect(
    runOp(c.id, "merge", "merge:exp-5", async () => {
      failures++;
      throw new Error("gh transient");
    }),
  ).rejects.toThrow("gh transient");
  expect(await runOp(c.id, "merge", "merge:exp-5", async () => "merged")).toBe("merged");
  expect(failures).toBe(1);
});

test("runOp: inflight row (crash window) blocks execution until settled", async () => {
  const c = createCase("exp-6", {});
  // simulate a crash: op left inflight
  caseDb()
    .query(`INSERT INTO operations (id, case_id, kind, idem_key, status, created_at) VALUES ('op_x', ?, 'incident', 'inc:exp-6', 'inflight', '2026-01-01')`)
    .run(c.id);
  await expect(runOp(c.id, "incident", "inc:exp-6", async () => "dup")).rejects.toThrow(/reconcile/);
  expect(inflightOps().length).toBe(1);
  settleOp("inc:exp-6", { done: true, externalRef: "urn:li:incident:recovered" });
  expect(await runOp(c.id, "incident", "inc:exp-6", async () => "dup")).toBe("urn:li:incident:recovered");
});

test("run markers and state queries", () => {
  expect(latestRunMarker("p1")).toBeNull();
  recordRunMarker("p1");
  expect(latestRunMarker("p1")).not.toBeNull();
  const c = createCase("exp-7", {});
  transitionCase(c.id, "INCIDENT_RAISED");
  expect(casesInState("INCIDENT_RAISED").map((x) => x.id)).toContain(c.id);
});
