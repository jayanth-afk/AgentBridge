/**
 * Child-process helper: simulates a REAL standalone agent process.
 * Mode "worker": runs an autonomous AgentRunner for the specified agentId,
 *                waiting for event bus notifications to claim and process requests.
 * Mode "requester": issues a bridge_ask_agent call and directly awaits the
 *                   correlated response over the cross-process event bus.
 */
import { AuditLogger } from '../../src/audit-logger.js';
import { TaskManager } from '../../src/task-manager.js';
import { MailboxHub } from '../../src/mailbox-hub.js';
import { EventBus } from '../../src/event-bus.js';
import { PresenceManager } from '../../src/presence-manager.js';
import { ProjectController } from '../../src/project-controller.js';
import { PermissionGuard } from '../../src/permission-guard.js';
import { AgentRunner } from '../../src/agent-runner.js';

const mode = process.argv[2]; // 'worker' | 'requester'
const dbPath = process.argv[3];
const agentId = process.argv[4];

const logger = new AuditLogger(dbPath);
const eventBus = new EventBus(logger);
const taskManager = new TaskManager(logger);
const mailbox = new MailboxHub(logger, taskManager, eventBus);
const presence = new PresenceManager(logger);
const guard = new PermissionGuard();
const controller = new ProjectController(guard, logger);

if (mode === 'worker') {
  const runner = new AgentRunner({
    agentId,
    mailboxHub: mailbox,
    presenceManager: presence,
    projectController: controller,
    eventBus
  });

  // Custom handler to simulate answering specific questions
  runner.registerHandler('math_double', async (task) => {
    const match = task.instructions.match(/double\s+(\d+)/i);
    const num = match ? Number(match[1]) : 0;
    return JSON.stringify({ original: num, result: num * 2, answeredBy: agentId });
  });

  runner.registerHandler('ping_query', async () => {
    return `PONG_FROM_${agentId.toUpperCase()}`;
  });

  runner.on('eventWoken', (data) => {
    process.stdout.write(`TIMING_B_WAKE:${JSON.stringify({ timestamp: data.timestamp, eventType: data.event?.type })}\n`);
  });

  runner.on('taskClaimed', (data) => {
    process.stdout.write(`TIMING_B_CLAIM:${JSON.stringify({ timestamp: data.timestamp, taskId: data.task?.id })}\n`);
  });

  runner.on('taskCompleted', (data) => {
    process.stdout.write(`TIMING_B_COMPLETE:${JSON.stringify({ timestamp: data.timestamp, executionMs: data.executionMs })}\n`);
  });

  runner.start();
  process.stdout.write(`WORKER_READY:${agentId}\n`);

  const keepAlive = setInterval(() => {}, 60000);

  process.on('message', (msg) => {
    if (msg === 'STOP') {
      clearInterval(keepAlive);
      runner.stop();
      eventBus.close();
      logger.close();
      process.exit(0);
    }
  });

  process.on('SIGTERM', () => {
    clearInterval(keepAlive);
    runner.stop();
    eventBus.close();
    logger.close();
    process.exit(0);
  });
} else if (mode === 'requester') {
  const targetAgent = process.argv[5];
  const question = process.argv[6];

  async function run() {
    try {
      const t0 = Date.now();
      // Direct correlated askAgent without any polling, check_inbox, or get_task_status
      const outcome = await mailbox.askAgent({
        fromAgent: agentId,
        toAgent: targetAgent,
        question,
        timeoutMs: 15000
      });
      const tDelivery = Date.now();

      process.stdout.write(`REQUEST_TIMING:${JSON.stringify({ t0, tDelivery, totalRoundTripMs: tDelivery - t0 })}\n`);
      process.stdout.write(`REQUEST_RESULT:${JSON.stringify(outcome)}\n`);
      eventBus.close();
      logger.close();
      process.exit(outcome.status === 'completed' ? 0 : 1);
    } catch (err) {
      process.stderr.write(`REQUEST_ERROR:${err.message}\n`);
      eventBus.close();
      logger.close();
      process.exit(1);
    }
  }

  run();
}
