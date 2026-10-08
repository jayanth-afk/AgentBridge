import { AdapterHealth } from './desktop-control-adapter.js';
import { AXEngine } from './ax-engine.js';
import { SwiftAXBridge } from './swift-ax-bridge.js';
import { ResponseObserver } from './response-observer.js';
import { CdpDesktopAdapter } from './cdp-adapter.js';
import { BrowserSessionAdapter } from './browser-session-adapter.js';
import { ChatGptLocalEngineAdapter } from './chatgpt-local-engine.js';
import { PersistentDesktopSessionManager, SessionState } from './persistent-session-manager.js';
import { PersistentSessionRegistry, RegistrySessionState } from './persistent-session-registry.js';
import { PersistentDesktopLauncher } from './persistent-desktop-launcher.js';
import { ResponseCorrelatorV2, CorrelationTier, CorrelationConfidence } from '../correlation/response-correlator-v2.js';
import { SafeRouteScheduler, TransportOutcome, TransportResult } from '../transports/transport-contract.js';
import { PriorityScheduler, RequestEnvelope, RequestState } from '../protocol/envelope.js';
import { sendDesktopNotification, activateDesktopApp } from '../session-adapters/desktop-notifier.js';

/**
 * DesktopControlPlane:
 * Central orchestration plane for all desktop agent transports.
 * Converged onto SafeRouteScheduler and ResponseCorrelatorV2.
 * Selects the highest legitimate route available without silent unsafe downgrade.
 * Manages session persistence, focus restoration, authentic model execution, and cross-route deduplication.
 */
export class DesktopControlPlane {
  constructor(options = {}) {
    this.options = options;
    this.swiftBridge = new SwiftAXBridge(options);
    this.axEngine = new AXEngine({ ...options, swiftBridge: this.swiftBridge });
    this.observer = new ResponseObserver(options);
    this.cdpAdapter = new CdpDesktopAdapter(options.cdp || {});
    this.browserAdapter = new BrowserSessionAdapter(options.browser || {});
    this.chatgptLocalEngine = new ChatGptLocalEngineAdapter(options.chatgptEngine || {});
    this.registry = new PersistentSessionRegistry({ ...options, swiftBridge: this.swiftBridge });
    this.launcher = new PersistentDesktopLauncher({
      ...options,
      swiftBridge: this.swiftBridge,
      registry: this.registry
    });
    this.correlator = options.correlator instanceof ResponseCorrelatorV2
      ? options.correlator
      : new ResponseCorrelatorV2(options.correlator || {});
    this.sessionManager = new PersistentDesktopSessionManager({
      ...options,
      swiftBridge: this.swiftBridge
    });
    this.scheduler = new PriorityScheduler();

    // Canonical Route Scheduler
    this.routeScheduler = options.routeScheduler || new SafeRouteScheduler({
      capabilityRegistry: options.capabilityRegistry,
      auditLogger: options.auditLogger
    });
    this.registerTransportsWithScheduler();

    // Configuration flags
    this.enabled = Boolean(options.enabled);
    this.preferredRoute = options.preferredRoute || 'auto';
    this.routeHistory = []; // Audit log of dispatched routes
    this.requestRegistry = new Map(); // requestId -> envelope
    this.inFlightLocks = new Set(); // Prevent duplicate dispatch across routes
  }

  registerTransportsWithScheduler() {
    // 1. MCP turn transport
    this.routeScheduler.registerTransport('mcp', {
      send: async (env, ctx = {}) => {
        if (ctx.mcpAdapter && typeof ctx.mcpAdapter.isActiveTurn === 'function' && ctx.mcpAdapter.isActiveTurn()) {
          const res = await ctx.mcpAdapter.sendMessage(env.message, { requestId: env.requestId });
          return new TransportResult({
            outcome: TransportOutcome.DELIVERED_CONFIRMED,
            routeId: 'mcp',
            attemptId: ctx.attemptId,
            epoch: ctx.epoch,
            details: res
          });
        }
        return new TransportResult({
          outcome: TransportOutcome.UNSUPPORTED,
          routeId: 'mcp',
          details: { reason: 'No active MCP session turn' }
        });
      }
    });

    // 2. ChatGPT Desktop Local Engine
    this.routeScheduler.registerTransport('chatgpt-local-engine', {
      send: async (env, ctx = {}) => {
        const isChatGpt = env.toAgent && env.toAgent.toLowerCase().includes('chatgpt');
        if (!isChatGpt || !this.chatgptLocalEngine.isInstalled()) {
          return new TransportResult({
            outcome: TransportOutcome.UNSUPPORTED,
            routeId: 'chatgpt-local-engine'
          });
        }
        const nonce = ctx.nonce || this.correlator.generateNonce(env.requestId, ctx.attemptId || 'att_default', ctx.epoch || 1, 'chatgpt-local-engine');
        const taggedPrompt = this.correlator.embedNonceInPrompt(env.message, nonce);
        const engineRes = await this.chatgptLocalEngine.executeTurn({
          prompt: taggedPrompt,
          requestId: env.requestId
        });
        if (engineRes.ok) {
          const correlation = this.correlator.correlate({
            requestId: env.requestId,
            attemptId: ctx.attemptId,
            epoch: ctx.epoch,
            expectedNonce: nonce,
            rawResponse: engineRes.response,
            isStructuredStream: Boolean(engineRes.isStructuredStream)
          });
          const isDelivered = correlation.isAcceptableForSuccess();
          return new TransportResult({
            outcome: isDelivered ? TransportOutcome.DELIVERED_CONFIRMED : TransportOutcome.SENT_UNCONFIRMED,
            routeId: 'chatgpt-local-engine',
            attemptId: ctx.attemptId,
            epoch: ctx.epoch,
            nonce,
            evidence: correlation.evidence,
            details: {
              response: correlation.cleanedResponse,
              rawResponse: engineRes.response,
              usage: engineRes.usage,
              threadId: engineRes.threadId,
              confidence: correlation.confidence
            }
          });
        }
        return new TransportResult({
          outcome: TransportOutcome.FAILED,
          routeId: 'chatgpt-local-engine',
          attemptId: ctx.attemptId,
          epoch: ctx.epoch,
          nonDeliveryProven: true,
          evidence: engineRes.error
        });
      }
    });

    // 3. CDP Desktop Adapter
    this.routeScheduler.registerTransport('cdp', {
      send: async (env, ctx = {}) => {
        if (!this.cdpAdapter.enabled) {
          return new TransportResult({ outcome: TransportOutcome.UNSUPPORTED, routeId: 'cdp' });
        }
        const health = await this.cdpAdapter.health();
        if (health.status !== AdapterHealth.AVAILABLE) {
          return new TransportResult({ outcome: TransportOutcome.NOT_SENT, routeId: 'cdp', evidence: health.reason });
        }
        const res = await this.cdpAdapter.sendMessage(env);
        return new TransportResult({
          outcome: TransportOutcome.DELIVERED_CONFIRMED,
          routeId: 'cdp',
          details: res
        });
      }
    });

    // 4. Browser Session Adapter
    this.routeScheduler.registerTransport('browser', {
      send: async (env, ctx = {}) => {
        if (!this.browserAdapter.enabled) {
          return new TransportResult({ outcome: TransportOutcome.UNSUPPORTED, routeId: 'browser' });
        }
        const health = await this.browserAdapter.health();
        if (health.status !== AdapterHealth.AVAILABLE) {
          return new TransportResult({ outcome: TransportOutcome.NOT_SENT, routeId: 'browser', evidence: health.reason });
        }
        const res = await this.browserAdapter.sendMessage(env);
        return new TransportResult({
          outcome: TransportOutcome.DELIVERED_CONFIRMED,
          routeId: 'browser',
          details: res
        });
      }
    });

    // 5. Accessibility UI Adapter
    this.routeScheduler.registerTransport('accessibility', {
      send: async (env, ctx = {}) => {
        if (!this.enabled) {
          return new TransportResult({ outcome: TransportOutcome.UNSUPPORTED, routeId: 'accessibility' });
        }
        const appName = env.toAgent && env.toAgent.toLowerCase().includes('claude') ? 'Claude' : 'ChatGPT';
        const windowState = await this.axEngine.ensureAccessibleWindow(appName);
        if (!windowState.ok) {
          return new TransportResult({
            outcome: TransportOutcome.NOT_SENT,
            routeId: 'accessibility',
            evidence: windowState.error || 'No accessible window'
          });
        }
        const sendRes = await this.axEngine.executeReliableSend({
          targetApp: appName,
          text: env.message,
          requestId: env.requestId
        });
        if (sendRes.success) {
          this.observer.startObservation({ targetApp: appName, requestId: env.requestId });
          return new TransportResult({
            outcome: TransportOutcome.SENT_UNCONFIRMED,
            routeId: 'accessibility',
            attemptId: ctx.attemptId,
            epoch: ctx.epoch,
            evidence: 'UI keystrokes dispatched to window; awaiting observation (UNVERIFIED)'
          });
        }
        return new TransportResult({
          outcome: TransportOutcome.FAILED,
          routeId: 'accessibility',
          nonDeliveryProven: true,
          evidence: sendRes.error
        });
      }
    });

    // 6. Desktop Notification Fallback
    this.routeScheduler.registerTransport('notification', {
      send: async (env, ctx = {}) => {
        const notifRes = await sendDesktopNotification({
          title: `Agent Bridge -> ${env.toAgent}`,
          subtitle: 'Task Dispatched',
          message: env.message
        });
        return new TransportResult({
          outcome: TransportOutcome.DELIVERED_CONFIRMED,
          routeId: 'notification',
          details: notifRes
        });
      }
    });
  }

  /**
   * Determine the optimal route for a given target agent
   */
  async selectRoute(targetAgent, mcpAdapter = null) {
    const isClaude = targetAgent.toLowerCase().includes('claude');
    const isChatGpt = targetAgent.toLowerCase().includes('chatgpt');

    // 1. Tier 1: Active MCP session turn (Authoritative)
    if (mcpAdapter && typeof mcpAdapter.isActiveTurn === 'function' && mcpAdapter.isActiveTurn()) {
      return { route: 'mcp', confidence: 'authoritative', transport: 'mcp-turn' };
    }

    // 2. Tier 2: Real ChatGPT Desktop Local Engine (Official bundled codex-cli, non-interactive idle turn)
    if (isChatGpt && this.chatgptLocalEngine.isInstalled()) {
      return { route: 'chatgpt-local-engine', confidence: 'authoritative', transport: 'chatgpt-local-engine' };
    }

    // 3. Tier 3: CDP if explicitly enabled and verified
    if (this.cdpAdapter.enabled) {
      const cdpHealth = await this.cdpAdapter.health();
      if (cdpHealth.status === AdapterHealth.AVAILABLE) {
        return { route: 'cdp', confidence: 'high', transport: 'chromium-devtools' };
      }
    }

    // 4. Tier 4: Persistent Browser Session if explicitly enabled
    if (this.browserAdapter.enabled) {
      const browserHealth = await this.browserAdapter.health();
      if (browserHealth.status === AdapterHealth.AVAILABLE) {
        return { route: 'browser', confidence: 'high', transport: 'browser-profile' };
      }
    }

    // 5. Tier 5: User-authorized macOS Accessibility (UI automation)
    if (this.enabled) {
      const appName = isClaude ? 'Claude' : 'ChatGPT';
      const windowState = await this.axEngine.ensureAccessibleWindow(appName);
      if (windowState.ok) {
        return { route: 'accessibility', confidence: 'high', transport: 'macos-accessibility' };
      }
    }

    // 6. Tier 6: Native desktop notification fallback
    return { route: 'notification', confidence: 'fallback', transport: 'macos-notification' };
  }

  getCandidateRouteIds(targetAgent, mcpAdapter = null) {
    const isChatGpt = targetAgent && targetAgent.toLowerCase().includes('chatgpt');

    const candidates = [];
    if (mcpAdapter && typeof mcpAdapter.isActiveTurn === 'function' && mcpAdapter.isActiveTurn()) {
      candidates.push('mcp');
    }
    if (isChatGpt && this.chatgptLocalEngine.isInstalled()) {
      candidates.push('chatgpt-local-engine');
    }
    if (this.cdpAdapter.enabled) {
      candidates.push('cdp');
    }
    if (this.browserAdapter.enabled) {
      candidates.push('browser');
    }
    if (this.enabled) {
      candidates.push('accessibility');
    }
    candidates.push('notification');
    return candidates;
  }

  /**
   * Dispatch request through SafeRouteScheduler with single-flight locks and focus restoration
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

    const startMs = Date.now();
    // Capture user's current foreground app to restore later
    const previousFocus = await this.sessionManager.captureUserFocus();

    try {
      const candidateRouteIds = this.getCandidateRouteIds(targetAgent, mcpAdapter);
      const attemptContext = {
        mcpAdapter,
        requestId: envelope.requestId,
        conversationId: envelope.conversationId,
        taskId: envelope.taskId
      };

      const dispatchOutcome = await this.routeScheduler.dispatchWithSafeFallback(
        envelope,
        candidateRouteIds,
        attemptContext
      );

      const route = dispatchOutcome.routeId || 'none';
      this.routeHistory.push({
        requestId: envelope.requestId,
        toAgent: targetAgent,
        route,
        timestamp: new Date().toISOString()
      });

      const outcome = dispatchOutcome.result ? dispatchOutcome.result.outcome : TransportOutcome.FAILED;
      let returnVal;

      if (outcome === TransportOutcome.DELIVERED_CONFIRMED) {
        envelope.transition(RequestState.COMPLETED);
        returnVal = {
          success: true,
          transport: route,
          route,
          status: route === 'notification' ? 'delivered_notification' : 'completed',
          outcome: TransportOutcome.DELIVERED_CONFIRMED,
          requestId: envelope.requestId,
          latencyMs: Date.now() - startMs,
          state: envelope.state,
          ...(dispatchOutcome.result.details || {})
        };
      } else if (outcome === TransportOutcome.SENT_UNCONFIRMED) {
        envelope.transition(RequestState.PROCESSING);
        returnVal = {
          success: true,
          transport: route,
          route,
          status: 'sent_unconfirmed',
          outcome: TransportOutcome.SENT_UNCONFIRMED,
          fallbackRefused: Boolean(dispatchOutcome.fallbackRefused),
          requestId: envelope.requestId,
          latencyMs: Date.now() - startMs,
          state: envelope.state,
          evidence: dispatchOutcome.result.evidence,
          ...(dispatchOutcome.result.details || {})
        };
      } else {
        envelope.transition(RequestState.FAILED, { error: dispatchOutcome.result?.evidence || 'Dispatch failed' });
        returnVal = {
          success: false,
          transport: route,
          route,
          status: 'failed',
          outcome,
          requestId: envelope.requestId,
          error: dispatchOutcome.result?.evidence || 'All candidate routes failed',
          latencyMs: Date.now() - startMs,
          state: envelope.state
        };
      }

      if (previousFocus) {
        await this.sessionManager.restoreUserFocus(previousFocus);
      }

      return returnVal;
    } catch (err) {
      envelope.transition(RequestState.UNKNOWN, { error: err.message });
      if (previousFocus) {
        try { await this.sessionManager.restoreUserFocus(previousFocus); } catch {}
      }
      return {
        success: false,
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
    const chatgptEngineHealth = await this.chatgptLocalEngine.health();
    const swiftAvailable = this.swiftBridge.isBinaryAvailable();

    return {
      desktopControlPlane: true,
      enabled: this.enabled,
      preferredRoute: this.preferredRoute,
      routes: {
        mcp: { supported: true, preferred: true },
        chatgptLocalEngine: { supported: true, available: chatgptEngineHealth.status === AdapterHealth.AVAILABLE },
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
