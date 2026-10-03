import { AdapterHealth } from './desktop-control-adapter.js';
import { AXEngine } from './ax-engine.js';
import { SwiftAXBridge } from './swift-ax-bridge.js';
import { ResponseObserver } from './response-observer.js';
import { CdpDesktopAdapter } from './cdp-adapter.js';
import { BrowserSessionAdapter } from './browser-session-adapter.js';
import { PersistentDesktopSessionManager, SessionState } from './persistent-session-manager.js';
import { PriorityScheduler, RequestEnvelope, RequestState } from '../protocol/envelope.js';
import { sendDesktopNotification, activateDesktopApp } from '../session-adapters/desktop-notifier.js';

/**
 * DesktopControlPlane:
 * Central orchestration plane for all desktop agent transports.
 * Selects the highest legitimate route available without silent unsafe downgrade.
 * Manages session persistence, focus restoration, and cross-route deduplication.
 */
export class DesktopControlPlane {
  constructor(options = {}) {
    this.options = options;
    this.swiftBridge = new SwiftAXBridge(options);
    this.axEngine = new AXEngine(options);
    this.observer = new ResponseObserver(options);
    this.cdpAdapter = new CdpDesktopAdapter(options.cdp || {});
    this.browserAdapter = new BrowserSessionAdapter(options.browser || {});
    this.sessionManager = new PersistentDesktopSessionManager({
      ...options,
      swiftBridge: this.swiftBridge
    });
    this.scheduler = new PriorityScheduler();

    // Configuration flags
    this.enabled = Boolean(options.enabled);
    this.preferredRoute = options.preferredRoute || 'auto';
    this.routeHistory = []; // Audit log of dispatched routes
    this.requestRegistry = new Map(); // requestId -> envelope
    this.inFlightLocks = new Set(); // Prevent duplicate dispatch across routes
  }

  /**
   * Determine the optimal route for a given target agent
   */
  async selectRoute(targetAgent, mcpAdapter = null) {
    // 1. Tier 1: Active MCP session turn (Authoritative)
    if (mcpAdapter && typeof mcpAdapter.isActiveTurn === 'function' && mcpAdapter.isActiveTurn()) {
      return { route: 'mcp', confidence: 'authoritative', transport: 'mcp-turn' };
    }

    // 2. Tier 2: CDP if explicitly enabled and verified
    if (this.cdpAdapter.enabled) {
      const cdpHealth = await this.cdpAdapter.health();
      if (cdpHealth.status === AdapterHealth.AVAILABLE) {
        return { route: 'cdp', confidence: 'high', transport: 'chromium-devtools' };
      }
    }

    // 3. Tier 3: Persistent Browser Session if explicitly enabled
    if (this.browserAdapter.enabled) {
      const browserHealth = await this.browserAdapter.health();
      if (browserHealth.status === AdapterHealth.AVAILABLE) {
        return { route: 'browser', confidence: 'high', transport: 'browser-profile' };
      }
    }

    // 4. Tier 4: User-authorized macOS Accessibility (UI automation)
    if (this.enabled) {
      const appName = targetAgent.includes('claude') ? 'Claude' : 'ChatGPT';
      const windowState = await this.axEngine.ensureAccessibleWindow(appName);
      if (windowState.ok) {
        return { route: 'accessibility', confidence: 'high', transport: 'macos-accessibility' };
      }
    }

    // 5. Tier 5: Native desktop notification fallback
    return { route: 'notification', confidence: 'fallback', transport: 'macos-notification' };
  }

  /**
   * Dispatch request through selected route with single-flight locks and focus restoration
   */
  async dispatch(rawPayload, { targetAgent, mcpAdapter = null, priority = 'normal', requestId = null, conversationId = null, taskId = null } = {}) {
    const resolvedReqId = (rawPayload && typeof rawPayload === 'object' && rawPayload.requestId) || requestId;
    const resolvedConvId = (rawPayload && typeof rawPayload === 'object' && rawPayload.conversationId) || conversationId;
    const resolvedTaskId = (rawPayload && typeof rawPayload === 'object' && rawPayload.taskId) || taskId;
    const resolvedMessage = (rawPayload && typeof rawPayload === 'object')
      ? (rawPayload.message || rawPayload.text || '')
      : String(rawPayload);

    const envelope = rawPayload instanceof RequestEnvelope
      ? rawPayload
      : new RequestEnvelope({
          fromAgent: (rawPayload && rawPayload.fromAgent) || 'agent-bridge',
          toAgent: targetAgent,
          message: resolvedMessage,
          requestId: resolvedReqId,
          conversationId: resolvedConvId,
          taskId: resolvedTaskId,
          priority
        });

    // Cross-Route Single-Flight Lock: prevent sending duplicate while first route is in-flight
    if (this.inFlightLocks.has(envelope.requestId)) {
      return {
        success: false,
        error: 'DUPLICATE_IN_FLIGHT',
        requestId: envelope.requestId,
        details: 'A send operation is already actively in-flight for this requestId.'
      };
    }

    this.inFlightLocks.add(envelope.requestId);
    this.requestRegistry.set(envelope.requestId, envelope);
    envelope.transition(RequestState.ROUTING);

    const selection = await this.selectRoute(targetAgent, mcpAdapter);
    const route = selection.route;

    this.routeHistory.push({
      requestId: envelope.requestId,
      toAgent: targetAgent,
      route,
      timestamp: new Date().toISOString()
    });

    let result;
    const startMs = Date.now();

    // Capture user's current foreground app to restore later
    const previousFocus = await this.sessionManager.captureUserFocus();

    try {
      if (route === 'mcp' && mcpAdapter) {
        envelope.transition(RequestState.SENT, { route: 'mcp' });
        result = await mcpAdapter.sendMessage(envelope.message, { requestId: envelope.requestId });
        envelope.transition(RequestState.COMPLETED);
      } else if (route === 'cdp') {
        envelope.transition(RequestState.SENT, { route: 'cdp' });
        result = await this.cdpAdapter.sendMessage(envelope);
        envelope.transition(RequestState.COMPLETED);
      } else if (route === 'browser') {
        envelope.transition(RequestState.SENT, { route: 'browser' });
        result = await this.browserAdapter.sendMessage(envelope);
        envelope.transition(RequestState.COMPLETED);
      } else if (route === 'accessibility') {
        envelope.transition(RequestState.SENT, { route: 'accessibility' });
        const appName = targetAgent.includes('claude') ? 'Claude' : 'ChatGPT';
        result = await this.axEngine.executeReliableSend({
          targetApp: appName,
          text: envelope.message,
          requestId: envelope.requestId
        });

        if (result.success) {
          envelope.transition(RequestState.PROCESSING);
          this.observer.startObservation({ targetApp: appName, requestId: envelope.requestId });
        } else {
          envelope.transition(RequestState.FAILED, { error: result.error });
        }
      } else {
        // Fallback: Native macOS notification
        envelope.transition(RequestState.SENT, { route: 'notification' });
        const notifRes = await sendDesktopNotification({
          title: `Agent Bridge -> ${targetAgent}`,
          subtitle: 'Task Dispatched',
          message: envelope.message
        });
        result = {
          success: true,
          transport: 'notification',
          status: 'delivered_notification',
          details: notifRes
        };
        envelope.transition(RequestState.COMPLETED);
      }

      // Restore user focus to avoid disrupting user experience
      if (previousFocus) {
        await this.sessionManager.restoreUserFocus(previousFocus);
      }

      return {
        ...result,
        route,
        requestId: envelope.requestId,
        latencyMs: Date.now() - startMs,
        state: envelope.state
      };
    } catch (err) {
      // Transition to UNKNOWN if transport threw during execution to guard against uncertain resends
      envelope.transition(RequestState.UNKNOWN, { error: err.message });
      return {
        success: false,
        route,
        requestId: envelope.requestId,
        error: err.message,
        state: RequestState.UNKNOWN
      };
    } finally {
      this.inFlightLocks.delete(envelope.requestId);
    }
  }

  /**
   * Health and Diagnostics overview
   */
  async diagnostics() {
    const cdpHealth = await this.cdpAdapter.health();
    const browserHealth = await this.browserAdapter.health();
    const swiftAvailable = this.swiftBridge.isBinaryAvailable();

    return {
      desktopControlPlane: true,
      enabled: this.enabled,
      preferredRoute: this.preferredRoute,
      routes: {
        mcp: { supported: true, preferred: true },
        cdp: { supported: true, enabled: this.cdpAdapter.enabled, health: cdpHealth.status },
        browser: { supported: true, enabled: this.browserAdapter.enabled, health: browserHealth.status },
        accessibility: { supported: true, enabled: this.enabled, swiftHelperAvailable: swiftAvailable },
        notification: { supported: true, enabled: true }
      },
      activeRequests: this.requestRegistry.size,
      recentDispatches: this.routeHistory.slice(-10)
    };
  }
}
