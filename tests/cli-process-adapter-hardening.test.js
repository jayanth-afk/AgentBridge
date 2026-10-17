import test from 'node:test';
import assert from 'node:assert/strict';
import { CliProcessAdapter, ALLOWED_CLI_COMMANDS } from '../src/control-plane/cli-process-adapter.js';

test('A6 Hardening: CliProcessAdapter child environment, process tree kill, and command allowlist', async (t) => {
  await t.test('1. Sentinel secret and control plane keys in parent process.env are absent in child', async () => {
    // Inject sentinel secrets in parent environment
    process.env.PARENT_SENTINEL_SECRET_TOKEN = 'SUPER_SECRET_VALUE_998811';
    process.env.CONTROL_PLANE_API_KEY = 'CONTROL_PLANE_SECRET_KEY_123';
    process.env.AGENT_BRIDGE_API_KEY = 'BRIDGE_SECRET_KEY_456';

    const adapter = new CliProcessAdapter('test-env-scrub', {
      command: 'node',
      inputMode: 'arg'
    });

    const checkScript = `
      const sentinel = process.env.PARENT_SENTINEL_SECRET_TOKEN;
      const cpKey = process.env.CONTROL_PLANE_API_KEY;
      const bridgeKey = process.env.AGENT_BRIDGE_API_KEY;
      const term = process.env.TERM;
      console.log(JSON.stringify({ sentinel: sentinel || null, cpKey: cpKey || null, bridgeKey: bridgeKey || null, term: term || null }));
    `;

    const res = await adapter.send({
      requestId: 'req_env_check_1',
      args: ['-e', checkScript]
    });

    assert.strictEqual(res.outcome, 'DELIVERED_CONFIRMED');
    const parsed = JSON.parse(res.response);
    assert.strictEqual(parsed.sentinel, null, 'Parent sentinel secret must not be leaked to child process');
    assert.strictEqual(parsed.cpKey, null, 'CONTROL_PLANE_API_KEY must not be leaked to child process');
    assert.strictEqual(parsed.bridgeKey, null, 'AGENT_BRIDGE_API_KEY must not be leaked to child process');
    assert.ok(parsed.term, 'Standard allowed terminal env should be preserved');

    delete process.env.PARENT_SENTINEL_SECRET_TOKEN;
  });

  await t.test('2. Command allowlist blocks unlisted binaries and accepts allowlisted commands', async () => {
    assert.ok(ALLOWED_CLI_COMMANDS.includes('echo'));
    assert.ok(ALLOWED_CLI_COMMANDS.includes('node'));
    assert.ok(!ALLOWED_CLI_COMMANDS.includes('unauthorized_tool'));

    const unlistedAdapter = new CliProcessAdapter('unauthorized', {
      command: 'unauthorized_tool'
    });

    const probeRes = await unlistedAdapter.probe();
    assert.strictEqual(probeRes.ready, false);
    assert.match(probeRes.reason, /allowlist/i);

    await assert.rejects(
      async () => {
        await unlistedAdapter.send({ requestId: 'req_unauth_1', prompt: 'test' });
      },
      /allowlist/i
    );

    const allowedAdapter = new CliProcessAdapter('allowed', {
      command: 'echo'
    });
    const allowedProbe = await allowedAdapter.probe();
    assert.strictEqual(allowedProbe.ready, true);
  });

  await t.test('3. Process-tree termination kills grandchild process on cancel', async () => {
    const adapter = new CliProcessAdapter('tree-kill', {
      command: 'node'
    });

    // Grandchild script: child spawns grandchild node script that runs sleep loop
    const script = `
      const { spawn } = require('child_process');
      const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
        stdio: 'ignore'
      });
      console.log(JSON.stringify({ grandchildPid: grandchild.pid }));
      setInterval(() => {}, 1000);
    `;

    let grandchildPid = null;
    const observer = {
      onPartialText: (text) => {
        try {
          const parsed = JSON.parse(text.trim());
          if (parsed.grandchildPid) grandchildPid = parsed.grandchildPid;
        } catch {}
      }
    };

    const sendPromise = adapter.send({
      requestId: 'req_tree_cancel_1',
      args: ['-e', script],
      observer
    });

    // Wait until grandchild is spawned
    const startWait = Date.now();
    while (!grandchildPid && Date.now() - startWait < 5000) {
      await new Promise(r => setTimeout(r, 50));
    }

    assert.ok(grandchildPid, 'Grandchild PID must have been captured');

    // Verify grandchild is currently alive
    let grandchildAlive = true;
    try {
      process.kill(grandchildPid, 0);
    } catch {
      grandchildAlive = false;
    }
    assert.strictEqual(grandchildAlive, true, 'Grandchild must be alive before cancel');

    // Cancel the parent task
    const cancelRes = await adapter.cancel('req_tree_cancel_1');
    assert.strictEqual(cancelRes.cancelled, true);

    await sendPromise;

    // Allow grace period for process group SIGTERM / SIGKILL
    await new Promise(r => setTimeout(r, 350));

    // Verify grandchild process is dead
    let grandchildDead = false;
    try {
      process.kill(grandchildPid, 0);
    } catch (err) {
      if (err.code === 'ESRCH') grandchildDead = true;
    }
    assert.strictEqual(grandchildDead, true, `Grandchild process ${grandchildPid} must be terminated after task cancellation`);
  });
});
