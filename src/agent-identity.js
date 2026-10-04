import crypto from 'node:crypto';
import { CONFIG } from './config.js';

export class AgentIdentityManager {
  constructor(auditLogger, boundAgentId = null) {
    this.logger = auditLogger;
    this.db = auditLogger.db;
    this.boundAgentId = boundAgentId || process.env.AGENT_ID || null;
    this.initTables();
  }

  initTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_tokens (
        token TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        description TEXT
      );
    `);
  }

  createToken(agentId, ttlMs = 86400000, description = 'Agent Bridge Token') {
    const token = `abt_${crypto.randomBytes(24).toString('hex')}`;
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();

    this.db.prepare(`
      INSERT INTO agent_tokens (token, agent_id, created_at, expires_at, description)
      VALUES (?, ?, ?, ?, ?)
    `).run(token, agentId, now, expiresAt, description);

    return { token, agentId, expiresAt };
  }

  verifyToken(token) {
    if (!token) return null;
    const row = this.db.prepare(`
      SELECT * FROM agent_tokens WHERE token = ?
    `).get(token);

    if (!row) return null;
    if (Date.now() > Date.parse(row.expires_at)) {
      this.db.prepare(`DELETE FROM agent_tokens WHERE token = ?`).run(token);
      return null;
    }
    return row.agent_id;
  }

  /**
   * Resolves caller identity securely.
   * Prevents arbitrary escalation (e.g. claiming to be 'system' when connected as 'claude-desktop').
   */
  resolveIdentity(suppliedAgentId, { token = null, allowCompatibility = CONFIG.ALLOW_IDENTITY_COMPATIBILITY } = {}) {
    // 1. If an auth token is provided and valid, it takes top precedence
    if (token) {
      const tokenAgent = this.verifyToken(token);
      if (tokenAgent) {
        return {
          authenticated: true,
          agentId: tokenAgent,
          method: 'token'
        };
      }
    }

    // 2. If the current bridge instance is bound to a specific agent (e.g. via launch config env)
    if (this.boundAgentId) {
      const normalizedBound = this.boundAgentId.trim().toLowerCase();

      // If caller supplied no agentId, default directly to the bound identity
      if (!suppliedAgentId) {
        return {
          authenticated: true,
          agentId: normalizedBound,
          method: 'connection_binding'
        };
      }

      const normalizedSupplied = suppliedAgentId.trim().toLowerCase();

      // Caller claims to be the same as bound identity -> verified
      if (normalizedSupplied === normalizedBound) {
        return {
          authenticated: true,
          agentId: normalizedBound,
          method: 'connection_binding'
        };
      }

      // Caller attempts privilege escalation to 'system'
      if (normalizedSupplied === 'system' && normalizedBound !== 'system') {
        throw new Error(
          `Security Violation: Connection is bound to '${normalizedBound}'. Escalation to 'system' identity is denied.`
        );
      }

      // Explicit legacy compatibility opt-in: adopt a different unprivileged
      // identity. Off by default; enabling it re-introduces impersonation.
      if (allowCompatibility === true && CONFIG.AGENT_IDENTITIES.includes(normalizedSupplied)) {
        return {
          authenticated: false,
          compatibilityMode: true,
          agentId: normalizedSupplied,
          boundAgentId: normalizedBound,
          method: 'compatibility_unauthenticated'
        };
      }

      // A bound connection is authoritative. It can never act as a different
      // agent: the requested identity is ignored and the bound identity is
      // used (recorded for observability) instead of silently impersonating.
      return {
        authenticated: true,
        agentId: normalizedBound,
        requestedAgentId: normalizedSupplied === normalizedBound ? undefined : normalizedSupplied,
        method: normalizedSupplied === normalizedBound ? 'connection_binding' : 'connection_binding_forced'
      };
    }

    // 3. Fallback for unbound connections (e.g. generic CLI or testing)
    if (suppliedAgentId) {
      const normalizedSupplied = suppliedAgentId.trim().toLowerCase();

      // Do NOT allow untrusted external callers to claim 'system' without token
      if (normalizedSupplied === 'system' && !token) {
        // Fall back to 'freebuff' or reject
        return {
          authenticated: false,
          compatibilityMode: true,
          agentId: 'freebuff',
          method: 'unbound_demoted_from_system'
        };
      }

      if (CONFIG.AGENT_IDENTITIES.includes(normalizedSupplied)) {
        return {
          authenticated: false,
          compatibilityMode: true,
          agentId: normalizedSupplied,
          method: 'unbound_compatibility'
        };
      }
    }

    return {
      authenticated: false,
      agentId: 'freebuff',
      method: 'default_fallback'
    };
  }
}
