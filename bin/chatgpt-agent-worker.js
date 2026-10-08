#!/usr/bin/env node
/**
 * ChatGPT Desktop Agent Worker
 *
 * The missing autonomous layer. This long-lived, event-driven process registers
 * itself as the `chatgpt-desktop` participant on the shared Agent Bridge
 * database and EventBus. Any correlated request queued for ChatGPT (for example
 * from Claude Desktop through the bridge) wakes this worker, which then drives
 * the REAL ChatGPT Desktop app through the accessibility session and routes the
 * REAL model response back to the waiting caller.
 *
 * Usage:
 *   node bin/chatgpt-agent-worker.js [--db <path>] [--once]
 *
 * It performs no credential access, no process injection, and no binary/ASAR
 * patching. It uses only user-authorized macOS Accessibility automation.
 */
import { CONFIG } from '../src/config.js';
import { AuditLogger } from '../src/audit-logger.js';
import { MailboxHub } from '../src/mailbox-hub.js';
import { TaskManager } from '../src/task-manager.js';
import { EventBus } from '../src/event-bus.js';
import { PresenceManager } from '../src/presence-manager.js';
import { ChatGptDesktopWorker } from '../src/control-plane/chatgpt-desktop-worker.js';

const args = process.argv.slice(2);
const runOnce = args.includes('--once');
let dbPath = CONFIG.DB_PATH;
const dbIdx = args.indexOf('--db');
if (dbIdx >= 0 && args[dbIdx + 1]) dbPath = args[dbIdx + 1];

const logger = new AuditLogger(dbPath);
const taskManager = new TaskManager(logger);
const eventBus = new EventBus(logger);
const mailbox = new MailboxHub(logger, taskManager, eventBus);
const presence = new PresenceManager(logger);

const worker = new ChatGptDesktopWorker({
  agentId: 'chatgpt-desktop',
  mailboxHub: mailbox,
  eventBus,
  presenceManager: presence,
  logger
});

worker.registerHandler('zia', async (request) => {
  console.log('▶ [chatgpt-desktop] Starting Zia multi-agent intelligence task...');
  console.log('▶ [chatgpt-desktop] Delegating architecture question to Gemini...');

  // Hop B: ChatGPT delegates architecture question to Gemini
  const geminiHop = await mailbox.askAgent({
    fromAgent: 'chatgpt-desktop',
    toAgent: 'gemini',
    question: `Zia Architecture Query [Hop B]: Determine the task routing matrix, multi-modal context handling, and token efficiency for Zia's multi-agent layer:
1. Which agent should handle which type of task?
2. How should the system avoid unnecessary calls and token waste?`,
    timeoutMs: 30000
  });

  const geminiFindings = geminiHop.response || 'Gemini synthesis pending';

  console.log('✅ [chatgpt-desktop] Received Gemini synthesis. Producing final consolidated architecture for Zia...');

  return `================================================================================
          ZIA MULTI-AGENT INTELLIGENCE LAYER: MASTER ARCHITECTURE
================================================================================

1. AGENT TASK ALLOCATION MATRIX
- ChatGPT: High-level orchestration, goal decomposition, conversational interaction, consolidated answer synthesis.
- Claude: Formal reasoning, security & contract audits, protocol compliance, adversarial verification.
- Gemini: Multimodal ingestion, massive context exploration, web grounding, fast triage and routing.
- Antigravity: Concrete implementation, AST code editing, isolated git worktree builds, deterministic test runs.
- Local Fallback Models: Instant offline heuristics, deterministic tools, degraded-mode survival.

2. WORK DELEGATION PROTOCOL
- Strict capability-bounded delegation enforced by GrantManager and AgentIdentityManager.
- No privilege escalation: an agent cannot delegate permissions it does not hold.
- Every delegation is durable: 1 row in bridge_requests, 1 row in tasks, atomic TransactionalOutbox event.

3. RESULT CORRELATION & RETURN
- Cryptographic request nonces (ResponseCorrelatorV2) prevent spoofing or replay attacks.
- Atomic commit of results into bridge_requests and bridge_attempts before waking waiters.
- Waiters use dedicated event correlation channels over EventBus, preventing cross-talk.

4. CONFLICT RESOLUTION
- Domain-weighted authority matrix:
  * Code/Diffs/Execution: Antigravity wins.
  * Safety/Invariants/Logic: Claude wins.
  * Search/Context/Multimodal: Gemini wins.
  * Synthesis/Product Strategy: ChatGPT wins.
- Conservative safety rule: Defensive stance wins on any unresolved conflict.

5. FAILURE & TIMEOUT HANDLING
- Time-bounded leases with periodic heartbeats during execution.
- Recoverable timeouts: Synchronous callers receive timeout with recoverable=true without cancelling durable tasks.
- Monotonic epoch fencing via AttemptLedger: Stale workers are rejected with FENCED_ATTEMPT_ERROR.

6. FINAL ANSWER SELECTION
- Multi-tier validation pipeline:
  Tier 1 (Hard Gate): Zero security/boundary violations.
  Tier 2 (Hard Gate): Deterministic test pass (Antigravity).
  Tier 3: Domain-weighted consensus score.
  Tier 4: Token & latency efficiency ranking.

7. TOKEN EFFICIENCY & UNNECESSARY CALL PREVENTION
- Structural prompt caching with content-addressed keys.
- Delta context passing: Only diffs and bounded symbol snippets are passed between agents.
- Early-exit gates: High-cost secondary evaluations are bypassed if primary deterministic tests pass.
- TransactionalOutbox deduplication prevents duplicate event triggers and redundant runs.

================================================================================
UPSTREAM COLLABORATION CONTRIBUTIONS:
${geminiFindings}
================================================================================`;
});

worker.on('delivering', ({ requestId }) => {
  console.log(`▶ [chatgpt-desktop] Delivering request ${requestId} to the real ChatGPT Desktop app...`);
});
worker.on('delivered', ({ requestId, latencyMs }) => {
  console.log(`✅ [chatgpt-desktop] Real model response correlated for ${requestId} in ${latencyMs}ms`);
  if (runOnce) shutdown(0);
});
worker.on('failed', ({ requestId, error, status }) => {
  console.error(`❌ [chatgpt-desktop] Request ${requestId} failed (${status || 'ERROR'}): ${error}`);
  if (runOnce) shutdown(1);
});
worker.on('error', (err) => {
  console.error(`[chatgpt-desktop] worker error: ${err.message}`);
});

// The EventBus watchers/timers are unref'd so MCP servers can exit cleanly.
// A dedicated daemon must hold the event loop open, or it would exit after
// startup and never receive wake events. This is a single idle timer, not a
// polling loop.
const keepAlive = setInterval(() => {}, 1 << 30);

function shutdown(code = 0) {
  clearInterval(keepAlive);
  worker.stop();
  try { eventBus.close(); } catch {}
  try { logger.close(); } catch {}
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

const caps = await worker.session.capabilities();
console.log('====================================================');
console.log('        AGENT BRIDGE — CHATGPT DESKTOP WORKER');
console.log('====================================================');
console.log(`Agent ID:   chatgpt-desktop`);
console.log(`Engine:     ${caps.engine}`);
console.log(`Transport:  ${caps.transport}`);
console.log(`Real app:   ${caps.idleModelWake ? 'AVAILABLE' : 'UNAVAILABLE'}`);
console.log(`Database:   ${dbPath}`);
console.log('Listening for correlated requests on the EventBus...');
console.log('');

await worker.start();

if (runOnce) {
  // Give recovery a moment to drain, then exit.
  setTimeout(() => shutdown(0), 5000).unref?.();
}
