# AutoLineage demo orchestration. Paths come from bridge.config.json; secrets
# from the env file it references (never committed).
ENGINE_PATH   := $(shell bun -e "console.log((await import('./bridge/config.ts')).loadConfig().enginePath)" 2>/dev/null)
ENGINE_DB     := $(shell bun -e "console.log((await import('./bridge/config.ts')).loadConfig().engineDb)" 2>/dev/null)
DEMO_PATH     := $(shell bun -e "console.log((await import('./bridge/config.ts')).loadConfig().demoRepoPath)" 2>/dev/null)
OPENCODE_PORT ?= 4099
WG_MODEL_IMPLEMENTER ?= anthropic/claude-opus-5/max
WG_WALL_SCALE ?= 2

.PHONY: check up down demo-break verify-loop reset test

test:
	bun test

check:
	bun bridge/doctor-check.ts

## Start serve + engine + bridge (DataHub quickstart must already be up)
up: check
	cd $(ENGINE_PATH)/vice-head && WORKGRAPH_DB=$(ENGINE_DB) OPENCODE_PORT=$(OPENCODE_PORT) ./run-serve.sh > /dev/null 2>&1 &
	sleep 3
	cd $(ENGINE_PATH) && WORKGRAPH_DB=$(ENGINE_DB) OPENCODE_PORT=$(OPENCODE_PORT) \
	  WG_REPO_PATH=$(DEMO_PATH) WG_GH_REPO=$$(bun -e "console.log((await import('./bridge/config.ts')).loadConfig().demoRepoSlug)") \
	  WG_WORKTREE_ROOT=$(HOME)/.workgraph-worktrees \
	  WG_MODEL_IMPLEMENTER=$(WG_MODEL_IMPLEMENTER) WG_WALL_SCALE=$(WG_WALL_SCALE) \
	  ENGINE_TICK_SECONDS=15 bun engine/index.ts run >> engine-run.log 2>&1 &
	bun bridge/index.ts >> bridge-run.log 2>&1 &
	@echo "AutoLineage stack up (serve :$(OPENCODE_PORT), engine, bridge)"

down:
	-pkill -f "bun bridge/index.ts"
	-pkill -f "bun engine/index.ts"
	-pkill -f "opencode.*serve.*$(OPENCODE_PORT)"
	@echo "stack down"

## Plant the fragmentation regression and run the broken pipeline
demo-break:
	$(MAKE) -C $(DEMO_PATH) break BRIDGE_DIR=$(CURDIR)

## Re-green the canonical graph after a demo
reset:
	$(MAKE) -C $(DEMO_PATH) reset-data
	$(MAKE) -C $(DEMO_PATH) run BRIDGE_DIR=$(CURDIR)

## Assert the definition-of-done for the most recent case
verify-loop:
	bun scripts/verify-loop.ts
