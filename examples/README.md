# Examples — evaluate AutoLineage without running anything

Artifacts harvested from **real autonomous runs** against a live DataHub OSS
quickstart (no hand-editing; timestamps and URNs are the originals). Three heals
of three different failure classes, one of them straight through a bridge crash.

## Metrics (all runs, `metrics.txt`)

| case | class | outcome | time to heal |
|---|---|---|---|
| case_ms4xo5o0o92kim | path fragmentation | HEALED (PR #2) | 17.0 min |
| case_ms5srde8j38qps | endpoint drift (out-of-repo) | HEALED (PR #5) | 22.0 min |
| case_ms5tp6o25acvou | path fragmentation + bridge `kill -9` mid-verify | HEALED (PR #6) | 21.4 min |

## Heal 1 — path fragmentation (the classic)

A seeded "portability refactor" made data paths relative, fragmenting the graph
into duplicate URNs. Zero human input between break and healed.

- `operations-ledger-first-heal.txt` — every external step, exactly-once
- `incident-first-heal.json` — the DataHub incident, later RESOLVED
- `pr2-fix.diff` / `pr2-metadata.json` — the agent's fix; note it cites the
  incident URN and the contract file in a code comment
- `case-document-first-heal.md` — the case file written back into DataHub

## Heal 2 — out-of-repo endpoint drift (the impressive one)

The break was **never committed**: the executing host's local `conf/spark.conf`
drifted to a dead endpoint — repo history clean, jobs green, zero emissions.
From graph evidence alone (stale edge vs run marker), the agent inferred
environment drift and shipped a **defensive** fix: pin the emission endpoint
from env in the run entrypoint (it verified empirically that spark-submit
`--conf` overrides `--properties-file`) plus a fail-closed reachability
precheck so silent pipelines become loud failures.

- `pr5-defensive-fix.diff` / `pr5-metadata.json` — the fix + full diagnosis in the PR body
- `case-document-defensive-fix.md` — the case file in DataHub

## Heal 3 — crash-resume (the reliability proof)

Same fragmentation class, but the bridge was `kill -9`'d at the worst moment:
merge accepted on GitHub, post-merge confirmation still inflight. The engine
reached its terminal state independently during the outage; the restarted
bridge reconciled the inflight operation and resumed from its ledger.

- `operations-ledger-crash-resume.txt` — note `postmerge` timestamps spanning
  the crash, and **every operation kind appearing exactly once**: no duplicate
  incident, merge, or Document through a hard kill.
- `pr6-fix.diff` — the merged fix

## Where things run

- Detection, verification, write-back: [`bridge/`](../bridge/)
- The agent's diagnosis playbook: [`skills/datahub-lineage-debug/SKILL.md`](https://github.com/alucaptej/autolineage-demo-pipelines/blob/main/skills/datahub-lineage-debug/SKILL.md)
- The engine that runs the agent: [workgraph](https://github.com/alucaptej/workgraph)
