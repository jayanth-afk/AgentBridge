/**
 * Cross-process benchmark worker for Agent Bridge messaging paths.
 *
 * Opens the shared SQLite coordination DB, subscribes as AGENT_ID, claims the
 * task backing each `request_created` event, and submits a deterministic result.
 * Used by bench-messaging.mjs to measure a genuine multi-process round trip
 * (never an in-process function call).
 */
import { AuditLogger } from '../../src/audit-logger.js';
import { EventBus } from '../../src/event-bus.js';
import { TaskManager } from '../../src/task-manager.js';
import { MailboxHub } from '../../src/mailbox-hub.js';

const dbPath = process.env.BENCH_DB;
const agentId = process.env.BENCH_AGENT || 'bench-worker';
const delayMs = Number(process.env.BENCH_WORKER_DELAY_MS || 0);

const logger = new AuditLogger(dbPath);
const eventBus = new EventBus(logger, { fallbackIntervalMs: 100 });
const tasks = new TaskManager(logger, null, eventBus);
const mailbox = new MailboxHub(logger, tasks, eventBus);

const sub = eventBus.subscribe(agentId, (event) => {
  if (event.type !== 'request_created' || !event.requestId) return;
  setTimeout(() => {
    try {
      const req = mailbox.getRequest(event.requestId);
      if (!req || req.status !== 'pending') return;
      const answer = `echo:${event.requestId}`;
      if (req.taskId) {
        mailbox.submitTaskResult({ taskId: req.taskId, agentId, status: 'completed', result: answer });
      } else {
        mailbox.answerRequest({ requestId: event.requestId, agentId, response: answer });
      }
    } catch {}
  }, delayMs);
});

process.on('message', (m) => {
  if (m === 'stop') {
    try { sub.unsubscribe(); } catch {}
    try { eventBus.close(); } catch {}
    try { logger.close(); } catch {}
    process.exit(0);
  }
});

// Signal readiness to the parent once the subscription is active.
if (process.send) process.send('ready');
