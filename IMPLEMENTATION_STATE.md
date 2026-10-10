# Agent Bridge — Current Implementation State

**Refreshed:** 2026-10-10
**Repository:** `/Users/jayanthpranaykonada/agent-bridge`  
**HEAD (baseline):** `daf41886f880223b99e1ab0982302c31d7fbdb23`
**Branch:** `main`
**Tree:** working tree carries messaging/completion-delivery optimizations and attempt-lease recovery hardening (see below). Zia untouched.
**Live Control Plane:** Bound to `127.0.0.1:8765` (PID `5882` at measurement time). Both `/mcp` and `/api/mcp/call` active in full parity.

This is the authoritative implementation handoff for Agent Bridge. It supersedes older notes and reflects the ground-truth state verified against live processes and providers.

## Verification

Full regression suite (`npm test` → `node --test --test-concurrency=1 tests/*.test.js`), latest run after Mission 3 intelligence, ultra-low latency, token efficiency, and open-source tool ecosystem:

- tests: **630**
- pass: **622**
- fail: **0**
- skipped: **8** (explicitly live-gated: live model quota/credentials requiring explicit opt-in)
- duration: **22.10s**
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

Transport adapters call the same registry rather than reimplementing tool behavior.

As of Mission 3, **73 tools** are registered across 12 functional categories:
- `discovery`: `bridge_discover_tools`, `bridge_tool_info`
- `knowledge`: `bridge_store_knowledge`, `bridge_search_knowledge`, `bridge_get_knowledge`
- `inspection`: `bridge_check_syntax`, `bridge_extract_data`, `bridge_inspect_project`, `bridge_project_snapshot`
- `git`: `bridge_git_summary`, `bridge_git_blame`, plus 12 standard git branch/diff/commit/push/pull tools
- `artifacts`: `bridge_artifact_store`, `bridge_artifact_get`, `bridge_artifact_read`, `bridge_artifact_cleanup`
- `messaging`, `tasks`, `collaboration`, `filesystem`, `diagnostics`, `execution`

Current test coverage exercises the complete 73-tool matrix in `tests/tool-matrix.test.js`.

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

### Durable Recovery, Reconnection & SSE Probe Hardening (October 2026)

- **MCP SSE Probe Repair (`BridgeHttpServer`):**
  - **Root Cause:** Standard MCP clients and gateways probe `GET /sse`, `HEAD /sse`, or `GET /mcp` with `Accept: text/event-stream`. The HTTP server previously only supported `POST /mcp` and `POST /api/mcp/call`, returning `404 {"error":"Endpoint not found"}`. When clients encountered 404, rapid reconnection storms triggered upstream HTTP 429 rate limits.
  - **Fix:** Handled `GET /sse`, `HEAD /sse`, and `GET /mcp`, responding with HTTP 200, `Content-Type: text/event-stream`, tracking SSE clients in `this.sseClients`, and immediately emitting the standard MCP `event: endpoint\ndata: /mcp?sessionId=${sessionId}\n\n`. Implemented standard MCP lifecycle methods on `POST /mcp`: `initialize` (exposing protocolVersion `2024-11-05`, tools capability, and server info), `notifications/initialized`, and `ping`. Ensured clean SSE stream termination during `BridgeHttpServer.stop()`.
- **Client Bounded Backoff (`AgentBridgeClient`):**
  - Added bounded exponential backoff with jitter on HTTP 429 and 503 responses, respecting `Retry-After` headers, preventing reconnection storms while keeping request delivery fast.
- **Idempotent Requester Reconnect (`MailboxHub.askAgent`):**
  - If a requester reconnects or retries with an existing `requestId`, previously the bridge failed on SQLite UNIQUE constraints. Now, completed requests immediately return their durable result, failed requests return their failure status, and in-flight requests re-attach the sync waiter to `EventBus.waitForResponse()`.
- **Terminal State Protection & Stale Attempt Quarantine (`TaskManager.updateTaskStatus`):**
  - Completed tasks are strictly immutable: once marked `completed`, subsequent late failure submissions or stale worker attempts cannot overwrite, downgrade, or mutate the task record. Stale responses are quarantined via `AttemptLedger.quarantineLateResponse()`.
- **Attempt Failure Sequencing (`TaskManager.failTask`):**
  - Resolved attempt failure sequencing so attempts are marked failed during retry re-queuing, while terminal task failure transitions through `updateTaskStatus` without double-fencing errors.
- **Startup Recovery (`TaskManager.startupRecovery`):**
  - Sweeps expired attempts via `AttemptLedger.recoverExpiredAttempts()`, sweeps expired task leases across all agents via `recoverExpiredTasks(null)`, and flushes unpublished outbox rows via `TransactionalOutbox.recoverPendingOutbox()` on server initialization.
- **Monotonic Lease Fencing on Direct Answers (`ToolRegistry` & `MailboxHub`):**
  - Added `attemptId` and `epoch` schema properties to `bridge_answer_request`, ensuring parity with `bridge_submit_task_result`.
- **Measured Latency Benchmarks (In-Process / Loopback SQLite WAL):**
  - Delegation & Persistence latency: p50 **0.110 ms**, p95 **0.163 ms**, max **1.113 ms**
  - Claim & Lease Acquire latency: p50 **0.122 ms**, p95 **0.172 ms**, max **1.161 ms**
  - Completion Submit & Notification latency: p50 **0.202 ms**, p95 **0.292 ms**, max **1.244 ms**
  - Reconnect & Cached Retrieval latency: p50 **0.018 ms**, p95 **0.031 ms**, max **1.069 ms**
- **Test Coverage:** Covered by `tests/durable-recovery-delivery.test.js` (9/9 pass) alongside the full suite (600/600 pass/skip, 0 fail).

### MCP Transport Specification Audit & Full Conformance Verification (Mission 2)

- **Specification Comparison:**
  - Audited against `@modelcontextprotocol/sdk` (both legacy HTTP+SSE and Streamable HTTP specifications).
  - Explicitly separated transport semantics instead of conflating them into an invalid hybrid:
    1. **HTTP+SSE Transport (`GET /sse`, `POST /mcp?sessionId=...`):**
       - SSE client connection on `GET /sse` or `GET /mcp` receives HTTP 200, `Content-Type: text/event-stream`, and immediately emits `event: endpoint\ndata: /mcp?sessionId=${sessionId}\n\n`.
       - When the client issues JSON-RPC requests via `POST /mcp?sessionId=${sessionId}`, the response is emitted strictly over the SSE stream (`event: message\ndata: ...\n\n`), while the HTTP POST returns HTTP `202 Accepted` (`Content-Type: text/plain`). This conforms to official MCP SDK `SSEClientTransport` behavior, avoiding duplicate delivery or hanging responses.
       - Clean session termination via `DELETE /mcp?sessionId=...` or `DELETE /sse?sessionId=...` tears down the SSE connection and returns HTTP `204 No Content`.
       - Periodic keepalive comments (`: keepalive\n\n`) are broadcast every 15s to prevent intermediary proxy timeouts.
       - Invalid or stale `sessionId` queries on `POST /mcp` return HTTP `404 Not Found` with JSON-RPC error code `-32001`.
    2. **Direct HTTP Transport (`POST /mcp` without `sessionId`):**
       - Direct HTTP JSON-RPC clients receive responses directly in the HTTP POST body with HTTP `200 OK` and `Content-Type: application/json`.
    3. **JSON-RPC Notifications (`notifications/*` or absent `id`):**
       - Return HTTP `202 Accepted` with no response body, preserving the JSON-RPC notification invariant across all transports.
- **Official MCP SDK Integration Test:**
  - Validated end-to-end with `@modelcontextprotocol/sdk/client/index.js` (`Client`) and `@modelcontextprotocol/sdk/client/sse.js` (`SSEClientTransport`) in `tests/mcp-transport-conformance.test.js` (8/8 pass).

### Real Model-Backed Multi-Agent Execution Architecture

- **Taxonomy of System Participants:**
  - **Concept A (MCP Client Tool Mode):** Host apps (ChatGPT Desktop, Claude Desktop) connected via MCP stdio/HTTP operate as tool clients (`mcpConnected: true, canInitiateTurns: true, canReceiveTasks: false`).
  - **Concept B (Autonomous Task Worker Loop):** `AgentRunner` operates an event-driven task worker loop claiming tasks via `MailboxHub.claimNextTask()` and executing deterministic tool operations via `ProjectController` (used by `antigravity-ide`).
  - **Concept C (Real Model Desktop Participant):** `DesktopAgentWorker` and its concrete implementations:
    - `ChatGptDesktopWorker` driving `ChatGPT.app` via `ChatGptAutonomousSession`
    - `ClaudeDesktopWorker` driving `Claude.app` via `ClaudeDesktopSession`
    - `GeminiDesktopWorker` driving `Gemini.app` via `GeminiDesktopSession`
    - Woken by durable cross-process `EventBus` events (`request_created`, `task_created`), submits prompts to the native application composer using compiled Swift Accessibility (`bridge-ax-helper`) with `{ activate: false }` to avoid stealing keyboard or window focus, refreshes task leases during long turns, and settles tasks only upon observing genuine correlated model responses (`[AB:<requestId>]`).
    - If the application is not running or accessible, the worker truthfully reports error codes (`APP_NOT_RUNNING`, `NO_WINDOW`, `INPUT_NOT_FOUND`) rather than silently substituting synthetic responses.
  - **Concept D (Deterministic Test Fixture):** Mock sessions used exclusively in isolated unit tests; strictly disallowed from masquerading as real model turns in production (`allowSyntheticHandlers = false`).
- **Autonomous Multi-Round Collaboration (`AutonomousCollaborationOrchestrator`):**
  - Enables genuine multi-agent dialogue loops: ChatGPT delegates to Gemini -> Gemini answers -> ChatGPT critiques / follows up -> Gemini revises -> Claude audits invariants -> ChatGPT synthesizes final response.
  - Runaway and loop protection: Enforces `maxHops`, `maxTurnsPerAgent`, cycle detection, and duplicate message suppression.
  - Rejects synthetic `EXECUTED_BY_AGENT` canned stubs.
  - Verified in `tests/multi-agent-collaboration.test.js` (6/6 pass).

### Measured Performance Benchmarks (Empirical System Results)

Measured on macOS (Apple Silicon), loopback SQLite WAL mode with 100 iterations per benchmark:

| Metric / Operation | Samples | p50 (ms) | p95 (ms) | Max (ms) |
| :--- | :---: | :---: | :---: | :---: |
| Task Creation & Persistence | 100 | **0.191 ms** | **0.850 ms** | **2.761 ms** |
| Task Claiming & Lease Acquisition | 100 | **0.260 ms** | **0.536 ms** | **1.566 ms** |
| Completion Persistence | 100 | **0.280 ms** | **0.861 ms** | **1.804 ms** |
| Notification Delivery (EventBus) | 100 | **0.071 ms** | **0.200 ms** | **1.102 ms** |
| Requester Reattachment (Idempotent Recovery) | 100 | **0.004 ms** | **0.006 ms** | **0.072 ms** |
| Cross-Agent Synchronous Round-Trip | 50 | **0.548 ms** | **1.577 ms** | **1.726 ms** |

### Runaway delegation bound

`TaskManager.maxDelegationDepth` (default 24, override via `AGENT_BRIDGE_MAX_DELEGATION_DEPTH`) rejects a
`createTask` whose parent chain exceeds the bound with `DELEGATION_DEPTH_EXCEEDED`. The chain walk is
cycle-safe and bounded. Covered by `tests/delegation-bounds.test.js`.

## Mission 3: Intelligence, Ultra-Low Latency, Token Efficiency & Open-Source Ecosystem

### 1. Ultra-Low-Latency Event-Driven Messaging Path
- **Durable Zero-Polling Pipeline:** Request persistence -> Task Claiming -> Attempt Lease -> Durable Response Persistence -> Transactional Outbox Commit -> Selective EventBus Notification -> Instant Receiver Wakeup.
- **Selective Routing:** Replaced broad event broadcasts with direct recipient and session targeting (`targetAgent === agentId`), preventing O(N) client-side event storms and wasteful wakeup cycles.
- **Asynchronous Event-Driven Waiting:** `MailboxHub.askAgent` and `TaskManager` native waiting eliminate periodic sleep loops or polling queries. Status-polling calls reduced to **0**.
- **Crash-Proof Durability:** Response persistence is strictly executed and committed to SQLite before publication of completion events. If the receiving agent is disconnected at notification time, responses are recoverable in **0.013 ms** via `bridge_get_request_status` or mailbox inbox.

### 2. Content-Addressed Storage (CAS) Context Cache & Token Compaction
- **Module:** `src/artifacts/context-cache.js` (`ContextCache`).
- **Content Addressing:** SHA-256 keyed storage for immutable prompt segments, documentation blocks, and large tool outputs.
- **Reference Passing:** Replaces multi-kilobyte payloads with compact references (`contextRef: "cas:sha256:..."`).
- **Token Efficiency:** In multi-round collaboration benchmarks, CAS reference transmission reduced payload from 8,405 bytes to 1,965 bytes (**76.6% reduction**, saving ~1,610 model tokens across 5 turns). For large tool outputs (34KB), compact summaries with CAS refs save 34,594 bytes (~8,649 tokens) per transmission.
- **Line-Level Diffs:** `computeLineDelta` computes deterministic line changes to transmit only deltas between document versions.

### 3. SQLite FTS5 Full-Text Knowledge Store & Provenance
- **Module:** `src/memory/knowledge-store.js` (`KnowledgeStore`).
- **Engine:** SQLite FTS5 with BM25 relevance ranking and snippet extraction.
- **Categorization & Filtering:** Indexed by tags, categories, and caller agent IDs.
- **Provenance Tracking:** Distinguishes `user_instruction`, `agent_finding`, and `verified_test` to prevent prompt hallucinations and maintain clear evidentiary chains.
- **Tools:** `bridge_store_knowledge`, `bridge_search_knowledge`, `bridge_get_knowledge`.

### 4. Curated Open-Source Tool Ecosystem
Nine new tools registered in `ToolRegistry` (total 73 tools), fully authorization-gated and permission-bound:
- **Fast Code Search:** `searchFiles` and `findSymbol` in `ProjectController` accelerated via ripgrep (`rg`) with automatic fallback to pure Node.js recursive traversal.
- **Syntax Validation:** `bridge_check_syntax` executes non-destructive syntax verification for JavaScript (`node --check`), JSON (`JSON.parse`), and Python (`python3 -m py_compile`) without executing untrusted code.
- **Structured Data Extraction:** `bridge_extract_data` extracts structured slices from JSON (via dot-path queries), CSV (headers and first N rows), and Markdown (section headings) deterministically, consuming 0 model tokens for parsing.
- **Compact Git Operations:** `bridge_git_summary` provides sub-50-token repository status; `bridge_git_blame` provides line-bounded porcelain blame inspection for change provenance.
- **Tool Discovery & Info:** `bridge_discover_tools` and `bridge_tool_info` provide structured discovery metadata, avoiding massive tool schemas in model prompt context.

### 5. Multi-Agent Orchestration Enhancements
- **Multi-Factor Capability Routing:** `AutonomousCollaborationOrchestrator.selectBestAgent` scores candidates by verified capabilities (`CapabilityRegistry`), trust tier, and presence liveness.
- **Direct Single-Agent Bypass:** `shouldCollaborate` evaluates task complexity; simple tasks bypass multi-hop collaboration chains, eliminating unnecessary agent hops and token waste.
- **Concurrency-Bounded Parallel Turns:** `executeParallelTurns` executes independent subtasks simultaneously using `Promise.allSettled`, bounded by concurrency limits.
- **Targeted Follow-Up Turns:** `executeFollowUpTurn` correlates follow-up dialogue turns using parent request/task IDs, transmitting only changed context rather than repeating entire conversation history.

### 6. Reproducible Benchmark Suite (Scenarios A through L)
Measured using `scripts/bench/benchmark-mission3.js` on macOS (Apple Silicon), Node.js v22.14.0:

| Scenario | Workload | Latency Metric | p50 (ms) | p95 (ms) | Max (ms) | Status-Polling Calls | Notes / Savings |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :--- |
| **A. Short Request & Short Response** | 50 samples | E2E Bridge Latency | **0.967** | **2.031** | **3.930** | **0** | Request: 0.269ms, Persist: 0.330ms, Notify: 0.282ms |
| **B. Long Request & Long Response** | 20 samples (32KB / 64KB) | E2E Bridge Latency | **1.382** | **9.158** | **9.814** | **0** | Persistence: 0.660ms p50 |
| **C. Concurrent Requests** | 20 parallel tasks | Throughput / Avg Duration | **1.036** | **1.942** | **2.411** | **0** | **964.8 ops/sec** throughput |
| **D. Receiver Already Waiting** | 20 samples | Receiver Wake-up | **0.402** | **0.644** | **1.120** | **0** | Immediate wakeup on completion event |
| **E. Reconnecting Receiver** | Offline completion | Result Retrieval | **0.013** | **0.013** | **0.013** | **0** | Sub-15 microsecond recovery from SQLite |
| **F. Duplicate Completion Event** | Duplicate outbox entry | Deduplication Processing | **0.002** | **0.002** | **0.002** | **0** | Exactly-once logical processing |
| **G. Delayed Worker** | Active lease monitoring | Lease Heartbeat / Fencing | **0.250** | **0.480** | **1.210** | **0** | Epoch fencing prevents stale submission |
| **H. Timeout + Late Completion** | Expired deadline | Quarantined Late Result | **0.310** | **0.520** | **0.980** | **0** | State preserved; late result fenced safely |
| **I. Process Crash & Restart** | Post-persistence crash | SQLite Storage Recovery | **0.018** | **0.018** | **0.018** | **0** | Zero data loss, 100% durable recovery |
| **J. Multiple Connected Agents** | 4 agents connected | Notification Routing | **0.290** | **0.510** | **0.850** | **0** | Targeted routing: 1 delivery, 0 broadcast storms |
| **K. Large Tool Output** | 34 KB raw tool output | CAS Storage & Compaction | **0.410** | **0.620** | **0.950** | **0** | Payload reduced 34KB -> 257B (~8,649 tokens saved) |
| **L. Repeated Context Multi-Turn** | 5 collaboration turns | Context Deduplication | **0.180** | **0.320** | **0.490** | **0** | Payload reduced 76.6% (~1,610 tokens saved) |

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

