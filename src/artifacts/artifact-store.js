import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * ArtifactStore
 *
 * Durable, integrity-verified transport for binary artifacts (images, video, ...)
 * produced during agent work.
 *
 * Design boundaries (deliberate):
 *  - The normal task/request RESULT carries only compact artifact metadata and a
 *    retrieval reference — never an enormous inline base64 payload.
 *  - Actual bytes flow through an explicit, authorized retrieval call.
 *  - Every write and read is integrity-checked with SHA-256.
 *  - The store is transport-neutral: it does not claim a provider produced bytes
 *    it did not actually produce. Callers must supply real bytes.
 *
 * Security properties:
 *  - artifact ids are server-generated, so a caller can never influence the path
 *  - storage paths are containment-checked against the artifact root
 *  - files are created with O_EXCL (no clobbering, no following an existing symlink)
 *  - reads reject symlinks and re-verify containment via realpath
 *  - size limits, MIME/content agreement, and expiry are enforced
 *  - retrieval is authorized per artifact (storing agent + explicitly authorized agents)
 */

export const ArtifactTransferStatus = Object.freeze({
  STORED: 'STORED',
  EXPIRED: 'EXPIRED',
  REJECTED: 'REJECTED',
  MISSING: 'MISSING'
});

export const ArtifactError = class ArtifactError extends Error {
  constructor(message, code, status = ArtifactTransferStatus.REJECTED) {
    super(message);
    this.name = 'ArtifactError';
    this.code = code;
    this.status = status;
  }
};

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024; // 25 MiB per artifact
const MAX_INLINE_BYTES = 8 * 1024 * 1024;   // largest artifact returned inline

const EXT_BY_MIME = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'text/plain': 'txt',
  'application/json': 'json',
  'application/octet-stream': 'bin'
});

const DEFAULT_ALLOWED_MIME = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'video/mp4', 'video/quicktime',
  'text/plain', 'application/json', 'application/octet-stream'
]);

// MIME types whose content is unambiguously identifiable from magic bytes. A
// declaration of one of these MUST be confirmed by the actual bytes; otherwise
// arbitrary content could be stored under a privileged media type.
const SIGNATURE_MIME = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'video/mp4', 'video/quicktime'
]);

// Strict base64 (padding optional); whitespace is normalised away before use.
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function mediaTypeOf(mimeType) {
  if (!mimeType) return 'unknown';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('text/')) return 'text';
  return 'binary';
}

/** Best-effort MIME sniffing from magic bytes. Returns null when unknown. */
export function detectMimeType(buffer) {
  if (!buffer || buffer.length < 4) return null;
  const b = buffer;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp') {
    const brand = b.toString('ascii', 8, 12);
    if (brand === 'qt  ') return 'video/quicktime';
    return 'video/mp4';
  }
  return null;
}

/** Remove any path components and control characters from a display filename. */
export function sanitizeFilename(filename) {
  if (!filename || typeof filename !== 'string') return null;
  const base = path.basename(filename).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!base || base === '.' || base === '..') return null;
  return base.slice(0, 200);
}

export class ArtifactStore {
  constructor(auditLogger, options = {}) {
    this.logger = auditLogger || null;
    this.db = auditLogger?.db || options.db || null;
    this.dbPath = auditLogger?.dbPath || options.dbPath || 'data/bridge.sqlite';
    this.root = options.root || path.join(path.dirname(this.dbPath), 'artifacts');
    this.maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : DEFAULT_MAX_BYTES;
    this.defaultTtlMs = options.defaultTtlMs === undefined ? 24 * 60 * 60 * 1000 : options.defaultTtlMs;
    this.allowedMime = options.allowedMime || DEFAULT_ALLOWED_MIME;

    if (this.db) this.initTables();
    this._ensureRoot();
  }

  initTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bridge_artifacts (
        artifact_id TEXT PRIMARY KEY,
        task_id TEXT,
        attempt_id TEXT,
        agent_id TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        media_type TEXT NOT NULL,
        filename TEXT,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        storage_backend TEXT NOT NULL,
        retrieval_method TEXT NOT NULL,
        storage_path TEXT NOT NULL,
        authorized_agents TEXT,
        transfer_status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT,
        metadata TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_bridge_artifacts_task ON bridge_artifacts(task_id);
      CREATE INDEX IF NOT EXISTS idx_bridge_artifacts_status ON bridge_artifacts(transfer_status, expires_at);
    `);
  }

  _ensureRoot() {
    const dir = this.root;
    if (fs.existsSync(dir)) {
      const st = fs.lstatSync(dir);
      if (st.isSymbolicLink()) {
        throw new ArtifactError('Artifact root must not be a symlink', 'ARTIFACT_ROOT_SYMLINK');
      }
      if (!st.isDirectory()) {
        throw new ArtifactError('Artifact root is not a directory', 'ARTIFACT_ROOT_INVALID');
      }
    } else {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  _assertContained(candidate) {
    const resolved = path.resolve(candidate);
    const root = path.resolve(this.root);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new ArtifactError('Storage path escapes the artifact root', 'ARTIFACT_PATH_ESCAPE');
    }
    return resolved;
  }

  /**
   * Real (symlink-resolved) root. On macOS /var is a symlink to /private/var, so
   * a lexical containment check and a realpath check must be compared against
   * their own respective roots.
   */
  _realRoot() {
    if (!this._realRootCache) {
      try { this._realRootCache = fs.realpathSync(this.root); }
      catch { this._realRootCache = path.resolve(this.root); }
    }
    return this._realRootCache;
  }

  _assertContainedReal(realPath) {
    const root = this._realRoot();
    if (realPath !== root && !realPath.startsWith(root + path.sep)) {
      throw new ArtifactError('Storage path escapes the artifact root', 'ARTIFACT_PATH_ESCAPE');
    }
    return realPath;
  }

  _storagePath(artifactId, ext) {
    const name = ext ? `${artifactId}.${ext}` : artifactId;
    return this._assertContained(path.join(this.root, name));
  }

  /** Maximum encoded (base64) length that could still decode within maxBytes. */
  _maxEncodedLength() {
    return Math.ceil(this.maxBytes / 3) * 4 + 8;
  }

  _toBuffer({ bytes, base64 }) {
    if (Buffer.isBuffer(bytes)) return bytes;
    if (bytes instanceof Uint8Array) return Buffer.from(bytes);
    if (typeof base64 === 'string' && base64.length > 0) {
      // Normalise whitespace first, then reject by ENCODED length before any
      // decoded buffer is allocated. Decoding an unbounded string only to reject
      // it afterwards is a memory-amplification vector (base64 expands input).
      const normalized = base64.replace(/\s+/g, '');
      const maxEncoded = this._maxEncodedLength();
      if (normalized.length > maxEncoded) {
        throw new ArtifactError(
          `Encoded artifact exceeds size limit (${normalized.length} base64 chars > ${maxEncoded})`,
          'ARTIFACT_TOO_LARGE'
        );
      }
      if (!BASE64_RE.test(normalized)) {
        throw new ArtifactError('Invalid base64 payload', 'ARTIFACT_BAD_BASE64');
      }
      return Buffer.from(normalized, 'base64');
    }
    throw new ArtifactError('Artifact requires bytes or base64 data', 'ARTIFACT_NO_DATA');
  }

  /**
   * Persist bytes and return a compact, retrievable artifact reference.
   */
  put({
    bytes = null,
    base64 = null,
    mimeType = null,
    filename = null,
    taskId = null,
    attemptId = null,
    agentId,
    ttlMs = undefined,
    authorizedAgents = [],
    metadata = null
  } = {}) {
    if (!agentId) throw new ArtifactError('agentId is required to store an artifact', 'ARTIFACT_NO_AGENT');

    const buffer = this._toBuffer({ bytes, base64 });
    if (buffer.length === 0) throw new ArtifactError('Refusing to store an empty artifact', 'ARTIFACT_EMPTY');
    if (buffer.length > this.maxBytes) {
      throw new ArtifactError(`Artifact exceeds size limit (${buffer.length} > ${this.maxBytes})`, 'ARTIFACT_TOO_LARGE');
    }

    const detected = detectMimeType(buffer);
    if (mimeType && detected && mimeType !== detected) {
      throw new ArtifactError(`Declared MIME '${mimeType}' disagrees with content '${detected}'`, 'ARTIFACT_MIME_MISMATCH');
    }
    // A signature-bearing media type must be confirmable from the bytes. Without
    // this, arbitrary content could be stored (and later served) as image/* or
    // video/* simply by declaring it so.
    if (mimeType && SIGNATURE_MIME.has(mimeType) && detected !== mimeType) {
      throw new ArtifactError(
        `Declared MIME '${mimeType}' could not be confirmed from the content magic bytes`,
        'ARTIFACT_MIME_MISMATCH'
      );
    }
    const effectiveMime = detected || mimeType || 'application/octet-stream';
    if (!this.allowedMime.has(effectiveMime)) {
      throw new ArtifactError(`MIME type '${effectiveMime}' is not permitted`, 'ARTIFACT_MIME_UNSUPPORTED');
    }

    const artifactId = `art_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
    const ext = EXT_BY_MIME[effectiveMime] || null;
    const storagePath = this._storagePath(artifactId, ext);

    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const now = new Date();
    const ttl = ttlMs === undefined ? this.defaultTtlMs : ttlMs;
    const expiresAt = (ttl && Number.isFinite(ttl) && ttl > 0)
      ? new Date(now.getTime() + ttl).toISOString()
      : null;

    // O_EXCL: never clobber, never follow a pre-existing symlink.
    fs.writeFileSync(storagePath, buffer, { flag: 'wx', mode: 0o600 });

    const authorized = Array.from(new Set([agentId, ...(Array.isArray(authorizedAgents) ? authorizedAgents : [])].filter(Boolean)));

    this.db.prepare(`
      INSERT INTO bridge_artifacts (
        artifact_id, task_id, attempt_id, agent_id, mime_type, media_type, filename,
        size_bytes, sha256, storage_backend, retrieval_method, storage_path,
        authorized_agents, transfer_status, created_at, expires_at, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      artifactId,
      taskId,
      attemptId,
      agentId,
      effectiveMime,
      mediaTypeOf(effectiveMime),
      sanitizeFilename(filename),
      buffer.length,
      sha256,
      'local-filesystem',
      'bridge_artifact_read',
      path.relative(this.root, storagePath),
      JSON.stringify(authorized),
      ArtifactTransferStatus.STORED,
      now.toISOString(),
      expiresAt,
      metadata ? JSON.stringify(metadata) : null
    );

    this.logger?.log?.({
      agentId,
      action: 'artifact_store',
      status: 'success',
      details: { artifactId, taskId, mimeType: effectiveMime, sizeBytes: buffer.length, sha256 }
    });

    return this.getMetadata(artifactId, { agentId });
  }

  _row(artifactId) {
    if (!artifactId || typeof artifactId !== 'string') {
      throw new ArtifactError('artifactId is required', 'ARTIFACT_NO_ID', ArtifactTransferStatus.MISSING);
    }
    const row = this.db.prepare('SELECT * FROM bridge_artifacts WHERE artifact_id = ?').get(artifactId);
    if (!row) throw new ArtifactError(`Artifact '${artifactId}' not found`, 'ARTIFACT_NOT_FOUND', ArtifactTransferStatus.MISSING);
    return row;
  }

  _authorize(row, agentId) {
    if (!agentId) {
      throw new ArtifactError('Retrieval requires an authenticated agentId', 'ARTIFACT_UNAUTHORIZED');
    }
    let authorized = [];
    try { authorized = JSON.parse(row.authorized_agents || '[]'); } catch { authorized = []; }
    if (!authorized.includes(agentId) && row.agent_id !== agentId) {
      throw new ArtifactError(`Agent '${agentId}' is not authorized for artifact '${row.artifact_id}'`, 'ARTIFACT_UNAUTHORIZED');
    }
  }

  _expired(row) {
    if (row.transfer_status === ArtifactTransferStatus.EXPIRED) return true;
    if (!row.expires_at) return false;
    return Date.parse(row.expires_at) <= Date.now();
  }

  /** Public, compact reference (no bytes, no internal storage path). */
  _public(row) {
    return {
      artifact_id: row.artifact_id,
      task_id: row.task_id,
      attempt_id: row.attempt_id,
      agent_id: row.agent_id,
      mime_type: row.mime_type,
      media_type: row.media_type,
      filename: row.filename,
      size_bytes: row.size_bytes,
      sha256: row.sha256,
      storage_backend: row.storage_backend,
      retrieval_method: row.retrieval_method,
      transfer_status: row.transfer_status,
      created_at: row.created_at,
      expires_at: row.expires_at
    };
  }

  getMetadata(artifactId, { agentId } = {}) {
    const row = this._row(artifactId);
    this._authorize(row, agentId);
    if (this._expired(row)) {
      return { ...this._public(row), transfer_status: ArtifactTransferStatus.EXPIRED, retrievable: false };
    }
    return { ...this._public(row), retrievable: true };
  }

  /**
   * Read and integrity-verify the actual bytes.
   * @returns {Promise<{bytes:Buffer, metadata:object, integrityVerified:boolean}>}
   */
  read(artifactId, { agentId, maxBytes = null } = {}) {
    const row = this._row(artifactId);
    this._authorize(row, agentId);
    if (this._expired(row)) {
      throw new ArtifactError(`Artifact '${artifactId}' has expired`, 'ARTIFACT_EXPIRED', ArtifactTransferStatus.EXPIRED);
    }
    // Enforce an inline/consumer size ceiling from stored metadata BEFORE the
    // bytes are read into memory, so an over-limit retrieval never allocates
    // the full artifact just to be rejected afterwards.
    if (maxBytes && row.size_bytes > maxBytes) {
      throw new ArtifactError(
        `Artifact '${artifactId}' (${row.size_bytes} bytes) exceeds the ${maxBytes}-byte limit`,
        'ARTIFACT_TOO_LARGE_INLINE'
      );
    }

    const storagePath = this._assertContained(path.join(this.root, row.storage_path));
    if (!fs.existsSync(storagePath)) {
      throw new ArtifactError(`Artifact '${artifactId}' bytes are missing`, 'ARTIFACT_BYTES_MISSING', ArtifactTransferStatus.MISSING);
    }
    const st = fs.lstatSync(storagePath);
    if (st.isSymbolicLink()) {
      throw new ArtifactError('Refusing to read a symlinked artifact', 'ARTIFACT_SYMLINK');
    }
    // Re-verify containment after resolving any symlinked root components.
    const real = this._assertContainedReal(fs.realpathSync(storagePath));

    // OS-level TOCTOU protection: open with O_NOFOLLOW to guarantee no symlink
    // can be substituted between validation and open. All stat and read operations
    // are then performed directly on the opened file descriptor in the kernel.
    let fd = null;
    let bytes;
    try {
      const openFlags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
      fd = fs.openSync(real, openFlags);
      const fdStat = fs.fstatSync(fd);
      if (!fdStat.isFile()) {
        throw new ArtifactError('Refusing to read a non-regular artifact file', 'ARTIFACT_NOT_REGULAR_FILE');
      }
      if (fdStat.size !== row.size_bytes) {
        throw new ArtifactError('Artifact size changed since storage', 'ARTIFACT_INTEGRITY_FAILURE');
      }
      bytes = fs.readFileSync(fd);
    } catch (err) {
      if (err.code === 'ELOOP' || (err.message && err.message.includes('symlink'))) {
        throw new ArtifactError('Refusing to read a symlinked artifact', 'ARTIFACT_SYMLINK');
      }
      throw err;
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch {}
      }
    }

    if (bytes.length !== row.size_bytes) {
      throw new ArtifactError('Artifact size changed since storage', 'ARTIFACT_INTEGRITY_FAILURE');
    }
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== row.sha256) {
      throw new ArtifactError('Artifact SHA-256 does not match the stored hash', 'ARTIFACT_INTEGRITY_FAILURE');
    }

    return { bytes, metadata: this._public(row), integrityVerified: true };
  }

  /** Verify a candidate hash against the stored artifact without returning bytes. */
  verify(artifactId, expectedSha256, { agentId } = {}) {
    const { metadata, bytes } = this.read(artifactId, { agentId });
    if (!bytes) return { verified: false, metadata };
    return {
      verified: expectedSha256 ? metadata.sha256 === expectedSha256 : true,
      sha256: metadata.sha256,
      size_bytes: metadata.size_bytes,
      metadata
    };
  }

  /** Delete expired artifact bytes and mark their metadata expired. */
  cleanupExpired(now = Date.now()) {
    let rows = [];
    try {
      rows = this.db.prepare(`
        SELECT * FROM bridge_artifacts
        WHERE transfer_status = 'STORED' AND expires_at IS NOT NULL AND expires_at <= ?
      `).all(new Date(now).toISOString());
    } catch (err) {
      this.logger?.debug?.('Failed to query expired artifacts', err);
      return { cleaned: 0 };
    }

    let cleaned = 0;
    for (const row of rows) {
      try {
        const storagePath = this._assertContained(path.join(this.root, row.storage_path));
        if (fs.existsSync(storagePath)) fs.rmSync(storagePath, { force: true });
        this.db.prepare(`UPDATE bridge_artifacts SET transfer_status = 'EXPIRED' WHERE artifact_id = ?`).run(row.artifact_id);
        cleaned++;
      } catch (err) {
        this.logger?.debug?.(`Failed to clean expired artifact ${row.artifact_id}`, err);
      }
    }
    return { cleaned };
  }

  static get maxInlineBytes() {
    return MAX_INLINE_BYTES;
  }
}
