import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { AuditLogger } from '../src/audit-logger.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { AgentIdentityManager } from '../src/agent-identity.js';
import { ArtifactStore } from '../src/artifacts/artifact-store.js';

function pngFixture(payload = 'PNG') {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    Buffer.from(payload, 'utf8')
  ]);
}

/**
 * The artifact tools previously accepted a caller-supplied `agentId`. These
 * tests prove the real execution path resolves identity from the trusted,
 * server-side bound context and that a caller cannot impersonate another agent
 * by supplying a different `agentId`.
 */
test('Artifact tools derive caller identity from the trusted context (no agentId spoofing)', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-identity-'));
  const logger = new AuditLogger(path.join(tmpDir, 'identity.sqlite'));
  const store = new ArtifactStore(logger, { root: path.join(tmpDir, 'store') });
  const registry = new ToolRegistry();

  t.after(() => {
    try { logger.close(); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  // Two independent connections, each bound to its own real identity.
  const ctxA = { logger, artifactStore: store, identity: new AgentIdentityManager(logger, 'gemini') };
  const ctxB = { logger, artifactStore: store, identity: new AgentIdentityManager(logger, 'chatgpt-desktop') };

  // Agent A stores an artifact.
  const ref = await registry.executeTool('bridge_artifact_store', {
    agentId: 'gemini',
    dataBase64: pngFixture('agent-a-secret').toString('base64'),
    mimeType: 'image/png',
    taskId: 'task_a'
  }, ctxA);
  assert.equal(ref.agent_id, 'gemini', 'the stored owner is the bound identity');

  await t.test('1. Agent B cannot read A bytes by claiming to be A', async () => {
    await assert.rejects(
      registry.executeTool('bridge_artifact_read', { agentId: 'gemini', artifactId: ref.artifact_id }, ctxB),
      /not authorized|Unauthorized/i
    );
  });

  await t.test('2. Agent B cannot read A metadata by claiming to be A', async () => {
    await assert.rejects(
      registry.executeTool('bridge_artifact_get', { agentId: 'gemini', artifactId: ref.artifact_id }, ctxB),
      /not authorized|Unauthorized/i
    );
  });

  await t.test('3. Agent B storing while claiming to be A is attributed to B, not A', async () => {
    const bRef = await registry.executeTool('bridge_artifact_store', {
      agentId: 'gemini',
      dataBase64: pngFixture('agent-b-forgery').toString('base64'),
      mimeType: 'image/png'
    }, ctxB);
    assert.equal(bRef.agent_id, 'chatgpt-desktop', 'forged agentId must not change the owner');

    // ...and the real A still cannot read B's artifact by claiming otherwise.
    await assert.rejects(
      registry.executeTool('bridge_artifact_read', { agentId: 'chatgpt-desktop', artifactId: bRef.artifact_id }, ctxA),
      /not authorized|Unauthorized/i
    );
  });

  await t.test('4. Agent B cannot self-grant access to A artifact through authorizedAgents', async () => {
    // There is no update path; a forged store call creates a NEW artifact owned by B.
    await registry.executeTool('bridge_artifact_store', {
      agentId: 'gemini',
      dataBase64: pngFixture('grant-attempt').toString('base64'),
      mimeType: 'image/png',
      authorizedAgents: ['chatgpt-desktop']
    }, ctxB);

    // A's original artifact authorization list is unchanged.
    const rowA = logger.db.prepare('SELECT authorized_agents FROM bridge_artifacts WHERE artifact_id = ?').get(ref.artifact_id);
    assert.deepEqual(JSON.parse(rowA.authorized_agents), ['gemini']);
    await assert.rejects(
      registry.executeTool('bridge_artifact_read', { agentId: 'gemini', artifactId: ref.artifact_id }, ctxB),
      /not authorized|Unauthorized/i
    );
  });

  await t.test('5. Forged task/attempt ids do not bypass agent authorization', async () => {
    await assert.rejects(
      registry.executeTool('bridge_artifact_read', {
        agentId: 'gemini',
        artifactId: ref.artifact_id,
        taskId: 'forged_task',
        attemptId: 'forged_attempt'
      }, ctxB),
      /not authorized|Unauthorized/i
    );
  });

  await t.test('6. Boundary escalation to system is denied', async () => {
    await assert.rejects(
      registry.executeTool('bridge_artifact_read', { agentId: 'system', artifactId: ref.artifact_id }, ctxB),
      /Security Violation|Unauthorized/i
    );
  });

  await t.test('7. An unauthenticated identity with requireAuthentication is rejected', async () => {
    const unbound = new AgentIdentityManager(logger, null);
    await assert.rejects(
      registry.executeTool('bridge_artifact_read',
        { agentId: 'gemini', artifactId: ref.artifact_id },
        { logger, artifactStore: store, identity: unbound, requireAuthentication: true }),
      /Unauthorized/i
    );
  });

  await t.test('8. Cleanup cannot delete another agent non-expired artifact', async () => {
    await registry.executeTool('bridge_artifact_cleanup', {}, ctxB);
    const still = store.getMetadata(ref.artifact_id, { agentId: 'gemini' });
    assert.equal(still.retrievable, true, 'a non-expired artifact must survive a peer cleanup');
  });
});
