#!/usr/bin/env node
import { WorkerSupervisor } from '../src/control-plane/worker-supervisor.js';

const args = process.argv.slice(2);
const command = args[0] || 'status';
const supervisor = new WorkerSupervisor();
supervisor.on('error', (err) => console.error('[Supervisor Error]', err.message));
const workerIdx = args.indexOf('--worker');
const targetWorker = workerIdx >= 0 ? args[workerIdx + 1] : null;

if (command === 'start') {
  if (targetWorker) {
    const res = await supervisor.startWorker(targetWorker, { detached: true });
    console.log(`Started worker [${targetWorker}]: PID ${res.pid} (alreadyRunning: ${res.alreadyRunning || false})`);
  } else {
    const res = await supervisor.startAll({ detached: true });
    console.log('Started all workers:', res);
  }
} else if (command === 'stop') {
  if (targetWorker) {
    const res = await supervisor.stopWorker(targetWorker);
    console.log(`Stopped worker [${targetWorker}]:`, res);
  } else {
    const res = await supervisor.stopAll();
    console.log('Stopped all workers:', res);
  }
} else if (command === 'restart') {
  if (targetWorker) {
    const res = await supervisor.restartWorker(targetWorker, { detached: true });
    console.log(`Restarted worker [${targetWorker}]: PID ${res.pid}`);
  } else {
    await supervisor.stopAll();
    const res = await supervisor.startAll({ detached: true });
    console.log('Restarted all workers:', res);
  }
} else {
  const status = supervisor.status();
  console.log('Agent Bridge Worker Supervisor Status:');
  for (const [id, s] of Object.entries(status)) {
    console.log(`  ${id.padEnd(18)} : ${s.running ? `RUNNING (PID: ${s.pid})` : 'STOPPED'} [log: ${s.logFile}]`);
  }
}
