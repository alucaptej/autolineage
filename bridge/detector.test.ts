// Detector logic on golden fixtures (shapes recorded from the live spike
// instance, gms v1.5.0.6). No network.
import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordRunMarker, resetCaseDbForTests } from "./cases.ts";
import { resetConfigForTests } from "./config.ts";
import { checkExpectation, dataJobUrn, type DetectorDeps, type Expectation } from "./detector.ts";
import { verifyNamespaceUrn } from "./verifier.ts";

const DOWN = "urn:li:dataset:(urn:li:dataPlatform:file,/private/tmp/lakehouse/curated_events,PROD)";
const UP = "urn:li:dataset:(urn:li:dataPlatform:file,/private/tmp/lakehouse/raw_events,PROD)";
const EXP: Expectation = {
  id: "curated-events-fed-by-raw-events",
  description: "d",
  downstream: DOWN,
  upstream: UP,
  via_flow: "urn:li:dataFlow:(spark,merge_upsert_curated,default)",
  job_name: "merge_upsert_curated",
  pipeline: "merge_upsert_curated",
  max_hops: 2,
};

function deps(overrides: Partial<DetectorDeps>): DetectorDeps {
  return {
    dataJobIO: async () => ({ inputs: [], outputs: [], fineGrainedPairs: [], lastObserved: 0 }),
    datasetExists: async () => false,
    searchDatasets: async () => [],
    ...overrides,
  };
}

let nowMs: number;

beforeEach(() => {
  resetCaseDbForTests();
  resetConfigForTests();
  const dir = mkdtempSync(join(tmpdir(), "det-"));
  process.env.DOCTOR_DB = join(dir, "doctor.db");
  process.env.DATAHUB_GMS_URL = "http://localhost:0";
  process.env.DATAHUB_GMS_TOKEN = "test";
  writeFileSync(
    join(dir, "bridge.config.json"),
    JSON.stringify({
      env_file: "/nonexistent",
      demo_repo_path: dir,
      demo_repo_slug: "example/demo",
      engine_path: dir,
      engine_db: join(dir, "wg.db"),
      expectations_path: join(dir, "expectations.json"),
      doctor_db: join(dir, "doctor.db"),
      index_lag_grace_ms: 10_000,
    }),
  );
  process.env.BRIDGE_CONFIG = join(dir, "bridge.config.json");
  recordRunMarker(EXP.pipeline);
  nowMs = Date.now() + 60_000; // safely past the grace window
});

test("no marker → nothing to judge", async () => {
  resetCaseDbForTests();
  process.env.DOCTOR_DB = join(mkdtempSync(join(tmpdir(), "det2-")), "d.db");
  expect(await checkExpectation(EXP, nowMs, deps({}))).toBeNull();
});

test("inside grace window → pending", async () => {
  expect(await checkExpectation(EXP, Date.now(), deps({}))).toBe("pending");
});

test("healthy: fresh dataset-level edges + dataset exists → null", async () => {
  const fresh = Date.now() + 50_000;
  const d = deps({
    dataJobIO: async () => ({
      inputs: [{ urn: UP, time: fresh }, { urn: DOWN, time: fresh }],
      outputs: [{ urn: DOWN, time: fresh }],
      fineGrainedPairs: [],
      lastObserved: fresh,
    }),
    datasetExists: async () => true,
  });
  expect(await checkExpectation(EXP, nowMs, d)).toBeNull();
});

test("healthy: edge present ONLY as column-level fine-grained pair → null", async () => {
  const fresh = Date.now() + 50_000;
  const d = deps({
    dataJobIO: async () => ({
      inputs: [],
      outputs: [{ urn: DOWN, time: fresh }],
      fineGrainedPairs: [{ upstream: UP, downstream: DOWN }],
      lastObserved: fresh,
    }),
    datasetExists: async () => true,
  });
  expect(await checkExpectation(EXP, nowMs, d)).toBeNull();
});

test("fragmentation: stale canonical edge + fresh fragment URNs", async () => {
  const stale = Date.now() - 3600_000;
  const fresh = Date.now() + 50_000;
  const frag = "urn:li:dataset:(urn:li:dataPlatform:file,data/curated_events,PROD)";
  const d = deps({
    dataJobIO: async () => ({
      // broken run rewrote the aspect: only fragment edges, canonical pair gone
      inputs: [{ urn: frag, time: fresh }],
      outputs: [{ urn: frag, time: fresh }],
      fineGrainedPairs: [{ upstream: frag, downstream: frag }],
      lastObserved: fresh,
    }),
    datasetExists: async () => true,
    searchDatasets: async () => [{ urn: frag }, { urn: DOWN }],
  });
  const v = await checkExpectation(EXP, nowMs, d);
  expect(v).not.toBeNull();
  expect(v).not.toBe("pending");
  if (v && v !== "pending") {
    expect(v.observed.signature_hint).toBe("stale-or-fragmented");
    expect(v.observed.fragment_candidates).toContain(frag);
    expect(v.observed.fragment_candidates).not.toContain(DOWN);
  }
});

test("silent pipeline: marker present, zero fresh emissions", async () => {
  const stale = Date.now() - 3600_000;
  const d = deps({
    dataJobIO: async () => ({
      inputs: [{ urn: UP, time: stale }],
      outputs: [{ urn: DOWN, time: stale }],
      fineGrainedPairs: [{ upstream: UP, downstream: DOWN }],
      lastObserved: stale,
    }),
    datasetExists: async () => true,
  });
  const v = await checkExpectation(EXP, nowMs, d);
  if (v && v !== "pending") {
    expect(v.observed.signature_hint).toBe("silent-pipeline");
    expect(v.observed.fresh_edges).toBe(false);
  } else {
    throw new Error("expected a violation");
  }
});

test("open case dedupe: second check returns null while case open", async () => {
  const d = deps({ datasetExists: async () => false });
  const v = await checkExpectation(EXP, nowMs, d);
  expect(v).not.toBeNull();
  // create the case as the driver would
  const { createCase } = await import("./cases.ts");
  createCase(EXP.id, v);
  expect(await checkExpectation(EXP, nowMs, d)).toBeNull();
});

test("dataJobUrn and verifyNamespaceUrn shapes", () => {
  expect(dataJobUrn(EXP)).toBe(
    "urn:li:dataJob:(urn:li:dataFlow:(spark,merge_upsert_curated,default),merge_upsert_curated)",
  );
  expect(verifyNamespaceUrn(DOWN, "verify-case_x")).toBe(
    "urn:li:dataset:(urn:li:dataPlatform:file,verify-case_x./private/tmp/lakehouse/curated_events,PROD)",
  );
});
