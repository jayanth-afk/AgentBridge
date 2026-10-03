import { EventEmitter } from 'node:events';
import { AXEngine } from './ax-engine.js';
import { SwiftAXBridge } from './swift-ax-bridge.js';
import { ResponseObserver } from './response-observer.js';
import { CdpDesktopAdapter } from './cdp-adapter.js';
import { BrowserSessionAdapter } from './browser-session-adapter.js';
import { PersistentDesktopSessionManager } from './persistent-session-manager.js';
import { AdapterHealth } from './desktop-control-adapter.js';
import { sendDesktopNotification } from '../session-adapters/desktop-notifier.js';

/**
 * ClaudeAutonomousSession:
 * Unified autonomous session abstraction for Claude Desktop.
 * Automatically chooses the best live transport (MCP, CDP, AX, Browser) based on
 * verified health and hides transport-specific details behind a clean API.
 */
export class ClaudeAutonomousSession extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.swiftBridge = options.swiftBridge || new SwiftAXBridge(options);
    this.axEngine = options.axEngine || new AXEngine(options);
    this.observer = options.observer || new ResponseObserver(options);
    this.cdpAdapter = options.cdpAdapter || new CdpDesktopAdapter(options.cdp || {});
    this.browserAdapter = options.browserAdapter || new BrowserSessionAdapter(options.browser || {});
    this.sessionManager = options.sessionManager || new PersistentDesktopSessionManager({
      ...options,
      swiftBridge: this.swiftBridge
    });

    this.appName = 'Claude';
    this.activeTurns = new Map(); // requestId -> turnState
  }

  /**
   * Determine best available Claude transport
   */
  async selectTransport(mcpAdapter = null) {
    if (mcpAdapter && typeof mcpAdapter.isActiveTurn === 'function' && mcpAdapter.isActiveTurn()) {
      return { transport: 'mcp', confidence: 'authoritative' };
    }

    if (this.cdpAdapter.enabled) {
      const cdpHealth = await this.cdpAdapter.health();
      if (cdpHealth.status === AdapterHealth.AVAILABLE) {
        return { transport: 'cdp', confidence: 'high' };
      }
    }

    // Check accessibility
    const windowState = await this.axEngine.ensureAccessibleWindow(this.appName);
    if (windowState.ok) {
      return { transport: 'accessibility', confidence: 'high' };
    }

    if (this.browserAdapter.enabled) {
      const bHealth = await this.browserAdapter.health();
      if (bHealth.status === AdapterHealth.AVAILABLE) {
        return { transport: 'browser', confidence: 'fallback' };
      }
    }

    return { transport: 'notification', confidence: 'fallback' };
  }

  /**
   * Send a prompt to Claude through the best available transport
   */
  async send({ text, requestId, conversationTitle = null, mcpAdapter = null }) {
    const resolvedReqId = requestId || `req_claude_${Date.now()}`;
    const selected = await this.selectTransport(mcpAdapter);
    const transport = selected.transport;

    const startMs = Date.now();
    this.emit('turn_started', { requestId: resolvedReqId, transport });

    const previousFocus = await this.sessionManager.captureUserFocus();

    try {
      let result;
      if (transport === 'mcp' && mcpAdapter) {
        result = await mcpAdapter.sendMessage(text, { requestId: resolvedReqId });
      } else if (transport === 'cdp') {
        result = await this.cdpAdapter.sendMessage({ requestId: resolvedReqId, message: text });
      } else if (transport === 'accessibility') {
        result = await this.axEngine.executeReliableSend({
          targetApp: this.appName,
          text,
          requestId: resolvedReqId,
          conversationTitle
        });
        if (result.success) {
          this.observer.startObservation({ targetApp: this.appName, requestId: resolvedReqId });
        } else {
          // Fall back gracefully to notification when input is not located
          const notifRes = await sendDesktopNotification({
            title: 'Agent Bridge -> Claude Desktop',
            subtitle: 'Turn Requested',
            message: `Request [${resolvedReqId}] queued: ${text.slice(0, 80)}`
          });
          result = {
            success: true,
            transport: 'notification',
            status: 'queued_notification_fallback',
            fallbackFrom: 'accessibility',
            axError: result.error,
            details: notifRes
          };
        }
      } else if (transport === 'browser') {
        result = await this.browserAdapter.sendMessage({ requestId: resolvedReqId, message: text });
      } else {
        result = {
          success: true,
          transport: 'notification',
          status: 'delivered_notification'
        };
      }

      if (previousFocus) {
        await this.sessionManager.restoreUserFocus(previousFocus);
      }

      const turnResult = {
        ...result,
        transport,
        requestId: resolvedReqId,
        latencyMs: Date.now() - startMs
      };

      this.activeTurns.set(resolvedReqId, turnResult);
      this.emit('turn_dispatched', turnResult);
      return turnResult;
    } catch (err) {
      if (previousFocus) {
        await this.sessionManager.restoreUserFocus(previousFocus).catch(() => {});
      }
      return {
        success: false,
        transport,
        requestId: resolvedReqId,
        error: err.message,
        latencyMs: Date.now() - startMs
      };
    }
  }

  /**
   * Cancel an in-flight Claude turn
   */
  async cancel(requestId) {
    if (this.activeTurns.has(requestId)) {
      this.activeTurns.delete(requestId);
      return { cancelled: true, requestId };
    }
    return { cancelled: false, reason: 'TURN_NOT_FOUND', requestId };
  }

  /**
   * Recover session by ensuring Claude window is restored
   */
  async recover() {
    const windowRes = await this.sessionManager.ensureWindow(this.appName);
    return {
      recovered: windowRes.ok,
      windowCount: windowRes.windowCount || 0,
      details: windowRes
    };
  }

  async health() {
    const inspect = await this.swiftBridge.inspectApp(this.appName);
    return {
      running: inspect.ok && inspect.running,
      windowCount: inspect.windowCount || 0,
      activeTurns: this.activeTurns.size
    };
  }
}
