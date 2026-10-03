import { EventEmitter } from 'node:events';
import { SwiftAXBridge } from './swift-ax-bridge.js';

/**
 * Detailed Desktop Session States
 */
export const RegistrySessionState = Object.freeze({
  OFFLINE: 'OFFLINE',
  RUNNING: 'RUNNING',
  WINDOWLESS: 'WINDOWLESS',
  WINDOW_RESTORING: 'WINDOW_RESTORING',
  ACCESSIBLE: 'ACCESSIBLE',
  CDP_CONNECTED: 'CDP_CONNECTED',
  MCP_CONNECTED: 'MCP_CONNECTED',
  MODEL_TURN_ACTIVE: 'MODEL_TURN_ACTIVE',
  MODEL_TURN_IDLE: 'MODEL_TURN_IDLE',
  UNKNOWN: 'UNKNOWN'
});

/**
 * PersistentSessionRegistry:
 * Maintains a live, revalidating registry of all desktop agent sessions across
 * Claude Desktop, ChatGPT Desktop, and Antigravity IDE.
 */
export class PersistentSessionRegistry extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.swiftBridge = options.swiftBridge || new SwiftAXBridge(options);
    this.sessions = new Map(); // sessionId -> sessionRecord
  }

  /**
   * Register or update a session
   */
  registerSession({
    sessionId = null,
    agentId,
    application,
    pid = null,
    bundleId = null,
    conversationId = null,
    transport = 'accessibility',
    state = RegistrySessionState.UNKNOWN,
    capabilities = {},
    windowId = null,
    accessibilityTarget = null,
    cdpTarget = null,
    browserTarget = null,
    reconnectPolicy = { maxAttempts: 5, backoffMs: 500 }
  }) {
    if (!agentId) throw new Error('agentId is required to register session');
    if (!application) throw new Error('application is required to register session');

    const id = sessionId || `sess_${agentId}_${Date.now()}`;
    const now = new Date().toISOString();

    const record = {
      sessionId: id,
      agentId,
      application,
      pid,
      bundleId,
      conversationId: conversationId || `conv_${agentId}_default`,
      transport,
      state,
      lastVerified: now,
      health: 'healthy',
      capabilities: {
        canWake: true,
        canSubmit: true,
        canObserve: true,
        ...capabilities
      },
      windowId,
      accessibilityTarget,
      cdpTarget,
      browserTarget,
      reconnectPolicy,
      createdAt: now,
      history: [{ state, timestamp: now }]
    };

    this.sessions.set(id, record);
    this.emit('session_registered', record);
    return record;
  }

  /**
   * Update session state with audit trail
   */
  updateSessionState(sessionId, newState, details = {}) {
    const record = this.sessions.get(sessionId);
    if (!record) return null;

    const oldState = record.state;
    record.state = newState;
    record.lastVerified = new Date().toISOString();
    if (details.pid !== undefined) record.pid = details.pid;
    if (details.health !== undefined) record.health = details.health;
    if (details.transport !== undefined) record.transport = details.transport;

    record.history.push({
      fromState: oldState,
      toState: newState,
      timestamp: record.lastVerified,
      details
    });

    this.emit('state_changed', { sessionId, fromState: oldState, toState: newState, record });
    return record;
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  findSessionForAgent(agentId) {
    for (const record of this.sessions.values()) {
      if (record.agentId.toLowerCase() === agentId.toLowerCase()) {
        return record;
      }
    }
    return null;
  }

  getAllSessions() {
    return Array.from(this.sessions.values());
  }

  /**
   * Revalidate session against live OS process & window state
   */
  async revalidateSession(sessionId) {
    const record = this.sessions.get(sessionId);
    if (!record) return null;

    const inspection = await this.swiftBridge.inspectApp(record.application);
    const now = new Date().toISOString();
    record.lastVerified = now;

    if (!inspection.ok || !inspection.running) {
      this.updateSessionState(sessionId, RegistrySessionState.OFFLINE, { reason: 'PROCESS_NOT_FOUND' });
      record.pid = null;
      return record;
    }

    // Process is alive
    const currentPid = inspection.pid;
    const pidChanged = record.pid && record.pid !== currentPid;
    record.pid = currentPid;

    if (inspection.windowCount === 0) {
      this.updateSessionState(sessionId, RegistrySessionState.WINDOWLESS, { pidChanged, windowCount: 0 });
    } else {
      // Accessible window confirmed
      this.updateSessionState(sessionId, RegistrySessionState.ACCESSIBLE, {
        pidChanged,
        windowCount: inspection.windowCount,
        windows: inspection.windows
      });
    }

    return record;
  }

  /**
   * Revalidate all registered sessions concurrently
   */
  async revalidateAll() {
    const promises = Array.from(this.sessions.keys()).map(id => this.revalidateSession(id));
    return Promise.all(promises);
  }
}
