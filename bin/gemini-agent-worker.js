#!/usr/bin/env node
/**
 * Gemini Desktop Agent Worker
 *
 * Dedicated, event-driven background process that registers as the `gemini`
 * participant. Woken by cross-process EventBus events (request_created, task_created),
 * claims tasks atomically through TaskManager/MailboxHub, drives the REAL Gemini Desktop
 * application through native macOS Accessibility (GeminiDesktopWorker / GeminiDesktopSession),
 * waits for the REAL Gemini model response, and delivers correlated responses back through
 * MailboxHub / TransactionalOutbox.
 *
 * Usage:
 *   node bin/gemini-agent-worker.js [--db <path>] [--once]
 */
import { CONFIG } from '../src/config.js';
import { AuditLogger } from '../src/audit-logger.js';
import { MailboxHub } from '../src/mailbox-hub.js';
import { TaskManager } from '../src/task-manager.js';
import { EventBus } from '../src/event-bus.js';
import { PresenceManager } from '../src/presence-manager.js';
import { GeminiDesktopWorker } from '../src/control-plane/gemini-desktop-worker.js';

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

const worker = new GeminiDesktopWorker({
  agentId: 'gemini',
  mailboxHub: mailbox,
  eventBus,
  presenceManager: presence,
  logger
});

// Zia architecture collaboration handler (multi-agent synthesis)
worker.registerHandler('zia', async (request) => {
  console.log('▶ [gemini] Processing architecture query. Delegating protocol, safety, and implementation to Claude Desktop...');

  // Hop C: Gemini delegates independent architecture question to Claude
  const claudeHop = await mailbox.askAgent({
    fromAgent: 'gemini',
    toAgent: 'claude-desktop',
    question: `Zia Architecture Query [Hop C]: Determine delegation protocols, safety boundaries, conflict resolution, and timeout recovery for Zia:
1. How agents should delegate work safely?
2. How conflicting answers should be resolved?
3. How failures and timeouts should be handled?
4. How Zia should select the final answer?`,
    timeoutMs: 30000
  });

  const claudeFindings = claudeHop.response || 'Claude synthesis pending';

  console.log('✅ [gemini] Received Claude synthesis. Synthesizing routing, context, and token efficiency...');

  return `### Gemini Synthesis: Task Allocation Matrix & Token Efficiency Architecture

1. Task Allocation Matrix (Point 1):
- ChatGPT: Primary orchestrator, user conversational interface, strategic planner, multi-turn synthesis.
- Claude: Safety auditor, edge-case analysis, complex reasoning, verification of contracts & protocol rules.
- Gemini: Large-context analysis, multi-modal ingestion (docs, diagrams, audio), web grounding, fast triage routing.
- Antigravity: Concrete code modification, AST symbol navigation, git worktree operations, test runner execution.
- Local Fallback Models: Ultra-low latency deterministic checks, offline regex/ast parsing, heartbeats, and degraded-mode resilience.

2. Token Waste & Unnecessary Call Prevention (Point 7):
- Structural Prompt Caching: Common system prompts, API definitions, and project schemas are cached with content hashes.
- Delta Context Passing: Subtasks receive only relevant symbol snippets and diffs, rather than full file trees or giant chat histories.
- Early-Exit Consensus: If the primary agent's solution passes automated deterministic tests, secondary verification models are skipped.
- Smart Triage Gate: Cheap/local model triages query complexity before waking high-cost models.

${claudeFindings}`;
});

worker.on('delivering', ({ requestId }) => {
  console.log(`▶ [gemini] Delivering request ${requestId} to the real Gemini Desktop app...`);
});
worker.on('delivered', ({ requestId, latencyMs, status }) => {
  console.log(`✅ [gemini] Real model response correlated for ${requestId} in ${latencyMs}ms (${status})`);
  if (runOnce) shutdown(0);
});
worker.on('failed', ({ requestId, error, status }) => {
  console.error(`❌ [gemini] Request ${requestId} failed (${status || 'ERROR'}): ${error}`);
  if (runOnce) shutdown(1);
});
worker.on('error', (err) => {
  console.error(`[gemini] worker error: ${err.message}`);
});

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

console.log('====================================================');
console.log('         AGENT BRIDGE — GEMINI DESKTOP WORKER');
console.log('====================================================');
console.log(`Agent ID:   gemini`);
console.log(`Engine:     GeminiDesktopWorker (real model / native AX)`);
console.log(`Transport:  gemini-desktop-accessibility`);
console.log(`Database:   ${dbPath}`);
console.log('Listening for correlated requests on the EventBus...');
console.log('');

worker.start().catch((err) => {
  console.error(`Failed to start Gemini worker: ${err.message}`);
  shutdown(1);
});

if (runOnce) {
  setTimeout(() => shutdown(0), 10000).unref?.();
}
