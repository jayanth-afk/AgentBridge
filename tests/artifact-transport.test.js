import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import { AuditLogger } from '../src/audit-logger.js';
import { ToolRegistry } from '../src/tool-registry.js';
import {
  ArtifactStore,
  ArtifactError,
  ArtifactTransferStatus,
  detectMimeType,
  sanitizeFilename
} from '../src/artifacts/artifact-store.js';

// --- Deterministic fixtures (real magic bytes, real byte content) --------------

function pngFixture(payload = 'PNG_PAYLOAD') {
  const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  return Buffer.concat([signature, Buffer.from(payload, 'utf8')]);
}

function jpegFixture(payload = 'JPEG_PAYLOAD') {
  return Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF]), Buffer.from(payload, 'utf8')]);
}

function mp4Fixture(payload = 'MP4_PAYLOAD') {
  const header = Buffer.alloc(12);
  header.writeUInt32BE(12 + payload.length, 0);
  header.write('ftyp', 4, 'ascii');
  header.write('isom', 8, 'ascii');
  return Buffer.concat([header, Buffer.from(payload, 'utf8')]);
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

test('Binary artifact transport: real bytes, integrity, and authorization', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-test-'));
  const dbPath = path.join(tmpDir, 'artifacts.sqlite');
  const logger = new AuditLogger(dbPath);
  const store = new ArtifactStore(logger, {
    root: path.join(tmpDir, 'store'),
    maxBytes: 2 * 1024 * 1024
  });

  t.after(() => {
    try { logger.close(); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  await t.test('1. Magic-byte MIME detection', () => {
    assert.equal(detectMimeType(pngFixture()), 'image/png');
    assert.equal(detectMimeType(jpegFixture()), 'image/jpeg');
    assert.equal(detectMimeType(mp4Fixture()), 'video/mp4');
    assert.equal(detectMimeType(Buffer.from('plain text')), null);
  });

  await t.test('2. Filename sanitization strips path components', () => {
    assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd');
    assert.equal(sanitizeFilename('/tmp/../../x/y.png'), 'y.png');
    assert.equal(sanitizeFilename('..'), null);
    assert.equal(sanitizeFilename(''), null);
  });

  await t.test('3. Store returns a compact reference containing NO bytes', async () => {
    const bytes = pngFixture('round-trip');
    const ref = store.put({ bytes, mimeType: 'image/png', filename: '../../evil.png', agentId: 'gemini', taskId: 'task_a' });

    assert.ok(ref.artifact_id.startsWith('art_'));
    assert.equal(ref.mime_type, 'image/png');
    assert.equal(ref.media_type, 'image');
    assert.equal(ref.size_bytes, bytes.length);
    assert.equal(ref.sha256, sha256(bytes));
    assert.equal(ref.storage_backend, 'local-filesystem');
    assert.equal(ref.retrieval_method, 'bridge_artifact_read');
    assert.equal(ref.transfer_status, ArtifactTransferStatus.STORED);
    assert.equal(ref.filename, 'evil.png', 'filename is sanitized to a basename');
    assert.ok(ref.expires_at);
    assert.equal('dataBase64' in ref, false, 'reference must not embed bytes');
    assert.equal('storage_path' in ref, false, 'reference must not leak the storage path');
  });

  await t.test('4. Byte-for-byte round trip with SHA-256 verification', async () => {
    const bytes = pngFixture('byte-for-byte-' + 'x'.repeat(500));
    const ref = store.put({ bytes, mimeType: 'image/png', filename: 'image.png', agentId: 'gemini' });

    const { bytes: out, metadata, integrityVerified } = store.read(ref.artifact_id, { agentId: 'gemini' });
    assert.equal(integrityVerified, true);
    assert.equal(out.length, bytes.length);
    assert.ok(out.equals(bytes), 'retrieved bytes must equal the stored bytes exactly');
    assert.equal(metadata.sha256, sha256(bytes));
    assert.equal(sha256(out), ref.sha256);
  });

  await t.test('5. MP4 video round trip', async () => {
    const bytes = mp4Fixture('fake-video-frame-data');
    const ref = store.put({ bytes, filename: 'clip.mp4', agentId: 'gemini' });
    assert.equal(ref.mime_type, 'video/mp4');
    assert.equal(ref.media_type, 'video');
    const { bytes: out } = store.read(ref.artifact_id, { agentId: 'gemini' });
    assert.ok(out.equals(bytes));
  });

  await t.test('6. Unauthorized callers are rejected', async () => {
    const ref = store.put({ base64: pngFixture().toString('base64'), filename: 'a.png', agentId: 'gemini', taskId: 'task_priv' });
    assert.throws(() => store.read(ref.artifact_id, { agentId: 'chatgpt-desktop' }), (e) => e.code === 'ARTIFACT_UNAUTHORIZED');
    assert.throws(() => store.read(ref.artifact_id, {}), (e) => e.code === 'ARTIFACT_UNAUTHORIZED');
    assert.throws(() => store.getMetadata(ref.artifact_id, { agentId: 'claude-desktop' }), (e) => e.code === 'ARTIFACT_UNAUTHORIZED');
  });

  await t.test('7. Explicitly authorized peers can retrieve; cross-task isolation holds', async () => {
    const ref = store.put({
      bytes: pngFixture('shared'),
      filename: 'shared.png',
      agentId: 'gemini',
      taskId: 'task_a',
      authorizedAgents: ['chatgpt-desktop']
    });
    // Explicitly authorized agent succeeds.
    const ok = store.read(ref.artifact_id, { agentId: 'chatgpt-desktop' });
    assert.equal(ok.integrityVerified, true);

    // An unrelated task's agent is still denied (no accidental cross-task read).
    assert.throws(() => store.read(ref.artifact_id, { agentId: 'claude-desktop' }), (e) => e.code === 'ARTIFACT_UNAUTHORIZED');
  });

  await t.test('8. Path traversal through a forged artifactId cannot escape the store', () => {
    assert.throws(
      () => store.read('../../etc/passwd', { agentId: 'gemini' }),
      (e) => e.code === 'ARTIFACT_NOT_FOUND' || e.code === 'ARTIFACT_PATH_ESCAPE'
    );
    assert.throws(
      () => store.read('art_1/../../../etc/passwd', { agentId: 'gemini' }),
      (e) => e.code === 'ARTIFACT_NOT_FOUND' || e.code === 'ARTIFACT_PATH_ESCAPE'
    );
  });

  await t.test('9. A symlinked artifact file is refused', async () => {
    const ref = store.put({ bytes: pngFixture('symlink-test'), filename: 's.png', agentId: 'gemini' });
    const row = logger.db.prepare('SELECT storage_path FROM bridge_artifacts WHERE artifact_id = ?').get(ref.artifact_id);
    const onDisk = path.join(store.root, row.storage_path);
    const outside = path.join(tmpDir, 'outside-target.png');
    fs.writeFileSync(outside, pngFixture('attacker'));
    fs.rmSync(onDisk);
    fs.symlinkSync(outside, onDisk);

    assert.throws(() => store.read(ref.artifact_id, { agentId: 'gemini' }), (e) => e.code === 'ARTIFACT_SYMLINK');
  });

  await t.test('10. Oversized, empty, mismatched, and corrupt artifacts are rejected', async () => {
    assert.throws(
      () => store.put({ bytes: Buffer.alloc(3 * 1024 * 1024, 1), agentId: 'gemini' }),
      (e) => e.code === 'ARTIFACT_TOO_LARGE'
    );
    assert.throws(
      () => store.put({ bytes: Buffer.alloc(0), agentId: 'gemini' }),
      (e) => e.code === 'ARTIFACT_EMPTY'
    );
    assert.throws(
      () => store.put({ bytes: jpegFixture(), mimeType: 'image/png', agentId: 'gemini' }),
      (e) => e.code === 'ARTIFACT_MIME_MISMATCH'
    );

    // Corruption after storage is detected on read.
    const ref = store.put({ bytes: pngFixture('integrity'), filename: 'i.png', agentId: 'gemini' });
    const row = logger.db.prepare('SELECT storage_path FROM bridge_artifacts WHERE artifact_id = ?').get(ref.artifact_id);
    const onDisk = path.join(store.root, row.storage_path);
    fs.writeFileSync(onDisk, pngFixture('tampered'));
    assert.throws(() => store.read(ref.artifact_id, { agentId: 'gemini' }), (e) => e.code === 'ARTIFACT_INTEGRITY_FAILURE');
  });

  await t.test('11. Expiry blocks retrieval and cleanup removes bytes', async () => {
    const ref = store.put({ bytes: pngFixture('expire-me'), filename: 'e.png', agentId: 'gemini', ttlMs: 30 });
    await new Promise(r => setTimeout(r, 60));
    assert.throws(() => store.read(ref.artifact_id, { agentId: 'gemini' }), (e) => e.code === 'ARTIFACT_EXPIRED');
    const meta = store.getMetadata(ref.artifact_id, { agentId: 'gemini' });
    assert.equal(meta.transfer_status, ArtifactTransferStatus.EXPIRED);
    assert.equal(meta.retrievable, false);

    const cleanup = store.cleanupExpired();
    assert.ok(cleanup.cleaned >= 1);
    const row = logger.db.prepare('SELECT storage_path FROM bridge_artifacts WHERE artifact_id = ?').get(ref.artifact_id);
    assert.equal(fs.existsSync(path.join(store.root, row.storage_path)), false, 'expired bytes must be deleted');
  });

  await t.test('12. Retrieval through the client-facing tool path returns real bytes', async () => {
    const registry = new ToolRegistry();
    const bytes = pngFixture('via-tools-' + 'y'.repeat(300));
    const context = { logger, artifactStore: store };

    const stored = await registry.executeTool('bridge_artifact_store', {
      agentId: 'gemini',
      dataBase64: bytes.toString('base64'),
      mimeType: 'image/png',
      filename: 'tool.png',
      taskId: 'task_tools'
    }, context);

    assert.equal(stored.mime_type, 'image/png');
    assert.equal('dataBase64' in stored, false, 'store tool must not echo bytes');

    const meta = await registry.executeTool('bridge_artifact_get', { agentId: 'gemini', artifactId: stored.artifact_id }, context);
    assert.equal(meta.size_bytes, bytes.length);

    const read = await registry.executeTool('bridge_artifact_read', {
      agentId: 'gemini',
      artifactId: stored.artifact_id,
      expectedSha256: stored.sha256
    }, context);

    assert.equal(read.integrityVerified, true);
    assert.equal(read.expectedSha256Matches, true);
    const returned = Buffer.from(read.dataBase64, 'base64');
    assert.ok(returned.equals(bytes), 'bytes retrieved through the tool path must match exactly');
    assert.equal(sha256(returned), stored.sha256);

    // An unauthorized agent hitting the same tool path is refused.
    await assert.rejects(
      registry.executeTool('bridge_artifact_read', { agentId: 'claude-desktop', artifactId: stored.artifact_id }, context),
      /(Unauthorized|not authorized)/i
    );
  });

  await t.test('13. Oversized base64 is rejected by encoded length BEFORE decoding', () => {
    const originalFrom = Buffer.from;
    let decoded = false;
    // Spy: any base64 decode attempting to allocate is observable.
    Buffer.from = function (...a) {
      if (typeof a[0] === 'string' && a[1] === 'base64') decoded = true;
      return originalFrom.apply(Buffer, a);
    };
    try {
      const oversized = 'A'.repeat(store._maxEncodedLength() + 1024);
      assert.throws(
        () => store.put({ base64: oversized, agentId: 'gemini' }),
        (e) => e.code === 'ARTIFACT_TOO_LARGE'
      );
      assert.equal(decoded, false, 'the oversized payload must never be decoded');
    } finally {
      Buffer.from = originalFrom;
    }
  });

  await t.test('14. Invalid base64 is rejected, not silently decoded', () => {
    assert.throws(
      () => store.put({ base64: 'not*valid*base64!!!', agentId: 'gemini' }),
      (e) => e.code === 'ARTIFACT_BAD_BASE64'
    );
  });

  await t.test('15. A signature MIME declaration must match the real bytes', () => {
    // Plain text declared as an image must NOT be stored under image/png.
    assert.throws(
      () => store.put({ bytes: Buffer.from('this is definitely not a png'), mimeType: 'image/png', agentId: 'gemini' }),
      (e) => e.code === 'ARTIFACT_MIME_MISMATCH'
    );
    // A real PNG with the matching declaration still succeeds.
    const ok = store.put({ bytes: pngFixture('real'), mimeType: 'image/png', agentId: 'gemini' });
    assert.equal(ok.mime_type, 'image/png');
  });

  await t.test('16. Metadata and bytes survive a store/process restart', () => {
    const bytes = pngFixture('persisted-across-restart');
    const ref = store.put({ bytes, filename: 'restart.png', agentId: 'gemini' });

    // A fresh store instance over the same db + root simulates a process restart.
    const reopened = new ArtifactStore(logger, { root: store.root, maxBytes: 2 * 1024 * 1024 });
    const meta = reopened.getMetadata(ref.artifact_id, { agentId: 'gemini' });
    assert.equal(meta.size_bytes, bytes.length);
    assert.equal(meta.sha256, ref.sha256);
    const { bytes: out, integrityVerified } = reopened.read(ref.artifact_id, { agentId: 'gemini' });
    assert.equal(integrityVerified, true);
    assert.ok(out.equals(bytes));
  });

  await t.test('17. Concurrent stores yield distinct, non-colliding artifacts', async () => {
    const writes = Array.from({ length: 20 }, (_, i) =>
      Promise.resolve().then(() => store.put({ bytes: pngFixture('concurrent-' + i), filename: `c${i}.png`, agentId: 'gemini' }))
    );
    const refs = await Promise.all(writes);
    const ids = new Set(refs.map(r => r.artifact_id));
    assert.equal(ids.size, 20, 'every artifact must have a unique id');
    for (const ref of refs) {
      const { integrityVerified } = store.read(ref.artifact_id, { agentId: 'gemini' });
      assert.equal(integrityVerified, true);
    }
  });

  await t.test('18. The inline ceiling is enforced from metadata before reading bytes', async () => {
    const bigRoot = path.join(tmpDir, 'big-store');
    const bigStore = new ArtifactStore(logger, { root: bigRoot, maxBytes: 9 * 1024 * 1024 });
    const bigBytes = Buffer.concat([pngFixture('big'), Buffer.alloc(8 * 1024 * 1024 + 4096, 7)]);
    assert.ok(bigBytes.length > ArtifactStore.maxInlineBytes);
    const ref = bigStore.put({ bytes: bigBytes, mimeType: 'image/png', agentId: 'gemini' });

    // Metadata-level read with the inline ceiling rejects without reading bytes.
    assert.throws(
      () => bigStore.read(ref.artifact_id, { agentId: 'gemini', maxBytes: ArtifactStore.maxInlineBytes }),
      (e) => e.code === 'ARTIFACT_TOO_LARGE_INLINE'
    );

    // Through the client-facing tool path the same ceiling applies.
    const registry = new ToolRegistry();
    await assert.rejects(
      registry.executeTool('bridge_artifact_read', { agentId: 'gemini', artifactId: ref.artifact_id }, { logger, artifactStore: bigStore }),
      /too large|exceeds/i
    );
  });
});
