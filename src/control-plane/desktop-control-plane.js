import { AdapterHealth } from './desktop-control-adapter.js';
import { AXEngine } from './ax-engine.js';
import { SwiftAXBridge } from './swift-ax-bridge.js';
import { ResponseObserver } from './response-observer.js';
import { CdpDesktopAdapter } from './cdp-adapter.js';
import { PriorityScheduler, RequestEnvelope, RequestState } from '../protocol/envelope.js';
import { sendDesktopNotification, activateDesktopApp } from '../session-adapters/desktop-notifier.js';

/**
 * DesktopControlPlane:
 * Central orchestration plane for all desktop agent transports.
 * Selects the highest legitimate route available without silent unsafe downgrade.
 */
export class DesktopControlPlane {
  constructor(options = {}) {
    this.options = options;
    this.axEngine = new AXEngine(options);
    this.swiftBridge = new SwiftAXBridge(options);
    this.observer = new ResponseObserver(options);
    this.cdpAdapter = new CdpDesktopAdapter(options.cdp || {});
    this.scheduler = new PriorityScheduler();

    // Configuration flags
    this.enabled = Boolean(options.enabled);
    this.preferredRoute = options.preferredRoute || 'auto';
    this.routeHistory = []; // Audit log of dispatched routes
    this.requestRegistry = new Map(); // requestId -> envelope
  }

  /**
   * Determine the optimal route for a given target agent
   */
  async selectRoute(targetAgent, mcpAdapter = null) {
    // 1. Tier 1: Active MCP session turn
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

    // 3. Tier 3: User-authorized macOS Accessibility (UI automation)
    if (this.enabled) {
      const appName = targetAgent.includes('claude') ? 'Claude' : 'ChatGPT';
      const windowState = await this.axEngine.ensureAccessibleWindow(appName);
      if (windowState.ok) {
        return { route: 'accessibility', confidence: 'high', transport: 'macos-accessibility' };
      }
    }

    // 4. Tier 4: Native desktop notification fallback
    return { route: 'notification', confidence: 'fallback', transport: 'macos-notification' };
  }

  /**
   * Dispatch request through selected route with lifecycle state tracking
   */
  async dispatch(rawPayload, { targetAgent, mcpAdapter = null, priority = 'normal' } = {}) {
    const envelope = rawPayload instanceof RequestEnvelope
      ? rawPayload
      : new RequestEnvelope({
          fromAgent: rawPayload.fromAgent || 'agent-bridge',
          toAgent: targetAgent,
          message: rawPayload.message || rawPayload.text || String(rawPayload),
          requestId: rawPayload.requestId,
          conversationId: rawPayload.conversationId,
          taskId: rawPayload.taskId,
          priority
        });

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

    try {
      if (route === 'mcp' && mcpAdapter) {
        envelope.transition(RequestState.SENT, { route: 'mcp' });
        result = await mcpAdapter.sendMessage(envelope.message, { requestId: envelope.requestId });
        envelope.transition(RequestState.COMPLETED);
      } else if (route === 'cdp') {
        envelope.transition(RequestState.SENT, { route: 'cdp' });
        result = await this.cdpAdapter.sendMessage(envelope);
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
          // Start background response observer
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

      return {
        ...result,
        route,
        requestId: envelope.requestId,
        latencyMs: Date.now() - startMs,
        state: envelope.state
      };
    } catch (err) {
      envelope.transition(RequestState.FAILED, { error: err.message });
      return {
        success: false,
        route,
        requestId: envelope.requestId,
        error: err.message,
        state: envelope.state
      };
    }
  }

  /**
   * Health and Diagnostics overview
   */
  async diagnostics() {
    const cdpHealth = await this.cdpAdapter.health();
    const swiftAvailable = this.swiftBridge.isBinaryAvailable();

    return {
      desktopControlPlane: true,
      enabled: this.enabled,
      preferredRoute: this.preferredRoute,
      routes: {
        mcp: { supported: true, preferred: true },
        cdp: { supported: true, enabled: this.cdpAdapter.enabled, health: cdpHealth.status },
        accessibility: { supported: true, enabled: this.enabled, swiftHelperAvailable: swiftAvailable },
        notification: { supported: true, enabled: true }
      },
      activeRequests: this.requestRegistry.size,
      recentDispatches: this.routeHistory.slice(-10)
    };
  }
}
