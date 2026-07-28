// Bridge configuration: connection env from an env file (never committed) +
// deployment paths/caps from bridge.config.json (committed, no secrets).
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

export interface BridgeConfig {
  gmsUrl: string;
  gmsToken: string;
  /** demo pipeline repo checkout (the doctor's PR target) */
  demoRepoPath: string;
  demoRepoSlug: string; // owner/name for gh
  /** engine checkout (published workgraph clone) + its DB */
  enginePath: string;
  engineDb: string;
  expectationsPath: string;
  doctorDb: string;
  attemptsCap: number;
  caseWallClockMs: number;
  detectorIntervalMs: number;
  verifierIntervalMs: number;
  /** grace for DataHub search/graph index lag when judging freshness */
  indexLagGraceMs: number;
}

function envFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function expand(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return isAbsolute(p) ? p : resolve(REPO_ROOT, p);
}

let cached: BridgeConfig | null = null;

export function loadConfig(): BridgeConfig {
  if (cached) return cached;
  const cfgPath = process.env.BRIDGE_CONFIG ?? join(REPO_ROOT, "bridge.config.json");
  const raw = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
  const env = {
    ...envFile(expand(String(raw.env_file ?? "~/hack/.env.datahub"))),
    ...process.env,
  };
  const gmsUrl = env.DATAHUB_GMS_URL;
  const gmsToken = env.DATAHUB_GMS_TOKEN;
  if (!gmsUrl || !gmsToken) throw new Error("DATAHUB_GMS_URL / DATAHUB_GMS_TOKEN missing (env or env_file)");
  cached = {
    gmsUrl,
    gmsToken,
    demoRepoPath: expand(String(raw.demo_repo_path)),
    demoRepoSlug: String(raw.demo_repo_slug),
    enginePath: expand(String(raw.engine_path)),
    engineDb: expand(String(raw.engine_db)),
    expectationsPath: expand(String(raw.expectations_path)),
    doctorDb: expand(String(raw.doctor_db ?? "doctor.db")),
    attemptsCap: Number(raw.attempts_cap ?? 2),
    caseWallClockMs: Number(raw.case_wall_clock_ms ?? 3 * 3600_000),
    detectorIntervalMs: Number(raw.detector_interval_ms ?? 60_000),
    verifierIntervalMs: Number(raw.verifier_interval_ms ?? 15_000),
    indexLagGraceMs: Number(raw.index_lag_grace_ms ?? 30_000),
  };
  return cached;
}

/** Test hook. */
export function resetConfigForTests(): void {
  cached = null;
}
