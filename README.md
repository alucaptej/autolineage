# AutoLineage

**Self-healing lineage for DataHub.** An autonomous agent that detects broken Spark/Delta
lineage against a declared contract, diagnoses the failure using live DataHub MCP evidence,
ships the fix as a CI-tested pull request, verifies the graph actually healed, and writes
the incident + case record back into DataHub.

Built for [Build with DataHub: The Agent Hackathon](https://datahub.devpost.com)
(category: *Agents That Do Real Work*).

> 🚧 **Build in progress** — submission deadline Aug 10, 2026. This repo fills out daily;
> architecture and full setup instructions land with the MVP.

## How it works (short version)

1. `expectations.json` declares the lineage a pipeline must produce.
2. A bridge daemon diffs the contract against the live DataHub graph; on violation it
   raises a **DataHub incident** and enqueues a work item for the agent.
3. The agent investigates via the **DataHub MCP server** (`get_lineage`,
   `get_dataset_queries`, search), ranks hypotheses, and opens a PR against the
   [demo pipeline repo](https://github.com/alucaptej/autolineage-demo-pipelines) with its
   reasoning in the PR body. Unknown failures are escalated, never guessed.
4. The bridge validates the candidate SHA in an isolated DataHub namespace, merges exactly
   that SHA, re-runs post-merge to confirm the real graph healed, resolves the incident,
   and files a durable case record in DataHub.

## Repos

| Repo | Role |
|---|---|
| [autolineage](https://github.com/alucaptej/autolineage) | Bridge, diagnosis playbook, demo env, examples (this repo) |
| [autolineage-demo-pipelines](https://github.com/alucaptej/autolineage-demo-pipelines) | PySpark/Delta demo pipeline the agent repairs |
| [workgraph](https://github.com/alucaptej/workgraph) | Agent work-item engine (pre-existing, disclosed — see DISCLOSURE.md) |

## License

[Apache-2.0](./LICENSE)
