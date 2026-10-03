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
      console.log(`Tracked Conversations: ${status.conversations}\n`);

      for (const [key, agent] of Object.entries(status.agents)) {
        console.log(`[${agent.name.toUpperCase()}]`);
        console.log(`  PID:             ${agent.pid || 'N/A'}`);
        console.log(`  Running:         ${agent.running ?? 'N/A'}`);
        console.log(`  Window Count:    ${agent.windowCount ?? 'N/A'}`);
        console.log(`  Transport:       ${agent.transport}`);
        console.log(`  Idle Model Wake: ${agent.idleModelWake ? 'YES (Verified)' : 'NO (User/AX Required)'}`);
        console.log(`  Health:          ${agent.health}`);
        if (agent.activeJobs !== undefined) console.log(`  Active Jobs:     ${agent.activeJobs}`);
        if (agent.activeTurns !== undefined) console.log(`  Active Turns:    ${agent.activeTurns}`);
        console.log('');
      }
      break;
    }
    case 'ask': {
      const targetAgent = args[1];
      const message = args.slice(2).join(' ');
      if (!targetAgent || !message) {
        console.error('Usage: bridge ask <agent> <message>');
        process.exit(1);
      }
      console.log(`Delegating task to ${targetAgent}...`);
      const res = await orchestrator.delegateModelTask({
        fromAgent: 'cli-user',
        toAgent: targetAgent,
        message
      });
      console.log('Result:', JSON.stringify(res, null, 2));
      break;
    }
    case 'ping': {
      console.log(JSON.stringify({ ok: true, status: 'pong', timestamp: new Date().toISOString() }));
      break;
    }
    default: {
      console.log(`Unknown command: ${command}`);
      console.log('Available commands: status, ask <agent> <message>, ping');
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error('CLI Error:', err);
  process.exit(1);
});
