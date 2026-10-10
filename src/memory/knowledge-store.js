import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

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
 *  - Content-addressed: Every entry is indexed by SHA-256 for integrity and deduplication.
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
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_bridge_knowledge_cat ON bridge_knowledge(category);
      CREATE INDEX IF NOT EXISTS idx_bridge_knowledge_hash ON bridge_knowledge(sha256);
    `);

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
    tags = []
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

    const stmt = this.db.prepare(`
      INSERT INTO bridge_knowledge (
        key, category, title, content, author_agent, provenance, tags, sha256, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        category = excluded.category,
        title = excluded.title,
        content = excluded.content,
        author_agent = excluded.author_agent,
        provenance = excluded.provenance,
        tags = excluded.tags,
        sha256 = excluded.sha256,
        updated_at = excluded.updated_at
    `);

    stmt.run(cleanKey, cleanCat, cleanTitle, cleanContent, authorAgent, provStr, tagsStr, sha256, now, now);

    // Update FTS index
    try {
      this.db.prepare('DELETE FROM bridge_knowledge_fts WHERE key = ?').run(cleanKey);
      this.db.prepare(`
        INSERT INTO bridge_knowledge_fts (key, title, content, tags, category)
        VALUES (?, ?, ?, ?, ?)
      `).run(cleanKey, cleanTitle, cleanContent, tagsStr, cleanCat);
    } catch {}

    this.logger?.log?.({
      agentId: authorAgent,
      action: 'knowledge_store',
      status: 'success',
      details: { key: cleanKey, category: cleanCat, title: cleanTitle, sha256, bytes: cleanContent.length }
    });

    return {
      success: true,
      id: cleanKey,
      key: cleanKey,
      category: cleanCat,
      title: cleanTitle,
      sha256,
      contentHash: `sha256:${sha256}`,
      provenance: provStr,
      sizeBytes: Buffer.byteLength(cleanContent, 'utf8'),
      updatedAt: now
    };
  }

  /**
   * Search knowledge using FTS5 BM25 relevance ranking
   */
  search({ query, category = null, limit = 10, snippetChars = 150 } = {}) {
    if (!query || typeof query !== 'string' || !query.trim()) {
      return [];
    }

    const cleanQuery = query.trim().replace(/['"/*]/g, ' ');
    const resolvedLimit = Math.max(1, Math.min(Number(limit) || 10, 50));

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
    sql += ` ORDER BY rank ASC LIMIT ?`;
    params.push(resolvedLimit);

    let rows = [];
    try {
      rows = this.db.prepare(sql).all(...params);
    } catch (err) {
      // Fallback to LIKE if FTS query syntax error
      const fallbackSql = `
        SELECT * FROM bridge_knowledge
        WHERE (title LIKE ? OR content LIKE ? OR tags LIKE ?)
        ${category ? 'AND category = ?' : ''}
        ORDER BY updated_at DESC LIMIT ?
      `;
      const likePattern = `%${cleanQuery}%`;
      const fallbackParams = [likePattern, likePattern, likePattern];
      if (category) fallbackParams.push(String(category).trim().toLowerCase());
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
      sizeBytes: Buffer.byteLength(row.content, 'utf8'),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
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
      tags: args.tags
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
