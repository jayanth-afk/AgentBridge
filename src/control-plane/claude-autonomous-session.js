import { ModelExecutionAdapter } from './model-execution-adapter.js';
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
export class ClaudeAutonomousSession extends ModelExecutionAdapter {
  constructor(options = {}) {
    super('claude-autonomous-session', options);
    this.swiftBridge = options.swiftBridge || new SwiftAXBridge(options);
    this.axEngine = options.axEngine || new AXEngine({ ...options, allowHiddenWindowActivation: false, swiftBridge: this.swiftBridge });
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
   * Report detailed agent engine capabilities
   * Strictly distinguishes UI submission, model turn confirmation, and model response completion.
   */
  async capabilities() {
    const inspect = await this.swiftBridge.inspectApp(this.appName);
    const isRunning = Boolean(inspect.ok && inspect.running);
    return {
      name: this.name,
      agent: 'claude',
      engine: 'desktop-native-ax',
      trueHeadlessEngine: false, // Truthful! GUI/AX based
      idleModelWake: isRunning ? 'VERIFIED' : 'UNSUPPORTED',
      uiSubmission: isRunning,
      modelTurnConfirmation: isRunning,
      modelResponseCorrelation: true,
      streaming: true,
      cancellation: true,
      concurrency: false,
      transports: ['accessibility', 'mcp', 'cdp', 'browser']
    };
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
  async send({ text, requestId, conversationTitle = null, mcpAdapter = null, timeoutMs = null }) {
    const resolvedReqId = requestId || `req_claude_${Date.now()}`;
    const selected = await this.selectTransport(mcpAdapter);
    const transport = selected.transport;

    const startMs = Date.now();
    this.emit('turn_started', { requestId: resolvedReqId, transport });

    try {
      let result;
      if (transport === 'mcp' && mcpAdapter) {
        result = await mcpAdapter.sendMessage(text, { requestId: resolvedReqId });
      } else if (transport === 'cdp') {
        result = await this.cdpAdapter.sendMessage({ requestId: resolvedReqId, message: text });
      } else if (transport === 'accessibility') {
        if (this.swiftBridge.isBinaryAvailable()) {
          // One native invocation captures the AX baseline BEFORE Send, then
          // observes the same turn. This closes the send/observe race.
          const turnTimeout = timeoutMs || this.options.timeoutMs || 90000;
          const turnRes = await this.swiftBridge.sendAndObserve(
            this.appName,
            text,
            resolvedReqId,
            turnTimeout,
            { activate: false }
          );
          if (turnRes.ok) {
            this.emit('model_turn_started', { requestId: resolvedReqId, transport: 'accessibility' });
            result = {
              success: true,
              status: turnRes.status || 'COMPLETED',
              response: turnRes.response,
              modelTurnConfirmed: true,
              latencyMs: turnRes.latencyMs
            };
          } else {
            result = {
              success: false,
              status: turnRes.status || 'TIMEOUT',
              error: turnRes.error || 'Model response observation timed out',
              modelTurnConfirmed: false
            };
          }
        }

        // Do not fall back to activating AX: preserve background invariant.
        if (!result) {
          result = {
            success: false,
            status: 'SWIFT_BINARY_NOT_FOUND',
            error: 'Swift AX helper binary is not available',
            modelTurnConfirmed: false
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
