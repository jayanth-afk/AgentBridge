import fs from 'node:fs';
import path from 'node:path';
import EventEmitter from 'node:events';

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

    // Subscriptions: agentId -> Set of handler functions
    this.subscribers = new Map();
    // In-memory cursor cache: agentId -> lastEventId
    this.cursorCache = new Map();
    // Waiters for correlated request/response: requestId -> { resolve, reject, timer, agentId }
    this.responseWaiters = new Map();

    this.fileWatcher = null;
    this.fallbackTimer = null;
    this.isClosed = false;
    this.isChecking = false;

    this.ensureNotifyFile();
    this.initTables();
  }

  ensureNotifyFile() {
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

      CREATE INDEX IF NOT EXISTS idx_bridge_events_agent_id ON bridge_events(agent_id, event_id);
      CREATE INDEX IF NOT EXISTS idx_bridge_events_req_id ON bridge_events(request_id);
      CREATE INDEX IF NOT EXISTS idx_bridge_requests_to_status ON bridge_requests(to_agent, status);
    `);
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
    payload = null
  }) {
    if (this.isClosed) throw new Error('EventBus is closed');
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
        timestamp, type, agent_id, from_agent, conversation_id, request_id, task_id, status, payload
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      timestamp,
      type,
      agentId,
      fromAgent,
      convId,
      requestId,
      taskId,
      status,
      payloadStr
    );

    // Retrieve generated monotonically increasing event_id
    const row = this.db.prepare(`SELECT last_insert_rowid() as eventId`).get();
    const eventId = Number(row?.eventId || 0);

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
    try {
      fs.writeFileSync(this.notifyFilePath, String(eventId));
    } catch {}

    // In-process immediate dispatch (0ms)
    this.dispatchLocal(event);

    return event;
  }

  dispatchLocal(event) {
    // 1. Check if there are waiters for correlated request/response
    if (event.requestId && this.responseWaiters.has(event.requestId)) {
      if (event.type === 'response_delivered' || event.type === 'task_completed' || event.status === 'completed' || event.status === 'failed') {
        const waiter = this.responseWaiters.get(event.requestId);
        this.responseWaiters.delete(event.requestId);
        if (waiter.timer) clearTimeout(waiter.timer);

        let finalResponse = event.payload?.snippet || null;
        let finalError = event.payload?.error || null;
        try {
          const reqRow = this.db.prepare('SELECT response, error FROM bridge_requests WHERE request_id = ?').get(event.requestId);
          if (reqRow) {
            if (reqRow.response !== undefined && reqRow.response !== null) finalResponse = reqRow.response;
            if (reqRow.error) finalError = reqRow.error;
          }
        } catch {}

        waiter.resolve({
          ...event,
          response: finalResponse,
          error: finalError
        });
      }
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
    if (this.fileWatcher || this.isClosed) return;

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

      // Also check response waiters
      if (event.requestId && this.responseWaiters.has(event.requestId)) {
        if (event.type === 'response_delivered' || event.type === 'task_completed' || event.status === 'completed' || event.status === 'failed') {
          const waiter = this.responseWaiters.get(event.requestId);
          this.responseWaiters.delete(event.requestId);
          if (waiter.timer) clearTimeout(waiter.timer);

          let finalResponse = event.payload?.snippet || null;
          let finalError = event.payload?.error || null;
          try {
            const reqRow = this.db.prepare('SELECT response, error FROM bridge_requests WHERE request_id = ?').get(event.requestId);
            if (reqRow) {
              if (reqRow.response !== undefined && reqRow.response !== null) finalResponse = reqRow.response;
              if (reqRow.error) finalError = reqRow.error;
            }
          } catch {}

          waiter.resolve({
            ...event,
            response: finalResponse,
            error: finalError
          });
        }
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
    for (const [requestId, waiter] of this.responseWaiters.entries()) {
      try {
        const reqRow = this.db.prepare(`
          SELECT * FROM bridge_requests WHERE request_id = ?
        `).get(requestId);

        if (reqRow && (reqRow.status === 'completed' || reqRow.status === 'failed')) {
          this.responseWaiters.delete(requestId);
          if (waiter.timer) clearTimeout(waiter.timer);
          waiter.resolve({
            requestId,
            conversationId: reqRow.conversation_id,
            status: reqRow.status,
            response: reqRow.response,
            error: reqRow.error,
            completedAt: reqRow.completed_at
          });
        }
      } catch (err) {}
    }
  }

  /**
   * Correlated Request/Response Waiter:
   * Keeps caller attached to correlated response channel without manual polling.
   */
  async waitForResponse({ requestId, agentId = null, timeoutMs = 30000 }) {
    if (!requestId) throw new Error('requestId is required to wait for response');

    // 1. Check if already answered in bridge_requests table (handles race conditions)
    try {
      const existing = this.db.prepare(`
        SELECT * FROM bridge_requests WHERE request_id = ?
      `).get(requestId);

      if (existing && (existing.status === 'completed' || existing.status === 'failed')) {
        return {
          requestId: existing.request_id,
          conversationId: existing.conversation_id,
          status: existing.status,
          response: existing.response,
          error: existing.error,
          completedAt: existing.completed_at
        };
      }
    } catch {}

    this.ensureWatcherStarted();

    return new Promise((resolve) => {
      let timer = null;
      if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
        timer = setTimeout(() => {
          this.responseWaiters.delete(requestId);
          resolve({
            requestId,
            status: 'timeout',
            response: null,
            error: `Request timed out after ${timeoutMs}ms waiting for response`
          });
        }, timeoutMs);
      }

      this.responseWaiters.set(requestId, {
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
        timer,
        agentId
      });
    });
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

  close() {
    this.isClosed = true;
    this.stopWatcher();
    for (const waiter of this.responseWaiters.values()) {
      if (waiter.timer) clearTimeout(waiter.timer);
    }
    this.responseWaiters.clear();
    this.subscribers.clear();
  }
}
