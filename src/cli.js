#!/usr/bin/env node
import { ModelOrchestrator } from './control-plane/model-orchestrator.js';

const args = process.argv.slice(2);
const command = args[0] || 'status';

const orchestrator = new ModelOrchestrator();

async function main() {
  switch (command) {
    case 'status': {
      const status = await orchestrator.getLiveStatus();
      console.log('====================================================');
      console.log('           AGENT BRIDGE — LIVE STATUS               ');
      console.log('====================================================');
      console.log(`Timestamp: ${status.timestamp}`);
      console.log(`Active Delegated Tasks: ${status.activeTasks}`);
      console.log(`Tracked Conversations:  ${status.conversations}\n`);

      for (const [key, agent] of Object.entries(status.agents)) {
        console.log(`  ${key.toUpperCase()}`);
        console.log(`    engine:             ${agent.engine}`);
        console.log(`    idleTurn:           ${agent.idleTurn}`);
        console.log(`    trueHeadlessEngine: ${agent.trueHeadlessEngine}`);
        console.log(`    modelTurn:          ${agent.modelTurn}`);
        console.log(`    health:             ${agent.health}`);
        if (agent.pid) console.log(`    pid:                ${agent.pid}`);
        if (agent.windowCount !== undefined) console.log(`    windows:            ${agent.windowCount}`);
        console.log('');
      }
      break;
    }
    case 'sessions': {
      const convs = orchestrator.conversations.getAll();
      console.log('====================================================');
      console.log('         AGENT BRIDGE — ACTIVE SESSIONS             ');
      console.log('====================================================');
      if (convs.length === 0) {
        console.log('No active conversations recorded.');
      } else {
        for (const c of convs) {
          console.log(`[Conversation ${c.conversationId}]`);
          console.log(`  Agent:        ${c.agent}`);
          console.log(`  ThreadId:     ${c.threadId || 'N/A'}`);
          console.log(`  Turns:        ${c.turnCount}`);
          console.log(`  Last Latency: ${c.lastLatencyMs ? c.lastLatencyMs + 'ms' : 'N/A'}`);
          console.log(`  Last Request: ${c.lastRequest ? c.lastRequest.slice(0, 80) : 'N/A'}`);
          console.log(`  Last Output:  ${c.lastResponse ? c.lastResponse.slice(0, 80) : 'N/A'}`);
          console.log('');
        }
      }
      break;
    }
    case 'tasks': {
      console.log('====================================================');
      console.log('          AGENT BRIDGE — ACTIVE TASKS               ');
      console.log('====================================================');
      if (orchestrator.activeTasks.size === 0) {
        console.log('No in-flight delegated tasks.');
      } else {
        for (const [reqId, task] of orchestrator.activeTasks.entries()) {
          console.log(`[Task ${reqId}]`);
          console.log(`  From:    ${task.envelope.fromAgent}`);
          console.log(`  To:      ${task.envelope.toAgent}`);
          console.log(`  State:   ${task.envelope.state}`);
          console.log(`  Elapsed: ${Date.now() - task.startTime}ms`);
          console.log(`  Message: ${task.envelope.message.slice(0, 80)}`);
          console.log('');
        }
      }
      break;
    }
    case 'ask': {
      const targetAgent = args[1];
      const message = args.slice(2).join(' ');
      if (!targetAgent || !message) {
        console.error('Usage: ./src/cli.js ask <agent> "<message>"');
        process.exit(1);
      }
      console.log(`Delegating task to [${targetAgent}]...`);
      const start = Date.now();
      const res = await orchestrator.delegateModelTask({
        fromAgent: 'cli-user',
        toAgent: targetAgent,
        message
      });
      console.log('Result:', JSON.stringify(res, null, 2));
      console.log(`Total roundtrip: ${Date.now() - start}ms`);
      break;
    }
    case 'ping': {
      console.log(JSON.stringify({ ok: true, status: 'pong', timestamp: new Date().toISOString() }));
      break;
    }
    default: {
      console.log(`Unknown command: ${command}`);
      console.log('Available commands: status, sessions, tasks, ask <agent> "<message>", ping');
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error('CLI Error:', err);
  process.exit(1);
});
