# Agent Bridge — Current Implementation State

**Refreshed:** 2026-10-10
**Repository:** `/Users/jayanthpranaykonada/agent-bridge`  
**HEAD (baseline):** `daf41886f880223b99e1ab0982302c31d7fbdb23`
**Branch:** `main`
**Tree:** working tree carries messaging/completion-delivery optimizations and attempt-lease recovery hardening (see below). Zia untouched.
**Live Control Plane:** Bound to `127.0.0.1:8765` (PID `5882` at measurement time). Both `/mcp` and `/api/mcp/call` active in full parity.

This is the authoritative implementation handoff for Agent Bridge. It supersedes older notes and reflects the ground-truth state verified against live processes and providers.

## Verification

Full regression suite (`npm test` → `node --test --test-concurrency=1 tests/*.test.js`), latest run after the attempt-lease recovery change:

- tests: **591**
- pass: **583**
- fail: **0**
- skipped: **8** (explicitly live-gated: live model quota/credentials requiring explicit opt-in)
- duration: **18.55s**
- exit code: **0**

## Runtime composition

### MCP server

`src/mcp-server.js` is the primary MCP server.

It creates:

- AuditLogger
- PermissionGuard
- ConcurrencyManager
- CacheManager
- DiagnosticsManager
- PresenceManager
- AgentIdentityManager
- EventBus
- TaskManager
- MailboxHub
- CollaborationManager
- FileActivityManager
- GitController
- ProjectController
- SessionAdapter
- ToolRegistry

It starts the local HTTP control plane and the MCP stdio transport.

### HTTP control plane

`src/http-server.js` provides the loopback control plane, normally on:

`127.0.0.1:8765`

It also owns the dedicated ZiA/ChatGPT brain endpoints and their stricter authentication boundary.

Automatic ChatGPT transport selection is:

```
requested UI       → UI
requested engine   → headless engine
automatic          → healthy headless engine if available, otherwise UI
```

### Tool registry

`src/tool-registry.js` is the single source of truth for bridge tools.

Transport adapters should call the same registry rather than reimplementing tool behavior.

Current test coverage exercises the complete registered tool matrix.

## Agent lifecycle

`AgentIdentityManager` binds a connection to an identity.

`PresenceManager` maintains live heartbeat state.

The known identities currently include:

- chatgpt-desktop
- claude-desktop
- zia
- antigravity-ide
- freebuff
- system

The special `system` identity must never be reachable through ordinary caller-supplied impersonation.

## Client SDK endpoint

`AgentBridgeClient` posts JSON-RPC to `/api/mcp/call`. That path never existed on
the HTTP server (which serves the canonical `/mcp`), so every SDK tool call
returned 404. The HTTP server now serves `/api/mcp/call` as an alias of `/mcp`.

## Messaging

### EventBus

The EventBus is the internal event path.

Delivery guarantees implemented in this session:

- `waitForResponse()` registers the in-memory waiter **before** the
  authoritative `bridge_requests` check, eliminating the lost-wakeup window.
- A single `_settleWaiter()` path (used by live dispatch, DB drain,
  pre-registration check, and fallback poll) resolves a waiter **only** from the
  durable terminal row — never from an event payload snippet.
- The waiter timeout timer is intentionally **referenced** (not unref'd): a
  short-lived requester process must stay alive until a cross-process reply
  arrives. Unref'ing it caused cross-process requesters to exit early.
- A caller timeout is reported as `timeout` with `recoverable: true` and never
  overwrites the durable request/task, so a late result stays retrievable.

`src/diagnostics/request-tracer.js` (`RequestTracer`) records correlated lifecycle
stages with monotonic + wall-clock timestamps for stage-level latency analysis.
It never stores prompts or response bodies.

### MailboxHub

MailboxHub provides correlated request/response and pending-request recovery.

### TaskManager

TaskManager provides durable task lifecycle and authorization.

### CollaborationManager

CollaborationManager provides durable multi-agent collaboration state and events.

This separation is intentional:

- EventBus = delivery/wakeup
- Mailbox = request/result correlation
- TaskManager = work lifecycle
- CollaborationManager = shared objective/board

## Filesystem and command security

The current configuration has two broad authorized roots:

- bridge test workspace
- the user's home directory

The home-directory authorization is owner-authorized, but credential-sensitive paths remain forbidden.

The forbidden-path policy includes credential stores such as:

- SSH keys
- GnuPG
- AWS credentials
- Google Cloud credentials
- Codex auth
- Gemini OAuth credentials
- Docker credentials
- netrc/npmrc
- environment files
- macOS Keychains/Cookies
- browser profile credential data

Command execution is separately constrained by:

- executable allowlist
- dangerous-pattern rejection
- command chaining/substitution/redirection rejection
- path-like argument validation
- working-directory containment
- timeout/error propagation

## Concurrency

The bridge has explicit concurrency protection for:

- file edits
- task leases
- event delivery
- multi-process SQLite access
- duplicate request IDs
- desktop single-flight operations

File edits can use expected hashes to detect concurrent modifications.

FileActivityManager exposes which agents are currently reading/writing a file.

## Git

Git operations are structured through GitController and are covered by dedicated tests.

Current policy:

- protected branches include main/master/production/release
- autonomous protected-branch push is disabled by default
- normal autonomous push behavior is tested
- every Git operation is audited

## Desktop control

The control-plane directory contains adapters for:

- AX/accessibility
- native Swift AX helper
- CDP
- browser sessions
- ChatGPT desktop
- Claude desktop
- persistent desktop launch/session management
- response observation/correlation

Desktop automation is explicitly opt-in.

The important invariant is **do not steal user focus for background work**.

Tests cover the logical no-activation invariant. Physical validation on a real multi-Space fullscreen arrangement remains an acceptance test.

## ChatGPT headless engine

`ChatGptLocalEngineAdapter` wraps the installed bundled/local Codex engine when available.

The adapter has:

- installation discovery
- health checking
- temporary per-turn working directories
- JSONL event handling
- first-token timeout
- total timeout
- cancellation
- concurrent stateless turns
- automatic fallback to UI transport

A successful HTTP response is not considered a successful model turn unless the underlying engine/session produced a valid correlated result.

## Session adapters

Session adapters normalize different desktop agents behind a shared contract.

Current adapters include:

- ChatGPT
- Claude
- Antigravity
- composite desktop/UI
- notification/browser support

This allows the bridge to evolve transports independently of logical task/message semantics.

## Binary artifact transport

`src/artifacts/artifact-store.js` (`ArtifactStore`) provides durable,
integrity-verified transport for real binary artifacts:

- table `bridge_artifacts` with `artifact_id`, `task_id`, `attempt_id`,
  `agent_id`, `mime_type`, `media_type`, `filename`, `size_bytes`, `sha256`,
  `storage_backend`, `retrieval_method`, `transfer_status`, `created_at`,
  `expires_at`
- bytes stored under `data/artifacts/` with O_EXCL creation, size limits,
  magic-byte MIME agreement, SHA-256 verification on store **and** read,
  lexical + realpath containment checks, symlink refusal, expiry, and cleanup
- retrieval authorized per artifact (storing agent + explicitly authorized
  agents), so one task cannot read another task's artifact
- exposed through tools `bridge_artifact_store`, `bridge_artifact_get`,
  `bridge_artifact_read`, `bridge_artifact_cleanup` (registry now 64 tools)

Security hardening (audit & hardening phase):

- OS-level TOCTOU immunity: `ArtifactStore.read()` opens storage files with the OS-level `O_NOFOLLOW` flag via `fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)`, validates the opened descriptor with `fs.fstatSync(fd)` (ensuring file size matches and it is a regular file), and reads directly from the verified file descriptor with `fs.readFileSync(fd)` inside a `finally { fs.closeSync(fd) }` block. This eliminates filesystem race conditions and symlink substitution between path validation and read.
- Caller identity for every artifact tool is resolved from the trusted, server-side bound context (`AgentIdentityManager.resolveIdentity`), never from the caller-supplied `agentId`; a bound connection can never act as another agent. Regression coverage: `tests/artifact-identity-security.test.js`.
- Base64 payloads are rejected by **encoded length before decoding** and must be well-formed; the 8 MiB inline retrieval ceiling is enforced from stored metadata before bytes are read into memory.
- A declared `image/*`/`video/*` MIME must be confirmed by content magic bytes.
- `bridge_artifact_store` (non-idempotent) and `bridge_artifact_cleanup` (idempotent) are classified as effectful tools, fenced and audited like other mutations under the effects policy.

Provider limitation (truthfulness): no desktop provider exposes a raw-byte export route today — the Ax helper has no screenshot/export op and desktop sessions return text. The store refuses to fabricate bytes from a filename or UI element id.

## Request tracer & retention policy

`src/diagnostics/request-tracer.js` (`RequestTracer`) captures fine-grained request lifecycle events across all stages: `REQUEST_CREATED`, `TASK_CREATED`, `TASK_CLAIMED`, `WORKER_AWAKENED`, `PROVIDER_SUBMITTED`, `PROVIDER_RESPONSE_COMPLETED`, `RESULT_PERSISTED`, `WAITER_RESOLVED`, `RESPONSE_RETURNED`, `REQUEST_FAILED`, `REQUEST_TIMED_OUT`.

Retention & memory safety:
- Index `idx_request_lifecycle_wall` on `(wall_time_ms)` enables high-performance bounded pruning.
- `prune({ retentionMs, maxBatch, now })` prunes old terminal records while strictly preserving records for active or pending requests (`bridge_requests.status NOT IN ('completed', 'failed', 'cancelled')`) and active tasks (`bridge_tasks.status NOT IN ('completed', 'failed', 'cancelled')`).
- `getStats()` provides total count, oldest/newest timestamps, and active request count.
- Exposed through `MailboxHub.pruneRequestLifecycle()` and `MailboxHub.getRequestLifecycleStats()`.
- Verified in `tests/request-tracer-retention.test.js`.

## Durable storage

SQLite is the coordination database under the bridge data directory.

It supports:

- audit
- presence
- tasks
- mailbox
- collaborations
- file activity
- persistent sessions

Multi-process tests currently prove that multiple bridge processes can share the database without SQLITE_BUSY failures under the tested workload.

## Current architectural boundary with ZiA

Agent Bridge provides infrastructure and transport.

ZiA owns:

- canonical personal state
- memory
- intelligence policy
- provider selection
- task semantics
- task verification
- user-facing identity

The bridge may transport or execute authorized operations for ZiA, but should not become ZiA's canonical state machine.

## Remaining implementation work

### A. Peer-to-peer autonomy

Strengthen automatic peer discovery and capability-aware delegation so agents can initiate useful collaboration without a human manually forwarding prompts.

### B. Long-running reliability

Add more coverage for:

- process restart during active requests
- network/tunnel interruption
- mailbox replay
- task lease expiry during multi-hop collaboration
- cancellation propagation across agents
- partial peer failure

### C. Background desktop operation

Prove the intended behavior physically on macOS:

- agent app fullscreen on another Space
- user remains on a different Space
- background request completes
- no unexpected activation
- no Space switching
- result returns through the bridge

If native/headless transport can perform the work, UI automation should not be used.

### D. Capability-aware delegation

Expose agent capabilities strongly enough for a coordinator to ask:

- who can edit this repository?
- who can run Swift tests?
- who has the right model/desktop transport?
- who is currently available?
- who is already overloaded?

Then delegate based on evidence rather than agent-name conventions.

### E. Review/council workflows

Future collaboration primitives should support:

- independent proposals
- peer review
- evidence exchange
- conflict resolution
- final synthesis

The bridge should remain transport/coordination infrastructure rather than becoming the deciding intelligence.

## Verified Provider Capability Matrix

The following matrix represents the empirical, ground-truth capabilities verified directly against running desktop applications and live bridge routes:

| Provider | Connected | Can Receive Tasks | Can Initiate Tasks | Real Model Turn Verified | Background Submission Verified | Complete Text Response Verified | Late Response Recovery | Image/Media Generation | Media Bytes Export Verified | Focus-Safe Operation | Status & Limitations |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| **ChatGPT (Codex Engine)** | Yes | Yes | Yes | **PASS — VERIFIED** | **PASS — VERIFIED** | **PASS — VERIFIED** | **PASS — VERIFIED** | Unverified | Unverified | **PASS — VERIFIED** | Fully autonomous headless engine via Codex CLI. 19,097 tokens in 9.94s, zero focus theft. |
| **Claude Desktop** | Yes | Yes | Yes | **PASS — VERIFIED** | **PASS — VERIFIED** | **PASS — VERIFIED** | **PASS — VERIFIED** | N/A | N/A | **PASS — VERIFIED** | Fully repaired via `bridge-ax-helper`. Electron AX tree correctly handled without CFRange bounds bugs, underscore-safe markdown correlation, and zero focus theft. Thinking mode ("Sonnet 5.5 Medium") requires 60–90s timeout. |
| **Gemini Desktop** | Yes | Yes | Yes | **PASS — VERIFIED** | **PASS — VERIFIED** | **PASS — VERIFIED** | **PASS — VERIFIED** | **PASS — VERIFIED** | **BLOCKED — EXTERNAL LIMITATION** | **PASS — VERIFIED** | Native WebKit app handles background accessibility actions cleanly. Text turn ("MANGO") verified in 18.6s. Image generation produces in-app session artifact (`￼`, Nano Banana), but desktop app sandbox exposes no direct filesystem export route. |
| **Antigravity IDE** | Yes | Yes | Yes | **PASS — VERIFIED** | **PASS — VERIFIED** | **PASS — VERIFIED** | **PASS — VERIFIED** | N/A | N/A | **PASS — VERIFIED** | Primary orchestrator / caller. Fully integrated with MCP tools and HTTP control plane. |
| **Freebuff** | Yes | No | Yes | **PARTIAL — LIMITED ROUTE** | N/A | N/A | N/A | N/A | N/A | **PASS — VERIFIED** | Connected via stdio MCP. Can initiate turns and tools, but cannot receive autonomous inbound tasks without manual user prompting. |

## Live Runtime & Parity Verification

- **Bridge PID:** 48913 (`node src/index.js`) listening on `127.0.0.1:8765`.
- **Endpoints:**
  - `/health` → `200 OK` (`{"status":"healthy","uptime":...}`)
  - `/mcp` → Standard JSON-RPC 2.0 endpoint for MCP tooling.
  - `/api/mcp/call` → Full JSON-RPC parity endpoint with identical tool dispatch and error codes (`-32601`, `-32602`, 400 on malformed, 413 on >5MB).
- **Security:**
  - Identity binding: Connection identities securely resolved from trusted server context; caller-supplied spoofing strictly prevented.
  - Verification tokens: Registered as non-secret test values; sensitive credential access (API keys, SSH keys, passwords) strictly denied and audited.
  - Path security: Protected project (`Zia`) remains strictly read-only and write-fenced; direct writes prohibited without isolated worktrees.
  - Artifact store: OS-level `O_NOFOLLOW` and descriptor `fstat` checks protect against symlinks and TOCTOU races.

## Messaging performance measurement & optimization (2026-10-09)

Reproducible harness: `node scripts/bench/bench-messaging.mjs` (uses a temp SQLite DB,
never the live control plane; spawns a real second process via
`scripts/bench/bench-worker.mjs` for the cross-process case).

Measured on `darwin arm64`, Node `v24.12.0`, after the changes below:

| Path | n | p50 | p95 | max |
| :--- | :--: | :--: | :--: | :--: |
| In-process correlated round trip (`askAgent`) | 200 | 2.02 ms | 3.57 ms | 4.99 ms |
| Cross-process round trip (separate worker process) | 60 | 3.87 ms | 5.93 ms | 6.31 ms |
| `EventBus.publish` throughput | 2000 | — | — | 11.96k events/s (0.084 ms/event) |

- Large response integrity: a 120,004-char response was delivered intact (not truncated; 6.95 ms).
- Timeout + late result: caller timed out while the worker kept running; the
  durable request reached `completed` and re-attached at 0.63 ms — no lost or duplicated result.
- Independent concurrency: 4 agents each with a simulated 30 ms provider turn ran in
42.10 ms wall (≈3.33× parallel speedup); one slow provider does not block the others.

**Conclusion (truthful):** bridge-owned overhead is already sub-3 ms (in-process) and
sub-6 ms (cross-process), well below the 20 ms p95 target. It is *not* the bottleneck for
real agent-to-agent latency. Real latency is dominated by (a) provider accessibility UI
submission/observation and (b) model generation time, which this harness does **not** and
must not fake. A real-provider benchmark is therefore explicitly marked unavailable here.

Changes made (both regression-covered, no test weakened):

1. `EventBus.publish()` and `TransactionalOutbox._stageEventInTransaction()` no longer run a
   second `SELECT last_insert_rowid()` per event; they use `stmt.run().lastInsertRowid`.
2. `EventBus.responseWaiters` is now `requestId -> Set<waiter>`. Previously a second
   `waitForResponse()` for the same request overwrote the first waiter, orphaning it until
   timeout. All waiters for a request now resolve from the same authoritative durable row.

Known remaining latency (not changed, by design — no evidence of bridge fault):

- Claude/Gemini response completion is detected by a 250 ms / 300 ms accessibility poll in the
  Swift helper (`observeResponseFromClaude` / `observeResponseFromGemini`), i.e. a bounded
  ≤300 ms observation tail. Which of `sawGenerating` / stability governs completion cannot be
  measured without a live, opt-in provider turn; no blind interval change was made.

## Phase 2 — token analysis & completion-triggered delivery (2026-10-09)

### MCP tool-schema token analysis

Measured with `node scripts/bench/bench-tool-schema.mjs`:

- 64 tools, **21,397 serialized bytes** (exact). Breakdown: names 1,332; descriptions 4,236; schemas 13,012.
- Token figure is an **estimate only** (no serving-model tokenizer is bundled): ~4,755–5,944
  tokens depending on chars/token ratio. Not an exact provider count.
- The schema is **already minimal**: 172/218 properties are type-only, no `additionalProperties`,
  no empty `required`, no duplicated property descriptions, no duplicated tool descriptions.
- Determination: the bridge always serves all 64 tools from `tools/list` (stdio and HTTP), emits no
  `notifications/tools/list_changed`, and has no per-route filtering. Whether a client re-injects the
  list into model context every turn is client-controlled and cannot be observed from the bridge.
- **Rejected reductions (with reasons):** dynamic/capability-filtered tool exposure (MCP client
  compatibility cannot be verified here; hiding capabilities risks task failure); removing fields or
  tools (no redundancy remains; capability loss not justified); aggressive description shortening
  (no measurable selection evidence without a live model).
- Delivered: `scripts/bench/bench-tool-schema.mjs`, `scripts/bench/tool-selection-corpus.mjs`
  (20 fixed tasks across 10 categories + `scoreSelection`), `tests/tool-schema-integrity.test.js`.
  The LLM tool-selection evaluation harness is ready but **not run** (requires a live model; not simulated).
- A measured reduction was delivered on the autonomous-collaboration prompt: **21,918 → 19,253 chars**
  over 10 turns (**−12.2%**), preserving the objective, every prior turn, and the instruction.

### Completion-triggered event-driven response delivery

- **Before:** the production worker path (`DesktopAgentWorker` → `session.send` →
  `MailboxHub.submitTaskResult`) already persisted + dispatched a completion event transactionally and
  resolved waiters event-driven. The gap was the `DesktopControlPlane` accessibility route: it started
  `ResponseObserver` but **nothing consumed `response_completed`**, so that route never delivered.
- **After:** `DesktopControlPlane extends EventEmitter`, accepts `mailboxHub`, and subscribes to
  `response_completed`; `settleFromCompletion()` persists inside the durable outbox transaction and then
  the same commit dispatches the completion event, resolving every waiter. Idempotent (terminal rows are
  left untouched), correlation-safe (target-app mismatch is refused), and never settles an empty response.
  Observer timeout/failure does **not** overwrite durable state, so a late but valid result is preserved.
  `ResponseObserver` gained an injectable `probe` seam for deterministic tests.
- Lifecycle stages already present and reused: `REQUEST_CREATED → TASK_CLAIMED → PROVIDER_SUBMITTED →
  PROVIDER_RESPONSE_COMPLETED → RESULT_PERSISTED → WAITER_RESOLVED → RESPONSE_RETURNED`.
- Measured with `node scripts/bench/bench-completion-delivery.mjs` (fallback poll set to 60 s to prove
  the path is event-driven, not polling-driven):

| Measurement | p50 | p95 | p99 |
| :--- | :--: | :--: | :--: |
| In-process completion → requester receipt | 0.26 ms | 0.66 ms | 1.56 ms |
| Cross-process completion → requester receipt | 1.71 ms | 2.96 ms | 4.40 ms |
| `RESULT_PERSISTED` → `WAITER_RESOLVED` | 0.38 ms in the latest run (varies by run) | | |

- 4 concurrent independent requests completed in 2.05 ms wall, all correctly correlated.
- **Provider completion DETECTION (accessibility observation) is not measured** — it requires live provider
  turns and is not simulated. The known bounded tail is the Swift helper's 250 ms / 300 ms observation poll.
- **Auto-resumption (stage D) is NOT supported:** a completed MCP tool call returns the result to the
  calling model within that call, but the bridge cannot resume an already-finished model turn. Results are
  delivered through the durable waiting tool call / mailbox. Reported truthfully rather than faked.

### Attempt-lease crash recovery

- `TaskManager.claimNextTask()` now sweeps expired attempt leases before recovering/reassigning expired task leases, so crashed workers do not leave attempts marked active indefinitely.
- `AgentRunner` passes the claimed task's `attemptId` and `epoch` through both its immediate and periodic heartbeats. Task and attempt leases therefore stay aligned while work is running, and fencing metadata is not silently omitted.
- Regression coverage: `tests/attempt-ledger.test.js` verifies that claiming new work expires a stale attempt; the full suite passes.

### Runaway delegation bound

`TaskManager.maxDelegationDepth` (default 24, override via `AGENT_BRIDGE_MAX_DELEGATION_DEPTH`) rejects a
`createTask` whose parent chain exceeds the bound with `DELEGATION_DEPTH_EXCEEDED`. The chain walk is
cycle-safe and bounded. Covered by `tests/delegation-bounds.test.js`.

## Long-term topology

The target topology is peer-to-peer:

```
          ┌───────────────┐
          │  Agent Bridge │
          └───────┬───────┘
          ┌───────┼────────┬────────┐
          ▼       ▼        ▼        ▼
         ZiA    ChatGPT   Claude  Antigravity
          │       │        │        │
          └───────┴────────┴────────┘
                 future peers
```

There is no requirement for a permanent master agent.

The bridge should provide reliable communication, identity, presence, delegation, coordination, security, and recovery. Each agent remains responsible for its own intelligence and authority model.

## Documentation rule

These documents are the current source of truth for the bridge:

- `README.md` — product purpose, capabilities, architecture, roadmap
- `IMPLEMENTATION_STATE.md` — implementation-level handoff

Do not revive obsolete claims from old transcripts, agent reports, or generated notes. If implementation changes, update these documents from the actual code and test results.

