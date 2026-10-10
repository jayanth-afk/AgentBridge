import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

import { CONFIG } from '../src/config.js';
import { AuditLogger } from '../src/audit-logger.js';
import { PermissionGuard } from '../src/permission-guard.js';
import { ProjectController } from '../src/project-controller.js';
import { ConcurrencyManager } from '../src/concurrency-manager.js';
import { CacheManager } from '../src/cache-manager.js';
import { DiagnosticsManager } from '../src/diagnostics-manager.js';
import { PresenceManager } from '../src/presence-manager.js';
import { AgentIdentityManager } from '../src/agent-identity.js';
import { GitController } from '../src/git-controller.js';
import { MailboxHub } from '../src/mailbox-hub.js';
import { TaskManager } from '../src/task-manager.js';
import { EventBus } from '../src/event-bus.js';
import { CollaborationManager } from '../src/collaboration-manager.js';
import { FileActivityManager } from '../src/file-activity-manager.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { RequestExplainer } from '../src/diagnostics/request-explainer.js';
import { ArtifactStore } from '../src/artifacts/artifact-store.js';

const TEST_DB = path.join(CONFIG.DATA_DIR, 'test_tool_matrix.sqlite');
const WS = CONFIG.TEST_WORKSPACE;
const AGENT = 'claude-desktop';

function rmDb() {
  for (const s of ['', '-wal', '-shm', '-journal']) {
    const p = `${TEST_DB}${s}`;
    if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch {} }
  }
}

const results = {};

test('Agent Bridge Tool Matrix — all registered tools exercised', async (t) => {
  rmDb();
  if (!fs.existsSync(WS)) fs.mkdirSync(WS, { recursive: true });

  const logger = new AuditLogger(TEST_DB);
  const guard = new PermissionGuard(CONFIG);
  const concurrency = new ConcurrencyManager();
  const cache = new CacheManager();
  const diagnostics = new DiagnosticsManager();
  const presence = new PresenceManager(logger);
  const identity = new AgentIdentityManager(logger, AGENT);
  const git = new GitController(guard, logger);
  const eventBus = new EventBus(logger);
  const taskManager = new TaskManager(logger);
  const fileActivity = new FileActivityManager(logger);
  const collaboration = new CollaborationManager(logger);
  const mailbox = new MailboxHub(logger, taskManager, eventBus);
  const controller = new ProjectController(guard, logger, concurrency, fileActivity, cache, git);

  mailbox.registerAgentHandler('chatgpt-desktop', async (q) => `peer answered: ${q}`);

  const requestExplainer = new RequestExplainer(logger);

  const ctx = {
    controller, mailbox, taskManager, collaboration, fileActivity, logger, git,
    presence, identity, diagnostics, cache, eventBus, requestExplainer, boundAgentId: AGENT
  };

  // ---- fixtures -----------------------------------------------------------
  const mainFile = path.join(WS, 'matrix_file.txt');
  fs.writeFileSync(mainFile, 'alpha\nbeta\ngamma\n');
  const deleteTarget = path.join(WS, 'matrix_delete_me.txt');
  fs.writeFileSync(deleteTarget, 'delete me');
  const batchA = path.join(WS, 'matrix_batch_a.txt');
  const batchB = path.join(WS, 'matrix_batch_b.txt');

  // git repo with a local bare remote
  const repoDir = path.join(WS, 'matrix-git');
  if (fs.existsSync(repoDir)) fs.rmSync(repoDir, { recursive: true, force: true });
  fs.mkdirSync(repoDir, { recursive: true });
  const run = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  run(repoDir, 'init', '-q');
  run(repoDir, 'config', 'user.email', 'matrix@agent-bridge.local');
  run(repoDir, 'config', 'user.name', 'matrix');
  fs.writeFileSync(path.join(repoDir, 'seed.txt'), 'seed\n');
  run(repoDir, 'add', 'seed.txt');
  run(repoDir, 'commit', '-q', '-m', 'seed');
  run(repoDir, 'branch', '-M', 'matrix-branch');
  // Uncommitted change so bridge_git_stage/commit have something real to do.
  fs.writeFileSync(path.join(repoDir, 'matrix_change.txt'), 'change\n');
  const bareDir = path.join(WS, 'matrix-remote.git');
  if (fs.existsSync(bareDir)) fs.rmSync(bareDir, { recursive: true, force: true });
  execFileSync('git', ['init', '-q', '--bare', bareDir], { stdio: 'pipe' });
  run(repoDir, 'remote', 'add', 'origin', bareDir);

  // entities
  const task = mailbox.delegateTask({ fromAgent: AGENT, toAgent: 'chatgpt-desktop', title: 'matrix task', instructions: 'do it' });
  const collab = collaboration.create({ ownerAgent: AGENT, title: 'matrix collab', objective: 'exercise tools' });
  collaboration.join({ collaborationId: collab.id, agentId: AGENT });
  // Addressed to the bound agent (AGENT) so the bound caller may legitimately answer it.
  const pending = await mailbox.askAgent({ fromAgent: 'chatgpt-desktop', toAgent: AGENT, question: 'async', asyncMode: true });
  eventBus.publish({ type: 'matrix_probe', agentId: AGENT, fromAgent: AGENT, conversationId: 'conv_matrix', status: 'info', payload: { hi: true } });

  const writeFile = path.join(WS, 'matrix_written.txt');
  const writeFile2 = path.join(WS, 'matrix_written2.txt');
  for (const f of [writeFile, writeFile2, batchA, batchB]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }

  // ---- matrix: each entry exercises one tool with a valid invocation -------
  // Binary-artifact transport fixtures (real PNG bytes, isolated temp storage root).
  ctx.artifactStore = new ArtifactStore(logger, { root: fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-artifacts-')) });
  const matrixPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const storedArtifact = ctx.artifactStore.put({
    base64: matrixPngBase64,
    mimeType: 'image/png',
    filename: 'matrix.png',
    agentId: AGENT
  });

  const valid = [
    ['bridge_ping', {}],
    ['bridge_discover_agents', {}],
    ['bridge_agent_presence', {}],
    ['bridge_diagnostics', {}],
    ['bridge_context', { rootPath: WS, agentId: AGENT }],
    ['bridge_find_symbol', { rootPath: CONFIG.BRIDGE_ROOT, symbol: 'ToolRegistry', agentId: AGENT }],
    ['bridge_read_symbol', { filePath: path.join(CONFIG.BRIDGE_ROOT, 'src', 'tool-registry.js'), symbol: 'ToolRegistry', agentId: AGENT }],
    ['bridge_test_plan', { rootPath: CONFIG.BRIDGE_ROOT, agentId: AGENT }],
    ['bridge_inspect_project', { rootPath: WS, agentId: AGENT }],
    ['bridge_project_snapshot', { rootPath: CONFIG.BRIDGE_ROOT, agentId: AGENT }],
    ['bridge_read_file', { filePath: mainFile, agentId: AGENT, startLine: 1, endLine: 2 }],
    ['bridge_create_file', { filePath: writeFile, content: 'created by matrix', agentId: AGENT }],
    ['bridge_edit_file', { filePath: writeFile, targetContent: 'created by matrix', replacementContent: 'edited by matrix', agentId: AGENT }],
    ['bridge_apply_patch', { filePath: writeFile, patch: { targetContent: 'edited by matrix', replacementContent: 'patched by matrix' }, agentId: AGENT }],
    ['bridge_search_files', { rootPath: WS, query: 'matrix', agentId: AGENT }],
    ['bridge_batch_read', { files: [{ filePath: batchA }, { filePath: batchB }], agentId: AGENT }],
    ['bridge_batch_write', { files: [{ filePath: writeFile2, content: 'batch written' }], agentId: AGENT }],
    ['bridge_batch_stat', { paths: [mainFile, writeFile2], agentId: AGENT }],
    ['bridge_execute_command', { commandLine: 'echo matrix_ok', cwd: WS, agentId: AGENT }],
    ['bridge_git_status', { repoPath: repoDir, agentId: AGENT }],
    ['bridge_git_branches', { repoPath: repoDir, agentId: AGENT }],
    ['bridge_git_create_branch', { repoPath: repoDir, branchName: 'matrix-created', agentId: AGENT }],
    ['bridge_git_switch_branch', { repoPath: repoDir, branchName: 'matrix-created', agentId: AGENT }],
    ['bridge_git_stage', { repoPath: repoDir, stageAll: true, agentId: AGENT }],
    ['bridge_git_commit', { repoPath: repoDir, message: 'matrix commit', stageAll: true, agentId: AGENT }],
    ['bridge_git_log', { repoPath: repoDir, maxCommits: 3, agentId: AGENT }],
    ['bridge_git_diff', { repoPath: repoDir, agentId: AGENT }],
    ['bridge_git_push', { repoPath: repoDir, remote: 'origin', branch: 'matrix-created', dryRun: false, agentId: AGENT }],
    ['bridge_git_pull', { repoPath: repoDir, remote: 'origin', branch: 'matrix-created', agentId: AGENT }],
    ['bridge_git_fetch', { repoPath: repoDir, remote: 'origin', agentId: AGENT }],
    ['bridge_git_switch_branch', { repoPath: repoDir, branchName: 'matrix-branch', agentId: AGENT }],
    ['bridge_git_delete_branch', { repoPath: repoDir, branchName: 'matrix-created', force: true, agentId: AGENT }],
    ['bridge_send_message', { fromAgent: AGENT, toAgent: 'chatgpt-desktop', subject: 'matrix', content: 'hello' }],
    ['bridge_broadcast_message', { fromAgent: AGENT, toAgents: ['chatgpt-desktop', 'antigravity-ide'], subject: 'matrix b', content: 'broadcast' }],
    ['bridge_check_inbox', { agentId: 'chatgpt-desktop', compact: true }],
    ['bridge_delegate_task', { fromAgent: AGENT, toAgent: 'chatgpt-desktop', title: 'matrix delegated', instructions: 'x' }],
    ['bridge_claim_task', { agentId: 'chatgpt-desktop' }],
    ['bridge_get_task_status', { taskId: task.id }],
    ['bridge_submit_task_result', { taskId: task.id, agentId: 'chatgpt-desktop', status: 'completed', result: 'done' }],
    ['bridge_ask_agent', { fromAgent: AGENT, toAgent: 'chatgpt-desktop', question: 'matrix sync question' }],
    ['bridge_get_request_status', { requestId: pending.requestId }],
    ['bridge_get_response', { requestId: pending.requestId }],
    ['bridge_get_pending_requests', { agentId: AGENT }],
    ['bridge_answer_request', { requestId: pending.requestId, agentId: AGENT, response: 'answered' }],
    ['bridge_get_events', { agentId: AGENT, limit: 5 }],
    ['bridge_get_adapter_capabilities', { agentId: AGENT }],
    ['bridge_request_review', { fromAgent: AGENT, toAgent: 'chatgpt-desktop', filePath: mainFile, description: 'review it' }],
    ['bridge_create_collaboration', { ownerAgent: AGENT, title: 'c2', objective: 'o2' }],
    ['bridge_join_collaboration', { collaborationId: collab.id, agentId: AGENT }],
    ['bridge_heartbeat_collaboration', { collaborationId: collab.id, agentId: AGENT }],
    ['bridge_leave_collaboration', { collaborationId: collab.id, agentId: AGENT }],
    ['bridge_get_collaboration', { collaborationId: collab.id }],
    ['bridge_list_collaborations', { agentId: AGENT }],
    ['bridge_post_collaboration_event', { collaborationId: collab.id, agentId: AGENT, eventType: 'note', payload: { n: 1 } }],
    ['bridge_file_activity_start', { filePath: mainFile, agentId: AGENT, activityType: 'editing' }],
    ['bridge_file_activity_heartbeat', { filePath: mainFile, agentId: AGENT, activityType: 'editing' }],
    ['bridge_get_file_activity', { filePath: mainFile }],
    ['bridge_get_all_file_activity', {}],
    ['bridge_file_activity_stop', { filePath: mainFile, agentId: AGENT, activityType: 'editing' }],
    ['bridge_get_audit_log', { limit: 5 }],
    ['bridge_delete_file', { filePath: deleteTarget, agentId: AGENT }],
    ['bridge_close_collaboration', { collaborationId: collab.id, agentId: AGENT }],
    ['bridge_artifact_store', { agentId: AGENT, dataBase64: matrixPngBase64, mimeType: 'image/png', filename: 'matrix2.png' }],
    ['bridge_artifact_get', { agentId: AGENT, artifactId: storedArtifact.artifact_id }],
    ['bridge_artifact_read', { agentId: AGENT, artifactId: storedArtifact.artifact_id }],
    ['bridge_artifact_cleanup', { agentId: AGENT }],
    ['bridge_discover_tools', { category: 'discovery' }],
    ['bridge_tool_info', { toolName: 'bridge_check_syntax' }],
    ['bridge_store_knowledge', { title: 'Matrix Knowledge', content: 'Matrix test knowledge content', agentId: AGENT }],
    ['bridge_search_knowledge', { query: 'matrix test' }],
    ['bridge_get_knowledge', { id: 'matrix_knowledge' }],
    ['bridge_check_syntax', { filePath: path.join(CONFIG.BRIDGE_ROOT, 'src', 'tool-registry.js'), agentId: AGENT }],
    ['bridge_git_summary', { repoPath: repoDir, agentId: AGENT }],
    ['bridge_git_blame', { repoPath: repoDir, filePath: 'seed.txt', startLine: 1, endLine: 2, agentId: AGENT }],
    ['bridge_extract_data', { filePath: path.join(CONFIG.BRIDGE_ROOT, 'package.json'), jsonPath: 'name', agentId: AGENT }]
  ];

  const registry = new ToolRegistry();
  const allNames = registry.getToolDefinitions().map(t => t.name).sort();
  const coveredNames = [...new Set(valid.map(v => v[0]))].sort();

  await t.test('every registered tool has a matrix entry', () => {
    assert.deepStrictEqual(coveredNames, allNames, `unexercised tools: ${allNames.filter(n => !coveredNames.includes(n))}`);
  });

  for (const [name, args] of valid) {
    await t.test(`valid: ${name}`, async () => {
      let out;
      try {
        out = await registry.executeTool(name, args, ctx);
      } catch (err) {
        results[name] = `FAIL: ${err.message}`;
        throw new Error(`${name} valid invocation threw: ${err.message}`);
      }
      assert.notStrictEqual(out, undefined, `${name} returned undefined`);
      results[name] = 'PASS';
    });
  }

  await t.test('invalid: unknown tool rejected', async () => {
    await assert.rejects(() => registry.executeTool('no_such_tool', {}, ctx), /Unknown tool/);
  });

  await t.test('invalid: bound connection cannot escalate to system', async () => {
    await assert.rejects(
      () => registry.executeTool('bridge_read_file', { filePath: mainFile, agentId: 'system' }, ctx),
      /Security Violation|Escalation to 'system'/
    );
  });

  await t.test('invalid: sandbox escape rejected', async () => {
    await assert.rejects(() => registry.executeTool('bridge_read_file', { filePath: '/etc/passwd', agentId: AGENT }, ctx), /outside allowed roots/);
  });

  await t.test('invalid: disallowed command rejected', async () => {
    await assert.rejects(() => registry.executeTool('bridge_execute_command', { commandLine: 'rm -rf /', cwd: WS, agentId: AGENT }, ctx), /dangerous pattern|not in the safe whitelist/);
  });

  await t.test('invalid: missing required content rejected', async () => {
    await assert.rejects(() => registry.executeTool('bridge_create_file', { filePath: path.join(WS, 'x.txt'), agentId: AGENT }, ctx));
  });

  t.after(() => {
    try { eventBus.close(); } catch {}
    try { logger.close(); } catch {}
    try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(bareDir, { recursive: true, force: true }); } catch {}
    rmDb();
  });

  await t.test('summary: no tool returned FAIL', () => {
    const failed = Object.entries(results).filter(([, v]) => v !== 'PASS');
    assert.deepStrictEqual(failed, [], `failed tools: ${JSON.stringify(failed)}`);
  });
});
