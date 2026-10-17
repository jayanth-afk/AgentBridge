import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { PersistentSwiftAXBridge } from '../src/control-plane/persistent-swift-ax-bridge.js';

test('B2 AX Daemon Lifecycle: pidfile recording, prior daemon reaping, and safe unref lifecycle', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ax-daemon-test-'));
  const pidFilePath = path.join(tmpDir, 'ax-daemon.json');
  const fakeDaemonPath = path.join(tmpDir, 'fake-ax-helper.js');

  // Create executable fake daemon script
  fs.writeFileSync(fakeDaemonPath, `#!/usr/bin/env node
setInterval(() => {}, 1000);
`, { mode: 0o755 });

  // Spawn an unrelated process that MUST NOT be touched
  const unrelatedChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore'
  });
  const unrelatedPid = unrelatedChild.pid;

  let bridge1 = null;
  let bridge2 = null;

  try {
    // 1. First bridge instance starts worker
    bridge1 = new PersistentSwiftAXBridge({
      binaryPath: fakeDaemonPath,
      pidFilePath
    });

    const worker1 = bridge1.ensureWorker();
    const pid1 = worker1.pid;
    assert.ok(pid1, 'Worker 1 should have a PID');

    // Verify pidfile exists and contains correct info
    assert.ok(fs.existsSync(pidFilePath), 'Pidfile must be created');
    const record1 = JSON.parse(fs.readFileSync(pidFilePath, 'utf8'));
    assert.strictEqual(record1.pid, pid1);
    assert.strictEqual(record1.binaryPath, fakeDaemonPath);

    // Verify worker 1 is alive
    assert.doesNotThrow(() => process.kill(pid1, 0));

    // 2. Second bridge instance starts (simulating restart / new instance)
    // It should reap worker 1 (because worker 1 matches pidfile and command line)
    bridge2 = new PersistentSwiftAXBridge({
      binaryPath: fakeDaemonPath,
      pidFilePath
    });

    const worker2 = bridge2.ensureWorker();
    const pid2 = worker2.pid;
    assert.ok(pid2, 'Worker 2 should have a PID');
    assert.notStrictEqual(pid2, pid1, 'Worker 2 must have a new PID');

    // Give SIGTERM time to terminate worker 1
    await new Promise(r => setTimeout(r, 200));

    // Worker 1 should now be dead
    let worker1Alive = true;
    try {
      process.kill(pid1, 0);
    } catch {
      worker1Alive = false;
    }
    assert.strictEqual(worker1Alive, false, 'Prior daemon must have been reaped');

    // Unrelated process MUST STILL BE ALIVE (never touched)
    let unrelatedAlive = true;
    try {
      process.kill(unrelatedPid, 0);
    } catch {
      unrelatedAlive = false;
    }
    assert.strictEqual(unrelatedAlive, true, 'Unrelated process must not be touched');

    // 3. Close bridge 2 and verify worker 2 is terminated and pidfile removed
    bridge2.close();
    await new Promise(r => setTimeout(r, 200));

    let worker2Alive = true;
    try {
      process.kill(pid2, 0);
    } catch {
      worker2Alive = false;
    }
    assert.strictEqual(worker2Alive, false, 'Worker 2 must be dead after close()');
    assert.strictEqual(fs.existsSync(pidFilePath), false, 'Pidfile must be removed after close()');

  } finally {
    if (bridge1) bridge1.close();
    if (bridge2) bridge2.close();
    try { unrelatedChild.kill('SIGKILL'); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});
