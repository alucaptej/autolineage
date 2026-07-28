# Bridge ↔ WorkGraph engine interface

The bridge integrates with [workgraph](https://github.com/alucaptej/workgraph)
through four narrow, documented channels — nothing else touches the engine.

## 1. Enqueue (write, transactional)

`bun bin/enqueue.ts --json` in the engine checkout, `WORKGRAPH_DB` env pointing at
the engine DB. Atomically creates work_item + assignment (with the engine's own
indexing/event logging) + `workflow(READY)`; returns
`{"work_item_id","assignment_id"}`. The title embeds `[autolineage:<case_id>]` —
the reconciliation marker.

## 2. Observation (read-only SQL)

A `readonly` SQLite handle over the engine DB (WAL — safe concurrent readers):

- `workflow.state` — the item's FSM state
- `change_sets.pr_number`, `change_sets.head_sha` — PR identity (head_sha is
  push-time; the bridge always refetches the live OID from GitHub before acting)
- `operator_gates` — pending `merge_approval` gates

Shared-DB reads are the engine's own integration idiom (its telegram transport,
CI poller, and seed tooling all do the same).

## 3. Gate close after an external merge (write, one row)

When the bridge merges externally (`gh pr merge --match-head-commit`), the engine
reaches `DONE` on its own via ci-poll → `pr.merged`. The still-pending gate row is
closed directly: `UPDATE operator_gates SET status='approved', decided_at=? WHERE
id=? AND status='pending'`. **No** `gate.decided` event is emitted — the item is
already terminal, and terminal states accept no events.

## 4. Gate rejection (write, row + event)

When verification fails, the failed item must not stay parked: the bridge mirrors
the engine's own `recordDecision()` (telegram.ts) — mark the gate `rejected` AND
insert the `gate.decided` engine_event (dedupe key `gate-decided:<gateId>`), so
the FSM terminates the item as `OPERATOR_REJECTED`. This runs on every failed
attempt (before enqueueing a replacement item), never only at the attempt cap.

## Deployment invariants

- `opencode serve` must run with the same `WORKGRAPH_DB` as the engine daemon,
  or the plugin's `work_finish` writes land in the wrong database and every job
  dies at its wall deadline.
- Engine flags `auto-merge-on-green=0` and `merge-on-approve=0`: the engine never
  merges; the bridge owns the merge after verification.
- Role models via `WG_MODEL_ARCHITECT/IMPLEMENTER/REVIEWER` env.
- The PR target repo must gitignore `.omo/` (OpenCode plugin state) or the
  engine's read-only-worktree fingerprint guard trips.
