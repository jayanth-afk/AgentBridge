import crypto from 'node:crypto';

/**
 * ContextCache (Content-Addressed Storage for Context Blocks & Prompt Deltas)
 *
 * Prevents redundant token consumption by indexing immutable prompt segments,
 * documentation blocks, and task instructions by their SHA-256 content hash.
 *
 * Guarantees:
 *  - Deduplication: Identical context blocks yield the same hash reference.
 *  - Token Savings: Agents pass lightweight `contextRef: 'sha256:...'` instead
 *    of re-transmitting large blocks across multi-hop collaboration turns.
 *  - Delta Computation: Computes lightweight line diffs between context versions.
 *  - Fast Resolution: Sub-millisecond local lookup from in-memory cache + SQLite.
 */
export class ContextCache {
  constructor(auditLogger = null) {
    this.logger = auditLogger;
    this.db = auditLogger?.db || null;
    this.memoryCache = new Map(); // hash -> { text, metadata, timestamp }
    this.maxMemoryItems = 500;

    if (this.db) {
      this.initTables();
    }
  }

  initTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bridge_context_cache (
        sha256 TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        metadata TEXT,
        created_at TEXT NOT NULL
      );
    `);
  }

  /**
   * Compute SHA-256 hash
   */
  _hash(text) {
    return crypto.createHash('sha256').update(text || '', 'utf8').digest('hex');
  }

  /**
   * Store context block and return content-addressed reference
   */
  store(text, metadata = {}) {
    if (typeof text !== 'string') {
      text = JSON.stringify(text ?? '');
    }
    const hash = this._hash(text);
    const contextRef = `sha256:${hash}`;
    const sizeBytes = Buffer.byteLength(text, 'utf8');
    const now = new Date().toISOString();

    // Check memory cache
    if (this.memoryCache.has(hash)) {
      return {
        contextRef,
        hash,
        sizeBytes,
        isNew: false
      };
    }

    // Save to memory cache
    this.memoryCache.set(hash, { text, metadata, timestamp: Date.now() });
    if (this.memoryCache.size > this.maxMemoryItems) {
      const oldest = this.memoryCache.keys().next().value;
      this.memoryCache.delete(oldest);
    }

    // Persist to DB
    let isNew = true;
    if (this.db) {
      try {
        const existing = this.db.prepare('SELECT 1 FROM bridge_context_cache WHERE sha256 = ?').get(hash);
        if (existing) {
          isNew = false;
        } else {
          this.db.prepare(`
            INSERT INTO bridge_context_cache (sha256, content, size_bytes, metadata, created_at)
            VALUES (?, ?, ?, ?, ?)
          `).run(hash, text, sizeBytes, JSON.stringify(metadata), now);
        }
      } catch {}
    }

    return {
      contextRef,
      hash,
      sizeBytes,
      isNew
    };
  }

  /**
   * Resolve context text from content-addressed reference or hash
   */
  resolve(contextRefOrHash) {
    if (!contextRefOrHash) return null;
    const hash = String(contextRefOrHash).replace(/^sha256:/i, '').trim().toLowerCase();

    // 1. Check memory cache
    const inMem = this.memoryCache.get(hash);
    if (inMem) return inMem.text;

    // 2. Check SQLite
    if (this.db) {
      try {
        const row = this.db.prepare('SELECT content, metadata FROM bridge_context_cache WHERE sha256 = ?').get(hash);
        if (row) {
          this.memoryCache.set(hash, {
            text: row.content,
            metadata: row.metadata ? JSON.parse(row.metadata) : {},
            timestamp: Date.now()
          });
          return row.content;
        }
      } catch {}
    }

    return null;
  }

  /**
   * Compact a prompt payload: If large, stores full text and returns snippet + contextRef
   */
  compactPayload(text, thresholdChars = 600, snippetChars = 200) {
    if (!text || typeof text !== 'string' || text.length <= thresholdChars) {
      return {
        compact: false,
        text,
        contextRef: null
      };
    }

    const { contextRef, sizeBytes } = this.store(text);
    const snippet = text.slice(0, snippetChars) + `... [${sizeBytes} bytes total; reference: ${contextRef}]`;

    return {
      compact: true,
      snippet,
      contextRef,
      originalBytes: sizeBytes,
      savingsBytes: sizeBytes - Buffer.byteLength(snippet, 'utf8')
    };
  }

  /**
   * Compute simple line-based delta between base context and new context
   */
  computeDelta(baseHashOrRef, newText) {
    let baseText = this.resolve(baseHashOrRef);
    if (baseText === null && typeof baseHashOrRef === 'string') {
      baseText = baseHashOrRef;
    }
    if (baseText === null) {
      return { hasBase: false, fullText: newText, delta: null, identical: false, diffLines: [] };
    }

    const baseLines = baseText.split('\n');
    const newLines = newText.split('\n');

    const added = [];
    const removed = [];

    const baseSet = new Set(baseLines);
    const newSet = new Set(newLines);

    for (let i = 0; i < newLines.length; i++) {
      if (!baseSet.has(newLines[i])) {
        added.push({ line: i + 1, content: newLines[i] });
      }
    }

    for (let i = 0; i < baseLines.length; i++) {
      if (!newSet.has(baseLines[i])) {
        removed.push({ line: i + 1, content: baseLines[i] });
      }
    }

    const newStore = this.store(newText);

    return {
      hasBase: true,
      baseRef: baseHashOrRef,
      newRef: newStore.contextRef,
      linesAdded: added.length,
      linesRemoved: removed.length,
      isIdentical: added.length === 0 && removed.length === 0,
      diffLines: added.map(a => `+ ${a.content}`).concat(removed.map(r => `- ${r.content}`)),
      identical: added.length === 0 && removed.length === 0,
      delta: { added: added.slice(0, 50), removed: removed.slice(0, 50) }
    };
  }

  storeContextBlock(sessionId, text, metadata = {}) {
    const res = this.store(text, { sessionId, ...metadata });
    return {
      hash: res.contextRef,
      contextRef: res.contextRef,
      rawHash: res.hash,
      hit: !res.isNew,
      isNew: res.isNew,
      sizeBytes: res.sizeBytes
    };
  }

  retrieveContextBlock(refOrHash) {
    const content = this.resolve(refOrHash);
    return content !== null ? { content, ref: refOrHash } : null;
  }

  createSnapshot(collabId, items = []) {
    const serialized = JSON.stringify(items);
    const stored = this.store(serialized, { collabId, type: 'snapshot' });
    return {
      snapshotId: `snap_${stored.hash.slice(0, 12)}`,
      contextRef: stored.contextRef,
      itemCount: items.length,
      sizeBytes: stored.sizeBytes
    };
  }
}
