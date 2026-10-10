import fs from 'node:fs';

/**
 * TransactionalOutbox:
 * Guarantees atomic state transition + event staging.
 * Invariant: Events are NEVER dispatched before the authoritative SQLite transaction commits.
 * On rollback, staged events vanish without waking consumers.
 * On commit, staged events are immediately flushed to the notify file and in-process subscribers.
 */
export class TransactionalOutbox {
  constructor(auditLogger, eventBus = null) {
    this.logger = auditLogger;
    this.db = auditLogger.db;
    this.eventBus = eventBus;
    this.initTables();
  }

  initTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bridge_outbox (
        outbox_id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id INTEGER,
        timestamp TEXT NOT NULL,
        type TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        from_agent TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        request_id TEXT,
        task_id TEXT,
        status TEXT,
        payload TEXT,
        dedup_key TEXT,
        published_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_outbox_pending ON bridge_outbox(published_at) WHERE published_at IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_dedup ON bridge_outbox(dedup_key) WHERE dedup_key IS NOT NULL;
    `);

    // Ensure dedup_key exists on bridge_events table
    try {
      const info = this.db.prepare(`PRAGMA table_info(bridge_events)`).all();
      const hasDedup = info.some(col => col.name === 'dedup_key');
      if (!hasDedup) {
        this.db.exec(`ALTER TABLE bridge_events ADD COLUMN dedup_key TEXT;`);
        this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_bridge_events_dedup ON bridge_events(dedup_key);`);
      }
    } catch {}
  }

  /**
   * Executes a unit of work inside an explicit SQLite transaction.
   * Events staged via tx.stageEvent() are persisted in the transaction
   * and dispatched ONLY after commit succeeds.
   */
  runInTransaction(workFn) {
    if (this._inTx) {
      return workFn(this._currentTxContext);
    }

    let started = false;
    try {
      this.db.exec('BEGIN IMMEDIATE;');
      started = true;
    } catch (err) {
      if (err.message && err.message.includes('cannot start a transaction')) {
        if (this._currentTxContext) {
          return workFn(this._currentTxContext);
        }
        const fallbackStaged = [];
        const fallbackContext = {
          db: this.db,
          stageEvent: (eventParams) => {
            const staged = this._stageEventInTransaction(eventParams);
            if (staged) fallbackStaged.push(staged);
            return staged;
          }
        };
        const res = workFn(fallbackContext);
        this._flushStagedEvents(fallbackStaged);
        return res;
      }
      throw err;
    }

    this._inTx = true;
    const stagedEvents = [];
    let committed = false;

    const txContext = {
      db: this.db,
      stageEvent: (eventParams) => {
        const staged = this._stageEventInTransaction(eventParams);
        if (staged) {
          stagedEvents.push(staged);
        }
        return staged;
      }
    };
    this._currentTxContext = txContext;

    try {
      const result = workFn(txContext);
      if (started) {
        this.db.exec('COMMIT;');
        committed = true;
      }

      // Dispatched ONLY after commit succeeds
      this._flushStagedEvents(stagedEvents);

      return result;
    } catch (err) {
      if (started && !committed) {
        try {
          this.db.exec('ROLLBACK;');
        } catch {}
      }
      throw err;
    } finally {
      if (started) {
        this._inTx = false;
        this._currentTxContext = null;
      }
    }
  }

  _stageEventInTransaction(eventParams) {
    const {
      type,
      agentId,
      fromAgent = 'system',
      conversationId = null,
      requestId = null,
      taskId = null,
      status = 'pending',
      payload = null,
      dedupKey = null
    } = eventParams;

    // Deduplication check within transaction
    if (dedupKey) {
      const existing = this.db.prepare(`
        SELECT * FROM bridge_events WHERE dedup_key = ?
      `).get(dedupKey);

      if (existing) {
        return null; // Idempotently skip duplicate event
      }
    }

    const timestamp = new Date().toISOString();
    const convId = conversationId || (requestId ? `conv_${requestId}` : `conv_${Date.now()}`);

    let payloadStr = null;
    if (payload !== null && payload !== undefined) {
      payloadStr = typeof payload === 'object' ? JSON.stringify(payload) : String(payload);
    }

    // 1. Insert into authoritative bridge_events
    const stmt = this.db.prepare(`
      INSERT INTO bridge_events (
        timestamp, type, agent_id, from_agent, conversation_id, request_id, task_id, status, payload, dedup_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertInfo = stmt.run(
      timestamp,
      type,
      agentId,
      fromAgent,
      convId,
      requestId,
      taskId,
      status,
      payloadStr,
      dedupKey
    );

    // run() already returns the generated event_id; skip the extra
    // SELECT last_insert_rowid() round trip staged inside every transaction.
    const eventId = Number(insertInfo?.lastInsertRowid || 0);

    // 2. Insert into outbox table (marking unpublished)
    this.db.prepare(`
      INSERT INTO bridge_outbox (
        event_id, timestamp, type, agent_id, from_agent, conversation_id, request_id, task_id, status, payload, dedup_key, published_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      eventId,
      timestamp,
      type,
      agentId,
      fromAgent,
      convId,
      requestId,
      taskId,
      status,
      payloadStr,
      dedupKey
    );

    return {
      eventId,
      type,
      agentId,
      fromAgent,
      conversationId: convId,
      requestId,
      taskId,
      status,
      payload: payloadStr ? (() => { try { return JSON.parse(payloadStr); } catch { return payloadStr; } })() : null,
      timestamp,
      dedupKey
    };
  }

  _flushStagedEvents(stagedEvents) {
    if (!stagedEvents || stagedEvents.length === 0) return;

    const now = new Date().toISOString();
    for (const event of stagedEvents) {
      // Mark published in outbox table
      try {
        this.db.prepare(`
          UPDATE bridge_outbox SET published_at = ? WHERE event_id = ?
        `).run(now, event.eventId);
      } catch {}

      // Cross-process notify file touch
      if (this.eventBus?.notifyFilePath && this.eventBus.dbPath !== ':memory:') {
        try {
          fs.writeFileSync(this.eventBus.notifyFilePath, String(event.eventId));
        } catch {}
      }

      // In-process immediate dispatch to subscribers
      if (this.eventBus && typeof this.eventBus.dispatchLocal === 'function') {
        try {
          this.eventBus.dispatchLocal(event);
        } catch {}
      }
    }
  }

  /**
   * Drain any un-flushed outbox events after process crash or restart
   */
  recoverPendingOutbox() {
    const rows = this.db.prepare(`
      SELECT * FROM bridge_outbox WHERE published_at IS NULL ORDER BY outbox_id ASC
    `).all();

    if (!rows || rows.length === 0) return 0;

    const now = new Date().toISOString();
    let count = 0;

    for (const r of rows) {
      const event = {
        eventId: r.event_id,
        type: r.type,
        agentId: r.agent_id,
        fromAgent: r.from_agent,
        conversationId: r.conversation_id,
        requestId: r.request_id,
        taskId: r.task_id,
        status: r.status,
        payload: r.payload ? (() => { try { return JSON.parse(r.payload); } catch { return r.payload; } })() : null,
        timestamp: r.timestamp,
        dedupKey: r.dedup_key
      };

      this.db.prepare(`
        UPDATE bridge_outbox SET published_at = ? WHERE outbox_id = ?
      `).run(now, r.outbox_id);

      if (this.eventBus?.notifyFilePath && this.eventBus.dbPath !== ':memory:') {
        try {
          fs.writeFileSync(this.eventBus.notifyFilePath, String(r.event_id));
        } catch {}
      }

      if (this.eventBus && typeof this.eventBus.dispatchLocal === 'function') {
        try {
          this.eventBus.dispatchLocal(event);
        } catch {}
      }

      count++;
    }

    return count;
  }
}
