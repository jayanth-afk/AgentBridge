import crypto from 'node:crypto';

/**
 * ResponseMode enum
 */
export const ResponseMode = Object.freeze({
  DIRECT: 'direct',
  ASSIST: 'assist',
  SYNTHESIS: 'synthesis',
  STRUCTURED: 'structured'
});

/**
 * Scans text for leaked credentials, private keys, or API tokens.
 * Returns { detected: boolean, reason?: string }.
 */
export function scanForSensitiveCredentials(text) {
  if (typeof text !== 'string') return { detected: false };
  const rawSecretPatterns = [
    // AWS Access Key ID
    /\bAKIA[0-9A-Z]{16}\b/,
    // GitHub Personal Access Token / Fine-grained token
    /\bgh[pousr]_[A-Za-z0-9_]{36,}\b/,
    // Private Key blocks
    /-----BEGIN (?:[A-Z0-9_-]+ )?PRIVATE KEY-----/,
    // JWT Tokens (3 base64url segments)
    /\beyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/,
    // Explicit API Key assignments
    /\b(?:api[_-]?key|secret[_-]?key|client[_-]?secret|auth[_-]?token)\s*[:=]\s*['"][a-zA-Z0-9_.-]{16,}['"]/i,
    // Password assignments with sensitive values
    /\b(?:password|passwd|pwd)\s*[:=]\s*['"][^'"]{8,}['"]/i
  ];

  for (const pattern of rawSecretPatterns) {
    if (pattern.test(text)) {
      return { detected: true, reason: 'CREDENTIAL_DETECTED_IN_RESPONSE' };
    }
  }
  return { detected: false };
}

/**
 * Detects the appropriate response mode.
 * Explicit caller mode takes absolute precedence.
 * Heuristics act solely as fallback when explicitMode is omitted or null.
 */
export function detectResponseMode({ question = '', objective = '', explicitMode = null } = {}) {
  if (explicitMode && typeof explicitMode === 'string') {
    const norm = explicitMode.toLowerCase();
    if (Object.values(ResponseMode).includes(norm)) {
      return norm;
    }
  }

  const combined = `${question} ${objective}`.toLowerCase();

  // Structured mode triggers
  const structuredTriggers = [
    'json schema', 'json format', 'json output', 'return json',
    'machine-readable', 'structured json', 'output as json', 'schema:'
  ];
  if (structuredTriggers.some(t => combined.includes(t))) {
    return ResponseMode.STRUCTURED;
  }

  // Assist / Synthesis triggers
  const assistTriggers = [
    'synthesize', 'consensus', 'reconcile', 'compare and contrast',
    'critique', 'review and refine', 'incorporate both', 'unified proposal',
    'peer review', 'merge findings'
  ];
  if (assistTriggers.some(t => combined.includes(t))) {
    return ResponseMode.ASSIST;
  }

  // Default: Direct mode (relay of responding agent's unaltered intelligence)
  return ResponseMode.DIRECT;
}

/**
 * ResponsePreserver
 *
 * Durably preserves responding agent outputs as immutable response artifacts:
 * - Exact response text (preserving formatting, code blocks, links, citations)
 * - Structured metadata and content extraction
 * - Compact response envelopes with untrustedData: true markers
 * - Credential quarantine: scans response content; withholds leaked credentials
 * - Content-hash addressing and byte payload accounting
 */
export class ResponsePreserver {
  constructor(db, options = {}) {
    this.db = db;
    // Optional canonical payload store. When present, response bytes live once in
    // bridge_artifacts and this table holds only metadata + a reference.
    this.artifactStore = options.artifactStore || null;
    this.ensureSchema();
  }

  /**
   * Structured debug logging for non-fatal internal failures.
   * Never silently swallows an error; never leaks payload content.
   * Enabled via AGENT_BRIDGE_DEBUG=1 so normal runs stay quiet.
   */
  _logDebug(context, err) {
    if (!process.env.AGENT_BRIDGE_DEBUG) return;
    const message = err && err.message ? err.message : String(err);
    process.stderr.write(`[ResponsePreserver] ${context}: ${message}\n`);
  }

  ensureSchema() {
    if (!this.db || typeof this.db.exec !== 'function') return;
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS bridge_response_artifacts (
          response_id TEXT PRIMARY KEY,
          request_id TEXT NOT NULL,
          task_id TEXT,
          responding_agent_id TEXT NOT NULL,
          requesting_agent_id TEXT NOT NULL,
          content_type TEXT NOT NULL DEFAULT 'text/plain',
          response_text TEXT NOT NULL,
          structured_data TEXT,
          code_blocks TEXT,
          content_hash TEXT NOT NULL,
          payload_size INTEGER NOT NULL,
          result_version INTEGER NOT NULL DEFAULT 1,
          response_mode TEXT NOT NULL DEFAULT 'direct',
          quarantined INTEGER NOT NULL DEFAULT 0,
          quarantine_reason TEXT,
          correlation_tier TEXT NOT NULL DEFAULT 'direct_session',
          attempt_epoch INTEGER NOT NULL DEFAULT 1,
          origin_route TEXT NOT NULL DEFAULT 'bridge',
          payload_artifact_id TEXT,
          payload_manifest TEXT,
          token_usage TEXT,
          execution_metadata TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_resp_artifacts_req ON bridge_response_artifacts(request_id);
        CREATE INDEX IF NOT EXISTS idx_resp_artifacts_task ON bridge_response_artifacts(task_id);
      `);

      // Safe schema migrations for existing tables. A "duplicate column" error is
      // the expected no-op when the column already exists, but it is surfaced to
      // debug logging rather than silently discarded.
      for (const ddl of [
        `ALTER TABLE bridge_response_artifacts ADD COLUMN quarantined INTEGER NOT NULL DEFAULT 0;`,
        `ALTER TABLE bridge_response_artifacts ADD COLUMN quarantine_reason TEXT;`,
        `ALTER TABLE bridge_response_artifacts ADD COLUMN correlation_tier TEXT NOT NULL DEFAULT 'direct_session';`,
        `ALTER TABLE bridge_response_artifacts ADD COLUMN attempt_epoch INTEGER NOT NULL DEFAULT 1;`,
        `ALTER TABLE bridge_response_artifacts ADD COLUMN origin_route TEXT NOT NULL DEFAULT 'bridge';`,
        `ALTER TABLE bridge_response_artifacts ADD COLUMN payload_artifact_id TEXT;`,
        `ALTER TABLE bridge_response_artifacts ADD COLUMN payload_manifest TEXT;`
      ]) {
        try { this.db.exec(ddl); } catch (err) { this._logDebug('schema migration skipped', err); }
      }
    } catch (err) {
      // Non-fatal for in-memory/mock databases, but never silent.
      this._logDebug('ensureSchema failed', err);
    }
  }

  /**
   * Parse code blocks out of response text without modifying the text.
   */
  extractCodeBlocks(text) {
    if (typeof text !== 'string') return [];
    const blocks = [];
    const codeBlockRegex = /```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g;
    let match;
    while ((match = codeBlockRegex.exec(text)) !== null) {
      blocks.push({
        language: match[1] || 'plaintext',
        code: match[2],
        length: match[2].length,
        lines: match[2].split('\n').length
      });
    }
    return blocks;
  }

  /**
   * Detect content type and extract structured JSON if present.
   */
  analyzeContent(text) {
    if (typeof text !== 'string') {
      return { contentType: 'application/json', structuredData: text };
    }

    const trimmed = text.trim();
    // Check if entire text is valid JSON
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        const parsed = JSON.parse(trimmed);
        return { contentType: 'application/json', structuredData: parsed };
      } catch (err) {
        // Expected for JSON-looking text that is not strictly valid JSON.
        this._logDebug('analyzeContent JSON parse fell back to text', err);
      }
    }

    // Check if text contains markdown code blocks or formatting
    if (trimmed.includes('```') || trimmed.includes('# ') || trimmed.includes('*') || trimmed.includes('- ')) {
      return { contentType: 'text/markdown', structuredData: null };
    }

    return { contentType: 'text/plain', structuredData: null };
  }

  /**
   * Preserve an authentic model response as a durable response artifact.
   * Performs credential scanning: if credentials exist, marks quarantined: true.
   */
  preserveResponse({
    requestId,
    taskId = null,
    respondingAgentId,
    requestingAgentId,
    responseText,
    responseMode = ResponseMode.DIRECT,
    tokenUsage = null,
    executionMetadata = {}
  }) {
    if (!requestId) throw new Error('requestId is required to preserve response');
    if (!respondingAgentId) throw new Error('respondingAgentId is required');

    const exactText = typeof responseText === 'string' ? responseText : JSON.stringify(responseText);
    const contentHash = crypto.createHash('sha256').update(exactText).digest('hex');
    const payloadSize = Buffer.byteLength(exactText, 'utf8');
    const responseId = `resp_${contentHash.slice(0, 12)}_${Date.now()}`;
    const now = new Date().toISOString();

    const { contentType, structuredData } = this.analyzeContent(exactText);
    const codeBlocks = this.extractCodeBlocks(exactText);

    // Canonical payload storage: the response bytes are persisted once in
    // ArtifactStore (bridge_artifacts). This metadata row references that
    // artifact instead of duplicating the response text.
    const canonical = this._persistCanonicalPayload({
      exactText,
      contentType,
      requestId,
      taskId,
      respondingAgentId,
      requestingAgentId: requestingAgentId || 'unknown'
    }, contentHash);

    // Credential denylist scan: Never leak raw credentials or secrets
    const secretScan = scanForSensitiveCredentials(exactText);
    const isQuarantined = secretScan.detected;
    const quarantineReason = secretScan.reason || null;

    const correlationTier = executionMetadata.correlationTier || 'direct_session';
    const attemptEpoch = executionMetadata.attemptEpoch || 1;
    const originRoute = executionMetadata.originRoute || 'bridge';

    const artifact = {
      responseId,
      requestId,
      taskId,
      respondingAgentId,
      requestingAgentId: requestingAgentId || 'unknown',
      contentType,
      responseText: exactText,
      structuredData,
      codeBlocks,
      contentHash: `sha256:${contentHash}`,
      payloadSize,
      resultVersion: 1,
      responseMode,
      quarantined: isQuarantined,
      quarantineReason,
      correlationTier,
      attemptEpoch,
      originRoute,
      payloadArtifactId: canonical ? canonical.artifactId : null,
      payloadManifest: canonical ? canonical.manifest : null,
      tokenUsage: tokenUsage || null,
      executionMetadata,
      createdAt: now
    };

    if (this.db && typeof this.db.prepare === 'function') {
      try {
        this.db.prepare(`
          INSERT OR REPLACE INTO bridge_response_artifacts (
            response_id, request_id, task_id, responding_agent_id, requesting_agent_id,
            content_type, response_text, structured_data, code_blocks, content_hash,
            payload_size, result_version, response_mode, quarantined, quarantine_reason,
            correlation_tier, attempt_epoch, origin_route, payload_artifact_id, payload_manifest,
            token_usage, execution_metadata, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          artifact.responseId,
          artifact.requestId,
          artifact.taskId,
          artifact.respondingAgentId,
          artifact.requestingAgentId,
          artifact.contentType,
          artifact.payloadArtifactId ? '' : artifact.responseText,
          artifact.structuredData ? JSON.stringify(artifact.structuredData) : null,
          artifact.codeBlocks.length > 0 ? JSON.stringify(artifact.codeBlocks) : null,
          artifact.contentHash,
          artifact.payloadSize,
          artifact.resultVersion,
          artifact.responseMode,
          artifact.quarantined ? 1 : 0,
          artifact.quarantineReason,
          artifact.correlationTier,
          artifact.attemptEpoch,
          artifact.originRoute,
          artifact.payloadArtifactId,
          artifact.payloadManifest ? JSON.stringify(artifact.payloadManifest) : null,
          artifact.tokenUsage ? JSON.stringify(artifact.tokenUsage) : null,
          artifact.executionMetadata ? JSON.stringify(artifact.executionMetadata) : null,
          artifact.createdAt
        );
      } catch (err) {
        // Non-fatal for in-memory/mock databases, but never silent.
        this._logDebug('preserveResponse persistence skipped', err);
      }
    }

    return artifact;
  }

  /**
   * Construct a compact, lightweight response envelope for notification delivery.
   * Includes untrustedData: true, correlation evidence, and bridgeUnaltered status.
   */
  createCompactEnvelope(artifact) {
    if (!artifact) return null;
    const isUnaltered = !artifact.quarantined && (artifact.responseMode === ResponseMode.DIRECT);

    return {
      eventType: 'task.completed',
      requestId: artifact.requestId,
      taskId: artifact.taskId,
      responseId: artifact.responseId,
      respondingAgentId: artifact.respondingAgentId,
      requestingAgentId: artifact.requestingAgentId,
      contentType: artifact.contentType,
      resultVersion: artifact.resultVersion || 1,
      contentHash: artifact.contentHash,
      payloadSize: artifact.payloadSize,
      responseMode: artifact.responseMode || ResponseMode.DIRECT,
      hasCodeBlocks: (artifact.codeBlocks?.length || 0) > 0,
      codeBlockCount: artifact.codeBlocks?.length || 0,
      bridgeUnaltered: isUnaltered,
      untrustedData: true,
      quarantined: Boolean(artifact.quarantined),
      quarantineReason: artifact.quarantineReason || null,
      correlationTier: artifact.correlationTier || 'direct_session',
      attemptEpoch: artifact.attemptEpoch || 1,
      originRoute: artifact.originRoute || 'bridge'
    };
  }

  /**
   * Persist the canonical response payload into ArtifactStore (bridge_artifacts).
   * Returns { artifactId, manifest } or null when no canonical store is configured
   * or the payload cannot be stored (in which case the caller keeps inline text).
   */
  _persistCanonicalPayload({ exactText, contentType, requestId, taskId, respondingAgentId, requestingAgentId }, contentHash) {
    if (!this.artifactStore || !exactText) return null;

    // Idempotent replay: reuse the existing artifact for the same request + hash.
    try {
      const existing = this.db?.prepare(
        'SELECT payload_artifact_id FROM bridge_response_artifacts WHERE request_id = ? AND content_hash = ? AND payload_artifact_id IS NOT NULL LIMIT 1'
      ).get(requestId, `sha256:${contentHash}`);
      if (existing?.payload_artifact_id) {
        return { artifactId: existing.payload_artifact_id, manifest: { reused: true } };
      }
    } catch (err) {
      this._logDebug('canonical payload reuse lookup skipped', err);
    }

    try {
      const ref = this.artifactStore.put({
        bytes: Buffer.from(exactText, 'utf8'),
        mimeType: this._canonicalMime(contentType),
        filename: `${requestId}.txt`,
        taskId: taskId || null,
        agentId: respondingAgentId,
        authorizedAgents: [requestingAgentId].filter(Boolean)
      });
      return {
        artifactId: ref.artifact_id,
        manifest: { sha256: ref.sha256, sizeBytes: ref.size_bytes, mimeType: ref.mime_type }
      };
    } catch (err) {
      // Keep inline text as a safe fallback; never lose the response.
      this._logDebug('canonical payload store failed; keeping inline text', err);
      return null;
    }
  }

  /** Map response content types onto ArtifactStore's permitted MIME set. */
  _canonicalMime(contentType) {
    return contentType === 'application/json' ? 'application/json' : 'text/plain';
  }

  /**
   * Resolve response text from the canonical store, falling back to inline text
   * (legacy rows and no-store deployments).
   */
  _resolveCanonicalText(row) {
    if (!row?.payload_artifact_id) return row?.response_text ?? null;
    if (!this.artifactStore) {
      this._logDebug('canonical payload present but no artifact store configured', new Error(row.payload_artifact_id));
      return row.response_text ?? null;
    }
    try {
      const { bytes } = this.artifactStore.read(row.payload_artifact_id, {
        agentId: row.requesting_agent_id
      });
      return bytes.toString('utf8');
    } catch (err) {
      this._logDebug('canonical payload read failed; falling back to inline text', err);
      return row.response_text ?? null;
    }
  }

  /**
   * Retrieve response artifact by responseId.
   */
  getByResponseId(responseId) {
    if (!this.db || typeof this.db.prepare !== 'function') return null;
    try {
      const row = this.db.prepare('SELECT * FROM bridge_response_artifacts WHERE response_id = ?').get(responseId);
      return this._hydrate(row);
    } catch (err) {
      this._logDebug('getByResponseId failed', err);
      return null;
    }
  }

  /**
   * Retrieve response artifact by requestId.
   */
  getByRequestId(requestId) {
    if (!this.db || typeof this.db.prepare !== 'function') return null;
    try {
      const row = this.db.prepare('SELECT * FROM bridge_response_artifacts WHERE request_id = ? ORDER BY created_at DESC LIMIT 1').get(requestId);
      return this._hydrate(row);
    } catch (err) {
      this._logDebug('getByRequestId failed', err);
      return null;
    }
  }

  _hydrate(row) {
    if (!row) return null;
    return {
      responseId: row.response_id,
      requestId: row.request_id,
      taskId: row.task_id,
      respondingAgentId: row.responding_agent_id,
      requestingAgentId: row.requesting_agent_id,
      contentType: row.content_type,
      responseText: this._resolveCanonicalText(row),
      structuredData: row.structured_data ? JSON.parse(row.structured_data) : null,
      codeBlocks: row.code_blocks ? JSON.parse(row.code_blocks) : [],
      contentHash: row.content_hash,
      payloadSize: row.payload_size,
      resultVersion: row.result_version,
      responseMode: row.response_mode,
      quarantined: Boolean(row.quarantined),
      quarantineReason: row.quarantine_reason || null,
      correlationTier: row.correlation_tier || 'direct_session',
      attemptEpoch: row.attempt_epoch || 1,
      originRoute: row.origin_route || 'bridge',
      payloadArtifactId: row.payload_artifact_id || null,
      payloadManifest: row.payload_manifest ? JSON.parse(row.payload_manifest) : null,
      tokenUsage: row.token_usage ? JSON.parse(row.token_usage) : null,
      executionMetadata: row.execution_metadata ? JSON.parse(row.execution_metadata) : {},
      createdAt: row.created_at
    };
  }
}

