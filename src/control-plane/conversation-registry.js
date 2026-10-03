import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

/**
 * ConversationRegistry:
 * Tracks verified conversation threads, window bindings, thread IDs,
 * and conversational health across ChatGPT, Claude, and Antigravity.
 */
export class ConversationRegistry extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.conversations = new Map(); // conversationId -> record
    // Persistence is opt-in: pass persistPath to enable. Default null = in-memory only.
    this.persistPath = options.persistPath !== undefined ? options.persistPath : null;
    this._loadPersisted();
  }

  _loadPersisted() {
    if (!this.persistPath) return;
    try {
      if (fs.existsSync(this.persistPath)) {
        const raw = fs.readFileSync(this.persistPath, 'utf8');
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          for (const item of list) {
            if (item && item.conversationId) {
              this.conversations.set(item.conversationId, item);
            }
          }
        }
      }
    } catch {
      // Ignore initial load error
    }
  }

  _savePersisted() {
    if (!this.persistPath) return;
    try {
      const dir = path.dirname(this.persistPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const data = JSON.stringify(Array.from(this.conversations.values()), null, 2);
      fs.writeFileSync(this.persistPath, data, 'utf8');
    } catch {
      // Ignore background persist error
    }
  }

  /**
   * Create or register a verified conversation record
   */
  createConversation({
    conversationId,
    agent,
    transport = 'auto',
    threadId = null,
    windowTitle = null,
    pid = null,
    metadata = {}
  }) {
    if (!conversationId) throw new Error('conversationId is required');
    if (!agent) throw new Error('agent is required');

    const now = new Date().toISOString();
    const record = {
      conversationId,
      agent,
      transport,
      threadId,
      windowTitle,
      pid,
      createdAt: now,
      lastActivity: now,
      lastRequest: null,
      lastResponse: null,
      turnCount: 0,
      health: 'healthy',
      status: 'active',
      metadata: { ...metadata }
    };

    this.conversations.set(conversationId, record);
    this._savePersisted();
    this.emit('conversation_created', record);
    return record;
  }

  get(conversationId) {
    return this.conversations.get(conversationId) || null;
  }

  findByAgent(agent) {
    const results = [];
    for (const record of this.conversations.values()) {
      if (record.agent.toLowerCase() === agent.toLowerCase() && record.status === 'active') {
        results.push(record);
      }
    }
    return results;
  }

  /**
   * Attach/update metadata such as newly discovered threadId or window
   */
  attach(conversationId, updates = {}) {
    const record = this.conversations.get(conversationId);
    if (!record) return null;

    if (updates.threadId !== undefined) record.threadId = updates.threadId;
    if (updates.windowTitle !== undefined) record.windowTitle = updates.windowTitle;
    if (updates.pid !== undefined) record.pid = updates.pid;
    if (updates.transport !== undefined) record.transport = updates.transport;
    if (updates.metadata) Object.assign(record.metadata, updates.metadata);

    record.lastActivity = new Date().toISOString();
    this._savePersisted();
    this.emit('conversation_updated', record);
    return record;
  }

  /**
   * Update conversational activity after turn completion
   */
  updateActivity(conversationId, { request = null, response = null, latencyMs = 0 } = {}) {
    const record = this.conversations.get(conversationId);
    if (!record) return null;

    record.lastActivity = new Date().toISOString();
    if (request) record.lastRequest = request;
    if (response) record.lastResponse = response;
    record.turnCount++;
    record.lastLatencyMs = latencyMs;

    this._savePersisted();
    this.emit('activity', { conversationId, record });
    return record;
  }

  /**
   * Invalidate or close a conversation
   */
  invalidate(conversationId, reason = 'EXPIRED') {
    const record = this.conversations.get(conversationId);
    if (!record) return null;

    record.status = 'invalidated';
    record.invalidationReason = reason;
    record.health = 'stale';
    this._savePersisted();
    this.emit('conversation_invalidated', { conversationId, reason });
    return record;
  }

  detach(conversationId) {
    const had = this.conversations.delete(conversationId);
    if (had) {
      this._savePersisted();
      this.emit('conversation_detached', conversationId);
    }
    return had;
  }

  getAll() {
    return Array.from(this.conversations.values());
  }
}
