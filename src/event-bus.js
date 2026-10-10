import fs from 'node:fs';
import path from 'node:path';
import EventEmitter from 'node:events';
import { TransactionalOutbox } from './events/transactional-outbox.js';
import { LifecycleStage } from './diagnostics/request-tracer.js';

/**
 * CrossProcessEventBus
 *
 * Durable SQLite-backed cross-process event bus with monotonic ordering,
 * persistent agent cursors, file-system instant wakeup, and token-compact payloads.
 */
export class EventBus extends EventEmitter {
  constructor(auditLogger, options = {}) {
    super();
    this.logger = auditLogger;
    this.db = auditLogger.db;
    this.dbPath = auditLogger.dbPath || (options.dbPath || 'data/bridge.sqlite');
    this.notifyFilePath = `${this.dbPath}.notify`;
    this.fallbackIntervalMs = options.fallbackIntervalMs || 500;
    // Optional lifecycle tracer (assigned by MailboxHub). Never required.
    this.tracer = options.tracer || null;

    // Subscriptions: agentId -> Set of handler functions
    this.subscribers = new Map();
    // In-memory cursor cache: agentId -> lastEventId
    this.cursorCache = new Map();
    // Waiters for correlated request/response: requestId -> Set<waiter>.
    // A single request may have more than one concurrent waiter (an original
    // caller plus a re-attaching observer). Every waiter for a request must
    // resolve from the same authoritative durable row; previously a second
    // registration overwrote the first, silently orphaning it until timeout.
    this.responseWaiters = new Map();

    this.fileWatcher = null;
    this.fallbackTimer = null;
    this.isClosed = false;
    this.isChecking = false;

    this.ensureNotifyFile();
    this.initTables();
    this.outbox = new TransactionalOutbox(auditLogger, this);
    try {
      this.outbox.recoverPendingOutbox();
    } catch {}
  }

  ensureNotifyFile() {
    if (!this.notifyFilePath || this.dbPath === ':memory:') return;
    try {
      const dir = path.dirname(this.notifyFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      if (!fs.existsSync(this.notifyFilePath)) {
        fs.writeFileSync(this.notifyFilePath, '0');
      }
    } catch (err) {
      // Ignore directory/file race conditions
    }
  }

  initTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bridge_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        type TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        from_agent TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        request_id TEXT,
        task_id TEXT,
        status TEXT,
        payload TEXT
      );

      CREATE TABLE IF NOT EXISTS bridge_requests (
        request_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        from_agent TEXT NOT NULL,
        to_agent TEXT NOT NULL,
        question TEXT NOT NULL,
        context TEXT,
        task_id TEXT,
        status TEXT NOT NULL,
        response TEXT,
        error TEXT,
        timeout_ms INTEGER DEFAULT 30000,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS agent_event_cursors (
        agent_id TEXT PRIMARY KEY,
        last_event_id INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS bridge_event_acks (
        agent_id TEXT NOT NULL,
        event_id INTEGER NOT NULL,
        acked_at TEXT NOT NULL,
        PRIMARY KEY (agent_id, event_id)
      );

      CREATE INDEX IF NOT EXISTS idx_bridge_events_agent_id ON bridge_events(agent_id, event_id);
      CREATE INDEX IF NOT EXISTS idx_bridge_events_req_id ON bridge_events(request_id);
      CREATE INDEX IF NOT EXISTS idx_bridge_requests_to_status ON bridge_requests(to_agent, status);
      CREATE INDEX IF NOT EXISTS idx_event_acks_agent ON bridge_event_acks(agent_id, event_id);
    `);

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
   * Run work within an atomic SQLite transaction via outbox pattern
   */
  runInTransaction(workFn) {
    if (!this.outbox) throw new Error('TransactionalOutbox not initialized');
    return this.outbox.runInTransaction(workFn);
  }

  /**
   * Publishes a durable event into SQLite and signals all listening processes.
   */
  publish({
    type,
    agentId, // recipient agent, or '*' for broadcast
    fromAgent = 'system',
    conversationId = null,
    requestId = null,
    taskId = null,
    status = 'pending',
    payload = null,
    dedupKey = null
  }) {
    if (this.isClosed) throw new Error('EventBus is closed');

    // Deduplication invariant: duplicate events do not create side effects
    if (dedupKey) {
      try {
        const existing = this.db.prepare('SELECT * FROM bridge_events WHERE dedup_key = ?').get(dedupKey);
        if (existing) {
          return {
            eventId: existing.event_id,
            type: existing.type,
            agentId: existing.agent_id,
            fromAgent: existing.from_agent,
            conversationId: existing.conversation_id,
            requestId: existing.request_id,
            taskId: existing.task_id,
            status: existing.status,
            payload: existing.payload ? (() => { try { return JSON.parse(existing.payload); } catch { return existing.payload; } })() : null,
            timestamp: existing.timestamp,
            dedupKey: existing.dedup_key,
            isDuplicate: true
          };
        }
      } catch {}
    }

    const timestamp = new Date().toISOString();
    const convId = conversationId || (requestId ? `conv_${requestId}` : `conv_${Date.now()}`);

    // Token optimization: Compact payload string
    let payloadStr = null;
    if (payload !== null && payload !== undefined) {
      payloadStr = typeof payload === 'object' ? JSON.stringify(payload) : String(payload);
      if (payloadStr.length > 500) {
        payloadStr = payloadStr.slice(0, 500) + '... (truncated for event compactness)';
      }
    }

    const stmt = this.db.prepare(`
      INSERT INTO bridge_events (
        timestamp, type, agent_id, from_agent, conversation_id, request_id, task_id, status, payload, dedup_key
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

    // The SQLite driver already returns the generated monotonically increasing
    // event_id from run(); a second `SELECT last_insert_rowid()` round trip per
    // published event is redundant work on the hot delivery path.
    const eventId = Number(insertInfo?.lastInsertRowid || 0);

    const event = {
      eventId,
      type,
      agentId,
      fromAgent,
      conversationId: convId,
      requestId,
      taskId,
      status,
      payload: payloadStr ? (() => { try { return JSON.parse(payloadStr); } catch { return payloadStr; } })() : null,
      timestamp
    };

    // Cross-process wakeup: touch notify file
    if (this.dbPath !== ':memory:') {
      try {
        fs.writeFileSync(this.notifyFilePath, String(eventId));
      } catch {}
    }

    // In-process immediate dispatch (0ms)
    this.dispatchLocal(event);

    return event;
  }

  dispatchLocal(event) {
    // 1. Live wakeup for correlated request/response waiters.
    //    The durable bridge_requests row is authoritative; this notification only
    //    accelerates discovery of an already-committed terminal result. It never
    //    substitutes a payload snippet for the real stored response.
    if (event.requestId) {
      this._settleWaiter(event.requestId, 'event');
    }

    // 2. Dispatch to agent-specific subscribers
    if (this.subscribers.has(event.agentId)) {
      for (const handler of this.subscribers.get(event.agentId)) {
        try {
          handler(event);
        } catch (err) {
          this.emit('error', err);
        }
      }
      this.cursorCache.set(event.agentId, event.eventId);
      this.updateCursor(event.agentId, event.eventId);
    }

    // 3. Dispatch to wildcard subscribers
    if (event.agentId === '*') {
      for (const [subAgentId, handlers] of this.subscribers.entries()) {
        for (const handler of handlers) {
          try {
            handler(event);
          } catch (err) {
            this.emit('error', err);
          }
        }
        this.cursorCache.set(subAgentId, event.eventId);
        this.updateCursor(subAgentId, event.eventId);
      }
    } else if (this.subscribers.has('*')) {
      for (const handler of this.subscribers.get('*')) {
        try {
          handler(event);
        } catch (err) {
          this.emit('error', err);
        }
      }
      this.cursorCache.set('*', event.eventId);
      this.updateCursor('*', event.eventId);
    }

    // 4. Emit standard event
    this.emit('event', event);
  }

  /**
   * Subscribes an agent to receive incoming events.
   * Immediately catches up on unconsumed events from SQLite cursor.
   */
  subscribe(agentId, handler, options = {}) {
    if (this.isClosed) throw new Error('EventBus is closed');
    if (!this.subscribers.has(agentId)) {
      this.subscribers.set(agentId, new Set());
    }
    this.subscribers.get(agentId).add(handler);

    // Initialize cursor from DB or options
    const fromBeginning = Boolean(options.fromBeginning);
    let cursor = this.getCursor(agentId);
    if (cursor === 0 && !fromBeginning) {
      // Start from current latest event so we don't replay ancient history unless requested
      const latest = this.getLatestEventId();
      this.updateCursor(agentId, latest);
      cursor = latest;
    }
    this.cursorCache.set(agentId, cursor);

    // Start background watcher if not already running
    this.ensureWatcherStarted();

    // Immediately drain pending events
    process.nextTick(() => {
      this.drainEventsForAgent(agentId);
    });

    return {
      unsubscribe: () => {
        const set = this.subscribers.get(agentId);
        if (set) {
          set.delete(handler);
          if (set.size === 0) {
            this.subscribers.delete(agentId);
          }
        }
        if (this.subscribers.size === 0 && this.responseWaiters.size === 0) {
          this.stopWatcher();
        }
      }
    };
  }

  ensureWatcherStarted() {
    if (this.fileWatcher || this.isClosed || this.dbPath === ':memory:') return;

    this.ensureNotifyFile();

    try {
      this.fileWatcher = fs.watch(this.notifyFilePath, { persistent: false }, () => {
        this.checkAllNewEvents();
      });
      if (this.fileWatcher && this.fileWatcher.unref) {
        this.fileWatcher.unref();
      }
    } catch (err) {
      // Fallback timer will handle waking up if fs.watch fails
    }

    // Gentle fallback poll timer for missed OS events or busy locks
    if (!this.fallbackTimer) {
      this.fallbackTimer = setInterval(() => {
        this.checkAllNewEvents();
      }, this.fallbackIntervalMs);
      if (this.fallbackTimer.unref) {
        this.fallbackTimer.unref();
      }
    }
  }

  stopWatcher() {
    if (this.fileWatcher) {
      try { this.fileWatcher.close(); } catch {}
      this.fileWatcher = null;
    }
    if (this.fallbackTimer) {
      clearInterval(this.fallbackTimer);
      this.fallbackTimer = null;
    }
  }

  checkAllNewEvents() {
    if (this.isChecking || this.isClosed) return;
    this.isChecking = true;

    try {
      for (const agentId of this.subscribers.keys()) {
        this.drainEventsForAgent(agentId);
      }

      // Check waiters if any pending
      if (this.responseWaiters.size > 0) {
        this.checkPendingWaiters();
      }
    } finally {
      this.isChecking = false;
    }
  }

  drainEventsForAgent(agentId) {
    if (this.isClosed) return;
    const currentCursor = this.cursorCache.get(agentId) ?? this.getCursor(agentId);

    const query = `
      SELECT * FROM bridge_events
      WHERE event_id > ? AND (agent_id = ? OR agent_id = '*')
      ORDER BY event_id ASC
      LIMIT 100
    `;

    let rows = [];
    try {
      rows = this.db.prepare(query).all(currentCursor, agentId);
    } catch (err) {
      return;
    }

    if (!rows || rows.length === 0) return;

    let maxId = currentCursor;
    const handlers = this.subscribers.get(agentId);

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
        timestamp: r.timestamp
      };

      if (r.event_id > maxId) {
        maxId = r.event_id;
      }

      // Also wake any correlated waiter for this request (durable row decides).
      if (event.requestId) {
        this._settleWaiter(event.requestId, 'event');
      }

      if (handlers) {
        for (const handler of handlers) {
          try {
            handler(event);
          } catch (err) {
            this.emit('error', err);
          }
        }
      }
    }

    if (maxId > currentCursor) {
      this.cursorCache.set(agentId, maxId);
      this.updateCursor(agentId, maxId);
    }
  }

  checkPendingWaiters() {
    for (const requestId of Array.from(this.responseWaiters.keys())) {
      this._settleWaiter(requestId, 'poll');
    }
  }

  /**
   * Read the authoritative terminal state of a correlated request.
   * @returns {{requestId,conversationId,status,response,error,completedAt}|null}
   */
  _readTerminalRequest(requestId) {
    if (!requestId) return null;
    try {
      const row = this.db.prepare(`SELECT * FROM bridge_requests WHERE request_id = ?`).get(requestId);
      if (!row) return null;
      if (row.status !== 'completed' && row.status !== 'failed') return null;
      return {
        requestId: row.request_id,
        conversationId: row.conversation_id,
        status: row.status,
        response: row.response,
        error: row.error,
        completedAt: row.completed_at
      };
    } catch {
      return null;
    }
  }

  /**
   * Single, consistent waiter-resolution path used by live dispatch, DB drain,
   * pre-registration checks and fallback polling. Resolves ONLY from the durable
   * bridge_requests row, so a stale/duplicate/out-of-order notification can never
   * deliver a wrong status or a truncated snippet.
   *
   * @returns {boolean} true if a waiter was resolved by this call.
   */
  _settleWaiter(requestId, source = 'event') {
    const waiters = this.responseWaiters.get(requestId);
    if (!waiters || waiters.size === 0) return false;

    const settled = this._readTerminalRequest(requestId);
    if (!settled) return false; // Not terminal yet: keep waiting for the real result.

    // Remove the whole set first so a re-entrant notification cannot double-resolve.
    this.responseWaiters.delete(requestId);

    const now = Date.now();
    for (const waiter of waiters) {
      if (waiter.timer) clearTimeout(waiter.timer);

      if (this.tracer) {
        this.tracer.mark({
          requestId,
          stage: LifecycleStage.WAITER_RESOLVED,
          taskId: waiter.taskId || null,
          attemptId: waiter.attemptId || null,
          agentId: waiter.agentId || null,
          routeId: waiter.routeId || null,
          meta: { source, status: settled.status }
        });
      }

      waiter.resolve({ ...settled, source, waiterLatencyMs: now - (waiter.registeredAt || now) });
    }
    return true;
  }

  /**
   * Correlated Request/Response Waiter:
   * Keeps caller attached to correlated response channel without manual polling.
   */
  async waitForResponse({ requestId, agentId = null, taskId = null, attemptId = null, routeId = null, timeoutMs = 30000 }) {
    if (!requestId) throw new Error('requestId is required to wait for response');

    this.ensureWatcherStarted();

    // Register the waiter BEFORE any authoritative check. Previously the code
    // checked the database first and registered second, so a result committed in
    // that window produced no live wakeup and had to wait for the fallback poll.
    // Registering first and checking second closes the window for BOTH the
    // same-process (dispatchLocal) and cross-process (notify file / poll) cases.
    let timer = null;
    const waiterPromise = new Promise((resolve) => {
      const waiter = {
        resolve: (eventOrReq) => {
          if (timer) clearTimeout(timer);
          resolve(eventOrReq);
        },
        reject: (err) => {
          if (timer) clearTimeout(timer);
          resolve({
            requestId,
            status: 'failed',
            response: null,
            error: err.message
          });
        },
        timer: null,
        agentId,
        taskId,
        attemptId,
        routeId,
        registeredAt: Date.now()
      };

      // Register BEFORE the timeout is armed and BEFORE the authoritative
      // check below, so a result committed in any window is never missed.
      let waiters = this.responseWaiters.get(requestId);
      if (!waiters) {
        waiters = new Set();
        this.responseWaiters.set(requestId, waiters);
      }
      waiters.add(waiter);

      if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
        timer = setTimeout(() => {
          const current = this.responseWaiters.get(requestId);
          if (current) {
            current.delete(waiter);
            if (current.size === 0) this.responseWaiters.delete(requestId);
          }
          if (this.tracer) {
            this.tracer.mark({
              requestId,
              stage: LifecycleStage.WAITER_RESOLVED,
              taskId,
              attemptId,
              agentId,
              routeId,
              meta: { source: 'timeout', timeoutMs }
            });
          }
          resolve({
            requestId,
            status: 'timeout',
            response: null,
            error: `Request timed out after ${timeoutMs}ms waiting for response`,
            timedOut: true,
            recoverable: true
          });
        }, timeoutMs);
        waiter.timer = timer;
        // Deliberately NOT unref'd: a process that is synchronously awaiting a
        // correlated response must stay alive until that response arrives or the
        // deadline expires. Unref'ing this timer let short-lived requester
        // processes exit before a cross-process reply was delivered.
      }
    });

    // Second, authoritative check now that a waiter exists. If the result was
    // already committed (even in the window between an earlier check and
    // registration), this resolves synchronously with the full durable response.
    if (this._readTerminalRequest(requestId)) {
      this._settleWaiter(requestId, 'precheck');
    }

    return waiterPromise;
  }

  getActiveWaiterCount(requestId) {
    if (!requestId) return 0;
    return this.responseWaiters.get(requestId)?.size ?? 0;
  }

  getCursor(agentId) {
    try {
      const row = this.db.prepare(`
        SELECT last_event_id FROM agent_event_cursors WHERE agent_id = ?
      `).get(agentId);
      return row ? Number(row.last_event_id) : 0;
    } catch {
      return 0;
    }
  }

  updateCursor(agentId, eventId) {
    try {
      const now = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO agent_event_cursors (agent_id, last_event_id, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(agent_id) DO UPDATE SET
          last_event_id = MAX(last_event_id, excluded.last_event_id),
          updated_at = excluded.updated_at
      `).run(agentId, eventId, now);
      this.cursorCache.set(agentId, eventId);
    } catch {}
  }

  getLatestEventId() {
    try {
      const row = this.db.prepare(`SELECT MAX(event_id) as maxId FROM bridge_events`).get();
      return row?.maxId ? Number(row.maxId) : 0;
    } catch {
      return 0;
    }
  }

  getEvents({ agentId = null, afterEventId = 0, limit = 50, compact = true } = {}) {
    let query = `SELECT * FROM bridge_events WHERE event_id > ?`;
    const params = [afterEventId];

    if (agentId) {
      query += ` AND (agent_id = ? OR agent_id = '*' OR from_agent = ?)`;
      params.push(agentId, agentId);
    }

    query += ` ORDER BY event_id ASC LIMIT ?`;
    params.push(limit);

    const rows = this.db.prepare(query).all(...params);

    if (compact) {
      return rows.map(r => ({
        eventId: r.event_id,
        timestamp: r.timestamp,
        type: r.type,
        agentId: r.agent_id,
        fromAgent: r.from_agent,
        conversationId: r.conversation_id,
        requestId: r.request_id,
        taskId: r.task_id,
        status: r.status
      }));
    }

    return rows.map(r => ({
      eventId: r.event_id,
      timestamp: r.timestamp,
      type: r.type,
      agentId: r.agent_id,
      fromAgent: r.from_agent,
      conversationId: r.conversation_id,
      requestId: r.request_id,
      taskId: r.task_id,
      status: r.status,
      payload: r.payload ? (() => { try { return JSON.parse(r.payload); } catch { return r.payload; } })() : null
    }));
  }

  /**
   * Explicitly acknowledge processing of an event by an agent.
   * Persists to bridge_event_acks and updates agent_event_cursors.
   */
  ackEvent(agentId, eventId) {
    if (!agentId) throw new Error('agentId is required to ack event');
    if (eventId === null || eventId === undefined) throw new Error('eventId is required to ack event');
    const numId = Number(eventId);
    const now = new Date().toISOString();
    try {
      this.db.prepare(`
        INSERT INTO bridge_event_acks (agent_id, event_id, acked_at)
        VALUES (?, ?, ?)
        ON CONFLICT(agent_id, event_id) DO UPDATE SET acked_at = excluded.acked_at
      `).run(agentId, numId, now);
      this.updateCursor(agentId, numId);
    } catch {}
    return { agentId, eventId: numId, acked: true, ackedAt: now };
  }

  /**
   * Batch acknowledge multiple events for an agent.
   */
  ackEvents(agentId, eventIds) {
    if (!agentId) throw new Error('agentId is required to ack events');
    if (!Array.isArray(eventIds)) throw new Error('eventIds array is required');
    const now = new Date().toISOString();
    let maxId = 0;
    let ackedCount = 0;
    const stmt = this.db.prepare(`
      INSERT INTO bridge_event_acks (agent_id, event_id, acked_at)
      VALUES (?, ?, ?)
      ON CONFLICT(agent_id, event_id) DO UPDATE SET acked_at = excluded.acked_at
    `);
    for (const id of eventIds) {
      const numId = Number(id);
      try {
        stmt.run(agentId, numId, now);
        if (numId > maxId) maxId = numId;
        ackedCount++;
      } catch {}
    }
    if (maxId > 0) {
      this.updateCursor(agentId, maxId);
    }
    return { agentId, ackedCount, latestEventId: maxId };
  }

  /**
   * Check if a specific event has been acknowledged by an agent.
   */
  isEventAcked(agentId, eventId) {
    if (!agentId || eventId === null || eventId === undefined) return false;
    try {
      const row = this.db.prepare(`
        SELECT 1 FROM bridge_event_acks WHERE agent_id = ? AND event_id = ?
      `).get(agentId, Number(eventId));
      return Boolean(row);
    } catch {
      return false;
    }
  }

  /**
   * Retrieve unacknowledged events directed to an agent (or broadcast '*').
   */
  getUnackedEvents({ agentId, limit = 50, afterEventId = 0 } = {}) {
    if (!agentId) throw new Error('agentId is required to get unacked events');
    try {
      const rows = this.db.prepare(`
        SELECT e.* FROM bridge_events e
        LEFT JOIN bridge_event_acks a ON a.agent_id = ? AND a.event_id = e.event_id
        WHERE e.event_id > ?
          AND (e.agent_id = ? OR e.agent_id = '*')
          AND a.event_id IS NULL
        ORDER BY e.event_id ASC
        LIMIT ?
      `).all(agentId, afterEventId, agentId, limit);

      return rows.map(r => ({
        eventId: r.event_id,
        timestamp: r.timestamp,
        type: r.type,
        agentId: r.agent_id,
        fromAgent: r.from_agent,
        conversationId: r.conversation_id,
        requestId: r.request_id,
        taskId: r.task_id,
        status: r.status,
        payload: r.payload ? (() => { try { return JSON.parse(r.payload); } catch { return r.payload; } })() : null
      }));
    } catch {
      return [];
    }
  }

  /**
   * Re-dispatch unacknowledged events for an agent to active subscribers.
   */
  retryUnackedEvents({ agentId, limit = 50 } = {}) {
    if (!agentId) throw new Error('agentId is required to retry unacked events');
    const unacked = this.getUnackedEvents({ agentId, limit });
    let dispatched = 0;
    const handlers = this.subscribers.get(agentId);
    if (handlers && unacked.length > 0) {
      for (const event of unacked) {
        for (const handler of handlers) {
          try {
            handler(event);
            dispatched++;
          } catch (err) {
            this.emit('error', err);
          }
        }
      }
    }
    return { agentId, unackedCount: unacked.length, dispatched };
  }

  close() {
    this.isClosed = true;
    this.stopWatcher();
    for (const waiters of this.responseWaiters.values()) {
      for (const waiter of waiters) {
        if (waiter.timer) clearTimeout(waiter.timer);
      }
    }
    this.responseWaiters.clear();
    this.subscribers.clear();
  }
}
