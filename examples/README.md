# Examples — evaluate AutoLineage without running anything

Artifacts harvested from **real autonomous runs** against a live DataHub OSS
quickstart (no hand-editing; timestamps and URNs are the originals).

## The first fully autonomous heal (case_ms4xo5o0o92kim, 2026-07-28, 17 min)

A seeded regression ("derive data dir relative to the checkout for portability")
fragmented the lineage graph. Zero human input between break and healed.

| file | what it shows |
|---|---|
| `operations-ledger-first-heal.txt` | every external step, exactly-once: incident → enqueue → OID pin → CI → namespaced candidate validation → `--match-head-commit` merge → gate close → post-merge confirm → resolve → document |
| `incident-first-heal.json` | the DataHub incident raised on `curated_events`, later RESOLVED |
| `pr2-fix.diff` | the agent's fix ([PR #2](https://github.com/alucaptej/autolineage-demo-pipelines/pull/2)) — note it cites the incident URN and the contract in a code comment |
| `pr2-metadata.json` | merge metadata (squash commit, files) |
| `case-document-first-heal.md` | the case file written back into DataHub as a Document (evidence, diagnosis, resolution) |
| `metrics.txt` | time-to-heal and attempts recorded by the bridge |

## Where things run

- Detection, verification, and write-back: [`bridge/`](../bridge/)
- The agent's diagnosis playbook: [`skills/datahub-lineage-debug/SKILL.md`](https://github.com/alucaptej/autolineage-demo-pipelines/blob/main/skills/datahub-lineage-debug/SKILL.md)
- The engine that runs the agent: [workgraph](https://github.com/alucaptej/workgraph)
