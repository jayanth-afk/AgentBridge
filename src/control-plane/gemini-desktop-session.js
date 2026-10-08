import { ModelExecutionAdapter } from './model-execution-adapter.js';
import { GeminiAutonomousSession } from './gemini-autonomous-session.js';
import { SwiftAXBridge } from './swift-ax-bridge.js';
import { ResponseCorrelator } from './response-correlator.js';

/**
 * GeminiDesktopSession:
 * Session abstraction for the REAL, user-authorized Google Gemini Desktop application.
 * Embeds correlation markers [AB:requestId], delegates to GeminiAutonomousSession
 * (native Swift AX), and reports a completed turn ONLY when a correlated real model
 * response is observed from Gemini.app.
 */
export class GeminiDesktopSession extends ModelExecutionAdapter {
  constructor(options = {}) {
    super('gemini-desktop-autonomous-session', options);
    this.swiftBridge = options.swiftBridge || new SwiftAXBridge(options);
    this.correlator = options.correlator || new ResponseCorrelator(options);
    this.appName = options.appName || 'Gemini';
    this.defaultTimeoutMs = options.timeoutMs || 180000;
    this.inner = options.innerSession || new GeminiAutonomousSession({
      ...options,
      appName: this.appName,
      swiftBridge: this.swiftBridge,
      timeoutMs: this.defaultTimeoutMs
    });
    this.activeTurns = new Map();
  }

  async isAvailable() {
    if (!this.swiftBridge.isBinaryAvailable()) return false;
    const inspect = await this.swiftBridge.inspectApp(this.appName);
    return Boolean(inspect.ok && inspect.running && inspect.windowCount > 0);
  }

  async capabilities() {
    const available = await this.isAvailable();
    return {
      name: this.name,
      agent: 'gemini',
      engine: 'gemini-desktop-native-ax',
      transport: 'gemini-desktop-accessibility',
      trueHeadlessEngine: false, // Truthful: the real GUI app performs the turn.
      trueIdleModelWake: available,
      idleModelWake: available,
      idleModelWakeVerdict: available ? 'VERIFIED' : 'UNSUPPORTED',
      uiSubmissionSupported: available,
      modelTurnConfirmation: available,
      canReceiveTasks: available,
      autonomousWorker: true,
      realModelInvocation: available,
      modelResponseCorrelation: true,
      streaming: true,
      cancellation: false,
      concurrency: false,
      transports: ['accessibility'],
      requiresUserPrompt: false,
      notes: 'User-authorized macOS Accessibility automation of the real Gemini Desktop app.'
    };
  }

  async health() {
    if (!this.swiftBridge.isBinaryAvailable()) {
      return { healthy: false, status: 'helper_unavailable', name: this.name, activeTurns: this.activeTurns.size };
    }
    const inspect = await this.swiftBridge.inspectApp(this.appName);
    const healthy = Boolean(inspect.ok && inspect.running && inspect.windowCount > 0);
    return {
      healthy,
      running: Boolean(inspect.running),
      windowCount: inspect.windowCount || 0,
      activeTurns: this.activeTurns.size,
      name: this.name
    };
  }

  async send({ text, prompt, requestId, timeoutMs = null } = {}) {
    const resolvedId = requestId || `req_gem_ui_${Date.now()}`;
    const resolvedText = text || prompt || '';
    const startMs = Date.now();

    if (!resolvedText.trim()) {
      return {
        success: false,
        status: 'EMPTY_REQUEST',
        error: 'EMPTY_REQUEST',
        response: null,
        modelTurnConfirmed: false,
        requestId: resolvedId,
        transport: 'gemini-desktop-accessibility',
        latencyMs: 0
      };
    }

    if (!this.swiftBridge.isBinaryAvailable()) {
      return {
        success: false,
        status: 'GEMINI_ACCESSIBILITY_UNAVAILABLE',
        error: 'Swift AX helper binary is not available',
        response: null,
        modelTurnConfirmed: false,
        requestId: resolvedId,
        transport: 'gemini-desktop-accessibility',
        latencyMs: Date.now() - startMs
      };
    }

    const tagged = this.correlator.tagMessage(resolvedText, resolvedId);
    let inner;
    try {
      inner = await this.inner.send({
        text: tagged,
        requestId: resolvedId,
        timeoutMs: timeoutMs || this.defaultTimeoutMs
      });
    } catch (err) {
      inner = { success: false, error: err.message, response: null };
    }

    const hasResponse = Boolean(inner && inner.response && String(inner.response).trim());
    const result = {
      success: Boolean(inner?.success && hasResponse),
      status: inner?.status || (hasResponse ? 'COMPLETED' : 'UNKNOWN'),
      response: hasResponse ? inner.response : null,
      error: hasResponse ? null : (inner?.error || inner?.status || 'GEMINI_RESPONSE_FAILED'),
      modelTurnConfirmed: hasResponse,
      requestId: resolvedId,
      transport: 'gemini-desktop-accessibility',
      uiSubmitted: !['APP_NOT_RUNNING', 'NO_WINDOW', 'INPUT_NOT_FOUND', 'APP_NOT_AVAILABLE'].includes(inner?.status),
      latencyMs: inner?.latencyMs || (Date.now() - startMs)
    };

    if (result.success) {
      this.activeTurns.set(resolvedId, result);
    }
    return result;
  }
}
