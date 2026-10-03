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

const worker = new ChatGptDesktopWorker({
  agentId: 'chatgpt-desktop',
  mailboxHub: mailbox,
  eventBus,
  logger
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
