# Agent Bridge — Current Implementation State

**Refreshed:** 2026-10-09  
**Repository:** `/Users/jayanthpranaykonada/agent-bridge`  
**HEAD:** `cc45b9696c4aaa3217ca378cd43c0279b5b77223` (with verified AX helper and provider repairs)  
**Branch:** `main`  
**Tree:** clean on `main`. Zero uncommitted regressions. Zia untouched.  
**Live Control Plane:** Bound to `127.0.0.1:8765` (PID 48913). Both `/mcp` and `/api/mcp/call` active in full parity.

This is the authoritative implementation handoff for Agent Bridge. It supersedes older notes and reflects the ground-truth state verified against live processes and providers.

## Verification

Full regression suite (`node --test --test-concurrency=1 tests/*.test.js`):

- tests: **563**
- pass: **555**
- fail: **0**
- skipped: **8** (explicitly live-gated: live model quota/credentials requiring explicit opt-in)
- duration: **18.88s**
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

