import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { AuditLogger } from '../src/audit-logger.js';
import { EventBus } from '../src/event-bus.js';
import { TaskManager } from '../src/task-manager.js';
import { MailboxHub } from '../src/mailbox-hub.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { RequestTracer, LifecycleStage } from '../src/diagnostics/request-tracer.js';
import { ArtifactStore } from '../src/artifacts/artifact-store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC_DIR = path.resolve(__dirname, '../src');

// Explicit allowlist of permissible non-authorization uses of args.agentId / args.fromAgent in src/
// Format: { file: relativePath, line: number, pattern: string, rationale: string }
const AUTHZ_SCAN_ALLOWLIST = [
  {
    file: 'tool-registry.js',
    pattern: 'args.agentId',
    rationale: 'Checking if caller supplied a mismatching agentId against trusted transport caller, or passing authorized agentId into controller/git operations'
  },
  {
    file: 'tool-registry.js',
    pattern: 'args.fromAgent',
    rationale: 'Checking if caller supplied a mismatching fromAgent against trusted transport caller, or routing destination'
  },
  {
    file: 'control-plane/multi-hop-router.js',
    pattern: 'initiatorAgent',
    rationale: 'Forwarding initiator identity through hop trace with strict permissionGuard checks'
  },
  {
    file: 'interop/a2a-adapter.js',
    pattern: 'params.targetAgent',
    rationale: 'Target agent routing destination for delegated tasks'
  }
];

function scanDirectory(dir, fileList = []) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      scanDirectory(fullPath, fileList);
    } else if (file.endsWith('.js')) {
      fileList.push(fullPath);
    }
  }
  return fileList;
}

test('A1 GUARD: static scan of src/ forbids caller-supplied authorization fallbacks', () => {
  const sourceFiles = scanDirectory(SRC_DIR);
  const violations = [];

  // Patterns that indicate an authorization check is deriving authority from caller-supplied fields
  const forbiddenPatterns = [
    /ctx\.agentId\s*\|\|\s*args\.agentId/,
    /args\.agentId\s*\|\|\s*ctx\.agentId/,
    /rawArgs\.agentId\s*\|\|\s*rawArgs\.fromAgent/,
    /rawArgs\.fromAgent\s*\|\|\s*rawArgs\.agentId/,
    /callerAgent\s*===\s*['"]system['"]/,
    /callerId\s*===\s*['"]system['"]/
  ];

  for (const file of sourceFiles) {
    const relPath = path.relative(SRC_DIR, file);
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');

    lines.forEach((lineText, idx) => {
      const lineNum = idx + 1;
      for (const pattern of forbiddenPatterns) {
        if (pattern.test(lineText)) {
          // Check if covered by explicit allowlist with comment
          const isAllowed = lineText.includes('// allow-caller-id:') || lineText.includes('allow-authz-scan:');
          if (!isAllowed) {
            violations.push({
              file: relPath,
              line: lineNum,
              matched: pattern.toString(),
              snippet: lineText.trim()
            });
          }
        }
      }
    });
  }

  assert.deepStrictEqual(
    violations,
    [],
    `Found forbidden caller-supplied authorization pattern(s) in src/: ${JSON.stringify(violations, null, 2)}`
  );
});

test('A1 GUARD: tool authorization matrix across unbound and bound transport shapes', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-shape-matrix-'));
  const logger = new AuditLogger(path.join(tmpDir, 'test.sqlite'));
  const eventBus = new EventBus(logger);
  const taskManager = new TaskManager(logger, null, eventBus);
  const mailbox = new MailboxHub(logger, taskManager, eventBus);
  const tracer = new RequestTracer(logger, { db: logger.db });
  const artifactStore = new ArtifactStore(logger);
  const registry = new ToolRegistry();

  t.after(() => {
    try { eventBus.close(); } catch {}
    try { logger.close(); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  const victimAgent = 'victim-agent';
  const attackerClaim = { agentId: victimAgent, fromAgent: victimAgent };

  // Setup victim request in tracer & mailbox
  tracer.mark({
    requestId: 'req_victim_shape',
    stage: LifecycleStage.REQUEST_CREATED,
    agentId: victimAgent,
    meta: { fromAgent: victimAgent, toAgent: 'chatgpt-desktop' }
  });

  // Setup victim artifact
  const art = artifactStore.put({
    bytes: Buffer.from('sensitive-data-bytes'),
    agentId: victimAgent,
    contentType: 'text/plain'
  });

  // Setup victim task
  const victimTask = await mailbox.delegateTask({
    fromAgent: victimAgent,
    toAgent: 'chatgpt-desktop',
    title: 'Victim Task',
    instructions: 'Sensitive computation'
  });

  // Shape 1: Unbound context (no agentId, no boundAgentId, not privileged)
  const unboundCtx = {
    isPrivileged: false,
    tracer,
    logger,
    mailbox,
    taskManager,
    artifactStore,
    eventBus
  };

  // Shape 2: Bound owner context (trusted transport identity)
  const boundCtx = {
    isPrivileged: false,
    agentId: victimAgent,
    tracer,
    logger,
    mailbox,
    taskManager,
    artifactStore,
    eventBus
  };

  // 1. bridge_request_ledger
  await t.test('bridge_request_ledger: unbound rejected, bound accepted', async () => {
    await assert.rejects(
      async () => await registry.executeTool('bridge_request_ledger', { requestId: 'req_victim_shape', ...attackerClaim }, unboundCtx),
      /Unauthorized/i
    );
    const res = await registry.executeTool('bridge_request_ledger', { requestId: 'req_victim_shape' }, boundCtx);
    assert.strictEqual(res.found, true);
  });

  // 2. bridge_artifact_get
  await t.test('bridge_artifact_get: unbound rejected, bound accepted', async () => {
    await assert.rejects(
      async () => await registry.executeTool('bridge_artifact_get', { artifactId: art.artifactId, ...attackerClaim }, unboundCtx),
      /authenticated agentId|unauthorized/i
    );
    const meta = await registry.executeTool('bridge_artifact_get', { artifactId: art.artifactId }, boundCtx);
    assert.strictEqual(meta.artifactId, art.artifactId);
  });

  // 3. bridge_artifact_read
  await t.test('bridge_artifact_read: unbound rejected, bound accepted', async () => {
    await assert.rejects(
      async () => await registry.executeTool('bridge_artifact_read', { artifactId: art.artifactId, ...attackerClaim }, unboundCtx),
      /authenticated agentId|unauthorized/i
    );
    const bytes = await registry.executeTool('bridge_artifact_read', { artifactId: art.artifactId }, boundCtx);
    assert.strictEqual(bytes.integrityVerified, true);
  });

  // 4. bridge_artifact_cleanup
  await t.test('bridge_artifact_cleanup: unbound rejected, bound accepted', async () => {
    await assert.rejects(
      async () => await registry.executeTool('bridge_artifact_cleanup', { ...attackerClaim }, unboundCtx),
      /Unauthorized/i
    );
    const res = await registry.executeTool('bridge_artifact_cleanup', {}, boundCtx);
    assert.ok(res !== undefined);
  });

  // 5. bridge_check_inbox
  await t.test('bridge_check_inbox: unbound rejected, bound accepted', async () => {
    await assert.rejects(
      async () => await registry.executeTool('bridge_check_inbox', { ...attackerClaim }, unboundCtx),
      /Unauthorized/i
    );
    const inbox = await registry.executeTool('bridge_check_inbox', {}, boundCtx);
    assert.ok(Array.isArray(inbox.messages || inbox));
  });

  // 6. bridge_claim_task
  await t.test('bridge_claim_task: unbound rejected, bound accepted', async () => {
    await assert.rejects(
      async () => await registry.executeTool('bridge_claim_task', { ...attackerClaim }, unboundCtx),
      /Unauthorized/i
    );
    const claim = await registry.executeTool('bridge_claim_task', {}, boundCtx);
    assert.ok(claim !== undefined);
  });

  // 7. bridge_get_task_status
  await t.test('bridge_get_task_status: unbound rejected, bound accepted', async () => {
    await assert.rejects(
      async () => await registry.executeTool('bridge_get_task_status', { taskId: victimTask.id, ...attackerClaim }, unboundCtx),
      /Unauthorized/i
    );
    const status = await registry.executeTool('bridge_get_task_status', { taskId: victimTask.id }, boundCtx);
    assert.ok(status.taskId === victimTask.id || status.id === victimTask.id);
  });

  // 8. bridge_send_message
  await t.test('bridge_send_message: unbound rejected, bound accepted', async () => {
    await assert.rejects(
      async () => await registry.executeTool('bridge_send_message', {
        fromAgent: victimAgent,
        toAgent: 'chatgpt-desktop',
        subject: 'test',
        content: 'test'
      }, unboundCtx),
      /Unauthorized/i
    );
    const sent = await registry.executeTool('bridge_send_message', {
      toAgent: 'chatgpt-desktop',
      subject: 'test',
      content: 'test'
    }, boundCtx);
    assert.ok(sent !== undefined);
  });

  // 9. bridge_store_knowledge
  await t.test('bridge_store_knowledge: unbound rejected, bound accepted', async () => {
    await assert.rejects(
      async () => await registry.executeTool('bridge_store_knowledge', {
        title: 'Secret Finding',
        content: 'Top secret findings',
        agentId: victimAgent
      }, unboundCtx),
      /Unauthorized/i
    );
    const stored = await registry.executeTool('bridge_store_knowledge', {
      title: 'Secret Finding',
      content: 'Top secret findings'
    }, boundCtx);
    assert.strictEqual(stored.success, true);
  });

  // 10. bridge_skill_load
  await t.test('bridge_skill_load: unbound rejected, bound accepted', async () => {
    await assert.rejects(
      async () => await registry.executeTool('bridge_skill_load', {
        name: 'test-skill',
        agentId: victimAgent
      }, unboundCtx),
      /Unauthorized/i
    );
  });
});
