#!/usr/bin/env bun
// Startup probes: refuse to run the bridge unless every dependency answers.
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { loadExpectations } from "./detector.ts";

interface Probe {
  name: string;
  run: () => Promise<string> | string;
}

const cfg = loadConfig();

const probes: Probe[] = [
  {
    name: "gms+token",
    run: async () => {
      const res = await fetch(`${cfg.gmsUrl}/api/graphql`, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.gmsToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query: "{ me { corpUser { username } } }" }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return `ok (${cfg.gmsUrl})`;
    },
  },
  {
    name: "gh-auth",
    run: () => {
      execFileSync("gh", ["auth", "status"], { encoding: "utf8", timeout: 15_000 });
      execFileSync("gh", ["repo", "view", cfg.demoRepoSlug, "--json", "name"], { encoding: "utf8", timeout: 15_000 });
      return "ok";
    },
  },
  {
    name: "engine-db",
    run: () => {
      const d = new Database(cfg.engineDb, { readonly: true });
      const n = d.query("SELECT count(*) c FROM workflow").get() as { c: number };
      d.close();
      return `ok (${n.c} workflow rows)`;
    },
  },
  {
    name: "expectations",
    run: () => `ok (${loadExpectations().length} expectations)`,
  },
  {
    name: "demo-venv",
    run: () => {
      const p = join(cfg.demoRepoPath, ".venv", "bin", "spark-submit");
      if (!existsSync(p)) throw new Error(`${p} missing`);
      return "ok";
    },
  },
];

let failed = 0;
for (const p of probes) {
  try {
    const msg = await p.run();
    console.log(`✓ ${p.name}: ${msg}`);
  } catch (e) {
    failed++;
    console.error(`✗ ${p.name}: ${e instanceof Error ? e.message : e}`);
  }
}
if (failed) {
  console.error(`doctor-check: ${failed} probe(s) failed — refusing to start`);
  process.exit(1);
}
console.log("doctor-check: all probes green");
