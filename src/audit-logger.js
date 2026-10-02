import { DatabaseSync } from 'node:sqlite';
import { CONFIG } from './config.js';
import fs from 'node:fs';
import path from 'node:path';

export class AuditLogger {
  constructor(dbPath = CONFIG.DB_PATH) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    // Each agent (ChatGPT / Claude / Antigravity) runs its own bridge process and
    // all of them share this one file. Without a busy timeout, a concurrent writer
    // fails immediately with "database is locked". WAL lets readers and a writer
    // proceed together; the timeout makes writers wait briefly instead of failing.
    // This is contention handling only, not a lock on agent work.
    this.db.exec('PRAGMA busy_timeout = 10000;');
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.initTables();
  }

  initTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        action TEXT NOT NULL,
        target_path TEXT,
        command TEXT,
        status TEXT NOT NULL,
        details TEXT,
        execution_ms INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        from_agent TEXT NOT NULL,
        to_agent TEXT NOT NULL,
        subject TEXT NOT NULL,
        content TEXT NOT NULL,
        reply_to_id TEXT,
        read_at TEXT
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        from_agent TEXT NOT NULL,
        to_agent TEXT NOT NULL,
        title TEXT NOT NULL,
        instructions TEXT NOT NULL,
        context TEXT,
        status TEXT NOT NULL,
        result TEXT
      );
    `);
  }

  log({ agentId, action, targetPath = null, command = null, status, details = null, executionMs = 0 }) {
    const stmt = this.db.prepare(`
      INSERT INTO audit_log (timestamp, agent_id, action, target_path, command, status, details, execution_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const timestamp = new Date().toISOString();
    stmt.run(
      timestamp,
      agentId,
      action,
      targetPath,
      command,
      status,
      typeof details === 'object' && details !== null ? JSON.stringify(details) : details,
      executionMs
    );
    return { timestamp, agentId, action, status };
  }

  getRecentLogs(limit = 50) {
    const stmt = this.db.prepare(`
      SELECT * FROM audit_log ORDER BY id DESC LIMIT ?
    `);
    return stmt.all(limit);
  }

  close() {
    this.db.close();
  }
}
