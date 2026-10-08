# Agent Bridge — Current Implementation State

**Refreshed:** 2026-10-08  
**Repository:** `/Users/jayanthpranaykonada/agent-bridge`  
**HEAD:** `2366dbe`  
**Branch:** `main`  
**Tree:** clean

This is the implementation handoff for the current bridge. It supersedes older notes and should be updated whenever architecture changes.

## Verification

Current `npm test` result:

- tests: **372**
- pass: **364**
- fail: **0**
- skipped: **8**

The skipped tests are explicitly live-gated:

- live ChatGPT model quota
- live Claude/model quota
- live desktop workers
- physical/live desktop smoke paths

They are not failures and are not evidence of live model availability.

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

## Messaging

### EventBus

The EventBus is the internal event path.

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
