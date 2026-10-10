import crypto from 'node:crypto';
import { CONFIG } from './config.js';

export class PresenceManager {
  constructor(auditLogger, options = {}) {
    this.logger = auditLogger;
    this.db = auditLogger.db;
    this.ttlMs = options.ttlMs || 20000; // 20s TTL for heartbeats
    this.initTables();
  }

  initTables() {
    try {
      const tableInfo = this.db.prepare(`PRAGMA table_info(agent_presence)`).all();
      const hasCompositePk = tableInfo.some(col => col.name === 'transport' && col.pk > 0);

      if (!hasCompositePk && tableInfo.length > 0) {
        // Migrate table to composite primary key (agent_id, transport)
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS agent_presence_v2 (
            agent_id TEXT NOT NULL,
            transport TEXT NOT NULL DEFAULT 'mcp-stdio',
            connected INTEGER DEFAULT 1,
            pid INTEGER,
            session_id TEXT,
            state TEXT DEFAULT 'IDLE',
            current_task_id TEXT,
            capabilities TEXT,
            health TEXT DEFAULT 'healthy',
            last_heartbeat TEXT NOT NULL,
            started_at TEXT NOT NULL,
            metadata TEXT,
            PRIMARY KEY (agent_id, transport)
          );
          INSERT OR REPLACE INTO agent_presence_v2 
            SELECT agent_id, COALESCE(transport, 'mcp-stdio'), connected, pid, session_id, state, current_task_id, capabilities, health, last_heartbeat, started_at, metadata
            FROM agent_presence;
          DROP TABLE agent_presence;
          ALTER TABLE agent_presence_v2 RENAME TO agent_presence;
        `);
      } else if (tableInfo.length === 0) {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS agent_presence (
            agent_id TEXT NOT NULL,
            transport TEXT NOT NULL DEFAULT 'mcp-stdio',
            connected INTEGER DEFAULT 1,
            pid INTEGER,
            session_id TEXT,
            state TEXT DEFAULT 'IDLE',
            current_task_id TEXT,
            capabilities TEXT,
            health TEXT DEFAULT 'healthy',
            last_heartbeat TEXT NOT NULL,
            started_at TEXT NOT NULL,
            metadata TEXT,
            PRIMARY KEY (agent_id, transport)
          );
        `);
      }
    } catch {
      // Fallback table creation
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS agent_presence (
          agent_id TEXT NOT NULL,
          transport TEXT NOT NULL DEFAULT 'mcp-stdio',
          connected INTEGER DEFAULT 1,
          pid INTEGER,
          session_id TEXT,
          state TEXT DEFAULT 'IDLE',
          current_task_id TEXT,
          capabilities TEXT,
          health TEXT DEFAULT 'healthy',
          last_heartbeat TEXT NOT NULL,
          started_at TEXT NOT NULL,
          metadata TEXT,
          PRIMARY KEY (agent_id, transport)
        );
      `);
    }
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
        agent_id, transport, connected, pid, session_id, state, current_task_id,
        capabilities, health, last_heartbeat, started_at, metadata
      )
      VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id, transport) DO UPDATE SET
        connected = 1,
        pid = excluded.pid,
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
      transport,
      pid,
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
      transport,
      connected: true,
      state,
      lastHeartbeat: now
    };
  }

  setOffline(agentId, transport = null) {
    if (!agentId) return;
    const now = new Date().toISOString();
    if (transport) {
      const stmt = this.db.prepare(`
        UPDATE agent_presence
        SET connected = 0, state = 'OFFLINE', current_task_id = NULL, last_heartbeat = ?
        WHERE agent_id = ? AND transport = ?
      `);
      stmt.run(now, agentId, transport);
    } else {
      const stmt = this.db.prepare(`
        UPDATE agent_presence
        SET connected = 0, state = 'OFFLINE', current_task_id = NULL, last_heartbeat = ?
        WHERE agent_id = ?
      `);
      stmt.run(now, agentId);
    }
  }

  setState(agentId, state, currentTaskId = null, transport = null) {
    const now = new Date().toISOString();
    if (transport) {
      const stmt = this.db.prepare(`
        UPDATE agent_presence
        SET state = ?, current_task_id = ?, last_heartbeat = ?, connected = 1
        WHERE agent_id = ? AND transport = ?
      `);
      stmt.run(state, currentTaskId, now, agentId, transport);
    } else {
      const stmt = this.db.prepare(`
        UPDATE agent_presence
        SET state = ?, current_task_id = ?, last_heartbeat = ?, connected = 1
        WHERE agent_id = ?
      `);
      stmt.run(state, currentTaskId, now, agentId);
    }
  }

  isProcessAlive(pid) {
    if (!pid || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  isAgentLive(agentId, ttlMs = this.ttlMs) {
    const agent = this.getAgent(agentId);
    if (!agent) return false;
    return agent.isLive === true;
  }

  hasAutonomousWorker(agentId, ttlMs = this.ttlMs) {
    const agent = this.getAgent(agentId);
    if (!agent) return false;
    return agent.autonomousWorker === true;
  }

  canReceiveTasks(agentId, ttlMs = this.ttlMs) {
    return this.hasAutonomousWorker(agentId, ttlMs);
  }

  canInitiateTurns(agentId, ttlMs = this.ttlMs) {
    const agent = this.getAgent(agentId);
    if (!agent) return false;
    return agent.isLive === true;
  }

  getAgent(agentId, transport = null) {
    if (transport) {
      const stmt = this.db.prepare(`SELECT * FROM agent_presence WHERE agent_id = ? AND transport = ?`);
      const row = stmt.get(agentId, transport);
      if (!row) return null;
      const isRecent = (Date.now() - Date.parse(row.last_heartbeat)) <= this.ttlMs;
      const processAlive = row.pid ? this.isProcessAlive(row.pid) : true;
      const isLive = row.connected === 1 && isRecent && processAlive;
      const isWorker = row.transport === 'agent-autonomous-worker' || row.transport.includes('worker');
      return {
        ...row,
        connected: isLive,
        capabilities: row.capabilities ? JSON.parse(row.capabilities) : [],
        metadata: row.metadata ? JSON.parse(row.metadata) : null,
        isLive,
        autonomousWorker: isLive && isWorker,
        canReceiveTasks: isLive && isWorker,
        canInitiateTurns: isLive,
        mcpConnected: isLive && row.transport === 'mcp-stdio'
      };
    }

    const stmt = this.db.prepare(`SELECT * FROM agent_presence WHERE agent_id = ? ORDER BY last_heartbeat DESC`);
    const rows = stmt.all(agentId);
    if (!rows || rows.length === 0) return null;

    const now = Date.now();
    let workerRow = null;
    let mcpRow = null;
    let anyLive = false;

    for (const r of rows) {
      const isRecent = (now - Date.parse(r.last_heartbeat)) <= this.ttlMs;
      const processAlive = r.pid ? this.isProcessAlive(r.pid) : true;
      const live = r.connected === 1 && isRecent && processAlive;
      if (live) anyLive = true;

      const isWorker = r.transport === 'agent-autonomous-worker' || r.transport.includes('worker');
      if (isWorker && live && !workerRow) {
        workerRow = r;
      }
      if (r.transport === 'mcp-stdio' && live && !mcpRow) {
        mcpRow = r;
      }
    }

    const primary = workerRow || mcpRow || rows[0];
    const isWorkerLive = Boolean(workerRow);
    const isMcpLive = Boolean(mcpRow);

    return {
      ...primary,
      agent_id: agentId,
      agentId,
      connected: anyLive,
      state: isWorkerLive ? workerRow.state : (isMcpLive ? mcpRow.state : (anyLive ? primary.state : 'OFFLINE')),
      transport: isWorkerLive ? workerRow.transport : (isMcpLive ? mcpRow.transport : primary.transport),
      pid: isWorkerLive ? workerRow.pid : (isMcpLive ? mcpRow.pid : primary.pid),
      capabilities: primary.capabilities ? JSON.parse(primary.capabilities) : [],
      metadata: primary.metadata ? JSON.parse(primary.metadata) : null,
      isLive: anyLive,
      autonomousWorker: isWorkerLive,
      canReceiveTasks: isWorkerLive,
      canInitiateTurns: anyLive,
      mcpConnected: isMcpLive,
      workerPid: workerRow?.pid || null,
      mcpPid: mcpRow?.pid || null
    };
  }

  getPresence(agentId) {
    const agent = this.getAgent(agentId);
    if (!agent) {
      return {
        agentId,
        isAlive: false,
        connected: false,
        state: 'OFFLINE',
        lastHeartbeat: null,
        metadata: null,
        transport: null,
        autonomousWorker: false,
        canReceiveTasks: false,
        canInitiateTurns: false,
        mcpConnected: false,
        workerPid: null,
        mcpPid: null
      };
    }
    return {
      agentId: agent.agent_id || agent.agentId,
      isAlive: agent.isLive === true,
      connected: agent.isLive === true,
      state: agent.isLive ? agent.state : 'OFFLINE',
      lastHeartbeat: agent.last_heartbeat,
      metadata: agent.metadata,
      transport: agent.transport,
      autonomousWorker: agent.autonomousWorker === true,
      canReceiveTasks: agent.canReceiveTasks === true,
      canInitiateTurns: agent.canInitiateTurns === true,
      mcpConnected: agent.mcpConnected === true,
      pid: agent.pid,
      workerPid: agent.workerPid || null,
      mcpPid: agent.mcpPid || null
    };
  }

  isAgentOnline(agentId, ttlMs = this.ttlMs) {
    if (!agentId) return false;
    const norm = (CONFIG.AGENT_IDENTITIES || []).find(id => id.toLowerCase() === agentId.toLowerCase()) || agentId;
    const stmt = this.db.prepare(`SELECT * FROM agent_presence WHERE agent_id = ?`);
    const rows = stmt.all(norm);
    const now = Date.now();
    for (const r of rows) {
      const isRecent = (now - Date.parse(r.last_heartbeat)) <= ttlMs;
      const processAlive = r.pid ? this.isProcessAlive(r.pid) : true;
      if (r.connected === 1 && isRecent && processAlive) return true;
    }
    return false;
  }

  listAgents(ttlMs = this.ttlMs) {
    const stmt = this.db.prepare(`SELECT * FROM agent_presence ORDER BY last_heartbeat DESC`);
    const rows = stmt.all();
    const now = Date.now();

    // Group rows by agent_id
    const agentMap = new Map();
    for (const r of rows) {
      if (!agentMap.has(r.agent_id)) {
        agentMap.set(r.agent_id, []);
      }
      agentMap.get(r.agent_id).push(r);
    }

    // Ensure all known agents are evaluated
    for (const id of CONFIG.AGENT_IDENTITIES || []) {
      if (!agentMap.has(id)) {
        agentMap.set(id, []);
      }
    }

    const result = [];
    for (const [agentId, agentRows] of agentMap.entries()) {
      let workerRow = null;
      let mcpRow = null;
      let anyLive = false;
      let latestHeartbeat = null;

      for (const r of agentRows) {
        const isRecent = (now - Date.parse(r.last_heartbeat)) <= ttlMs;
        const processAlive = r.pid ? this.isProcessAlive(r.pid) : true;
        const live = r.connected === 1 && isRecent && processAlive;
        if (live) anyLive = true;

        if (!latestHeartbeat || r.last_heartbeat > latestHeartbeat) {
          latestHeartbeat = r.last_heartbeat;
        }

        const isWorker = r.transport === 'agent-autonomous-worker' || r.transport.includes('worker');
        if (isWorker && live && !workerRow) {
          workerRow = r;
        }
        if (r.transport === 'mcp-stdio' && live && !mcpRow) {
          mcpRow = r;
        }
      }

      const primary = workerRow || mcpRow || (agentRows.length > 0 ? agentRows[0] : null);
      const isWorkerLive = Boolean(workerRow);
      const isMcpLive = Boolean(mcpRow);

      let caps = [];
      if (primary?.capabilities) {
        try { caps = JSON.parse(primary.capabilities); } catch {}
      }

      result.push({
        agentId,
        connected: anyLive,
        isLive: anyLive,
        state: isWorkerLive ? workerRow.state : (isMcpLive ? mcpRow.state : (anyLive ? primary.state : 'OFFLINE')),
        pid: isWorkerLive ? workerRow.pid : (isMcpLive ? mcpRow.pid : (primary?.pid || null)),
        workerPid: workerRow?.pid || null,
        mcpPid: mcpRow?.pid || null,
        transport: isWorkerLive ? workerRow.transport : (isMcpLive ? mcpRow.transport : (primary?.transport || 'none')),
        autonomousWorker: isWorkerLive,
        canReceiveTasks: isWorkerLive,
        canInitiateTurns: anyLive,
        mcpConnected: isMcpLive,
        currentTaskId: workerRow?.current_task_id || mcpRow?.current_task_id || null,
        capabilities: caps,
        // Do not report the last stored health value as current health when
        // the heartbeat has expired. A running PID alone does not prove that
        // the worker can receive EventBus work.
        health: anyLive ? (primary?.health || 'healthy') : (primary ? 'stale' : 'offline'),
        lastHeartbeat: latestHeartbeat
      });
    }

    return result;
  }

  startHeartbeatLoop(agentId, intervalMs = 5000, options = {}) {
    const sessionId = `sess_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const transport = options.transport || 'mcp-stdio';
    
    // Initial heartbeat
    this.heartbeat({
      agentId,
      sessionId,
      transport,
      capabilities: options.capabilities || ['read', 'write', 'execute', 'tasks']
    });

    const timer = setInterval(() => {
      try {
        this.heartbeat({
          agentId,
          sessionId,
          transport
        });
      } catch (err) {
        // Suppress heartbeat errors on DB contention
      }
    }, intervalMs);

    if (timer.unref) timer.unref();

    const cleanup = () => {
      clearInterval(timer);
      try {
        this.setOffline(agentId, transport);
      } catch {}
    };

    return { sessionId, timer, cleanup };
  }
}
