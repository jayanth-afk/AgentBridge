import crypto from 'node:crypto';
import path from 'node:path';

// Normalize so '/a/b/../c.js' and '/a/c.js' are recognised as the same file.
const norm = (p) => path.resolve(p);

export class FileActivityManager {
  constructor(auditLogger, options = {}) {
    this.logger = auditLogger;
    this.db = auditLogger.db;
    this.ttlMs = options.ttlMs || 30000;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS file_activity (
        id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        activity_type TEXT NOT NULL,
        started_at TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        collaboration_id TEXT,
        task_id TEXT,
        description TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_file_activity_path ON file_activity(file_path);
    `);
  }

  prune(now = Date.now()) {
    const cutoff = new Date(now - this.ttlMs).toISOString();
    this.db.prepare('DELETE FROM file_activity WHERE last_seen < ?').run(cutoff);
  }

  start({ filePath, agentId, activityType = 'editing', collaborationId = null, taskId = null, description = null }) {
    filePath = norm(filePath);
    this.prune();
    const now = new Date().toISOString();
    const existing = this.db.prepare(`
      SELECT * FROM file_activity
      WHERE file_path=? AND agent_id=? AND activity_type=?
      ORDER BY last_seen DESC LIMIT 1
    `).get(filePath, agentId, activityType);

    if (existing) {
      this.db.prepare('UPDATE file_activity SET last_seen=?, collaboration_id=?, task_id=?, description=? WHERE id=?')
        .run(now, collaborationId, taskId, description, existing.id);
      return { ...existing, lastSeen: now, collaborationId, taskId, description };
    }

    const id = `activity_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    this.db.prepare(`INSERT INTO file_activity
      (id, file_path, agent_id, activity_type, started_at, last_seen, collaboration_id, task_id, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, filePath, agentId, activityType, now, now, collaborationId, taskId, description
    );
    return { id, filePath, agentId, activityType, startedAt: now, lastSeen: now, collaborationId, taskId, description };
  }

  heartbeat({ filePath, agentId, activityType = 'editing' }) {
    filePath = norm(filePath);
    this.prune();
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE file_activity SET last_seen=?
      WHERE file_path=? AND agent_id=? AND activity_type=?
    `).run(now, filePath, agentId, activityType);
    return { filePath, agentId, activityType, active: result.changes > 0, lastSeen: now };
  }

  stop({ filePath, agentId, activityType = null }) {
    filePath = norm(filePath);
    const result = activityType
      ? this.db.prepare('DELETE FROM file_activity WHERE file_path=? AND agent_id=? AND activity_type=?').run(filePath, agentId, activityType)
      : this.db.prepare('DELETE FROM file_activity WHERE file_path=? AND agent_id=?').run(filePath, agentId);
    return { filePath, agentId, removed: result.changes };
  }

  get(filePath) {
    this.prune();
    return this.db.prepare('SELECT * FROM file_activity WHERE file_path=? ORDER BY last_seen DESC').all(norm(filePath));
  }

  getAll() {
    this.prune();
    return this.db.prepare('SELECT * FROM file_activity ORDER BY last_seen DESC').all();
  }
}
