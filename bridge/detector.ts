// Freshness-anchored contract detector. Structural existence alone can never
// catch a regression (yesterday's healthy edge persists in DataHub forever), so
// every judgment is relative to the latest pipeline run marker: after a run, the
// contract edge must have been re-observed. Emits evidence, never diagnoses.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { loadConfig } from "./config.ts";
import { dataJobIO, datasetExists, searchDatasets } from "./datahub.ts";
import { latestRunMarker, openCaseFor } from "./cases.ts";

export interface Expectation {
  id: string;
  description: string;
  downstream: string;
  upstream: string;
  via_flow: string;
  job_name: string;
  pipeline: string;
  max_hops: number;
}

export interface Violation {
  expectation_id: string;
  downstream: string;
  upstream: string;
  run_marker: string;
  observed: {
    dataset_exists: boolean;
    edge_last_modified: number | null;
    fresh_edges: boolean;
    fragment_candidates: string[];
    signature_hint: "stale-or-fragmented" | "silent-pipeline";
  };
}

export function loadExpectations(path?: string): Expectation[] {
  const p = path ?? loadConfig().expectationsPath;
  const raw = JSON.parse(readFileSync(p, "utf8")) as {
    pipeline?: string;
    expectations: Array<Record<string, unknown>>;
  };
  return raw.expectations.map((e) => ({
    id: String(e.id),
    description: String(e.description ?? ""),
    downstream: String(e.downstream),
    upstream: String(e.upstream),
    via_flow: String(e.via_flow),
    job_name: String(e.job_name ?? String(e.via_flow).match(/,([^,]+),[^,]+\)$/)?.[1] ?? ""),
    pipeline: String(e.pipeline ?? raw.pipeline ?? "default"),
    max_hops: Number(e.max_hops ?? 2),
  }));
}

export function dataJobUrn(exp: Expectation): string {
  return `urn:li:dataJob:(${exp.via_flow},${exp.job_name})`;
}

/** URN "name" of a dataset urn: urn:li:dataset:(platform,NAME,env). */
function urnName(urn: string): string {
  const m = urn.match(/^urn:li:dataset:\(urn:li:dataPlatform:[^,]+,(.+),[A-Z]+\)$/);
  return m ? m[1] : urn;
}

export interface DetectorDeps {
  dataJobIO: typeof dataJobIO;
  datasetExists: typeof datasetExists;
  searchDatasets: typeof searchDatasets;
}

const LIVE: DetectorDeps = { dataJobIO, datasetExists, searchDatasets };

/**
 * Check one expectation against the graph, anchored to the latest run marker.
 * Returns null when healthy, a case-shaped Violation otherwise, or "pending"
 * while inside the index-lag grace window (judge later, not now).
 */
export async function checkExpectation(
  exp: Expectation,
  nowMs = Date.now(),
  { dataJobIO, datasetExists, searchDatasets }: DetectorDeps = LIVE,
): Promise<Violation | "pending" | null> {
  const cfg = loadConfig();
  const marker = latestRunMarker(exp.pipeline);
  if (!marker) return null; // no run observed yet — nothing to judge
  const markerMs = Date.parse(marker);
  if (nowMs - markerMs < cfg.indexLagGraceMs) return "pending"; // let indexing settle
  if (openCaseFor(exp.id)) return null; // dedupe: one open case per expectation

  const io = await dataJobIO(dataJobUrn(exp));
  const exists = await datasetExists(exp.downstream);
  const outEdge = io?.outputs.find((e) => e.urn === exp.downstream);
  const inEdge = io?.inputs.find((e) => e.urn === exp.upstream);
  const edgeTime = outEdge && inEdge ? Math.min(outEdge.time, inEdge.time) : null;
  const fresh = edgeTime !== null && edgeTime >= markerMs - cfg.indexLagGraceMs;

  if (exists && fresh) return null; // contract held for this run

  // Evidence: near-duplicate URNs that share a basename with the contract datasets.
  const names = [urnName(exp.downstream), urnName(exp.upstream)].map((n) => basename(n));
  const hits = new Set<string>();
  for (const n of names) {
    for (const h of await searchDatasets(n)) {
      if (h.urn !== exp.downstream && h.urn !== exp.upstream) hits.add(h.urn);
    }
  }
  // Did ANYTHING fresh get emitted by this pipeline's job at all?
  const anyFresh =
    (io?.outputs.some((e) => e.time >= markerMs - cfg.indexLagGraceMs) ?? false) ||
    (io?.inputs.some((e) => e.time >= markerMs - cfg.indexLagGraceMs) ?? false);

  return {
    expectation_id: exp.id,
    downstream: exp.downstream,
    upstream: exp.upstream,
    run_marker: marker,
    observed: {
      dataset_exists: exists,
      edge_last_modified: edgeTime,
      fresh_edges: anyFresh,
      fragment_candidates: [...hits].slice(0, 10),
      signature_hint: anyFresh || hits.size ? "stale-or-fragmented" : "silent-pipeline",
    },
  };
}
