#!/usr/bin/env bun
// Small operational CLI:
//   bun bridge/cli.ts run-completed --pipeline <name>   (scheduler post-run hook)
//   bun bridge/cli.ts check [--expectations <path>]     (one-shot contract check)
import { recordRunMarker } from "./cases.ts";
import { checkExpectation, loadExpectations } from "./detector.ts";

const [cmd, ...rest] = process.argv.slice(2);
function opt(name: string): string | null {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 && rest[i + 1] ? rest[i + 1] : null;
}

if (cmd === "run-completed") {
  const pipeline = opt("pipeline") ?? "default";
  recordRunMarker(pipeline);
  console.log(`marker recorded for pipeline '${pipeline}'`);
} else if (cmd === "check") {
  const exps = loadExpectations(opt("expectations") ?? undefined);
  let bad = 0;
  for (const exp of exps) {
    const res = await checkExpectation(exp);
    const label = res === null ? "OK" : res === "pending" ? "PENDING (index lag)" : `VIOLATED (${res.observed.signature_hint})`;
    console.log(`${exp.id}: ${label}`);
    if (res !== null && res !== "pending") bad++;
  }
  process.exit(bad ? 1 : 0);
} else {
  console.error("usage: bun bridge/cli.ts run-completed --pipeline <name> | check [--expectations <path>]");
  process.exit(1);
}
