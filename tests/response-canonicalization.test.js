import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { AuditLogger } from '../src/audit-logger.js';
import { TaskManager } from '../src/task-manager.js';
import { MailboxHub } from '../src/mailbox-hub.js';
import { EventBus } from '../src/event-bus.js';
import { ResponsePreserver } from '../src/artifacts/response-preserver.js';

test('Response Storage Canonicalization (ArtifactStore-backed)', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'response-canon-'));
  const dbPath = path.join(tmpDir, 'canon.sqlite');

  const logger = new AuditLogger(dbPath);
  const eventBus = new EventBus(logger);
  const taskManager = new TaskManager(logger);
  const mailbox = new MailboxHub(logger, taskManager, eventBus);

  t.after(() => {
    eventBus.close();
    logger.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  await t.test('1. Canonical payload lives once in bridge_artifacts; metadata row holds only a reference', async () => {
    const requestId = `req_canon_${Date.now()}`;
    const exact = 'Canonical payload body with ```js\nconst x = 1;\n``` and a link https://example.com.';

    mailbox.registerAgentHandler('gemini', async () => exact);

    const result = await mailbox.askAgent({
      fromAgent: 'chatgpt',
      toAgent: 'gemini',
      question: 'Canonicalization probe',
      requestId,
      responseMode: 'direct'
    });

    assert.strictEqual(result.status, 'completed');
    assert.ok(result.responseId, 'responseId generated');

    const metaRow = logger.db.prepare(
      'SELECT response_text, payload_artifact_id FROM bridge_response_artifacts WHERE request_id = ?'
    ).get(requestId);

    assert.ok(metaRow, 'metadata row persisted');
    assert.ok(metaRow.payload_artifact_id, 'metadata row references the canonical artifact');
    assert.strictEqual(metaRow.response_text, '', 'full text is NOT duplicated in the metadata row');

    const artRow = logger.db.prepare(
      'SELECT artifact_id, mime_type, size_bytes FROM bridge_artifacts WHERE artifact_id = ?'
    ).get(metaRow.payload_artifact_id);

    assert.ok(artRow, 'canonical artifact row exists in bridge_artifacts');
    assert.strictEqual(artRow.mime_type, 'text/plain');
    assert.strictEqual(artRow.size_bytes, Buffer.byteLength(exact, 'utf8'));
  });

  await t.test('2. bridge_get_response resolves the exact payload from the canonical store', async () => {
    const requestId = `req_canon_read_${Date.now()}`;
    const exact = 'Exact text that must survive the canonical round trip.\nSecond line.';

    mailbox.registerAgentHandler('claude', async () => exact);

    const result = await mailbox.askAgent({
      fromAgent: 'chatgpt',
      toAgent: 'claude',
      question: 'Read-back probe',
      requestId,
      responseMode: 'direct'
    });

    const byId = mailbox.getResponse(result.responseId);
    assert.ok(byId, 'response retrievable by responseId');
    assert.strictEqual(byId.responseText, exact, 'exact text resolved from ArtifactStore');
    assert.strictEqual(byId.bridgeUnaltered, true);
    assert.strictEqual(byId.untrustedData, true);
    assert.ok(byId.payloadArtifactId, 'artifact reference exposed');

    const byReq = mailbox.getRequest(requestId);
    assert.ok(byReq.artifact, 'request exposes artifact');
    assert.strictEqual(byReq.artifact.responseText, exact, 'request-path text resolved from ArtifactStore');
  });

  await t.test('3. Quarantined payloads remain withheld even when artifact-backed', async () => {
    const requestId = `req_canon_quarantine_${Date.now()}`;
    const leaked = 'aws key: AKIAIOSFODNN7EXAMPLE';

    mailbox.registerAgentHandler('gemini', async () => leaked);

    const result = await mailbox.askAgent({
      fromAgent: 'chatgpt',
      toAgent: 'gemini',
      question: 'Leak probe',
      requestId,
      responseMode: 'direct'
    });

    assert.strictEqual(result.status, 'quarantined');
    assert.strictEqual(result.response, null);

    const fetched = mailbox.getResponse(result.responseId);
    assert.strictEqual(fetched.status, 'quarantined');
    assert.strictEqual(fetched.responseText, null, 'quarantined text withheld through every path');
    assert.strictEqual(fetched.response, null);
  });

  await t.test('4. Without an ArtifactStore, ResponsePreserver keeps inline text (fallback intact)', async () => {
    const inline = new ResponsePreserver(logger.db);
    const text = 'Inline fallback text.';
    const preserved = inline.preserveResponse({
      requestId: `req_inline_${Date.now()}`,
      respondingAgentId: 'gemini',
      requestingAgentId: 'chatgpt',
      responseText: text,
      responseMode: 'direct'
    });

    assert.strictEqual(preserved.payloadArtifactId, null);
    assert.strictEqual(preserved.responseText, text);

    const fetched = inline.getByResponseId(preserved.responseId);
    assert.strictEqual(fetched.responseText, text, 'inline text resolves without a canonical store');
  });
});
