# Pre-existing code disclosure (hackathon rules compliance)

Per the Build with DataHub hackathon rules, submitted work must be created during
the submission window, with pre-existing components disclosed.

## Pre-existing (created before the window, disclosed)

- **[workgraph](https://github.com/alucaptej/workgraph)** — the agent work-item
  engine (SQLite FSM, worktree isolation, CI polling, operator gates, OpenCode
  plugin). Built earlier in 2026 as a personal automation project; extracted,
  sanitized, and published for this hackathon with fresh history. Changes made
  IN-window for this project: `bin/enqueue.ts` (transactional enqueue API),
  `WG_MODEL_<ROLE>` env overrides, the generic `operator-gate.ts` policy plugin,
  env-driven target-repo configuration, and post-publication review hardening.

## Created in-window (this submission)

- Everything in **this repository**: the bridge daemon (`bridge/`), detector +
  case FSM + operations ledger, verifier protocol, reconciliation, CLI, probes,
  tests, docs.
- **[autolineage-demo-pipelines](https://github.com/alucaptej/autolineage-demo-pipelines)**:
  the PySpark/Delta demo pipeline, lineage contract, break/heal mechanics, and
  the `datahub-lineage-debug` diagnosis playbook (SKILL.md).

## Third-party

DataHub OSS quickstart, `mcp-server-datahub`, `acryl-spark-lineage` 0.2.17,
OpenCode, Bun, PySpark/Delta — all under their own licenses, unmodified.
