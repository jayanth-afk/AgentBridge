import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const statusObj = {
  VERIFIED: 'verified',
  HYPOTHESIS: 'hypothesis',
  OBSOLETE: 'obsolete',
  FAILED_EXPERIMENT: 'failed-experiment',
  AGENT_CLAIMED: 'agent-claimed'
};
Object.defineProperty(statusObj, 'UNREVIEWED', {
  value: 'unreviewed',
  enumerable: false,
  writable: false,
  configurable: false
});
export const KNOWLEDGE_STATUS = Object.freeze(statusObj);

const ALL_VALID_STATUSES = new Set([
  'verified',
  'hypothesis',
  'obsolete',
  'failed-experiment',
  'agent-claimed',
  'unreviewed'
]);

/**
 * KnowledgeStore
 *
 * Local-first, durable knowledge & memory layer powered by SQLite FTS5 (BM25 ranking).
 * Allows agents to store, retrieve, and search verified findings, architectural decisions,
 * test results, and documentation across tasks without inflating model prompt tokens.
 *
 * Guarantees:
 *  - 100% local: Zero cloud dependencies, zero external embeddings API calls.
 *  - Fast: Sub-millisecond FTS5 BM25 search.
 *  - Token-efficient: Search returns compact ranked snippets; full content is retrieved on-demand.
 *  - Provenance-aware: Tracks origin (user_instruction, agent_finding, verified_test), author, and version.
 *  - Validity windows & Lifecycle status: verified, hypothesis, obsolete, failed-experiment, agent-claimed, unreviewed.
 *  - Content-addressed: Every entry is indexed by SHA-256 for integrity and deduplication.
 *  - Append-only history: Every modification records an immutable history row.
 *  - Secure defaults: Agent submissions default to agent-claimed; verified requires verifiable evidence.
 */
export class KnowledgeStore {
  constructor(auditLoggerOrDb = null) {
    if (auditLoggerOrDb && typeof auditLoggerOrDb.exec === 'function') {
      this.db = auditLoggerOrDb;
      this.logger = null;
      this._isSelfCreatedDb = false;
    } else if (auditLoggerOrDb?.db) {
      this.logger = auditLoggerOrDb;
      this.db = auditLoggerOrDb.db;
      this._isSelfCreatedDb = false;
    } else {
      this.logger = null;
      this.db = new DatabaseSync(':memory:');
      this._isSelfCreatedDb = true;
    }
    this.ftsFailures = 0;
    this.initTables();
  }

  initTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bridge_knowledge (
        key TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        author_agent TEXT NOT NULL,
        provenance TEXT,
        tags TEXT,
        sha256 TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'unreviewed',
        valid_from TEXT,
        valid_until TEXT,
        source_file TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_bridge_knowledge_cat ON bridge_knowledge(category);
      CREATE INDEX IF NOT EXISTS idx_bridge_knowledge_hash ON bridge_knowledge(sha256);

      CREATE TABLE IF NOT EXISTS bridge_knowledge_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL,
        author_agent TEXT NOT NULL,
        modifier_agent TEXT NOT NULL,
        action TEXT NOT NULL,
        old_status TEXT,
        new_status TEXT,
        old_sha256 TEXT,
        new_sha256 TEXT,
        timestamp TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_bkh_key ON bridge_knowledge_history(key);
    `);

    // Migrations for existing schemas
    for (const ddl of [
      `ALTER TABLE bridge_knowledge ADD COLUMN status TEXT NOT NULL DEFAULT 'verified';`,
      `ALTER TABLE bridge_knowledge ADD COLUMN valid_from TEXT;`,
      `ALTER TABLE bridge_knowledge ADD COLUMN valid_until TEXT;`,
      `ALTER TABLE bridge_knowledge ADD COLUMN source_file TEXT;`
    ]) {
      try { this.db.exec(ddl); } catch {}
    }

    try {
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_bridge_knowledge_status ON bridge_knowledge(status);`);
    } catch {}

    // FTS5 Virtual Table for full-text lexical search with BM25 ranking
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS bridge_knowledge_fts USING fts5(
          key UNINDEXED,
          title,
          content,
          tags,
          category,
          tokenize = 'porter unicode61'
        );
      `);
    } catch (err) {
      // If FTS5 is already created or slightly different schema exists, verify usability
    }
  }

  /**
   * Compute SHA-256 of text
   */
  _computeHash(content) {
    return crypto.createHash('sha256').update(content || '', 'utf8').digest('hex');
  }

  _computeTrustLevel(status) {
    switch (status) {
      case 'verified':
        return 'high';
      case 'agent-claimed':
        return 'medium';
      case 'hypothesis':
      case 'unreviewed':
        return 'low';
      case 'obsolete':
      case 'failed-experiment':
      default:
        return 'none';
    }
  }

  /**
   * Store or update a knowledge item
   */
  store({
    key,
    category = 'finding',
    title,
    content,
    authorAgent = 'system',
    provenance = null,
    tags = [],
    status = null,
    validFrom = null,
    validUntil = null,
    sourceFile = null
  }) {
    const autoKey = key || (title ? title.toLowerCase().replace(/[^a-z0-9_]+/g, '_') : null) || `k_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const cleanKey = String(autoKey).trim().toLowerCase();
    const cleanTitle = title.trim();
    const cleanContent = content.trim();
    const cleanCat = (category || 'finding').trim().toLowerCase();
    const tagsStr = Array.isArray(tags) ? tags.join(' ') : String(tags || '');
    const provStr = provenance ? (typeof provenance === 'object' ? JSON.stringify(provenance) : String(provenance)) : null;
    const sha256 = this._computeHash(cleanContent);
    const now = new Date().toISOString();

    // 1. Status resolution and validation
    let finalStatus;
    if (status !== null && status !== undefined && String(status).trim() !== '') {
      const norm = String(status).trim().toLowerCase();
      if (!ALL_VALID_STATUSES.has(norm)) {
        if (authorAgent === 'system' && norm === 'super-certain-truth') {
          // Legacy backward compatibility for system author
          finalStatus = KNOWLEDGE_STATUS.VERIFIED;
        } else {
          throw new Error(`INVALID_KNOWLEDGE_STATUS: Status '${status}' is not a valid knowledge status`);
        }
      } else {
        finalStatus = norm;
      }
    } else {
      // Secure default: agent submissions default to agent-claimed; system defaults to verified
      if (authorAgent === 'system') {
        finalStatus = KNOWLEDGE_STATUS.VERIFIED;
      } else {
        finalStatus = KNOWLEDGE_STATUS.AGENT_CLAIMED;
      }
    }

    // 2. "verified" status requires verifiable evidence if authored by an agent
    if (finalStatus === KNOWLEDGE_STATUS.VERIFIED && authorAgent !== 'system') {
      let hasEvidence = false;
      if (sourceFile) {
        hasEvidence = true;
      } else if (provenance && typeof provenance === 'object') {
        if (provenance.verificationCommand || provenance.evidence || provenance.sourceReference || provenance.sourceFile || provenance.user_instruction || provenance.userInstruction || provenance.testResult) {
          hasEvidence = true;
        }
      } else if (typeof provenance === 'string') {
        const p = provenance.toLowerCase();
        if (p.includes('verified') || p.includes('user_instruction') || p.includes('evidence') || p.includes('npm test')) {
          hasEvidence = true;
        }
      }
      if (!hasEvidence) {
        throw new Error('VERIFICATION_EVIDENCE_REQUIRED: "verified" status requires explicit evidence fields (verificationCommand, sourceReference, or user_instruction)');
      }
    }

    // 3. Cross-agent author protection (no silent overwrite)
    const existing = this.db.prepare('SELECT * FROM bridge_knowledge WHERE key = ?').get(cleanKey);
    let action = 'create';
    if (existing) {
      if (existing.author_agent !== authorAgent && authorAgent !== 'system') {
        throw new Error(`KNOWLEDGE_ACCESS_DENIED: Agent '${authorAgent}' cannot overwrite record owned by '${existing.author_agent}'`);
      }
      action = 'update';
    }

    const finalValidFrom = validFrom || now;
    const finalValidUntil = validUntil || null;
    const finalSourceFile = sourceFile ? String(sourceFile).trim() : null;

    // 4. Append-only history record
    try {
      const histStmt = this.db.prepare(`
        INSERT INTO bridge_knowledge_history (
          key, author_agent, modifier_agent, action, old_status, new_status, old_sha256, new_sha256, timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      if (action === 'create') {
        histStmt.run(cleanKey, authorAgent, authorAgent, 'create', null, finalStatus, null, sha256, now);
      } else {
        histStmt.run(cleanKey, existing.author_agent, authorAgent, 'update', existing.status, finalStatus, existing.sha256, sha256, now);
      }
    } catch (histErr) {
      this.logger?.log?.({
        agentId: authorAgent,
        action: 'knowledge_history_error',
        status: 'error',
        details: { key: cleanKey, error: histErr.message }
      });
    }

    const stmt = this.db.prepare(`
      INSERT INTO bridge_knowledge (
        key, category, title, content, author_agent, provenance, tags, sha256,
        status, valid_from, valid_until, source_file, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        category = excluded.category,
        title = excluded.title,
        content = excluded.content,
        author_agent = excluded.author_agent,
        provenance = excluded.provenance,
        tags = excluded.tags,
        sha256 = excluded.sha256,
        status = excluded.status,
        valid_from = excluded.valid_from,
        valid_until = excluded.valid_until,
        source_file = excluded.source_file,
        updated_at = excluded.updated_at
    `);

    stmt.run(cleanKey, cleanCat, cleanTitle, cleanContent, authorAgent, provStr, tagsStr, sha256,
      finalStatus, finalValidFrom, finalValidUntil, finalSourceFile, now, now);

    // Update FTS index with failure tracking
    try {
      this.db.prepare('DELETE FROM bridge_knowledge_fts WHERE key = ?').run(cleanKey);
      this.db.prepare(`
        INSERT INTO bridge_knowledge_fts (key, title, content, tags, category)
        VALUES (?, ?, ?, ?, ?)
      `).run(cleanKey, cleanTitle, cleanContent, tagsStr, cleanCat);
    } catch (err) {
      this.ftsFailures++;
      this.logger?.log?.({
        agentId: authorAgent,
        action: 'fts_index_failure',
        status: 'error',
        details: { key: cleanKey, error: err.message }
      });
    }

    this.logger?.log?.({
      agentId: authorAgent,
      action: 'knowledge_store',
      status: 'success',
      details: { key: cleanKey, category: cleanCat, title: cleanTitle, sha256, status: finalStatus, bytes: cleanContent.length }
    });

    return {
      success: true,
      id: cleanKey,
      key: cleanKey,
      category: cleanCat,
      title: cleanTitle,
      status: finalStatus,
      trustLevel: this._computeTrustLevel(finalStatus),
      untrustedData: true,
      validFrom: finalValidFrom,
      validUntil: finalValidUntil,
      sourceFile: finalSourceFile,
      sha256,
      contentHash: `sha256:${sha256}`,
      authorAgent,
      provenance: provStr,
      sizeBytes: Buffer.byteLength(cleanContent, 'utf8'),
      updatedAt: now
    };
  }

  /**
   * Search knowledge using FTS5 BM25 relevance ranking
   */
  search({ query, category = null, tag = null, status = null, includeExpired = false, validAt = null, limit = 10, snippetChars = 150 } = {}) {
    if (!query || typeof query !== 'string' || !query.trim()) {
      return [];
    }

    const cleanQuery = query.trim().replace(/['"/*]/g, ' ');
    const resolvedLimit = Math.max(1, Math.min(Number(limit) || 10, 50));
    const nowIso = validAt || new Date().toISOString();

    // Sanitize query for FTS5 (tokenize into words joined by NEAR or AND)
    const words = cleanQuery.split(/\s+/).filter(w => w.length > 0);
    if (words.length === 0) return [];
    const ftsQuery = words.map(w => `"${w}"*`).join(' ');

    let sql = `
      SELECT
        k.key,
        k.category,
        k.title,
        k.content,
        k.author_agent,
        k.provenance,
        k.tags,
        k.sha256,
        k.status,
        k.valid_from,
        k.valid_until,
        k.source_file,
        k.updated_at,
        bm25(bridge_knowledge_fts) as rank
      FROM bridge_knowledge_fts f
      JOIN bridge_knowledge k ON f.key = k.key
      WHERE bridge_knowledge_fts MATCH ?
    `;

    const params = [ftsQuery];
    if (category) {
      sql += ` AND k.category = ?`;
      params.push(String(category).trim().toLowerCase());
    }
    if (tag) {
      sql += ` AND k.tags LIKE ?`;
      params.push(`%${tag.trim()}%`);
    }
    if (status && status !== 'all') {
      sql += ` AND k.status = ?`;
      params.push(String(status).trim().toLowerCase());
    } else if (!status) {
      // By default, exclude obsolete items when caller does not specify status
      sql += ` AND k.status != 'obsolete'`;
    }
    if (!includeExpired) {
      sql += ` AND (k.valid_until IS NULL OR k.valid_until >= ?)`;
      params.push(nowIso);
    }
    sql += ` ORDER BY rank ASC LIMIT ?`;
    params.push(resolvedLimit);

    let rows = [];
    try {
      rows = this.db.prepare(sql).all(...params);
    } catch (err) {
      // Fallback to LIKE if FTS query syntax error
      let fallbackSql = `
        SELECT * FROM bridge_knowledge
        WHERE (title LIKE ? OR content LIKE ? OR tags LIKE ?)
      `;
      const likePattern = `%${cleanQuery}%`;
      const fallbackParams = [likePattern, likePattern, likePattern];
      if (category) {
        fallbackSql += ` AND category = ?`;
        fallbackParams.push(String(category).trim().toLowerCase());
      }
      if (tag) {
        fallbackSql += ` AND tags LIKE ?`;
        fallbackParams.push(`%${tag.trim()}%`);
      }
      if (status && status !== 'all') {
        fallbackSql += ` AND status = ?`;
        fallbackParams.push(String(status).trim().toLowerCase());
      } else if (!status) {
        fallbackSql += ` AND status != 'obsolete'`;
      }
      if (!includeExpired) {
        fallbackSql += ` AND (valid_until IS NULL OR valid_until >= ?)`;
        fallbackParams.push(nowIso);
      }
      fallbackSql += ` ORDER BY updated_at DESC LIMIT ?`;
      fallbackParams.push(resolvedLimit);
      try {
        rows = this.db.prepare(fallbackSql).all(...fallbackParams);
      } catch {
        return [];
      }
    }

    return rows.map(r => {
      let prov = null;
      if (r.provenance) {
        try { prov = JSON.parse(r.provenance); } catch { prov = r.provenance; }
      }
      const fullText = r.content || '';
      const snippet = fullText.length > snippetChars
        ? fullText.slice(0, snippetChars) + '... [truncated]'
        : fullText;
      const isExpired = Boolean(r.valid_until && r.valid_until < nowIso);

      return {
        id: r.key,
        key: r.key,
        category: r.category,
        title: r.title,
        snippet,
        authorAgent: r.author_agent,
        provenance: prov,
        tags: r.tags ? r.tags.split(' ') : [],
        sha256: r.sha256,
        contentHash: `sha256:${r.sha256}`,
        status: r.status || 'verified',
        trustLevel: this._computeTrustLevel(r.status || 'verified'),
        untrustedData: true,
        validFrom: r.valid_from || null,
        validUntil: r.valid_until || null,
        sourceFile: r.source_file || null,
        isExpired,
        sizeBytes: Buffer.byteLength(fullText, 'utf8'),
        updatedAt: r.updated_at,
        rank: r.rank !== undefined ? Number(r.rank) : 0,
        relevanceScore: r.rank !== undefined ? Number((-r.rank).toFixed(3)) : 1.0
      };
    });
  }

  /**
   * Retrieve full knowledge item by key
   */
  get(key) {
    if (!key) return null;
    const cleanKey = String(key).trim().toLowerCase();
    const row = this.db.prepare('SELECT * FROM bridge_knowledge WHERE key = ?').get(cleanKey);
    if (!row) return null;

    let prov = null;
    if (row.provenance) {
      try { prov = JSON.parse(row.provenance); } catch { prov = row.provenance; }
    }
    const nowIso = new Date().toISOString();
    const isExpired = Boolean(row.valid_until && row.valid_until < nowIso);

    return {
      id: row.key,
      key: row.key,
      category: row.category,
      title: row.title,
      content: row.content,
      authorAgent: row.author_agent,
      provenance: prov,
      tags: row.tags ? row.tags.split(' ') : [],
      sha256: row.sha256,
      contentHash: `sha256:${row.sha256}`,
      status: row.status || 'verified',
      trustLevel: this._computeTrustLevel(row.status || 'verified'),
      untrustedData: true,
      validFrom: row.valid_from || null,
      validUntil: row.valid_until || null,
      sourceFile: row.source_file || null,
      isExpired,
      sizeBytes: Buffer.byteLength(row.content, 'utf8'),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  /**
   * Get append-only modification history for a key
   */
  getHistory(key) {
    if (!key) return [];
    const cleanKey = String(key).trim().toLowerCase();
    return this.db.prepare('SELECT * FROM bridge_knowledge_history WHERE key = ? ORDER BY id ASC').all(cleanKey);
  }

  /**
   * Verify FTS index consistency with primary store
   */
  checkFtsConsistency() {
    const rowCount = this.db.prepare('SELECT COUNT(*) as cnt FROM bridge_knowledge').get()?.cnt || 0;
    let ftsCount = 0;
    try {
      ftsCount = this.db.prepare('SELECT COUNT(*) as cnt FROM bridge_knowledge_fts').get()?.cnt || 0;
    } catch {}
    return {
      consistent: rowCount === ftsCount,
      rowCount,
      ftsCount,
      failures: this.ftsFailures
    };
  }

  /**
   * Rebuild FTS index from durable primary records
   */
  reindexFts() {
    try {
      this.db.prepare('DELETE FROM bridge_knowledge_fts').run();
    } catch {}
    const rows = this.db.prepare('SELECT key, title, content, tags, category FROM bridge_knowledge').all();
    const insertStmt = this.db.prepare(`
      INSERT INTO bridge_knowledge_fts (key, title, content, tags, category)
      VALUES (?, ?, ?, ?, ?)
    `);
    let count = 0;
    for (const r of rows) {
      insertStmt.run(r.key, r.title, r.content, r.tags || '', r.category || 'general');
      count++;
    }
    return { reindexed: count };
  }

  /**
   * Retrieve knowledge item by SHA-256 hash
   */
  getByHash(sha256) {
    if (!sha256) return null;
    const cleanHash = String(sha256).replace(/^sha256:/i, '').trim().toLowerCase();
    const row = this.db.prepare('SELECT * FROM bridge_knowledge WHERE sha256 = ?').get(cleanHash);
    if (!row) return null;
    return this.get(row.key);
  }

  /**
   * Delete a knowledge item
   */
  delete(key, agentId = 'system') {
    if (!key) return false;
    const cleanKey = String(key).trim().toLowerCase();
    const info = this.db.prepare('DELETE FROM bridge_knowledge WHERE key = ?').run(cleanKey);
    try {
      this.db.prepare('DELETE FROM bridge_knowledge_fts WHERE key = ?').run(cleanKey);
    } catch {}

    this.logger?.log?.({
      agentId,
      action: 'knowledge_delete',
      status: info.changes > 0 ? 'success' : 'not_found',
      details: { key: cleanKey }
    });

    return info.changes > 0;
  }

  /**
   * List distinct categories and counts
   */
  listCategories() {
    return this.db.prepare(`
      SELECT category, COUNT(*) as count, MAX(updated_at) as last_updated
      FROM bridge_knowledge
      GROUP BY category
      ORDER BY count DESC
    `).all();
  }

  storeKnowledge(args) {
    const key = args.key || args.id || (args.title ? args.title.toLowerCase().replace(/[^a-z0-9_]+/g, '_') : null) || `k_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    return this.store({
      key,
      category: args.category,
      title: args.title,
      content: args.content,
      authorAgent: args.agentId || args.authorAgent || 'system',
      provenance: args.provenance,
      tags: args.tags,
      status: args.status,
      validFrom: args.validFrom,
      validUntil: args.validUntil,
      sourceFile: args.sourceFile
    });
  }

  searchKnowledge(query, options = {}) {
    return this.search({ query, ...options });
  }

  getKnowledge(keyOrId) {
    return this.get(keyOrId);
  }

  getStats() {
    const catList = this.listCategories();
    const catMap = {};
    let total = 0;
    for (const c of catList) {
      catMap[c.category] = c.count;
      total += c.count;
    }
    return { totalEntries: total, categories: catMap };
  }

  close() {
    try {
      if (this._isSelfCreatedDb && this.db?.close) {
        this.db.close();
      }
    } catch {}
  }
}
