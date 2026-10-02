import crypto from 'node:crypto';

function id(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

export class CollaborationManager {
  constructor(auditLogger, options = {}) {
    this.logger = auditLogger;
    this.db = auditLogger.db;
    // A member whose last heartbeat is older than this is reported as 'stale'.
    // Informational only: stale members are never removed or blocked.
    this.presenceTtlMs = options.presenceTtlMs || 60000;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS collaborations (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        owner_agent TEXT NOT NULL,
        title TEXT NOT NULL,
        objective TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        metadata TEXT
      );
      CREATE TABLE IF NOT EXISTS collaboration_members (
        collaboration_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'participant',
        joined_at TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'online',
        capabilities TEXT,
        PRIMARY KEY (collaboration_id, agent_id)
      );
      CREATE TABLE IF NOT EXISTS collaboration_events (
        id TEXT PRIMARY KEY,
        collaboration_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT
      );
    `);
  }

  create({ ownerAgent, title, objective, metadata = null }) {
    const now = new Date().toISOString();
    const collaborationId = id('collab');
    this.db.prepare(`INSERT INTO collaborations
      (id, created_at, updated_at, owner_agent, title, objective, status, metadata)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`).run(
      collaborationId, now, now, ownerAgent, title, objective,
      metadata ? JSON.stringify(metadata) : null
    );
    this.join({ collaborationId, agentId: ownerAgent, role: 'coordinator' });
    this.event({ collaborationId, agentId: ownerAgent, eventType: 'created', payload: { title, objective } });
    return this.get(collaborationId);
  }

  requireOpen(collaborationId) {
    const row = this.db.prepare('SELECT status FROM collaborations WHERE id=?').get(collaborationId);
    if (!row) throw new Error(`Collaboration '${collaborationId}' not found.`);
    if (row.status !== 'active') throw new Error(`Collaboration '${collaborationId}' is ${row.status}.`);
  }

  join({ collaborationId, agentId, role = 'participant', capabilities = [] }) {
    this.requireOpen(collaborationId);
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO collaboration_members
      (collaboration_id, agent_id, role, joined_at, last_seen, status, capabilities)
      VALUES (?, ?, ?, ?, ?, 'online', ?)
      ON CONFLICT(collaboration_id, agent_id) DO UPDATE SET
        role=excluded.role, last_seen=excluded.last_seen, status='online', capabilities=excluded.capabilities
    `).run(collaborationId, agentId, role, now, now, JSON.stringify(capabilities));
    this.touch(collaborationId, agentId);
    return this.get(collaborationId);
  }

  heartbeat({ collaborationId, agentId, status = 'online' }) {
    const now = new Date().toISOString();
    const result = this.db.prepare(`UPDATE collaboration_members SET last_seen=?, status=? WHERE collaboration_id=? AND agent_id=?`)
      .run(now, status, collaborationId, agentId);
    if (!result.changes) throw new Error(`Agent '${agentId}' is not a member of '${collaborationId}'. Join first.`);
    return { collaborationId, agentId, status, lastSeen: now };
  }

  leave({ collaborationId, agentId }) {
    const now = new Date().toISOString();
    const result = this.db.prepare(`UPDATE collaboration_members SET status='offline', last_seen=? WHERE collaboration_id=? AND agent_id=?`)
      .run(now, collaborationId, agentId);
    if (!result.changes) throw new Error(`Agent '${agentId}' is not a member of '${collaborationId}'.`);
    return { collaborationId, agentId, status: 'offline', lastSeen: now };
  }

  touch(collaborationId, agentId) {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE collaboration_members SET last_seen=? WHERE collaboration_id=? AND agent_id=?`)
      .run(now, collaborationId, agentId);
    this.db.prepare(`UPDATE collaborations SET updated_at=? WHERE id=?`).run(now, collaborationId);
  }

  event({ collaborationId, agentId, eventType, payload = null }) {
    this.requireOpen(collaborationId);
    const now = new Date().toISOString();
    const eventId = id('event');
    this.db.prepare(`INSERT INTO collaboration_events
      (id, collaboration_id, timestamp, agent_id, event_type, payload)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
      eventId, collaborationId, now, agentId, eventType,
      payload == null ? null : JSON.stringify(payload)
    );
    this.db.prepare(`UPDATE collaborations SET updated_at=? WHERE id=?`).run(now, collaborationId);
    return { id: eventId, collaborationId, timestamp: now, agentId, eventType, payload };
  }

  get(collaborationId) {
    const collaboration = this.db.prepare(`SELECT * FROM collaborations WHERE id=?`).get(collaborationId);
    if (!collaboration) return null;
    const members = this.db.prepare(`SELECT * FROM collaboration_members WHERE collaboration_id=? ORDER BY joined_at`).all(collaborationId);
    const events = this.db.prepare(`SELECT * FROM collaboration_events WHERE collaboration_id=? ORDER BY timestamp ASC, rowid ASC`).all(collaborationId);
    const nowMs = Date.now();
    const presenceOf = (m) => {
      if (m.status === 'offline') return 'offline';
      return nowMs - Date.parse(m.last_seen) > this.presenceTtlMs ? 'stale' : 'online';
    };
    return {
      ...collaboration,
      metadata: collaboration.metadata ? JSON.parse(collaboration.metadata) : null,
      members: members.map(m => ({ ...m, presence: presenceOf(m), capabilities: m.capabilities ? JSON.parse(m.capabilities) : [] })),
      events: events.map(e => ({ ...e, payload: e.payload ? JSON.parse(e.payload) : null }))
    };
  }

  list({ agentId = null, status = null } = {}) {
    let q = 'SELECT * FROM collaborations WHERE 1=1';
    const params = [];
    if (agentId) {
      q += ' AND id IN (SELECT collaboration_id FROM collaboration_members WHERE agent_id=?)';
      params.push(agentId);
    }
    if (status) {
      q += ' AND status=?';
      params.push(status);
    }
    q += ' ORDER BY updated_at DESC';
    return this.db.prepare(q).all(...params);
  }

  close({ collaborationId, agentId, reason = null }) {
    const row = this.db.prepare(`SELECT owner_agent FROM collaborations WHERE id=?`).get(collaborationId);
    if (!row) throw new Error(`Collaboration '${collaborationId}' not found.`);
    if (row.owner_agent !== agentId) throw new Error('Only the collaboration owner can close the collaboration.');
    // Record the closing event while the board is still active, then close it.
    this.event({ collaborationId, agentId, eventType: 'closed', payload: { reason } });
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE collaborations SET status='closed', updated_at=? WHERE id=?`).run(now, collaborationId);
    return this.get(collaborationId);
  }
}
