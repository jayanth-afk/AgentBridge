/**
 * Cross-process completion helper for bench-completion-delivery.mjs.
 *
 * Opens the shared coordination DB and, on an IPC `complete` message, persists
 * the terminal result for a correlated request exactly as a real provider
 * worker would (MailboxHub.submitTaskResult -> transactional durable row +
 * immediate completion dispatch). Used to measure the genuine multi-process
 * "response ready -> requester receipt" delay.
 */
import { AuditLogger } from '../../src/audit-logger.js';
import { EventBus } from '../../src/event-bus.js';
import { TaskManager } from '../../src/task-manager.js';
import { MailboxHub } from '../../src/mailbox-hub.js';

const logger = new AuditLogger(process.env.BENCH_DB);
const eventBus = new EventBus(logger, { fallbackIntervalMs: 60000 });
const mailbox = new MailboxHub(logger, new TaskManager(logger, null, eventBus), eventBus);

process.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'complete') {
    try {
      mailbox.submitTaskResult({
        taskId: msg.taskId,
        agentId: msg.agentId,
        status: 'completed',
        result: msg.result
      });
      if (process.send) process.send({ type: 'completed', requestId: msg.requestId });
    } catch (err) {
      if (process.send) process.send({ type: 'error', requestId: msg.requestId, error: err.message });
    }
  } else if (msg.type === 'stop') {
    try { eventBus.close(); } catch {}
    try { logger.close(); } catch {}
    process.exit(0);
  }
});

if (process.send) process.send({ type: 'ready' });
