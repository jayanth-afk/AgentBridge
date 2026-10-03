import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AuditLogger } from '../src/audit-logger.js';

const helper = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers', 'worker-process.js');

function startWorker(dbPath, agentId) {
  const child = spawn(process.execPath, [helper, 'worker', dbPath, agentId], {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  let stdout = '';
  let stderr = '';
  const timings = {
    wakes: [],
    claims: [],
    completions: []
  };

  const readyPromise = new Promise((resolve, reject) => {
    const onData = (d) => {
      const text = d.toString();
      stdout += text;

      const wakeMatches = text.matchAll(/TIMING_B_WAKE:({.+})/g);
      for (const m of wakeMatches) {
        try { timings.wakes.push(JSON.parse(m[1])); } catch {}
      }

      const claimMatches = text.matchAll(/TIMING_B_CLAIM:({.+})/g);
      for (const m of claimMatches) {
        try { timings.claims.push(JSON.parse(m[1])); } catch {}
      }

      const compMatches = text.matchAll(/TIMING_B_COMPLETE:({.+})/g);
      for (const m of compMatches) {
        try { timings.completions.push(JSON.parse(m[1])); } catch {}
      }

      if (text.includes(`WORKER_READY:${agentId}`)) {
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`Worker ${agentId} exited with code ${code}: ${stderr}`));
      }
    });
  });

  return {
    child,
    timings,
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
      let timing = null;
      const match = stdout.match(/REQUEST_RESULT:(.+)/);
      if (match) {
        try {
          result = JSON.parse(match[1]);
        } catch {}
      }
      const timingMatch = stdout.match(/REQUEST_TIMING:(.+)/);
      if (timingMatch) {
        try {
          timing = JSON.parse(timingMatch[1]);
        } catch {}
      }
      resolve({ code, stdout, stderr, result, timing });
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
    // Process A directly awaits correlated response without calling check_inbox, claim_task, or get_task_status
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

    // 3. Exact Instrument Calculations (Audit #1)
    const logger = new AuditLogger(dbPath);
    const reqEvent = logger.db.prepare("SELECT * FROM bridge_events WHERE request_id = ? AND type = 'request_created'").get(resA.result.requestId);
    const respEvent = logger.db.prepare("SELECT * FROM bridge_events WHERE request_id = ? AND type = 'response_delivered'").get(resA.result.requestId);

    const t0 = resA.timing?.t0;
    const tDelivery = resA.timing?.tDelivery;
    const tEventInserted = reqEvent ? new Date(reqEvent.timestamp).getTime() : t0;
    const tResponseEvent = respEvent ? new Date(respEvent.timestamp).getTime() : tDelivery;

    const bWake = workerB.timings.wakes[0]?.timestamp || tEventInserted;
    const bClaim = workerB.timings.claims[0]?.timestamp || bWake;
    const bCompletion = workerB.timings.completions[0]?.timestamp || tResponseEvent;

    // Durations
    const dRequestToWake = Math.max(0, bWake - t0);
    const dWakeToProcessing = Math.max(0, bClaim - bWake);
    const dProcessingToResponse = Math.max(0, bCompletion - bClaim);
    const dResponseToDelivery = Math.max(0, tDelivery - bCompletion);
    const totalRoundTrip = tDelivery - t0;

    // Log instrumented metrics
    // console.log({
    //   t0_requestCreated: t0,
    //   t1_eventInserted: tEventInserted,
    //   t2_bWake: bWake,
    //   t3_bClaim: bClaim,
    //   t4_bCompletion: bCompletion,
    //   t5_responseEvent: tResponseEvent,
    //   t6_aDelivery: tDelivery,
    //   dRequestToWake_ms: dRequestToWake,
    //   dWakeToProcessing_ms: dWakeToProcessing,
    //   dProcessingToResponse_ms: dProcessingToResponse,
    //   dResponseToDelivery_ms: dResponseToDelivery,
    //   totalRoundTrip_ms: totalRoundTrip
    // });

    assert.ok(totalRoundTrip < 5000, `Total round trip was ${totalRoundTrip}ms`);
    assert.ok(workerB.timings.claims.length >= 1, 'Worker B must have claimed task');
    assert.ok(workerB.timings.completions.length >= 1, 'Worker B must have completed task');

    logger.close();
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

  await t.test('Multi-Agent Peer Network (A -> B, B -> A, A -> C, C -> B)', async () => {
    // Start 3 independent OS worker processes: A, B, C
    const workerA = startWorker(dbPath, 'chatgpt-desktop');
    const workerB = startWorker(dbPath, 'antigravity-ide');
    const workerC = startWorker(dbPath, 'claude-desktop');

    await Promise.all([workerA.ready, workerB.ready, workerC.ready]);

    // 1. A asks B
    const resAB = await runRequester(dbPath, 'chatgpt-desktop', 'antigravity-ide', 'math_double 10');
    assert.strictEqual(resAB.code, 0);
    assert.ok(resAB.result.response.includes('"result":20'));
    assert.ok(resAB.result.response.includes('"answeredBy":"antigravity-ide"'));

    // 2. B asks A
    const resBA = await runRequester(dbPath, 'antigravity-ide', 'chatgpt-desktop', 'math_double 15');
    assert.strictEqual(resBA.code, 0);
    assert.ok(resBA.result.response.includes('"result":30'));
    assert.ok(resBA.result.response.includes('"answeredBy":"chatgpt-desktop"'));

    // 3. A asks C
    const resAC = await runRequester(dbPath, 'chatgpt-desktop', 'claude-desktop', 'math_double 25');
    assert.strictEqual(resAC.code, 0);
    assert.ok(resAC.result.response.includes('"result":50'));
    assert.ok(resAC.result.response.includes('"answeredBy":"claude-desktop"'));

    // 4. C asks B
    const resCB = await runRequester(dbPath, 'claude-desktop', 'antigravity-ide', 'math_double 35');
    assert.strictEqual(resCB.code, 0);
    assert.ok(resCB.result.response.includes('"result":70'));
    assert.ok(resCB.result.response.includes('"answeredBy":"antigravity-ide"'));

    workerA.stop();
    workerB.stop();
    workerC.stop();
  });
});
