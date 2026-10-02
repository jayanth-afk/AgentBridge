#!/usr/bin/env node

import { CONFIG } from '../src/config.js';
import { AuditLogger } from '../src/audit-logger.js';
import { MailboxHub } from '../src/mailbox-hub.js';
import { FileActivityManager } from '../src/file-activity-manager.js';
import { CollaborationManager } from '../src/collaboration-manager.js';
import { PresenceManager } from '../src/presence-manager.js';
import { ProjectController } from '../src/project-controller.js';
import { PermissionGuard } from '../src/permission-guard.js';
import { GitController } from '../src/git-controller.js';
import { AgentRunner } from '../src/agent-runner.js';
import { CacheManager } from '../src/cache-manager.js';

const args = process.argv.slice(2);

function printHelp() {
  console.log(`
Agent Bridge CLI - Inter-Agent Terminal Gateway & Autonomous Worker

Usage:
  bridge ping [--agent <agentId>]
  bridge status
  bridge presence
  bridge snapshot [rootPath]
  bridge worker [--agent <agentId>] [--once]
  bridge send <toAgent> <subject> <content> [--agent <agentId>]
  bridge broadcast <subject> <content> [--agent <agentId>]
  bridge inbox [--unread] [--compact] [--agent <agentId>]
  bridge tasks [--pending] [--compact] [--agent <agentId>]
  bridge delegate <toAgent> <title> <instructions> [--agent <agentId>] [--priority <p>]
  bridge claim-task [--agent <agentId>]
  bridge complete-task <taskId> <result> [--agent <agentId>]
  bridge patch <filePath> <targetContent> <replacementContent> [--agent <agentId>]
  bridge activity-start <filePath> [activityType] [--agent <agentId>]
  bridge activity-stop <filePath> [--agent <agentId>]
  bridge activity-list

Default agent identity: freebuff (override with AGENT_ID env or --agent flag)
Available agents: ${CONFIG.AGENT_IDENTITIES.join(', ')}
`);
}

let agentId = process.env.AGENT_ID || 'freebuff';

// Extract --agent if present
const filteredArgs = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--agent' && i + 1 < args.length) {
    agentId = args[i + 1];
    i++;
  } else {
    filteredArgs.push(args[i]);
  }
}

const command = filteredArgs[0];

if (!command || command === 'help' || command === '--help' || command === '-h') {
  printHelp();
  process.exit(0);
}

const logger = new AuditLogger();
const guard = new PermissionGuard();
const mailbox = new MailboxHub(logger);
const activityManager = new FileActivityManager(logger);
const collabManager = new CollaborationManager(logger);
const presence = new PresenceManager(logger);
const cache = new CacheManager();
const git = new GitController(guard, logger);
const controller = new ProjectController(guard, logger, undefined, activityManager, cache, git);

try {
  switch (command) {
    case 'ping': {
      console.log(JSON.stringify({
        status: 'OK',
        token: 'CHATGPT_BRIDGE_REAL_TEST_7F31',
        agent: agentId,
        bridgePath: CONFIG.BRIDGE_ROOT,
        ziaWriteLocked: CONFIG.ZIA_WRITE_LOCKED,
        allowedRoots: CONFIG.ALLOWED_ROOTS,
        timestamp: new Date().toISOString()
      }, null, 2));
      break;
    }

    case 'status':
    case 'discover': {
      console.log(JSON.stringify({
        registeredAgents: CONFIG.AGENT_IDENTITIES,
        liveAgents: presence.listAgents(),
        currentAgent: agentId,
        ziaWriteLocked: CONFIG.ZIA_WRITE_LOCKED,
        allowedRoots: CONFIG.ALLOWED_ROOTS
      }, null, 2));
      break;
    }

    case 'presence': {
      const live = presence.listAgents();
      console.log(`Live Agent Presence (${live.length} registered):`);
      live.forEach(a => {
        const status = a.connected ? `ONLINE [${a.state}]` : 'OFFLINE';
        console.log(`  ${a.agentId.padEnd(18)} : ${status} (PID: ${a.pid || '-'}, transport: ${a.transport}, last: ${a.lastHeartbeat})`);
      });
      break;
    }

    case 'worker': {
      const runOnce = filteredArgs.includes('--once');
      console.log(`🚀 Starting Autonomous Agent Worker for [${agentId}] (runOnce: ${runOnce})...`);
      const runner = new AgentRunner({
        agentId,
        mailboxHub: mailbox,
        presenceManager: presence,
        projectController: controller,
        gitController: git
      });

      runner.on('processingTask', (task) => {
        console.log(`⚡ [${agentId}] Processing task [${task.id}]: "${task.title}"`);
      });

      runner.on('taskCompleted', ({ task, executionMs }) => {
        console.log(`✅ [${agentId}] Completed task [${task.id}] in ${executionMs}ms`);
        if (runOnce) {
          runner.stop();
          process.exit(0);
        }
      });

      runner.on('taskFailed', ({ task, error }) => {
        console.error(`❌ [${agentId}] Task [${task.id}] failed:`, error);
        if (runOnce) {
          runner.stop();
          process.exit(1);
        }
      });

      runner.start();

      process.on('SIGINT', () => {
        console.log(`\nStopping worker for [${agentId}]...`);
        runner.stop();
        process.exit(0);
      });
      process.on('SIGTERM', () => {
        runner.stop();
        process.exit(0);
      });

      if (runOnce) {
        // Trigger poll immediately
        runner.wakeUp();
      }
      break;
    }

    case 'snapshot': {
      const target = filteredArgs[1] || CONFIG.BRIDGE_ROOT;
      const snap = await controller.projectSnapshot(target, agentId);
      console.log(JSON.stringify(snap, null, 2));
      break;
    }

    case 'send': {
      const toAgent = filteredArgs[1];
      const subject = filteredArgs[2];
      const content = filteredArgs.slice(3).join(' ');
      if (!toAgent || !subject || !content) {
        console.error('Error: bridge send requires <toAgent> <subject> <content>');
        process.exit(1);
      }
      const msg = mailbox.sendMessage({ fromAgent: agentId, toAgent, subject, content });
      console.log(`✅ Message sent to ${toAgent}: [${msg.id}]`);
      break;
    }

    case 'broadcast': {
      const subject = filteredArgs[1];
      const content = filteredArgs.slice(2).join(' ');
      if (!subject || !content) {
        console.error('Error: bridge broadcast requires <subject> <content>');
        process.exit(1);
      }
      const recipients = CONFIG.AGENT_IDENTITIES.filter(a => a !== agentId && a !== 'system');
      const res = await mailbox.broadcastMessage({ fromAgent: agentId, toAgents: recipients, subject, content });
      console.log(`✅ Broadcast sent to ${recipients.join(', ')}:`, res.delivered.map(d => d.id));
      break;
    }

    case 'inbox': {
      const unreadOnly = filteredArgs.includes('--unread');
      const compact = filteredArgs.includes('--compact');
      const msgs = mailbox.getInbox({ agentId, unreadOnly, compact });
      if (msgs.length === 0) {
        console.log(`No ${unreadOnly ? 'unread ' : ''}messages for ${agentId}.`);
      } else {
        console.log(`📬 Inbox for ${agentId} (${msgs.length} message(s)):`);
        msgs.forEach(m => {
          const status = m.read_at ? 'READ' : 'UNREAD';
          console.log(`\n  [${m.id}] ${m.timestamp} (${status})`);
          console.log(`  From: ${m.from_agent} | Subject: ${m.subject}`);
          if (!compact) console.log(`  Content: ${m.content}`);
        });
      }
      break;
    }

    case 'tasks': {
      const pendingOnly = filteredArgs.includes('--pending');
      const compact = filteredArgs.includes('--compact');
      const statusFilter = pendingOnly ? 'pending' : null;
      const tasks = mailbox.listTasks({ agentId, status: statusFilter, compact });
      if (tasks.length === 0) {
        console.log(`No ${pendingOnly ? 'pending ' : ''}tasks for ${agentId}.`);
      } else {
        console.log(`📋 Tasks for ${agentId} (${tasks.length} task(s)):`);
        tasks.forEach(t => {
          console.log(`\n  [${t.id}] Status: ${t.status.toUpperCase()} | Priority: ${t.priority}`);
          console.log(`  From: ${t.creator || t.from_agent} | Title: ${t.title}`);
          if (t.instructions) console.log(`  Instructions: ${t.instructions}`);
          if (t.result) console.log(`  Result: ${t.result}`);
        });
      }
      break;
    }

    case 'delegate': {
      const toAgent = filteredArgs[1];
      const title = filteredArgs[2];
      const instructions = filteredArgs.slice(3).join(' ');
      if (!toAgent || !title || !instructions) {
        console.error('Error: bridge delegate requires <toAgent> <title> <instructions>');
        process.exit(1);
      }
      const task = mailbox.delegateTask({
        fromAgent: agentId,
        toAgent,
        title,
        instructions,
        context: {}
      });
      console.log(`✅ Task delegated to ${toAgent}: [${task.id}]`);
      break;
    }

    case 'claim-task': {
      const task = mailbox.claimNextTask(agentId);
      if (!task) {
        console.log(`No pending tasks available for ${agentId}.`);
      } else {
        console.log(`⚡ Claimed task [${task.id}]:`, task);
      }
      break;
    }

    case 'complete-task': {
      const taskId = filteredArgs[1];
      const result = filteredArgs.slice(2).join(' ');
      if (!taskId || !result) {
        console.error('Error: bridge complete-task requires <taskId> <result>');
        process.exit(1);
      }
      const completed = mailbox.submitTaskResult({
        agentId,
        taskId,
        result
      });
      console.log(`✅ Task [${taskId}] marked completed:`, completed);
      break;
    }

    case 'patch': {
      const filePath = filteredArgs[1];
      const targetContent = filteredArgs[2];
      const replacementContent = filteredArgs[3];
      if (!filePath || !targetContent || replacementContent === undefined) {
        console.error('Error: bridge patch requires <filePath> <targetContent> <replacementContent>');
        process.exit(1);
      }
      const res = await controller.applyPatch(filePath, agentId, { targetContent, replacementContent });
      console.log(`✅ Patch result:`, res);
      break;
    }

    case 'activity-start': {
      const filePath = filteredArgs[1];
      const activityType = filteredArgs[2] || 'editing';
      if (!filePath) {
        console.error('Error: bridge activity-start requires <filePath>');
        process.exit(1);
      }
      const act = activityManager.start({ filePath, agentId, activityType });
      console.log(`✅ Activity started: ${agentId} is ${activityType} on ${filePath} [lock: ${act.id}]`);
      break;
    }

    case 'activity-stop': {
      const filePath = filteredArgs[1];
      if (!filePath) {
        console.error('Error: bridge activity-stop requires <filePath>');
        process.exit(1);
      }
      activityManager.stop({ filePath, agentId });
      console.log(`✅ Activity stopped for ${agentId} on ${filePath}`);
      break;
    }

    case 'activity-list': {
      const acts = activityManager.getAll();
      if (acts.length === 0) {
        console.log('No active file activities across any agents.');
      } else {
        console.log('Active file activities:');
        acts.forEach(a => {
          console.log(`  ${a.agent_id} -> ${a.activity_type} on ${a.file_path} (since ${a.started_at})`);
        });
      }
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
} catch (err) {
  console.error('Error running bridge command:', err.message);
  process.exit(1);
}
