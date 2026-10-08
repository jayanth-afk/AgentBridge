#!/usr/bin/env node
/**
 * Gemini Autonomous Agent Worker
 *
 * Dedicated, event-driven background process that registers as the `gemini`
 * participant. Woken by cross-process EventBus events (request_created, task_created),
 * claims tasks atomically through TaskManager, executes deterministic / authorized logic,
 * and delivers correlated responses back through MailboxHub / TransactionalOutbox.
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
import { PermissionGuard } from '../src/permission-guard.js';
import { ConcurrencyManager } from '../src/concurrency-manager.js';
import { FileActivityManager } from '../src/file-activity-manager.js';
import { CacheManager } from '../src/cache-manager.js';
import { GitController } from '../src/git-controller.js';
import { ProjectController } from '../src/project-controller.js';
import { AgentRunner } from '../src/agent-runner.js';

const args = process.argv.slice(2);
const runOnce = args.includes('--once');
let dbPath = CONFIG.DB_PATH;
const dbIdx = args.indexOf('--db');
if (dbIdx >= 0 && args[dbIdx + 1]) dbPath = args[dbIdx + 1];

const logger = new AuditLogger(dbPath);
const guard = new PermissionGuard();
const concurrency = new ConcurrencyManager();
const cache = new CacheManager();
const fileActivity = new FileActivityManager(logger);
const git = new GitController(guard, logger);
const controller = new ProjectController(guard, logger, concurrency, fileActivity, cache, git);

const taskManager = new TaskManager(logger);
const eventBus = new EventBus(logger);
const mailbox = new MailboxHub(logger, taskManager, eventBus);
const presence = new PresenceManager(logger);

const runner = new AgentRunner({
  agentId: 'gemini',
  mailboxHub: mailbox,
  presenceManager: presence,
  projectController: controller,
  gitController: git,
  eventBus,
  pollIntervalMinMs: 50,
  pollIntervalMaxMs: 3000
});

runner.on('processingTask', (task) => {
  console.log(`▶ [gemini] Processing task ${task.id}: "${task.title || task.instructions}"`);
});

runner.on('taskCompleted', ({ task, result, executionMs }) => {
  console.log(`✅ [gemini] Completed task ${task.id} in ${executionMs}ms`);
  if (runOnce) shutdown(0);
});

runner.on('taskFailed', ({ task, error }) => {
  console.error(`❌ [gemini] Task ${task.id} failed: ${error}`);
  if (runOnce) shutdown(1);
});

runner.on('error', (err) => {
  console.error(`[gemini] Runner error: ${err.message}`);
});

const keepAlive = setInterval(() => {}, 1 << 30);

function shutdown(code = 0) {
  clearInterval(keepAlive);
  runner.stop();
  try { eventBus.close(); } catch {}
  try { logger.close(); } catch {}
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log('====================================================');
console.log('         AGENT BRIDGE — GEMINI WORKER');
console.log('====================================================');
console.log(`Agent ID:   gemini`);
console.log(`Engine:     AgentRunner (autonomous)`);
console.log(`Transport:  agent-autonomous-worker`);
console.log(`Database:   ${dbPath}`);
console.log('Listening for correlated requests on the EventBus...');
console.log('');

runner.start();

if (runOnce) {
  setTimeout(() => shutdown(0), 10000).unref?.();
}
