// DataHub client: exactly the surface the bridge needs. GraphQL for incidents,
// Documents, lineage; OpenAPI v3 for raw aspect reads. NO deletion calls exist
// in this module by design.
import { loadConfig } from "./config.ts";

export interface GqlResult {
  data?: Record<string, unknown>;
  errors?: Array<{ message: string }>;
}

async function gql(query: string, variables?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const cfg = loadConfig();
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${cfg.gmsUrl}/api/graphql`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cfg.gmsToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(20_000),
      });
      const body = (await res.json()) as GqlResult;
      if (body.errors?.length) throw new Error(`GraphQL: ${body.errors[0].message}`);
      if (!body.data) throw new Error(`GraphQL: empty data (HTTP ${res.status})`);
      return body.data;
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

export async function raiseIncident(input: {
  title: string;
  description: string;
  resourceUrn: string;
}): Promise<string> {
  const d = await gql(
    `mutation ($input: RaiseIncidentInput!) { raiseIncident(input: $input) }`,
    { input: { type: "OPERATIONAL", ...input } },
  );
  return d.raiseIncident as string;
}

export async function resolveIncident(urn: string, message: string): Promise<void> {
  await gql(`mutation ($urn: String!, $input: IncidentStatusInput!) { updateIncidentStatus(urn: $urn, input: $input) }`, {
    urn,
    input: { state: "RESOLVED", message },
  });
}

export async function createDocument(input: {
  title: string;
  text: string;
  relatedAssets: string[];
}): Promise<string> {
  const d = await gql(`mutation ($input: CreateDocumentInput!) { createDocument(input: $input) }`, {
    input: { title: input.title, contents: { text: input.text }, relatedAssets: input.relatedAssets },
  });
  return d.createDocument as string;
}

export interface ActiveIncident {
  urn: string;
  title: string;
}

/** Active (non-resolved) incidents on an entity — operator visibility + dedupe. */
export async function activeIncidents(resourceUrn: string): Promise<ActiveIncident[]> {
  const d = await gql(
    `query ($urn: String!) { entity(urn: $urn) { ... on Dataset {
        incidents(start: 0, count: 50, state: ACTIVE) {
          incidents { urn title }
        } } } }`,
    { urn: resourceUrn },
  );
  const entity = d.entity as { incidents?: { incidents?: ActiveIncident[] } } | null;
  return entity?.incidents?.incidents ?? [];
}

/** ALL incidents regardless of state — reconciliation must see resolved ones
 * too, or a marker created-then-resolved reads as "not found" and re-executes. */
export async function allIncidents(resourceUrn: string): Promise<ActiveIncident[]> {
  const d = await gql(
    `query ($urn: String!) { entity(urn: $urn) { ... on Dataset {
        incidents(start: 0, count: 100) {
          incidents { urn title }
        } } } }`,
    { urn: resourceUrn },
  );
  const entity = d.entity as { incidents?: { incidents?: ActiveIncident[] } } | null;
  return entity?.incidents?.incidents ?? [];
}

export interface UpstreamEntity {
  urn: string;
  type: string;
}

/** 1-hop upstream relationships (dataset ← datajob ← dataset needs two calls). */
export async function upstreams(urn: string): Promise<UpstreamEntity[]> {
  const d = await gql(
    `query ($urn: String!) { entityLineage: dataset(urn: $urn) {
        lineage(input: {direction: UPSTREAM, start: 0, count: 50}) {
          relationships { entity { urn type } } } } }`,
    { urn },
  );
  const ds = d.entityLineage as {
    lineage?: { relationships?: Array<{ entity: UpstreamEntity }> };
  } | null;
  return (ds?.lineage?.relationships ?? []).map((r) => r.entity);
}

export interface DatasetHit {
  urn: string;
}

export async function searchDatasets(query: string, count = 25): Promise<DatasetHit[]> {
  const d = await gql(
    `query ($q: String!, $count: Int!) { search(input: {type: DATASET, query: $q, start: 0, count: $count}) {
        searchResults { entity { urn } } } }`,
    { q: query, count },
  );
  const s = d.search as { searchResults?: Array<{ entity: DatasetHit }> } | null;
  return (s?.searchResults ?? []).map((r) => r.entity);
}

export async function datasetExists(urn: string): Promise<boolean> {
  const d = await gql(`query ($urn: String!) { dataset(urn: $urn) { exists } }`, { urn });
  return Boolean((d.dataset as { exists?: boolean } | null)?.exists);
}

/** Dataset urn embedded in a schemaField urn, or null. */
function schemaFieldDataset(sf: string): string | null {
  const m = sf.match(/^urn:li:schemaField:\((urn:li:dataset:\(.+?\)),[^)]+\)$/);
  return m ? m[1] : null;
}

export interface DataJobIO {
  inputs: Array<{ urn: string; time: number }>;
  outputs: Array<{ urn: string; time: number }>;
  /** dataset-level pairs distilled from fineGrainedLineages (column lineage) */
  fineGrainedPairs: Array<{ upstream: string; downstream: string }>;
  /** when THIS aspect was last written — the freshness anchor (edge lastModified
   * can survive re-writes; emission shape varies per Spark execution plan) */
  lastObserved: number;
}

/** dataJobInputOutput aspect of a datajob (edge presence + freshness). */
export async function dataJobIO(datajobUrn: string): Promise<DataJobIO | null> {
  const cfg = loadConfig();
  const res = await fetch(
    `${cfg.gmsUrl}/openapi/v3/entity/datajob/${encodeURIComponent(datajobUrn)}/datajobinputoutput?systemMetadata=true`,
    { headers: { Authorization: `Bearer ${cfg.gmsToken}` }, signal: AbortSignal.timeout(15_000) },
  );
  if (!res.ok) return null;
  const body = (await res.json()) as {
    value?: {
      inputDatasetEdges?: Array<{ destinationUrn: string; lastModified?: { time?: number } }>;
      outputDatasetEdges?: Array<{ destinationUrn: string; lastModified?: { time?: number } }>;
      fineGrainedLineages?: Array<{ upstreams?: string[]; downstreams?: string[] }>;
    };
    systemMetadata?: { lastObserved?: number };
  };
  const map = (edges?: Array<{ destinationUrn: string; lastModified?: { time?: number } }>) =>
    (edges ?? []).map((e) => ({ urn: e.destinationUrn, time: e.lastModified?.time ?? 0 }));
  if (!body.value) return null;
  const pairs: Array<{ upstream: string; downstream: string }> = [];
  for (const fg of body.value.fineGrainedLineages ?? []) {
    for (const u of fg.upstreams ?? []) {
      for (const d of fg.downstreams ?? []) {
        const up = schemaFieldDataset(u);
        const down = schemaFieldDataset(d);
        if (up && down) pairs.push({ upstream: up, downstream: down });
      }
    }
  }
  return {
    inputs: map(body.value.inputDatasetEdges),
    outputs: map(body.value.outputDatasetEdges),
    fineGrainedPairs: pairs,
    lastObserved: body.systemMetadata?.lastObserved ?? 0,
  };
}

/** Documents matching a title marker — reconciliation. */
export async function searchDocumentsByTitle(marker: string): Promise<string[]> {
  const d = await gql(
    `query ($q: String!) { search(input: {type: DOCUMENT, query: $q, start: 0, count: 10}) {
        searchResults { entity { urn } } } }`,
    { q: marker },
  );
  const s = d.search as { searchResults?: Array<{ entity: { urn: string } }> } | null;
  return (s?.searchResults ?? []).map((r) => r.entity.urn);
}
