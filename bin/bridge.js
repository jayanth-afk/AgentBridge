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
import { WorkerSupervisor } from '../src/control-plane/worker-supervisor.js';

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
  bridge supervisor [start|stop|restart|status] [--worker <agentId>]
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
  bridge dashboard [--port <p>]
  bridge tail <requestId>
  bridge doctor
  bridge config generate <agent>
  bridge explain <requestId>
  bridge agent add <agentId>
  bridge agent verify <agentId>
  bridge agent reload [manifestPath]
  bridge skill add <sourceDir>
  bridge skill approve <skillName>
  bridge backup [destinationDir]
  bridge restore <backupDir>
  bridge prune [--max-age-hours <n>]
  bridge live-verify <agent> [route] [--dry-run | --confirm-live-run]
  bridge evaluate [--live] [--model <m>]
  bridge protocol-snippet <agent>

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
        token: CONFIG.RESPONSE_TOKEN,
        environment: CONFIG.ENVIRONMENT_LABEL,
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

    case 'supervisor': {
      const supervisor = new WorkerSupervisor();
      const subAction = filteredArgs[1] || 'status';
      const workerIdx = filteredArgs.indexOf('--worker');
      const targetWorker = workerIdx >= 0 ? filteredArgs[workerIdx + 1] : null;

      if (subAction === 'start') {
        if (targetWorker) {
          const res = await supervisor.startWorker(targetWorker);
          console.log(`Supervisor started worker [${targetWorker}]: PID ${res.pid} (alreadyRunning: ${res.alreadyRunning || false})`);
        } else {
          const res = await supervisor.startAll();
          console.log('Supervisor started all workers:', res);
        }
      } else if (subAction === 'stop') {
        if (targetWorker) {
          const res = await supervisor.stopWorker(targetWorker);
          console.log(`Supervisor stopped worker [${targetWorker}]:`, res);
        } else {
          const res = await supervisor.stopAll();
          console.log('Supervisor stopped all workers:', res);
        }
      } else if (subAction === 'restart') {
        if (targetWorker) {
          const res = await supervisor.restartWorker(targetWorker);
          console.log(`Supervisor restarted worker [${targetWorker}]: PID ${res.pid}`);
        } else {
          await supervisor.stopAll();
          const res = await supervisor.startAll();
          console.log('Supervisor restarted all workers:', res);
        }
      } else {
        const status = supervisor.status();
        console.log('Agent Bridge Worker Supervisor Status:');
        for (const [id, s] of Object.entries(status)) {
          console.log(`  ${id.padEnd(18)} : ${s.running ? `RUNNING (PID: ${s.pid})` : 'STOPPED'} [log: ${s.logFile}]`);
        }
      }
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

    case 'dashboard': {
      const { DashboardServer } = await import('../src/dashboard/dashboard-server.js');
      const crypto = await import('node:crypto');
      const portIdx = filteredArgs.indexOf('--port');
      const customPort = portIdx !== -1 ? Number(filteredArgs[portIdx + 1]) : 8768;
      const token = crypto.randomBytes(24).toString('hex');
      const server = new DashboardServer({
        port: customPort,
        host: '127.0.0.1',
        authToken: token,
        logger
      });
      const bound = await server.start();
      console.log('====================================================');
      console.log('       AGENT BRIDGE — COMMAND CENTER DASHBOARD      ');
      console.log('====================================================');
      console.log(`URL:   http://127.0.0.1:${bound.port}/`);
      console.log(`Token: ${token}`);
      console.log('\nOpen the URL in your browser and authorize with the operator token.');
      console.log('Press Ctrl+C to terminate the dashboard.\n');
      process.on('SIGINT', async () => {
        await server.stop();
        process.exit(0);
      });
      break;
    }

    case 'tail': {
      const reqId = filteredArgs[1];
      if (!reqId) {
        console.error('Error: bridge tail requires <requestId>');
        process.exit(1);
      }
      console.log(`[bridge tail] Tailing display for request: ${reqId}`);
      const { defaultDisplayManager } = await import('../src/display/bridge-display-manager.js');
      const panel = defaultDisplayManager.getCommittedPanel(reqId);
      if (panel) {
        console.log(`\n--- COMMITTED RESULT (${panel.displayed ? 'DISPLAYED' : 'PENDING'}) ---`);
        console.log(panel.content);
        break;
      }
      defaultDisplayManager.on('chunk', ({ requestId, delta }) => {
        if (requestId === reqId) process.stdout.write(delta);
      });
      defaultDisplayManager.on('result_committed', ({ requestId, content }) => {
        if (requestId === reqId) {
          console.log(`\n\n--- COMMITTED RESULT ---`);
          console.log(content);
          process.exit(0);
        }
      });
      setTimeout(() => {
        console.log('\n[bridge tail] Finished or no active stream detected.');
        process.exit(0);
      }, 15000).unref();
      break;
    }

    case 'doctor': {
      const { runBridgeDoctor } = await import('../src/diagnostics/doctor.js');
      const docRes = await runBridgeDoctor({ logger });
      console.log(docRes.report);
      if (!docRes.passed) process.exit(1);
      break;
    }

    case 'config': {
      const sub = filteredArgs[1];
      if (sub === 'generate') {
        const targetAgent = filteredArgs[2] || 'claude';
        const pathModule = await import('node:path');
        const nodeBin = process.execPath;
        const bridgeScript = pathModule.join(CONFIG.BRIDGE_ROOT, 'src', 'mcp-server.js');
        const generated = {
          mcpServers: {
            'agent-bridge': {
              command: nodeBin,
              args: [bridgeScript],
              env: {
                AGENT_ID: targetAgent
              }
            }
          }
        };

        let placementPath = '';
        if (targetAgent.includes('claude')) {
          placementPath = '~/Library/Application Support/Claude/claude_desktop_config.json';
        } else if (targetAgent.includes('antigravity')) {
          placementPath = '~/.gemini/antigravity-ide/mcp_config.json';
        } else {
          placementPath = `~/.config/${targetAgent}/mcp_config.json`;
        }

        console.log('========================================================================');
        console.log(`     AGENT BRIDGE — GENERATED MCP CONFIG FOR: ${targetAgent}`);
        console.log('========================================================================');
        console.log(`\nGenerated Configuration (copy and place into: ${placementPath}):\n`);
        console.log(JSON.stringify(generated, null, 2));
        console.log('\nNOTE: Agent Bridge does not overwrite your existing application config.');
        console.log(`To install, copy the JSON block above into ${placementPath}.\n`);
      } else {
        console.error('Usage: bridge config generate <agent> (e.g. claude, antigravity)');
        process.exit(1);
      }
      break;
    }

    case 'explain': {
      const reqId = filteredArgs[1];
      if (!reqId) {
        console.error('Error: bridge explain requires <requestId>');
        process.exit(1);
      }
      const { RequestExplainer } = await import('../src/diagnostics/request-explainer.js');
      const explainer = new RequestExplainer(logger);
      const explanation = explainer.explainRequest(reqId);
      console.log(explanation);
      break;
    }

    case 'agent': {
      const sub = filteredArgs[1];
      if (sub === 'add') {
        const newId = filteredArgs[2];
        if (!newId) {
          console.error('Error: bridge agent add requires <agentId>');
          process.exit(1);
        }
        console.log(`[bridge agent add] Registering agent identity: ${newId}`);
        const { addAgentIdentity } = await import('../src/agent-identity.js');
        addAgentIdentity(newId);
        console.log(`✅ Successfully added agent '${newId}' to allowed identities.`);
      } else if (sub === 'verify') {
        const verifyId = filteredArgs[2];
        if (!verifyId) {
          console.error('Error: bridge agent verify requires <agentId>');
          process.exit(1);
        }
        console.log(`[bridge agent verify] Running conformance verification for: ${verifyId}`);
        const { runConformanceSuite } = await import('../src/testing/conformance-suite.js');
        const confRes = await runConformanceSuite(verifyId);
        console.log(confRes.summary);
        if (!confRes.passed) process.exit(1);
      } else if (sub === 'reload') {
        const manifestPath = filteredArgs[2];
        const { HotManifestReloader } = await import('../src/interop/hot-manifest-reloader.js');
        const reloader = new HotManifestReloader({ eventBus: mailbox.eventBus });
        const fs = await import('node:fs');
        let manifestData;
        if (manifestPath && fs.existsSync(manifestPath)) {
          manifestData = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        } else {
          manifestData = { id: 'agent-bridge', version: '1.2.0', status: 'online' };
        }
        const relRes = reloader.reloadManifest(manifestData);
        console.log(`✅ Hot-reloaded manifest for '${relRes.agentId}' (v${relRes.version}) without restarting server.`);
      } else {
        console.log('Usage: bridge agent [add <id> | verify <id> | reload [path]]');
      }
      break;
    }

    case 'skill': {
      const sub = filteredArgs[1];
      const { SignedSkillRegistry } = await import('../src/skills/skill-registry.js');
      const registry = new SignedSkillRegistry();
      if (sub === 'add') {
        const sourcePath = filteredArgs[2];
        if (!sourcePath) {
          console.error('Error: bridge skill add requires <sourceDir>');
          process.exit(1);
        }
        const proposal = registry.proposeSkillAdd(sourcePath);
        console.log(`Proposed skill addition:`);
        console.log(`  Name:        ${proposal.name}`);
        console.log(`  Description: ${proposal.description}`);
        console.log(`  SHA-256:     ${proposal.sha256}`);
        console.log(`  Permissions: ${proposal.permissions.join(', ')}`);
        registry.approveSkillAdd(proposal, { isHumanApproved: true, approvedBy: 'user' });
        console.log(`✅ Successfully approved and installed skill '${proposal.name}'.`);
      } else if (sub === 'approve') {
        const skillName = filteredArgs[2];
        if (!skillName) {
          console.error('Error: bridge skill approve requires <skillName>');
          process.exit(1);
        }
        registry.approveInstalledSkill(skillName, { isHumanApproved: true, approvedBy: 'user' });
        console.log(`✅ Successfully approved skill '${skillName}' for production use.`);
      } else {
        console.log('Usage: bridge skill [add <sourceDir> | approve <name>]');
      }
      break;
    }

    case 'backup': {
      const outDir = filteredArgs[1] || path.join(process.cwd(), `backup-${Date.now()}`);
      const { runBackup } = await import('../src/storage/backup-restore.js');
      const res = await runBackup(outDir);
      console.log(`✅ Backup successfully created at: ${res.backupPath}`);
      break;
    }

    case 'restore': {
      const bkpDir = filteredArgs[1];
      if (!bkpDir) {
        console.error('Error: bridge restore requires <backupPath>');
        process.exit(1);
      }
      const { runRestore } = await import('../src/storage/backup-restore.js');
      const res = await runRestore(bkpDir);
      console.log(`✅ Restored from backup: ${res.status}`);
      break;
    }

    case 'prune': {
      const maxAgeHours = filteredArgs[1] ? Number(filteredArgs[1]) : 72;
      const { RetentionPruner } = await import('../src/storage/retention-pruner.js');
      const pruner = new RetentionPruner(logger.db);
      const pruneRes = pruner.pruneAll({ maxAgeHours });
      console.log('✅ Retention pruning complete:');
      console.log(`   Audit log entries removed: ${pruneRes.auditLogPruned}`);
      console.log(`   Terminal requests pruned:  ${pruneRes.terminalRequestsPruned}`);
      console.log(`   Expired leases released:   ${pruneRes.expiredLeasesCleaned}`);
      break;
    }

    case 'live-verify': {
      const targetAgent = filteredArgs[1];
      const targetRoute = filteredArgs[2] || 'cli-process';
      const isDryRun = filteredArgs.includes('--dry-run');
      const isConfirmed = filteredArgs.includes('--confirm-live-run');

      if (!targetAgent) {
        console.error('Error: bridge live-verify requires <agent> [route] [--dry-run | --confirm-live-run]');
        process.exit(1);
      }

      const { LiveVerificationHarness } = await import('../src/cli/live-verify.js');
      const harness = new LiveVerificationHarness({
        agentId: targetAgent,
        routeId: targetRoute,
        dryRun: isDryRun || !isConfirmed
      });

      const preflight = await harness.preflightCheck({ confirmed: isConfirmed });
      if (!preflight.allowed) {
        console.error('====================================================================');
        console.error('               ⚠️  LIVE GATE: OPERATOR APPROVAL REQUIRED            ');
        console.error('====================================================================');
        console.error('Refusing to touch real applications or debug ports without explicit');
        console.error('human operator presence and interactive confirmation.');
        console.error('');
        console.error('To run safely against local fakes (offline dry-run):');
        console.error(`  node bin/bridge.js live-verify ${targetAgent} ${targetRoute} --dry-run`);
        console.error('');
        console.error('To run against live desktop apps (with operator present):');
        console.error(`  node bin/bridge.js live-verify ${targetAgent} ${targetRoute} --confirm-live-run`);
        console.error('====================================================================');
        process.exit(1);
      }

      console.log(`[live-verify] Mode: ${preflight.mode}`);
      console.log(`[live-verify] Target: ${targetAgent} via ${targetRoute}`);
      const selectors = await harness.discoverSelectors();
      console.log(`[live-verify] Discovered selectors in ${harness.stageLatencies.discoveryMs}ms:`);
      console.log(`  Input: ${selectors.inputSelector}`);
      console.log(`  Send:  ${selectors.sendButtonSelector}`);
      const probeRes = await harness.executeProbe();
      console.log(`[live-verify] Probe execution completed:`);
      console.log(`  Success:          ${probeRes.success ? '✅ PASSED' : '❌ FAILED'}`);
      console.log(`  Evidence Tier:    ${probeRes.completionTier}`);
      console.log(`  Nonce Echoed:     ${probeRes.nonceEchoed ? 'YES' : 'NO'}`);
      console.log(`  Focus Preserved:  ${probeRes.focusPreserved ? 'YES (No Window Stealing)' : 'NO'}`);
      const recordRes = await harness.commitEvidenceRecord(probeRes, 'cli_user_session');
      console.log(`[live-verify] Evidence Status: ${recordRes.level} (${recordRes.message || 'Committed'})`);
      break;
    }

    case 'evaluate': {
      const isLive = filteredArgs.includes('--live');
      const modelIdx = filteredArgs.indexOf('--model');
      const model = modelIdx !== -1 ? filteredArgs[modelIdx + 1] : 'fake-cli-model';

      if (isLive) {
        console.warn('⚠️  LIVE EVALUATION REQUESTED: This will consume real model API quota.');
      }

      const { RealWorldEvaluationHarness } = await import('../src/cli/evaluate.js');
      const harness = new RealWorldEvaluationHarness({ live: isLive, model });
      console.log(`Running real-world paired evaluation suite (mode: ${harness.live ? 'LIVE' : 'OFFLINE FAKE CLI'})...`);
      const report = await harness.runEvaluation();
      console.log(harness.formatReport(report));
      break;
    }

    case 'protocol-snippet': {
      const target = filteredArgs[1] || 'generic';
      console.log(`<!-- AGENT BRIDGE PROTOCOL SNIPPET: ${target} -->`);
      console.log(`You are connected to Agent Bridge. To collaborate with other agents and execute local tasks:`);
      console.log(`1. Discovery: Call \`bridge_discover_agents\` to list available agents and routes.`);
      console.log(`2. Delegation: To delegate or ask a peer, use \`bridge_ask_agent({ toAgent: "<agentId>", question: "..." })\`.`);
      console.log(`3. Results: To submit completed task results, use \`bridge_submit_task_result({ taskId, result, attemptId, epoch, nonce })\`.`);
      console.log(`4. Nonce Echo: Whenever a turn contains \`[NONCE:<nonce>]\`, you must echo it in your response as \`[[NONCE:<nonce>]]\`.`);
      console.log(`5. Files & Tools: Use \`bridge_read_file\`, \`bridge_edit_file\`, and \`bridge_get_symbol_outline\` within allowed project roots.`);
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
