import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const helper = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers', 'worker-process.js');

function startWorker(dbPath, agentId) {
  const child = spawn(process.execPath, [helper, 'worker', dbPath, agentId], {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  let stdout = '';
  let stderr = '';

  const readyPromise = new Promise((resolve, reject) => {
    const onData = (d) => {
      const text = d.toString();
      stdout += text;
      if (text.includes(`WORKER_READY:${agentId}`)) {
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`Worker exited with code ${code}: ${stderr}`));
      }
    });
  });

  return {
    child,
    ready: readyPromise,
    stop: () => {
      child.kill('SIGTERM');
    }
  };
}

function runRequester(dbPath, fromAgent, toAgent, question) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [helper, 'requester', dbPath, fromAgent, toAgent, question], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('close', (code) => {
      let result = null;
      const match = stdout.match(/REQUEST_RESULT:(.+)/);
      if (match) {
        try {
          result = JSON.parse(match[1]);
        } catch {}
      }
      resolve({ code, stdout, stderr, result });
    });
  });
}

test('Multi-Process Cross-Process Event Bus Acceptance Suite', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-mp-events-'));
  const dbPath = path.join(dir, 'mp_events.sqlite');

  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  });

  await t.test('Real Multi-Process Autonomous Request/Response: Process A -> Process B -> Process A', async () => {
    // 1. Spawn Worker Process B (antigravity-ide)
    const workerB = startWorker(dbPath, 'antigravity-ide');
    await workerB.ready;

    // 2. Spawn Requester Process A (chatgpt-desktop) asking Process B a question
    // Process A directly awaits correlated response without calling check_inbox or polling!
    const resA = await runRequester(
      dbPath,
      'chatgpt-desktop',
      'antigravity-ide',
      'math_double 21'
    );

    assert.strictEqual(resA.code, 0, `Requester failed: ${resA.stderr}`);
    assert.ok(resA.result, 'Should have received parsed result');
    assert.strictEqual(resA.result.status, 'completed');
    assert.strictEqual(resA.result.fromAgent, 'chatgpt-desktop');
    assert.strictEqual(resA.result.toAgent, 'antigravity-ide');
    assert.ok(resA.result.response.includes('"result":42'));
    assert.ok(resA.result.response.includes('"answeredBy":"antigravity-ide"'));

    workerB.stop();
  });

  await t.test('Concurrent Multi-Process Requesters to Single Autonomous Worker Process', async () => {
    const workerB = startWorker(dbPath, 'antigravity-ide');
    await workerB.ready;

    // 2 different requester processes at the same time
    const [req1, req2] = await Promise.all([
      runRequester(dbPath, 'chatgpt-desktop', 'antigravity-ide', 'math_double 50'),
      runRequester(dbPath, 'claude-desktop', 'antigravity-ide', 'math_double 100')
    ]);

    assert.strictEqual(req1.code, 0);
    assert.strictEqual(req2.code, 0);
    assert.ok(req1.result.response.includes('"result":100'));
    assert.ok(req2.result.response.includes('"result":200'));

    workerB.stop();
  });
});
