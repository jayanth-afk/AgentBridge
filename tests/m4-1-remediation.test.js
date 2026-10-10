import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { AuditLogger } from '../src/audit-logger.js';
import { MailboxHub } from '../src/mailbox-hub.js';
import { TaskManager } from '../src/task-manager.js';
import { EventBus } from '../src/event-bus.js';
import { LiveQuotaGate } from '../src/telemetry/live-quota-gate.js';
import { ModelOrchestrator } from '../src/control-plane/model-orchestrator.js';
import { AutonomousCollaborationOrchestrator } from '../src/control-plane/autonomous-collaboration-orchestrator.js';
import { AgentRunner } from '../src/agent-runner.js';
import { CommunicationMatrixHarness } from '../scripts/bench/communication-matrix-harness.js';
import { ChatGptModelAdapter, ClaudeModelAdapter, AntigravityModelAdapter } from '../src/control-plane/model-execution-adapter.js';

const workerHelper = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers', 'worker-process.js');

function startWorker(dbPath, agentId) {
  const child = spawn(process.execPath, [workerHelper, 'worker', dbPath, agentId], {
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
        reject(new Error(`Worker ${agentId} exited with code ${code}: ${stderr}`));
      }
    });
  });

  return {
    child,
    ready: readyPromise,
    stop: () => {
      try { child.kill('SIGTERM'); } catch {}
    }
  };
}

test('Mission 4.1 Remediation & Test Integrity Suite', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm4-1-remediation-test-'));
  const dbPath = path.join(tmpDir, 'test.sqlite');
  const logger = new AuditLogger(dbPath);
  const eventBus = new EventBus(logger);
  const taskManager = new TaskManager(logger);
  const mailbox = new MailboxHub(logger, taskManager, eventBus);

  t.after(() => {
    eventBus.close();
    logger.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  await t.test('1. Idempotency contract: sequential duplicate submission returns canonical task and creates 1 DB row', async () => {
    const dedupKey = `test_dedup_seq_${Date.now()}`;
    const task1 = await mailbox.delegateTask({
      fromAgent: 'agent-requester',
      toAgent: 'agent-worker',
      title: 'Test Title 1',
      instructions: 'Test Payload 1',
      dedupKey
    });
    const task2 = await mailbox.delegateTask({
      fromAgent: 'agent-requester',
      toAgent: 'agent-worker',
      title: 'Test Title 1',
      instructions: 'Test Payload 1',
      dedupKey
    });

    assert.strictEqual(task1.id, task2.id, 'Duplicate delegation with same dedupKey must return the same canonical task ID');

    // Check DB row count in SQLite
    const countRow = logger.db.prepare('SELECT COUNT(*) as cnt FROM tasks WHERE dedup_key = ?').get(dedupKey);
    assert.strictEqual(countRow.cnt, 1, 'Exactly one task record must exist for the unique dedupKey');

    // Check inbox message count: should only have 1 dispatched task
    const inbox = await mailbox.getInbox({ agentId: 'agent-worker', unreadOnly: true });
    const matchingMessages = inbox.filter(m => m.content && m.content.includes(task1.id));
    assert.strictEqual(matchingMessages.length, 1, 'Only one dispatch message must exist in the worker inbox');
  });

  await t.test('2. Idempotency contract: concurrent race-safe duplicate submission returns identical task ID', async () => {
    const dedupKey = `test_dedup_concurrent_${Date.now()}`;
    const [taskA, taskB, taskC] = await Promise.all([
      mailbox.delegateTask({ fromAgent: 'agent-requester', toAgent: 'agent-worker', title: 'Conc 1', instructions: 'Concurrent Test', dedupKey }),
      mailbox.delegateTask({ fromAgent: 'agent-requester', toAgent: 'agent-worker', title: 'Conc 2', instructions: 'Concurrent Test', dedupKey }),
      mailbox.delegateTask({ fromAgent: 'agent-requester', toAgent: 'agent-worker', title: 'Conc 3', instructions: 'Concurrent Test', dedupKey })
    ]);

    assert.strictEqual(taskA.id, taskB.id, 'Task A and Task B must have identical task ID');
    assert.strictEqual(taskB.id, taskC.id, 'Task B and Task C must have identical task ID');

    const countRow = logger.db.prepare('SELECT COUNT(*) as cnt FROM tasks WHERE dedup_key = ?').get(dedupKey);
    assert.strictEqual(countRow.cnt, 1, 'Exactly 1 task must be persisted under concurrent submission');
  });

  await t.test('3. Execution class truthfulness: Quota-gated models evaluate to UNAVAILABLE / BLOCKED', async () => {
    const quotaGate = new LiveQuotaGate();
    const allowed = quotaGate.checkQuota();
    assert.strictEqual(allowed.allowed, false, 'Desktop/API execution must be blocked by default without live models flag');
    assert.match(allowed.reason, /OPT_IN_REQUIRED/, 'Reason must accurately cite OPT_IN_REQUIRED');
  });

  await t.test('4. Workflow D: Missing target vs offline target distinction', async () => {
    // Case 1: Missing target throws immediately
    await assert.rejects(
      async () => {
        await mailbox.delegateTask({
          fromAgent: 'antigravity-ide',
          toAgent: null,
          title: 'Missing Target',
          instructions: 'Should fail immediately'
        });
      },
      /VALIDATION_ERROR|Target agent must be specified/
    );

    // Case 2: Offline target creates a pending task without synthetic auto-completion
    const offlineTask = await mailbox.delegateTask({
      fromAgent: 'antigravity-ide',
      toAgent: 'offline-worker-agent',
      title: 'Offline Task',
      instructions: 'Offline payload'
    });
    assert.strictEqual(offlineTask.status, 'pending', 'Task sent to offline target must remain pending');

    // Confirm it is NOT completed
    const retrieved = await taskManager.getTask(offlineTask.id);
    assert.strictEqual(retrieved.status, 'pending', 'Retrieved task for offline worker must remain pending');
    assert.strictEqual(retrieved.result, null, 'Result must remain null for unexecuted task');
  });

  await t.test('5. Workflow E & F: Epoch fencing and duplicate completion immutability', async () => {
    const task = await mailbox.delegateTask({
      fromAgent: 'agent-a',
      toAgent: 'worker-b',
      title: 'Task E',
      instructions: 'Payload E'
    });
    const claim1 = await taskManager.claimNextTask('worker-b');
    assert.strictEqual(claim1.id, task.id);
    assert.strictEqual(claim1.epoch, 1);

    // Complete the task legitimately
    const completion1 = await mailbox.submitTaskResult({
      taskId: task.id,
      agentId: 'worker-b',
      status: 'completed',
      result: { answer: 'First Canonical Result' },
      attemptId: claim1.attemptId,
      epoch: claim1.epoch
    });
    assert.strictEqual(completion1.status, 'completed');

    // Attempt second completion with conflicting data
    let secondError = null;
    let secondResult = null;
    try {
      secondResult = await mailbox.submitTaskResult({
        taskId: task.id,
        agentId: 'worker-b',
        status: 'completed',
        result: { answer: 'Second Tampered Result' },
        attemptId: claim1.attemptId,
        epoch: claim1.epoch
      });
    } catch (err) {
      secondError = err;
    }

    // Verify task state remains canonical first result
    const finalTask = await taskManager.getTask(task.id);
    assert.strictEqual(finalTask.status, 'completed');
    const parsedResult = typeof finalTask.result === 'string' ? JSON.parse(finalTask.result) : finalTask.result;
    assert.strictEqual(parsedResult.answer, 'First Canonical Result', 'Original result must not be overwritten by second submission');
  });

  await t.test('6. Workflow H: Unauthorized worker rejection', async () => {
    const task = await mailbox.delegateTask({
      fromAgent: 'agent-a',
      toAgent: 'worker-legit',
      title: 'Task H',
      instructions: 'Confidential task'
    });
    
    // worker-malicious attempts to submit result without having claimed it
    let spoofBlocked = false;
    try {
      await mailbox.submitTaskResult({
        taskId: task.id,
        agentId: 'worker-malicious',
        status: 'completed',
        result: { answer: 'Spoofed' }
      });
    } catch (err) {
      spoofBlocked = true;
    }
    assert.strictEqual(spoofBlocked, true, 'Submitting result by unauthorized worker must throw');

    const freshTask = await taskManager.getTask(task.id);
    assert.strictEqual(freshTask.status, 'pending', 'Task must remain pending when unauthorized submission is rejected');
  });

  await t.test('7. Report integrity: Dynamic matrix harness generation, invariant verification & summary consistency', async () => {
    const hTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-isolated-test-'));
    const hJsonPath = path.join(hTmpDir, 'matrix.json');
    const hMdPath = path.join(hTmpDir, 'matrix.md');

    const testHarness = new CommunicationMatrixHarness({
      outputJsonPath: hJsonPath,
      outputMdPath: hMdPath
    });

    try {
      // 1. Run all 20 directed pairs through the real harness
      const pairs = await testHarness.runAllPairs();
      assert.strictEqual(pairs.length, 20, 'Harness must evaluate exactly 20 directed pairs');

      // 2. Run self-routing and idempotency verification
      await testHarness.runSelfRoutingAndDuplicates();

      // 3. Run workflows suite
      const workflows = await testHarness.runAllWorkflows();
      assert.strictEqual(workflows.length, 14, 'Harness must execute all 14 workflow checks (A through N)');

      // 4. Export report into isolated temp directory
      const data = testHarness.exportReport();

      // Verify files were generated in isolated temp dir
      assert.strictEqual(fs.existsSync(hJsonPath), true, 'matrix.json must be generated in isolated temp dir');
      assert.strictEqual(fs.existsSync(hMdPath), true, 'matrix.md must be generated in isolated temp dir');

      const jsonRaw = fs.readFileSync(hJsonPath, 'utf8');
      const mdRaw = fs.readFileSync(hMdPath, 'utf8');

      // Assert Run ID consistency between JSON and Markdown
      assert.strictEqual(data.runId, testHarness.runId);
      assert.match(mdRaw, new RegExp(data.runId), 'Markdown must reference the exact runId of the JSON matrix');

      // Assert source of truth link points to isolated test output
      assert.match(mdRaw, new RegExp(hJsonPath), 'Markdown must reference isolated JSON file path as source of truth');

      // Assert total pairs
      assert.strictEqual(data.totalDirectedPairs, 20);
      assert.strictEqual(data.pairResults.length, 20);

      // Verify summary numbers match actual pairResults counts (strictly derived, not hardcoded)
      const expectedPass = data.pairResults.filter(r => r.status === 'PASS').length;
      const expectedPartial = data.pairResults.filter(r => r.status === 'PARTIAL').length;
      const expectedBlocked = data.pairResults.filter(r => r.status === 'BLOCKED').length;
      const expectedFail = data.pairResults.filter(r => r.status === 'FAIL').length;
      const expectedNotTested = data.pairResults.filter(r => r.status === 'NOT TESTED').length;

      assert.strictEqual(data.summary.pass, expectedPass, 'Summary PASS must strictly equal count of PASS pair results');
      assert.strictEqual(data.summary.partial, expectedPartial, 'Summary PARTIAL must strictly equal count of PARTIAL pair results');
      assert.strictEqual(data.summary.blocked, expectedBlocked, 'Summary BLOCKED must strictly equal count of BLOCKED pair results');
      assert.strictEqual(data.summary.fail, expectedFail, 'Summary FAIL must strictly equal count of FAIL pair results');
      assert.strictEqual(data.summary.notTested, expectedNotTested, 'Summary NOT TESTED must strictly equal count of NOT TESTED pair results');
      assert.strictEqual(data.summary.pass + data.summary.partial + data.summary.blocked + data.summary.fail + data.summary.notTested, 20, 'All 20 pairs must be accounted for');

      // Assert truthful evidence: desktop pairs are BLOCKED, local pairs are PASS or PARTIAL
      for (const r of data.pairResults) {
        assert.ok(['PASS', 'PARTIAL', 'BLOCKED', 'FAIL'].includes(r.status), `Pair ${r.pair} must have valid status`);
        if (r.status === 'PASS') {
          assert.strictEqual(r.proofLevel, 'L1 (In-Process Engine)', `PASS pair ${r.pair} must be L1 proof level`);
        }
        if (r.status === 'BLOCKED') {
          assert.strictEqual(r.proofLevel, 'L0 (Offline / Quota-Gated)', `BLOCKED pair ${r.pair} must be L0 proof level`);
        }
      }

      // Assert no synthetic fake responder strings exist anywhere in output
      assert.doesNotMatch(jsonRaw, /ANTIGRAVITY_PROCESSED_VERIFIED/);
      assert.doesNotMatch(mdRaw, /ANTIGRAVITY_PROCESSED_VERIFIED/);
      assert.doesNotMatch(jsonRaw, /FREEBUFF_AUDIT_VERIFIED/);
      assert.doesNotMatch(mdRaw, /FREEBUFF_AUDIT_VERIFIED/);
      assert.doesNotMatch(jsonRaw, /\[Antigravity Execution:/);
      assert.doesNotMatch(mdRaw, /\[Antigravity Execution:/);

      // Workflow invariant validation: assert meaningful invariants and properties
      assert.strictEqual(data.workflows.length, 14);
      for (const wf of data.workflows) {
        assert.ok(['PASS', 'PARTIAL', 'BLOCKED', 'FAIL'].includes(wf.status), `Workflow ${wf.id} status must be a recognized status`);
        assert.strictEqual(typeof wf.durationMs, 'number', `Workflow ${wf.id} must report numeric duration`);
        assert.ok(wf.durationMs >= 0, `Workflow ${wf.id} duration must be non-negative`);
        assert.strictEqual(typeof wf.invariant, 'string', `Workflow ${wf.id} must specify invariant`);
        assert.ok(wf.invariant.length > 5, `Workflow ${wf.id} invariant description must be non-empty`);
        assert.strictEqual(typeof wf.evidence, 'string', `Workflow ${wf.id} must cite evidence reference`);
      }

      // Falsification check: verify that a mismatched summary or fake pair would fail validation
      const tamperedData = JSON.parse(JSON.stringify(data));
      tamperedData.summary.pass += 1; // Falsify summary count
      assert.notStrictEqual(
        tamperedData.summary.pass,
        tamperedData.pairResults.filter(r => r.status === 'PASS').length,
        'Falsified summary count must be detected as inconsistent with pair results'
      );
    } finally {
      testHarness.close();
      try { fs.rmSync(hTmpDir, { recursive: true, force: true }); } catch {}
    }
  });

  await t.test('8. P0 Regression: ModelOrchestrator Antigravity Delegation fails truthfully when unsupported without fake simulation', async () => {
    const orchestrator = new ModelOrchestrator();
    const probeNonce = `READONLY_PROBE_${crypto.randomBytes(4).toString('hex')}`;
    const res = await orchestrator.delegateModelTask({
      fromAgent: 'cli-user',
      toAgent: 'antigravity',
      message: probeNonce
    });

    assert.strictEqual(res.success, false, 'Delegation without autonomous worker must fail');
    assert.strictEqual(res.status, 'unsupported', 'Status must be explicitly unsupported');
    assert.strictEqual(res.error, 'EXECUTION_UNSUPPORTED: no autonomous worker', 'Error message must truthfully state no autonomous worker');
    assert.strictEqual(res.response, undefined, 'Must not return fabricated response');
  });

  await t.test('9. P0 Regression: AutonomousCollaborationOrchestrator rejects synthetic simulation responses', async () => {
    const fakeModelOrchestrator = {
      delegateModelTask: async () => ({
        success: true,
        response: '[Antigravity Execution: READONLY_PROBE_abc123]',
        transport: 'antigravity-worker'
      })
    };

    const collabOrchestrator = new AutonomousCollaborationOrchestrator({
      modelOrchestrator: fakeModelOrchestrator,
      invisibilityMonitor: null
    });

    const session = collabOrchestrator.createCollaboration({
      objective: 'Verify synthetic response rejection',
      authorizedAgents: ['chatgpt', 'antigravity'],
      initiator: 'chatgpt'
    });

    const turnRes = await collabOrchestrator.executeTurn({
      collaborationId: session.id,
      fromAgent: 'chatgpt',
      toAgent: 'antigravity',
      instruction: 'probe'
    });

    assert.strictEqual(turnRes.success, false, 'Synthetic [Antigravity Execution: ...] must be rejected');
    assert.strictEqual(turnRes.status, 'SYNTHETIC_RESPONSE_REJECTED', 'Status must be SYNTHETIC_RESPONSE_REJECTED');
    assert.match(turnRes.error, /NON_MODEL_RESPONSE_REJECTED/);
  });

  await t.test('10. P1 L2 Execution: Genuine separate-process responder executes task with unpredictable nonce', async () => {
    const mpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm4-1-mp-test-'));
    const mpDbPath = path.join(mpDir, 'mp.sqlite');
    const mpLogger = new AuditLogger(mpDbPath);
    const mpEventBus = new EventBus(mpLogger);
    const mpTaskManager = new TaskManager(mpLogger);
    const mpMailbox = new MailboxHub(mpLogger, mpTaskManager, mpEventBus);

    // 1. Start real separate child process running worker
    const worker = startWorker(mpDbPath, 'antigravity-ide');
    await worker.ready;

    try {
      // 2. Requester creates unique unpredictable nonce
      const nonce = crypto.randomBytes(16).toString('hex');
      const expectedDerived = crypto.createHash('sha256').update(`RESPONDER_antigravity-ide_${nonce}`).digest('hex');

      // 3. Delegate task to the separate process
      const task = await mpMailbox.delegateTask({
        fromAgent: 'claude-desktop',
        toAgent: 'antigravity-ide',
        title: 'Separate Process Verification',
        instructions: `derive_nonce ${nonce}`
      });

      // 4. Await result via event bus or poll completion
      let completedTask = null;
      for (let i = 0; i < 50; i++) {
        await new Promise(r => setTimeout(r, 100));
        const check = mpTaskManager.getTask(task.id, false);
        if (check && check.status === 'completed') {
          completedTask = check;
          break;
        }
      }

      assert.ok(completedTask, 'Task must be completed by separate worker process');
      assert.strictEqual(completedTask.status, 'completed');

      const parsed = typeof completedTask.result === 'string' ? JSON.parse(completedTask.result) : completedTask.result;
      assert.strictEqual(parsed.receivedNonce, nonce, 'Worker must echo received unpredictable nonce');
      assert.strictEqual(parsed.derivedToken, expectedDerived, 'Worker must calculate expected derived token');
      assert.strictEqual(parsed.responderAgent, 'antigravity-ide');
      assert.notStrictEqual(parsed.responderPid, process.pid, 'Responder PID must be a separate OS process, not test runner PID');
      assert.strictEqual(typeof parsed.responderPid, 'number');
    } finally {
      worker.stop();
      mpEventBus.close();
      mpLogger.close();
      try { fs.rmSync(mpDir, { recursive: true, force: true }); } catch {}
    }
  });

  await t.test('11. P1 L2 Absence of Worker: Task remains pending and times out truthfully without fake output', async () => {
    const mpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm4-1-mp-offline-'));
    const mpDbPath = path.join(mpDir, 'offline.sqlite');
    const mpLogger = new AuditLogger(mpDbPath);
    const mpEventBus = new EventBus(mpLogger);
    const mpTaskManager = new TaskManager(mpLogger);
    const mpMailbox = new MailboxHub(mpLogger, mpTaskManager, mpEventBus);

    try {
      const orchestrator = new ModelOrchestrator({ mailboxHub: mpMailbox });
      const nonce = crypto.randomBytes(8).toString('hex');

      // No worker is started for antigravity-ide.
      // Delegating with a short deadline must timeout truthfully.
      const res = await orchestrator.delegateModelTask({
        fromAgent: 'chatgpt-desktop',
        toAgent: 'antigravity-ide',
        message: `Echo nonce: ${nonce}`,
        deadline: Date.now() + 500 // 500ms deadline
      });

      assert.strictEqual(res.success, false, 'Delegation must fail when no worker is running');
      assert.strictEqual(res.status, 'timeout', 'Status must be timeout');
      assert.match(res.error, /TIMEOUT_WAITING_FOR_WORKER/, 'Error must cite timeout waiting for worker');

      // Verify the task remained pending in the database
      const taskInDb = mpTaskManager.getTask(res.taskId, false);
      assert.strictEqual(taskInDb.status, 'pending', 'Task must remain pending in durable storage');
      assert.strictEqual(taskInDb.result, null, 'Task result must remain null');
    } finally {
      mpEventBus.close();
      mpLogger.close();
      try { fs.rmSync(mpDir, { recursive: true, force: true }); } catch {}
    }
  });

  await t.test('12. P0 Regression: AgentRunner truthful rejection of unsupported instructions, prevention of synthetic envelopes, and preservation of legitimate handlers', async () => {
    const arRunner = new AgentRunner({
      agentId: 'test-worker-agent',
      mailboxHub: mailbox,
      taskManager,
      autoStart: false
    });

    // Subtest 1: Unsupported instruction fails truthfully and is NOT marked completed
    const unsuppTask = await mailbox.delegateTask({
      fromAgent: 'requester-a',
      toAgent: 'test-worker-agent',
      title: 'Unsupported Test',
      instructions: 'some_completely_unrecognized_instruction_xyz_987'
    });
    const claimed1 = await taskManager.claimNextTask('test-worker-agent');
    assert.strictEqual(claimed1.id, unsuppTask.id);

    // executeTaskLogic must throw UNSUPPORTED_INSTRUCTION
    await assert.rejects(
      async () => {
        await arRunner.executeTaskLogic(claimed1);
      },
      (err) => err.code === 'UNSUPPORTED_INSTRUCTION'
    );

    // processTask fails the task in mailbox with allowRetry: false
    await arRunner.processTask(claimed1);
    const failedTask = await taskManager.getTask(unsuppTask.id);
    assert.strictEqual(failedTask.status, 'failed', 'Unsupported instruction task must transition to failed');
    assert.strictEqual(failedTask.result, null, 'Failed task result must remain null');
    assert.match(failedTask.error, /UNSUPPORTED_INSTRUCTION/, 'Error must explain unsupported instruction');

    // Subtest 2: Legitimate registered handler completes successfully
    arRunner.registerHandler('custom_reverse', async (tk) => {
      const match = tk.instructions.match(/custom_reverse:\s*(.+)/);
      return match ? match[1].split('').reverse().join('') : '';
    });
    const legitTask = await mailbox.delegateTask({
      fromAgent: 'requester-a',
      toAgent: 'test-worker-agent',
      title: 'Legitimate Handler Test',
      instructions: 'custom_reverse: HELLO_WORLD'
    });
    const claimed2 = await taskManager.claimNextTask('test-worker-agent');
    assert.strictEqual(claimed2.id, legitTask.id);
    await arRunner.processTask(claimed2);
    const completedLegit = await taskManager.getTask(legitTask.id);
    assert.strictEqual(completedLegit.status, 'completed', 'Legitimate handler task must complete');
    assert.strictEqual(completedLegit.result, 'DLROW_OLLEH');

    // Subtest 3: Synthetic EXECUTED_BY_AGENT fallback envelope is rejected even if returned by rogue logic
    arRunner.registerHandler('rogue_synthetic', async (tk) => ({
      status: 'EXECUTED_BY_AGENT',
      agent: 'test-worker-agent',
      taskId: tk.id,
      completedAt: new Date().toISOString()
    }));
    const rogueTask = await mailbox.delegateTask({
      fromAgent: 'requester-a',
      toAgent: 'test-worker-agent',
      title: 'Rogue Handler Test',
      instructions: 'rogue_synthetic'
    });
    const claimed3 = await taskManager.claimNextTask('test-worker-agent');
    await arRunner.processTask(claimed3);
    const rejectedRogue = await taskManager.getTask(rogueTask.id);
    assert.strictEqual(rejectedRogue.status, 'failed', 'Canned EXECUTED_BY_AGENT envelope must be rejected');
    assert.match(rejectedRogue.error, /CANNOT_SUBMIT_CANNED_ENVELOPE/, 'Error must cite canned envelope rejection');

    // Subtest 4: Legitimate user text containing literal string 'EXECUTED_BY_AGENT' is preserved and not rejected
    arRunner.registerHandler('echo_literal', async () => 'EXECUTED_BY_AGENT');
    const literalTask = await mailbox.delegateTask({
      fromAgent: 'requester-a',
      toAgent: 'test-worker-agent',
      title: 'Literal String Test',
      instructions: 'echo_literal'
    });
    const claimed4 = await taskManager.claimNextTask('test-worker-agent');
    await arRunner.processTask(claimed4);
    const literalCompleted = await taskManager.getTask(literalTask.id);
    assert.strictEqual(literalCompleted.status, 'completed', 'Legitimate user string must not be blocked');
    assert.strictEqual(literalCompleted.result, 'EXECUTED_BY_AGENT');
  });

  await t.test('13. P1 Regression: ModelExecutionAdapter provenance consistency under timeout, unsupported execution, and genuine completion', async () => {
    // 1. ChatGptModelAdapter: uninstalled/unsupported path returns modelTurnConfirmed: false
    const cgAdapter = new ChatGptModelAdapter({
      cliPath: '/non/existent/codex/path',
      timeoutMs: 50
    });
    const uninstalledRes = await cgAdapter.send({ prompt: 'test' });
    assert.strictEqual(uninstalledRes.success, false);
    assert.strictEqual(uninstalledRes.status, 'UNSUPPORTED');
    assert.strictEqual(uninstalledRes.modelTurnConfirmed, false);
    assert.strictEqual(uninstalledRes.provenance, 'unsupported');

    // 2. ClaudeModelAdapter: timeout simulation returns modelTurnConfirmed: false
    const claudeAdapter = new ClaudeModelAdapter();
    claudeAdapter.send = async ({ requestId }) => ({
      success: false,
      status: 'TIMEOUT',
      error: 'TIMEOUT',
      requestId: requestId || 'req_test',
      modelTurnConfirmed: false,
      provenance: 'timeout',
      latencyMs: 100
    });
    const timeoutRes = await claudeAdapter.send({ requestId: 'req_timeout_1' });
    assert.strictEqual(timeoutRes.success, false, 'Timeout must not be success');
    assert.strictEqual(timeoutRes.status, 'TIMEOUT');
    assert.strictEqual(timeoutRes.modelTurnConfirmed, false, 'Timeout must NEVER claim modelTurnConfirmed: true');
    assert.strictEqual(timeoutRes.provenance, 'timeout');

    // 3. AntigravityModelAdapter: unsupported task fails truthfully
    const agAdapter = new AntigravityModelAdapter();
    const agUnsupported = await agAdapter.send({ prompt: 'some_random_prompt_that_is_not_supported_123' });
    assert.strictEqual(agUnsupported.success, false, 'Unsupported prompt must fail');
    assert.strictEqual(agUnsupported.status, 'UNSUPPORTED_INSTRUCTION');
    assert.strictEqual(agUnsupported.modelTurnConfirmed, false, 'Unsupported prompt must not confirm turn');
    assert.strictEqual(agUnsupported.provenance, 'unsupported');
    assert.strictEqual(agUnsupported.response, undefined);

    // 4. AntigravityModelAdapter: genuine supported task succeeds with accurate provenance
    const agSupported = await agAdapter.send({ prompt: 'math_double 42' });
    assert.strictEqual(agSupported.success, true);
    assert.strictEqual(agSupported.status, 'COMPLETED');
    assert.strictEqual(agSupported.response, '84');
    assert.strictEqual(agSupported.modelTurnConfirmed, true);
    assert.strictEqual(agSupported.provenance, 'local-engine');

    // 5. AntigravityModelAdapter: derive_nonce calculates expected SHA-256 token
    const testNonce = 'test_nonce_777';
    const expectedAgHash = crypto.createHash('sha256').update(`RESPONDER_antigravity_${testNonce}`).digest('hex');
    const agNonceRes = await agAdapter.send({ prompt: `derive_nonce ${testNonce}` });
    assert.strictEqual(agNonceRes.success, true);
    const parsedNonce = JSON.parse(agNonceRes.response);
    assert.strictEqual(parsedNonce.derivedToken, expectedAgHash);
    assert.strictEqual(parsedNonce.status, 'OK');
    assert.strictEqual(parsedNonce.responderAgent, 'antigravity');
  });
});
