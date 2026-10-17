# Agent Bridge v2 — Definitive Verification Matrix

**Date:** 2026-10-14  
**Test Suite Size:** 138 Test Files · 1207 Total Tests · 1196 Passed · 0 Failed · 11 Skipped (Gated Live Routes)  
**Execution Environment:** Node.js v24.12.0 · Darwin 24.1.0 · macOS Apple Silicon  
**Hermeticity Status:** VERIFIED (Zero mutations to production database, zero lockfile dirtiness)  

---

## 1. Subsystem Verification Breakdown

| Subsystem | Test Suite Files | Test Count | Pass / Fail / Skip | Key Invariants Verified |
|---|---|---|---|---|
| **Storage & Schema Migration** | `tests/schema-migrator.test.js`, `tests/storage-*.test.js` | 24 | 24 / 0 / 0 | Idempotent multi-version migrations (v1→v2→v3); atomic step rollbacks on error; `PRAGMA user_version` tracking; schema integrity validation on boot. `[VERIFIED]` |
| **Identity & Routing** | `tests/agent-identity-routing.test.js`, `tests/agent-identity.test.js` | 26 | 26 / 0 / 0 | Write normalization (`chatgpt` → `chatgpt-desktop`); alias candidate expansion on task claims; dynamic manifest loading; backward compatibility for legacy unnormalized rows. `[VERIFIED]` |
| **Pending Work & Recovery** | `tests/pending-work-expiry.test.js`, `tests/durable-recovery-delivery.test.js` | 19 | 19 / 0 / 0 | Expiry of never-claimed requests/tasks past `MAX_PENDING_AGE_MS` (24h); typed failure `TARGET_UNREACHABLE`; immunity for blocked and recent items; idempotency of recovery sweeps. `[VERIFIED]` |
| **Silent Catch Linting** | `tests/silent-catch-lint.test.js` | 4 | 4 / 0 / 0 | Zero undocumented bare `catch {}` blocks across all 123 `src/` files; valid justification required for all `// swallow-ok:` annotations; inventory synchronization. `[VERIFIED]` |
| **Security & Sanitization** | `tests/stage1-security-hardening.test.js`, `tests/verification-tokens.test.js` | 32 | 32 / 0 / 0 | Neutralization of hostile JXA/AppleScript injections via `validateTargetApp` and `escapeJxaString`; `execFile` argument array usage; control plane Host/Origin guards; HTTP auth telemetry. `[VERIFIED]` |
| **Documentation & Hygiene** | `tests/documentation-invariants.test.js` | 8 | 8 / 0 / 0 | Dynamic derivation of canonical tool counts (74 registered + 5 skills + 2 comms = 81 system-wide); sync between code and docs; `.gitignore` validation; package version alignment. `[VERIFIED]` |
| **Workspace Isolation & Zia Protection** | `tests/zia-lock-and-allowed-roots.test.js`, `tests/workspace-isolation.test.js` | 18 | 18 / 0 / 0 | Default-deny write access to Zia main tree (`ZIA_WRITE_LOCKED=true`); symlink traversal prevention; isolated worktree provisioning for attempted writes; allowed roots confinement. `[VERIFIED]` |
| **Interoperability & Zero-Waste Delivery** | `tests/zero-waste-delivery.test.js`, `tests/v2-adversarial-integration.test.js` | 26 | 26 / 0 / 0 | Verbatim response delivery without re-synthesis; CAS artifact hashing; monotonic epoch fencing; late response quarantine; duplicate execution suppression. `[VERIFIED]` |
| **Skills Platform** | `tests/skills-platform.test.js`, `tests/mission-g-skill-registry.test.js` | 16 | 16 / 0 / 0 | In-house skills registration; lockfile integrity; tool registry profile filtering (`default` profile retains exactly 74 tools; `skills` profile adds 5). `[VERIFIED]` |
| **Core MCP Tools & Diagnostics** | `tests/mcp-tools-contract.test.js`, `tests/verification-recovery.test.js` | 991 | 983 / 0 / 8 | 74 registered MCP tools adhere to strict schemas; harmless read/write operations succeed in test-workspace; sensitive files forbidden; diagnostic doctor passes cleanly. `[VERIFIED]` |

*Subsystem counts above were captured in the 2026-10-14 subsystem run (1164 tests). The header summary and §3 skip audit are refreshed to the current full-suite run (1207 tests).*

---

## 2. Invariant Verification Ledger

```
[INV-01] PROD_DB_HERMETICITY:
         Pre-Test DB Hash:  33e639bbf120e6c2d5f6c1147b29b19d3f9d8214e333ddfe56944aac480b53b6
         Post-Test DB Hash: 33e639bbf120e6c2d5f6c1147b29b19d3f9d8214e333ddfe56944aac480b53b6
         Status: PASSED (100% Byte-Identical)

[INV-02] LOCKFILE_HERMETICITY:
         Pre-Test Lockfile Dirty:  false
         Post-Test Lockfile Dirty: false
         Status: PASSED (Zero Dirtying)

[INV-03] ZIA_WRITE_PROTECTION:
         Repository: /Users/jayanthpranaykonada/Zia
         Git Status Porcelain: 0 bytes
         HEAD Commit: 19363d30f398d66613a541da3760935b793191c9
         Status: PASSED (Untouched)

[INV-04] LIVE_PROCESS_CONTINUITY:
         Port 8765 Listener: PID 16225 (Node.js bridge)
         Claude Desktop MCP: PID 17000 (Node.js bridge)
         Status: PASSED (Uninterrupted)

[INV-05] SCHEMA_VERSION_MONOTONICITY:
         Baseline Version: 0
         Post-Migration Version: 3
         Status: PASSED (Monotonic advance to target v3)

[INV-06] AGENT_ID_NORMALIZATION:
         Legacy Alias Rows in Tasks: Claimable via candidate alias set
         New Row Write Format: Canonical IDs only
         Status: PASSED

[INV-07] PENDING_WORK_QUARANTINE:
         Live Pending Requests: 0 (5 safely expired)
         Live Pending Tasks:    0 (18 safely expired)
         Status: PASSED (Zero stuck pending rows remaining)

[INV-08] SILENT_CATCH_ELIMINATION:
         Undocumented Bare Catches in src/: 0
         Documented // swallow-ok Catches: 227
         Status: PASSED (Enforced by tests/silent-catch-lint.test.js)

[INV-09] JXA_INJECTION_NEUTRALIZATION:
         Hostile TargetApp Interpolation: Throws descriptive security error
         Hostile Script Payloads: Executed via execFile argument arrays
         Status: PASSED
```

---

## 3. Justified Skip Audit (AR-05)

The 11 skipped tests across the suite are explicitly cataloged and verified below:

1. `tests/desktop-session-verifier.test.js` (Category C & E): Requires a running Claude Desktop process (`AGENT_BRIDGE_LIVE_DESKTOP=1`).
2. `tests/desktop-session-verifier.test.js` (Category D & F): Requires a running ChatGPT Desktop process (`AGENT_BRIDGE_LIVE_DESKTOP=1`).
3. `tests/integration.test.js` (LIVE ZiA primary ChatGPT brain endpoint): Requires live ChatGPT credentials (`AGENT_BRIDGE_LIVE_CHATGPT=1`).
4. `tests/live-autonomous-multihop.test.js`: Requires live model credentials (`AGENT_BRIDGE_LIVE_MODELS=1`).
5. `tests/live-chatgpt-desktop.test.js`: Requires interactive desktop focus & AX session (`AGENT_BRIDGE_LIVE_CHATGPT=1`).
6. `tests/live-desktop-agents.test.js`: Requires interactive desktop session (`AGENT_BRIDGE_LIVE_DESKTOP=1`).
7. `tests/model-orchestrator.test.js` (Test 1, Live Status Reporting): Asserts real ChatGPT/Claude desktop processes are open (`AGENT_BRIDGE_LIVE_DESKTOP=1`).
8. `tests/model-orchestrator.test.js` (Test 3.1, Real streaming events): Requires live ChatGPT/Codex quota (`AGENT_BRIDGE_LIVE_MODELS=1`).
9. `tests/model-orchestrator.test.js` (Test 3.2, LIVE_MODEL Delegation): Requires live ChatGPT/Codex quota (`AGENT_BRIDGE_LIVE_MODELS=1`).
10. `tests/model-orchestrator.test.js` (Test 3.3, Autonomous Multi-Hop Loop): Requires live Claude quota (`AGENT_BRIDGE_LIVE_MODELS=1`).
11. `tests/persistent-session-engine.test.js` (Real non-interactive model execution): Requires live ChatGPT/Codex quota (`AGENT_BRIDGE_LIVE_MODELS=1`).

**Conclusion:** All 11 skips represent real-world external dependency boundaries. In the default hermetic test run, 0 tests fail, 1196 pass, and exactly these 11 skips execute. Setting `AGENT_BRIDGE_LIVE_DESKTOP=1` re-enables the desktop assertions and they fail loudly when the corresponding app is closed, so the gate never masks a genuine inspection regression.
