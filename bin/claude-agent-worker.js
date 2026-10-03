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

const worker = new ClaudeDesktopWorker({
  agentId: 'claude-desktop',
  mailboxHub: mailbox,
  eventBus,
  logger
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
