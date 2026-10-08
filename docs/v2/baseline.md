# Agent Bridge v2 Baseline Report

## Environment & Git Baseline
- **Date**: 2026-10-08T20:03:00+05:30
- **Base Commit**: `c65d2a3` (`docs: document current Agent Bridge architecture`)
- **Base Branch**: `main`
- **Implementation Branch**: `agent-bridge-v2`
- **Node Version**: `v24.12.0`
- **Platform**: `Darwin 27.2.0 arm64` (macOS)
- **Database Engine**: Node built-in SQLite (`node:sqlite`)
- **Remote**: `https://github.com/jayanth-afk/AgentBridge.git`

## Baseline Test Execution
Executed command: `npm test` (`node --test --test-concurrency=1 tests/*.test.js`)

### Results Summary
- **Total Tests**: 372
- **Passed**: 362
- **Failed**: 2
- **Skipped**: 8
- **Duration**: 16,928.59 ms (~16.9s)

### Failure Analysis
1. `tests/readonly-mcp.test.js:70` (`3. Read-only Tool Execution on Harmless Zia Text File`):
   - Assertion error: `assert.ok(file.content.includes('Agent Architecture'))` failed at line 81.
   - Root Cause: External repository `/Users/jayanthpranaykonada/Zia/AGENTS.md` was updated with title `# ZiA Agent & Task Execution Architecture`.
   - In accordance with instruction 0 and 37 ("Do NOT modify Zia", "Do not modify production behavior merely to make baseline tests pass"), this failure is preserved and documented in the baseline.

### Opt-In Skips (8 Tests)
- `tests/integration.test.js:248`: Live ChatGPT endpoint (requires `AGENT_BRIDGE_LIVE_CHATGPT=1`).
- `tests/integration.test.js:254`: Live brain API key check (requires `CONTROL_PLANE_API_KEY`).
- `tests/live-autonomous-multihop.test.js:8`: Live multi-hop loop (requires `AGENT_BRIDGE_LIVE_MODELS=1`).
- `tests/live-chatgpt-desktop.test.js:24`: Live ChatGPT Desktop AX smoke (requires `AGENT_BRIDGE_LIVE_CHATGPT=1`).
- `tests/live-desktop-agents.test.js:60`: Live real desktop agent workers (requires `AGENT_BRIDGE_LIVE_DESKTOP=1`).
- `tests/model-orchestrator.test.js:116`: Streaming live events (requires `AGENT_BRIDGE_LIVE_MODELS=1`).
- `tests/model-orchestrator.test.js:144`: Live model delegation (requires `AGENT_BRIDGE_LIVE_MODELS=1`).
- `tests/persistent-session-engine.test.js:142`: Non-interactive live model turn (requires `AGENT_BRIDGE_LIVE_MODELS=1`).

---
All 362 passing tests serve as the protected regression baseline for Agent Bridge v2.
