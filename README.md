# Agent Bridge

Agent Bridge is a local communication and execution fabric for independent AI agents running on the same Mac.

Its purpose is not to become another chatbot. It provides a shared, authenticated substrate through which agents such as ZiA, ChatGPT Desktop, Claude Desktop, Antigravity, and future workers can discover one another, exchange requests/results, coordinate work, access authorized project files, and use controlled execution capabilities.

## Current repository state

- Repository: `/Users/jayanthpranaykonada/agent-bridge`
- Branch: `main`
- HEAD at this documentation refresh: `be75a5d`
- Working tree: contains the delivery-reliability and binary-artifact changes from the current session (not yet committed)
- Node test suite: **551 tests**
- **543 passed**
- **8 intentionally skipped**
- **0 failed**
- Skips are explicit live-model/live-desktop checks that require external quota or physical desktop conditions.

## Current architecture

```
AI agent
  │
  ├─ MCP stdio
  │
  └─ local HTTP control plane
          │
          ▼
     Agent Bridge
          │
   ┌──────┼─────────────────────┐
   │      │          │           │
 identity presence  tasks    collaboration
   │      │          │           │
   ├──────┼──────────┼───────────┤
   │      │          │           │
 files  commands    git   mailbox/events/artifacts
   │      │          │           │
   └──────┴──────────┴───────────┘
          │
          ▼
 desktop/control-plane adapters
          │
   ChatGPT / Claude / Antigravity / ZiA
```

The MCP and HTTP surfaces use the same ToolRegistry, so there is one tool definition and execution path instead of transport-specific behavior.

## Current capabilities

### Agent identity and presence

The bridge tracks:

- bound agent identity
- live heartbeat
- transport
- state
- current task
- capabilities
- health

Identity binding is authoritative. A caller cannot simply supply another agent ID to impersonate it.

### Event-driven communication

Agents can:

- send requests
- receive correlated responses
- delegate tasks
- claim/complete tasks
- query request status
- inspect pending requests
- exchange peer messages
- communicate across processes
- queue work for offline recipients
- recover persisted request/results after reconnect

The current tests prove autonomous wake/response behavior and multi-process event exchange.

#### Correlated result delivery (race-safe)

The correlated waiter is now **registered before** the authoritative database
check, closing the window in which a result committed after an initial check but
before registration lost its live wakeup. Notifications are treated as an
accelerator only: the durable `bridge_requests` row is always authoritative, so a
stale, duplicate, or out-of-order event can never deliver a wrong status or a
truncated snippet instead of the full response. A caller timeout never erases the
durable task or its later result.

A `RequestTracer` records correlated lifecycle stages (request created, task
created, worker awakened, task claimed, provider submitted/observed, result
persisted, completion committed, waiter resolved, response returned) with both
wall-clock and monotonic timestamps, without ever logging prompt or response
bodies.

#### Binary artifacts (real bytes)

`ArtifactStore` provides a durable, integrity-checked transport for real binary
artifacts (PNG/JPEG/GIF/WEBP/MP4/MOV). Task results carry only compact artifact
metadata plus a retrieval reference; actual bytes flow through an authorized
`bridge_artifact_read` call. Every write and read is SHA-256 verified, size
limited, MIME-checked against content magic bytes, path-containment checked, and
refuses symlinked storage. See `src/artifacts/artifact-store.js`.

### Collaboration

The bridge provides durable collaboration boards with:

- owner
- objective
- members
- roles
- capabilities
- presence
- heartbeat
- event history
- close semantics

### Project and filesystem control

Authorized agents can:

- inspect projects
- read files
- create files
- edit files with optimistic hash protection
- batch read/write/stat
- search files
- inspect symbols/context
- execute approved commands
- perform structured Git operations

File activity is tracked so concurrent agents can see active work.

### Security boundary

The bridge enforces:

- allowed roots
- symlink/traversal protection
- credential-path denylist
- command executable allowlist
- command injection/chaining protection
- command argument path checks
- agent identity binding
- HTTP authentication when configured
- dedicated ChatGPT brain endpoint protection
- audit logging
- protected Git branch policy

Current local configuration deliberately allows owner-authorized mutation of the user's home directory while denying credential locations. ZiA is not globally write-locked in the current configuration.

Do not weaken these controls merely to make an agent workflow convenient.

## ChatGPT Desktop integration

The bridge currently supports two broad ChatGPT execution routes:

1. **Headless engine**
   - bundled/local Codex engine when installed and healthy
   - preferred by automatic transport resolution
   - no visible ChatGPT UI interaction is required for the engine path

2. **Desktop/UI route**
   - Accessibility/native desktop control
   - used as a fallback when the headless engine is unavailable
   - background mode is designed not to activate ChatGPT unnecessarily

The transport decision is reported to the caller and failures are surfaced rather than represented as successful model turns.

The dedicated ChatGPT brain HTTP endpoints are stricter than the general local control plane:

- loopback clients only
- browser Origin rejected
- loopback Host required
- mandatory API key
- fail closed when no key is configured

## Claude and other desktop agents

Claude Desktop has a parallel autonomous-session/worker path.

The session adapter layer allows agent-specific desktop transports to share the same generic request/task contract.

The bridge also contains adapters for:

- Antigravity
- ChatGPT Desktop
- Claude Desktop
- generic desktop/UI routes
- CDP/browser routes where explicitly enabled

## Media capability (honest status)

The bridge now transports real binary bytes, but the **desktop providers still do
not expose a route to raw bytes**. The shipped macOS Accessibility helper has no
screenshot/image/export operation, and the ChatGPT Desktop, Claude Desktop, and
Gemini Desktop sessions return correlated **text** only. Therefore: images or
videos that a provider renders in its own UI cannot yet be exported through the
current route. The artifact store only accepts bytes a caller actually supplies;
it never fabricates bytes from a filename or a UI element id.

## Transports

Current transport surfaces include:

- MCP stdio
- local HTTP control plane on loopback
- plugin-facing MCP surfaces
- session adapters
- desktop/control-plane adapters
- secure tunnel integration where configured

The architecture keeps transport separate from the logical agent/task protocol.

## Data model

SQLite is the local durable coordination store.

It backs areas such as:

- audit log
- tasks
- mailbox/events
- agent presence
- collaborations
- file activity
- persistent sessions

The system has explicit multi-process acceptance coverage to protect against SQLite contention and cross-process event loss.

## Operational defaults

The current configuration intentionally favors safety:

- HTTP control plane binds to `127.0.0.1`
- desktop automation is opt-in
- focus-on-send is disabled
- ambiguous desktop targets are rejected
- protected Git branches cannot be autonomously pushed by default
- dangerous shell patterns are blocked
- credential paths remain forbidden
- command argument paths are checked against the same filesystem policy

## What is proven vs what still needs physical validation

Proven by the automated suite:

- MCP handshake
- HTTP stack
- authentication
- tool registry consistency
- filesystem sandboxing
- command safety
- multi-agent messaging
- multi-process event bus
- task lifecycle/delegation
- collaboration
- identity binding
- ChatGPT/Claude adapter logic
- headless engine lifecycle/cancellation
- no-activation background invariants in the relevant test seams
- structured Git operations

Still environment-dependent:

- every real ChatGPT/Codex live-model turn
- every real Claude live-model turn
- physical multi-Space fullscreen behavior on the user's exact desktop arrangement
- hardware/accessibility permissions on every macOS configuration
- long-running real-world agent sessions under sustained load

Skipped tests are intentionally labeled rather than converted into false passes.

## Future direction

The target is a true peer-to-peer local agent fabric:

### 1. Persistent peer network

Agents should remain discoverable while they are alive, recover state after reconnect, and exchange work without requiring a human to relay messages.

### 2. Autonomous collaboration

Agents should be able to form a collaboration around an objective, invite capable peers, divide work, exchange evidence, review each other's results, and close the collaboration.

There should be no permanent "master agent" requirement.

### 3. Background operation

Agents should be able to run on different macOS Spaces or in minimized/background states without stealing the user's focus.

Where native/background transport exists, it should always be preferred over visible UI automation.

### 4. Intelligent delegation

The bridge should evolve from raw messaging into capability-aware delegation:

```
objective
  ↓
discover capable peers
  ↓
delegate bounded work
  ↓
parallel execution
  ↓
evidence/results
  ↓
peer review
  ↓
merged outcome
```

The bridge should coordinate communication, not decide the product's intelligence policy. ZiA remains the owner of its own canonical cognition and task state.

### 5. Reliability

Continue strengthening:

- offline queues
- reconnect recovery
- idempotent delivery
- cancellation
- leases
- crash recovery
- cross-process event ordering
- observability
- backpressure

### 6. Security

Future features must preserve the same principles:

- authenticated identity
- least privilege
- explicit capability boundaries
- sandboxed filesystem access
- safe command execution
- auditability
- no credential exfiltration
- no silent privilege escalation

## Relationship to ZiA

Agent Bridge is infrastructure.

ZiA is the persistent personal intelligence that consumes that infrastructure.

The intended relationship is:

```
ZiA
  ├─ owns identity/state/memory/task authority
  ├─ chooses what intelligence it needs
  │
  └─ uses Agent Bridge
       ├─ to reach ChatGPT Desktop
       ├─ to communicate with peer agents
       ├─ to inspect/mutate authorized projects
       └─ to coordinate external workers
```

Do not move ZiA's canonical state into the bridge merely because the bridge can transport it.

## Development rule

When changing Agent Bridge:

1. inspect the real implementation first
2. preserve identity/security boundaries
3. add deterministic tests for new behavior
4. distinguish mocked, live, and physical verification
5. update this README and `IMPLEMENTATION_STATE.md`
6. do not claim skipped/live-gated tests as passed
7. do not push unrelated generated artifacts
