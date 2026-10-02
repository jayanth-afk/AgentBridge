import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export class ConcurrencyManager {
  constructor() {
    this.activeLocks = new Map(); // filePath -> { agentId, acquiredAt, expiresAt }
    this.DEFAULT_LOCK_TTL_MS = 10000; // 10 seconds default lock
  }

  computeFileHash(filePath) {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  acquireLock(filePath, agentId, ttlMs = this.DEFAULT_LOCK_TTL_MS) {
    const resolved = path.resolve(filePath);
    const now = Date.now();
    const existing = this.activeLocks.get(resolved);

    // Locks are advisory only: one registered agent must never block another
    // from accessing a file. The owner explicitly wants multi-agent access.
    // Optimistic hash checking remains available separately via verifyExpectedHash().
    const previousAgentId = existing && existing.expiresAt > now
      ? existing.agentId
      : null;

    this.activeLocks.set(resolved, {
      agentId,
      acquiredAt: now,
      expiresAt: now + ttlMs
    });

    return {
      acquired: true,
      expiresAt: now + ttlMs,
      advisory: true,
      previousAgentId
    };
  }

  releaseLock(filePath, agentId) {
    const resolved = path.resolve(filePath);
    const existing = this.activeLocks.get(resolved);
    if (!existing) return { released: true };

    if (existing.agentId === agentId || existing.expiresAt <= Date.now()) {
      this.activeLocks.delete(resolved);
      return { released: true };
    }

    return { released: false, reason: `Lock held by different agent '${existing.agentId}'` };
  }

  verifyExpectedHash(filePath, expectedHash) {
    if (!expectedHash) return { valid: true }; // No optimistic lock requested

    const currentHash = this.computeFileHash(filePath);
    if (currentHash !== expectedHash) {
      return {
        valid: false,
        reason: `ConflictDetected: file was modified concurrently by another agent. Expected hash ${expectedHash}, current hash is ${currentHash}. Please refresh file content and retry.`
      };
    }

    return { valid: true, currentHash };
  }
}
