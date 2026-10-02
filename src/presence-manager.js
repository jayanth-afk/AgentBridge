import crypto from 'node:crypto';

export class PresenceManager {
  constructor(auditLogger, options = {}) {
    this.logger = auditLogger;
    this.db = auditLogger.db;
    this.ttlMs = options.ttlMs || 20000; // 20s TTL for heartbeats
    this.initTables();
  }

  initTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_presence (
        agent_id TEXT PRIMARY KEY,
        connected INTEGER DEFAULT 1,
        pid INTEGER,
        transport TEXT DEFAULT 'mcp-stdio',
        session_id TEXT,
        state TEXT DEFAULT 'IDLE',
        current_task_id TEXT,
        capabilities TEXT,
        health TEXT DEFAULT 'healthy',
        last_heartbeat TEXT NOT NULL,
        started_at TEXT NOT NULL,
        metadata TEXT
      );
    `);
  }

  heartbeat({
    agentId,
    pid = process.pid,
    transport = 'mcp-stdio',
    sessionId = null,
    state = 'IDLE',
    currentTaskId = null,
    capabilities = ['read', 'write', 'execute', 'tasks'],
    health = 'healthy',
    metadata = null
  }) {
    if (!agentId) return null;
    const now = new Date().toISOString();
    const capStr = Array.isArray(capabilities) ? JSON.stringify(capabilities) : capabilities;
    const metaStr = metadata ? JSON.stringify(metadata) : null;

    const stmt = this.db.prepare(`
      INSERT INTO agent_presence (
        agent_id, connected, pid, transport, session_id, state, current_task_id,
        capabilities, health, last_heartbeat, started_at, metadata
      )
      VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET
        connected = 1,
        pid = excluded.pid,
        transport = excluded.transport,
        session_id = COALESCE(excluded.session_id, session_id),
        state = excluded.state,
        current_task_id = excluded.current_task_id,
        capabilities = excluded.capabilities,
        health = excluded.health,
        last_heartbeat = excluded.last_heartbeat,
        metadata = excluded.metadata
    `);

    stmt.run(
      agentId,
      pid,
      transport,
      sessionId,
      state,
      currentTaskId,
      capStr,
      health,
      now,
      now,
      metaStr
    );

    return {
      agentId,
      connected: true,
      state,
      lastHeartbeat: now
    };
  }

  setOffline(agentId) {
    if (!agentId) return;
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE agent_presence
      SET connected = 0, state = 'OFFLINE', current_task_id = NULL, last_heartbeat = ?
      WHERE agent_id = ?
    `);
    stmt.run(now, agentId);
  }

  setState(agentId, state, currentTaskId = null) {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE agent_presence
      SET state = ?, current_task_id = ?, last_heartbeat = ?, connected = 1
      WHERE agent_id = ?
    `);
    stmt.run(state, currentTaskId, now, agentId);
  }

  isProcessAlive(pid) {
    if (!pid || pid <= 0) return false;
    try {
      // process.kill(pid, 0) checks if process exists without sending a signal
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  isAgentLive(agentId, ttlMs = this.ttlMs) {
    const agent = this.getAgent(agentId);
    if (!agent) return false;
    if (!agent.connected || agent.state === 'OFFLINE') return false;

    const lastTime = Date.parse(agent.last_heartbeat);
    if (isNaN(lastTime) || Date.now() - lastTime > ttlMs) {
      return false;
    }

    if (agent.pid && !this.isProcessAlive(agent.pid)) {
      // Clean up stale dead process record
      this.setOffline(agentId);
      return false;
    }

    return true;
  }

  getAgent(agentId) {
    const stmt = this.db.prepare(`SELECT * FROM agent_presence WHERE agent_id = ?`);
    const row = stmt.get(agentId);
    if (!row) return null;
    return {
      ...row,
      connected: row.connected === 1,
      capabilities: row.capabilities ? JSON.parse(row.capabilities) : [],
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
      isLive: row.connected === 1 && (Date.now() - Date.parse(row.last_heartbeat) <= this.ttlMs)
    };
  }

  listAgents(ttlMs = this.ttlMs) {
    const stmt = this.db.prepare(`SELECT * FROM agent_presence ORDER BY last_heartbeat DESC`);
    const rows = stmt.all();
    const now = Date.now();

    return rows.map(r => {
      const isRecent = (now - Date.parse(r.last_heartbeat)) <= ttlMs;
      const processAlive = r.pid ? this.isProcessAlive(r.pid) : true;
      const isLive = r.connected === 1 && isRecent && processAlive;

      return {
        agentId: r.agent_id,
        connected: isLive,
        state: isLive ? r.state : 'OFFLINE',
        pid: r.pid,
        transport: r.transport,
        currentTaskId: isLive ? r.current_task_id : null,
        capabilities: r.capabilities ? JSON.parse(r.capabilities) : [],
        health: r.health,
        lastHeartbeat: r.last_heartbeat,
        isLive
      };
    });
  }

  startHeartbeatLoop(agentId, intervalMs = 5000, options = {}) {
    const sessionId = `sess_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    
    // Initial heartbeat
    this.heartbeat({
      agentId,
      sessionId,
      transport: options.transport || 'mcp-stdio',
      capabilities: options.capabilities || ['read', 'write', 'execute', 'tasks']
    });

    const timer = setInterval(() => {
      try {
        this.heartbeat({
          agentId,
          sessionId,
          transport: options.transport || 'mcp-stdio'
        });
      } catch (err) {
        // Suppress heartbeat errors on DB contention
      }
    }, intervalMs);

    // Make sure timer does not prevent process exit
    if (timer.unref) timer.unref();

    const cleanup = () => {
      clearInterval(timer);
      try {
        this.setOffline(agentId);
      } catch {}
    };

    return { sessionId, timer, cleanup };
  }
}
