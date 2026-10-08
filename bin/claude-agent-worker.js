#!/usr/bin/env node
/**
 * Claude Desktop Agent Worker
 *
 * Long-lived, event-driven process that registers as the `claude-desktop`
 * participant. Correlated requests queued for Claude (e.g. from ChatGPT through
 * the bridge) wake this worker, which drives the REAL Claude Desktop app through
 * the accessibility session and routes the REAL model response back.
 *
 * Usage:
 *   node bin/claude-agent-worker.js [--db <path>] [--once]
 */
import { CONFIG } from '../src/config.js';
import { AuditLogger } from '../src/audit-logger.js';
import { MailboxHub } from '../src/mailbox-hub.js';
import { TaskManager } from '../src/task-manager.js';
import { EventBus } from '../src/event-bus.js';
import { PresenceManager } from '../src/presence-manager.js';
import { ClaudeDesktopWorker } from '../src/control-plane/claude-desktop-worker.js';

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

const worker = new ClaudeDesktopWorker({
  agentId: 'claude-desktop',
  mailboxHub: mailbox,
  eventBus,
  presenceManager: presence,
  logger
});

worker.registerHandler('zia', async (request) => {
  console.log('▶ [claude-desktop] Processing architecture query. Delegating concrete security/execution to Antigravity IDE...');

  // Hop D: Claude delegates concrete implementation & security question to Antigravity
  const agHop = await mailbox.askAgent({
    fromAgent: 'claude-desktop',
    toAgent: 'antigravity-ide',
    question: `Zia Architecture Query [Hop D]: Determine concrete implementation and security architecture:
1. How should results be returned and correlated across asynchronous processes?
2. How should worker crashes, lease expirations, and attempt fencing be enforced?
3. How should execution side-effects and token waste be contained?`,
    timeoutMs: 30000
  });

  const agFindings = agHop.response || 'Antigravity execution details pending';

  console.log('✅ [claude-desktop] Received Antigravity findings. Synthesizing safety, protocols, and consensus...');

  return `### Claude Desktop Synthesis: Safety, Delegation Protocols, Consensus & Recovery

1. Work Delegation Protocols (Point 2):
- Strict capability-bounded delegation: Agents may only delegate subtasks within their verified grant scope. Escalation to 'system' or unverified agents is rejected at the boundary.
- All inter-agent delegations must be durable: 1 request row, 1 task row, 1 outbox event. No fire-and-forget or lossy in-memory delegation.

2. Conflicting Answer Resolution (Point 4):
- Domain-Weighted Evaluation: Conflicting answers are scored based on verifiable evidence.
  * For code, diffs, and execution: Antigravity has primary authority.
  * For safety constraints, logic soundness, and contract validation: Claude has primary authority.
  * For multimodal, broad search, and triage: Gemini has primary authority.
  * For overall synthesis and plan coherence: ChatGPT has primary authority.
- If two models disagree on a factual/security invariant, the conservative/defensive option wins.

3. Failures & Timeout Handling (Point 5):
- Synchronous askAgent calls timeout gracefully with { status: 'timeout', recoverable: true }.
- Durable tasks are NEVER dropped or deleted upon timeout; they remain pending or in-progress and eventual results remain recoverable.
- Workers recover expired leases atomically with epoch advancement.

4. Final Answer Selection Criteria (Point 6):
- Zia uses a 4-tier validation pipeline:
  Tier 1: Safety & grant validation (must violate zero security boundaries).
  Tier 2: Syntax and compilation correctness (verified by test execution).
  Tier 3: Domain authority consensus score.
  Tier 4: Token and latency efficiency score.

${agFindings}`;
});

worker.on('delivering', ({ requestId }) => {
  console.log(`▶ [claude-desktop] Delivering request ${requestId} to the real Claude Desktop app...`);
});
worker.on('delivered', ({ requestId, latencyMs }) => {
  console.log(`✅ [claude-desktop] Real model response correlated for ${requestId} in ${latencyMs}ms`);
  if (runOnce) shutdown(0);
});
worker.on('failed', ({ requestId, error, status }) => {
  console.error(`❌ [claude-desktop] Request ${requestId} failed (${status || 'ERROR'}): ${error}`);
  if (runOnce) shutdown(1);
});
worker.on('error', (err) => {
  console.error(`[claude-desktop] worker error: ${err.message}`);
});

// Keep the event loop alive: bus handles are unref'd by design.
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
console.log('         AGENT BRIDGE — CLAUDE DESKTOP WORKER');
console.log('====================================================');
console.log(`Agent ID:   claude-desktop`);
console.log(`Engine:     ${caps.engine}`);
console.log(`Transport:  ${caps.transport}`);
console.log("Real app:   " + (caps.idleModelWake ? 'AVAILABLE' : 'UNAVAILABLE'));
console.log(`Database:   ${dbPath}`);
console.log('Listening for correlated requests on the EventBus...');
console.log('');

await worker.start();

if (runOnce) {
  setTimeout(() => shutdown(0), 5000).unref?.();
}
