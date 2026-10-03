import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';

import { CONFIG } from '../src/config.js';
import { AuditLogger } from '../src/audit-logger.js';
import { PermissionGuard } from '../src/permission-guard.js';
import { MailboxHub } from '../src/mailbox-hub.js';
import { ProjectController } from '../src/project-controller.js';
import { ConcurrencyManager } from '../src/concurrency-manager.js';
import { BridgeHttpServer } from '../src/http-server.js';
import { GuiAutomationAdapter } from '../src/gui-adapter.js';

const TEST_DB = path.join(CONFIG.DATA_DIR, 'integration_bridge.sqlite');
const TEST_WORKSPACE = CONFIG.TEST_WORKSPACE;

test('Complete 15-Point Connected Agent Integration Suite', async (t) => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  if (!fs.existsSync(TEST_WORKSPACE)) fs.mkdirSync(TEST_WORKSPACE, { recursive: true });

  const logger = new AuditLogger(TEST_DB);
  const guard = new PermissionGuard(CONFIG);
  const concurrency = new ConcurrencyManager();
  const mailbox = new MailboxHub(logger);
  const controller = new ProjectController(guard, logger, concurrency);
  const guiAdapter = new GuiAutomationAdapter();
  const httpServer = new BridgeHttpServer({
    port: 8999,
    host: '127.0.0.1',
    auditLogger: logger,
    permissionGuard: guard,
    mailboxHub: mailbox,
    projectController: controller
  });

  await httpServer.start();

  t.after(async () => {
    await httpServer.stop();
    logger.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  // Prepare disposable test files
  const claudeTestFile = path.join(TEST_WORKSPACE, 'claude_file.txt');
  const chatgptTestFile = path.join(TEST_WORKSPACE, 'chatgpt_file.txt');
  const sharedFile = path.join(TEST_WORKSPACE, 'shared_conflict_file.txt');

  await t.test('TEST 0: bridge_ping returns the configured liveness token', async () => {
    // Test HTTP endpoint call
    const res = await fetch('http://127.0.0.1:8999/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 100,
        method: 'tools/call',
        params: {
          name: 'bridge_ping',
          arguments: { agentId: 'chatgpt-desktop' }
        }
      })
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(data.result.content[0].text.includes(CONFIG.RESPONSE_TOKEN));
  });

  await t.test('TEST 1: Claude Desktop -> bridge -> read disposable file', async () => {
    fs.writeFileSync(claudeTestFile, 'Line 1: Claude Test\nLine 2: Data\nLine 3: End');
    const res = await controller.readFile(claudeTestFile, 'claude-desktop', 1, 3);
    assert.strictEqual(res.totalLines, 3);
    assert.ok(res.content.includes('Line 1: Claude Test'));
    assert.ok(typeof res.fileHash === 'string' && res.fileHash.length === 64);
  });

  await t.test('TEST 2: Claude Desktop -> bridge -> create disposable file', async () => {
    const newFile = path.join(TEST_WORKSPACE, 'claude_created.txt');
    if (fs.existsSync(newFile)) fs.unlinkSync(newFile);
    const res = await controller.createFile(newFile, 'claude-desktop', 'Created by Claude Desktop');
    assert.strictEqual(res.status, 'created');
    assert.strictEqual(fs.existsSync(newFile), true);
  });

  await t.test('TEST 3: Claude Desktop -> bridge -> edit disposable file', async () => {
    const editFile = path.join(TEST_WORKSPACE, 'claude_created.txt');
    const read = await controller.readFile(editFile, 'claude-desktop');
    const res = await controller.editFile(editFile, 'claude-desktop', 'Created by Claude Desktop', 'Edited by Claude Desktop', read.fileHash);
    assert.strictEqual(res.status, 'edited');
    const updated = fs.readFileSync(editFile, 'utf8');
    assert.strictEqual(updated, 'Edited by Claude Desktop');
  });

  await t.test('TEST 4: Claude Desktop -> bridge -> execute safe command', async () => {
    const res = await controller.executeCommand('echo "Claude safe command"', TEST_WORKSPACE, 'claude-desktop');
    assert.strictEqual(res.exitCode, 0);
    assert.strictEqual(res.stdout, 'Claude safe command');
  });

  await t.test('TEST 5: Claude -> bridge -> message -> Antigravity mailbox -> result', () => {
    const msg = mailbox.sendMessage({
      fromAgent: 'claude-desktop',
      toAgent: 'antigravity-ide',
      subject: 'Review request for module X',
      content: 'Can you inspect module X?'
    });
    assert.ok(msg.id);
    const inbox = mailbox.getInbox({ agentId: 'antigravity-ide', unreadOnly: true });
    const found = inbox.find(m => m.id === msg.id);
    assert.ok(found);
    assert.strictEqual(found.subject, 'Review request for module X');
  });

  await t.test('TEST 6: Antigravity -> bridge -> message -> Claude -> result', () => {
    const reply = mailbox.sendMessage({
      fromAgent: 'antigravity-ide',
      toAgent: 'claude-desktop',
      subject: 'Module X review complete',
      content: 'I verified the structure, looks solid.'
    });
    const claudeInbox = mailbox.getInbox({ agentId: 'claude-desktop', unreadOnly: true });
    const found = claudeInbox.find(m => m.id === reply.id);
    assert.ok(found);
    assert.strictEqual(found.content, 'I verified the structure, looks solid.');
  });

  await t.test('TEST 7: ChatGPT Desktop -> bridge -> read disposable file', async () => {
    fs.writeFileSync(chatgptTestFile, 'Line A: ChatGPT target\nLine B: Content');
    const res = await controller.readFile(chatgptTestFile, 'chatgpt-desktop', 1, 2);
    assert.strictEqual(res.totalLines, 2);
    assert.ok(res.content.includes('Line A: ChatGPT target'));
  });

  await t.test('TEST 8: ChatGPT Desktop -> bridge -> write disposable file', async () => {
    const createdByGpt = path.join(TEST_WORKSPACE, 'gpt_written.txt');
    if (fs.existsSync(createdByGpt)) fs.unlinkSync(createdByGpt);
    const res = await controller.createFile(createdByGpt, 'chatgpt-desktop', 'Written by ChatGPT Desktop');
    assert.strictEqual(res.status, 'created');
    assert.strictEqual(fs.existsSync(createdByGpt), true);
  });

  await t.test('TEST 9: ChatGPT -> Claude -> Claude response -> ChatGPT (Synchronous Peer Loop)', async () => {
    // Register Claude peer handler in mailbox
    mailbox.registerAgentHandler('claude-desktop', async (question) => {
      return `Claude analysis: evaluated '${question}' successfully.`;
    });

    const res = await mailbox.askAgent({
      fromAgent: 'chatgpt-desktop',
      toAgent: 'claude-desktop',
      question: 'Is the architectural split optimal?'
    });

    assert.strictEqual(res.mode, 'synchronous_peer_response');
    assert.ok(res.response.includes('Claude analysis: evaluated'));
  });

  await t.test('TEST 10: ChatGPT -> Antigravity -> result -> ChatGPT (Task Delegation Loop)', () => {
    const task = mailbox.delegateTask({
      fromAgent: 'chatgpt-desktop',
      toAgent: 'antigravity-ide',
      title: 'Run test verification in test-workspace',
      instructions: 'Please check that build passes'
    });

    // Antigravity picks up task and submits outcome
    const outcome = mailbox.updateTaskStatus({
      taskId: task.id,
      agentId: 'antigravity-ide',
      status: 'completed',
      result: 'Build clean, 0 errors'
    });

    assert.strictEqual(outcome.status, 'completed');
    const taskState = mailbox.getTask(task.id);
    assert.strictEqual(taskState.result, 'Build clean, 0 errors');
  });

  await t.test('TEST 11: Claude -> ChatGPT -> response -> Claude (Synchronous Peer Loop)', async () => {
    mailbox.registerAgentHandler('chatgpt-desktop', async (question) => {
      return `ChatGPT response: reviewed query '${question}' without issues.`;
    });

    const res = await mailbox.askAgent({
      fromAgent: 'claude-desktop',
      toAgent: 'chatgpt-desktop',
      question: 'Investigate potential edge cases in concurrency'
    });

    assert.strictEqual(res.mode, 'synchronous_peer_response');
    assert.ok(res.response.includes('ChatGPT response: reviewed query'));
  });

  await t.test('TEST 12: Two agents independently modify different disposable files', async () => {
    const fileA = path.join(TEST_WORKSPACE, 'file_a.txt');
    const fileB = path.join(TEST_WORKSPACE, 'file_b.txt');

    const resA = await controller.createFile(fileA, 'claude-desktop', 'Content A', true);
    const resB = await controller.createFile(fileB, 'chatgpt-desktop', 'Content B', true);

    assert.strictEqual(resA.status, 'created');
    assert.strictEqual(resB.status, 'created');
    assert.strictEqual(fs.readFileSync(fileA, 'utf8'), 'Content A');
    assert.strictEqual(fs.readFileSync(fileB, 'utf8'), 'Content B');
  });

  await t.test('TEST 13: Two agents attempt to modify same disposable file -> conflict protection', async () => {
    fs.writeFileSync(sharedFile, 'Base line to edit');
    const readClaude = await controller.readFile(sharedFile, 'claude-desktop');
    const readChatGPT = await controller.readFile(sharedFile, 'chatgpt-desktop');

    assert.strictEqual(readClaude.fileHash, readChatGPT.fileHash);

    // Claude updates first with expected hash -> SUCCESS
    const editClaude = await controller.editFile(sharedFile, 'claude-desktop', 'Base line to edit', 'Claude modification', readClaude.fileHash);
    assert.strictEqual(editClaude.status, 'edited');

    // ChatGPT attempts update using stale hash -> ConflictDetected ERROR
    await assert.rejects(async () => {
      await controller.editFile(sharedFile, 'chatgpt-desktop', 'Base line to edit', 'ChatGPT modification', readChatGPT.fileHash);
    }, /ConflictDetected/);
  });

  await t.test('TEST 14: Owner-authorized Zia writes are permitted', async () => {
    const ziaTargetPath = path.join(CONFIG.ZIA_ROOT, 'UnauthorizedProbe.swift');
    if (fs.existsSync(ziaTargetPath)) fs.unlinkSync(ziaTargetPath);
    const claudeWrite = await controller.createFile(ziaTargetPath, 'claude-desktop', 'allowed by owner policy');
    assert.strictEqual(claudeWrite.status, 'created');
    fs.unlinkSync(ziaTargetPath);

    const chatgptWrite = await controller.createFile(ziaTargetPath, 'chatgpt-desktop', 'allowed by owner policy');
    assert.strictEqual(chatgptWrite.status, 'created');
    fs.unlinkSync(ziaTargetPath);
  });

  await t.test('TEST 15: Home-directory access is owner-authorized', async () => {
    // Agent Bridge does not impose a secret-path denylist; macOS/TCC and Unix permissions remain authoritative.
    assert.strictEqual(guard.validatePathAccess(path.join(TEST_WORKSPACE, '.env'), 'READ').allowed, true);
    assert.strictEqual(guard.validatePathAccess('/Users/jayanthpranaykonada/.ssh/id_rsa', 'READ').allowed, true);
    assert.strictEqual(guard.validatePathAccess('/Users/jayanthpranaykonada/Library/Keychains/login.keychain-db', 'READ').allowed, true);
  });

  await t.test('GUI Automation Adapter Graceful Inspection', async () => {
    const perm = await guiAdapter.checkAccessibilityPermission();
    // Verify it returns structured outcome without crashing or unhandled rejections
    assert.ok(typeof perm.hasPermission === 'boolean');
    assert.ok(typeof perm.message === 'string');
  });
});
