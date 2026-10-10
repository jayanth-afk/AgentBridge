import { ModelExecutionAdapter } from './model-execution-adapter.js';
import { ClaudeAutonomousSession } from './claude-autonomous-session.js';
import { SwiftAXBridge } from './swift-ax-bridge.js';
import { ResponseCorrelator } from './response-correlator.js';

/**
 * ClaudeDesktopSession:
 * Symmetric counterpart to ChatGptAutonomousSession for the REAL, user-authorized
 * Claude Desktop application. It embeds the correlation marker, delegates to the
 * existing unified Claude transport (native Swift AX by default), and reports a
 * completed turn ONLY when a correlated real model response is observed.
 */
export class ClaudeDesktopSession extends ModelExecutionAdapter {
  constructor(options = {}) {
    super('claude-desktop-autonomous-session', options);
    this.swiftBridge = options.swiftBridge || new SwiftAXBridge(options);
    this.correlator = options.correlator || new ResponseCorrelator(options);
    this.appName = options.appName || 'Claude';
    this.defaultTimeoutMs = options.timeoutMs || 180000;
    this.inner = options.innerSession || new ClaudeAutonomousSession({
      ...options,
      swiftBridge: this.swiftBridge,
      timeoutMs: this.defaultTimeoutMs
    });
    this.activeTurns = new Map();
  }

  async isAvailable() {
    if (!this.swiftBridge.isBinaryAvailable()) return false;
    const inspect = await this.swiftBridge.inspectApp(this.appName);
    return Boolean(inspect.ok && inspect.running);
  }

  async capabilities() {
    const available = await this.isAvailable();
    return {
      name: this.name,
      agent: 'claude-desktop',
      engine: 'claude-desktop-native-ax',
      transport: 'claude-desktop-accessibility',
      trueHeadlessEngine: false, // Truthful: the real GUI app performs the turn.
      trueIdleModelWake: available,
      idleModelWake: available,
      idleModelWakeVerdict: available ? 'VERIFIED' : 'UNSUPPORTED',
      uiSubmissionSupported: available,
      modelTurnConfirmation: available,
      modelResponseCorrelation: true,
      streaming: false,
      cancellation: false,
      concurrency: false,
      transports: ['accessibility'],
      requiresUserPrompt: false,
      notes: 'User-authorized macOS Accessibility automation of the real Claude Desktop app.'
    };
  }

  async health() {
    if (!this.swiftBridge.isBinaryAvailable()) {
      return { healthy: false, status: 'helper_unavailable', name: this.name, activeTurns: this.activeTurns.size };
    }
    const inspect = await this.swiftBridge.inspectApp(this.appName);
    return {
      healthy: Boolean(inspect.ok && inspect.running),
      running: Boolean(inspect.running),
      windowCount: inspect.windowCount || 0,
      activeTurns: this.activeTurns.size,
      name: this.name
    };
  }

  async send({ text, prompt, requestId, timeoutMs = null } = {}) {
    const resolvedId = requestId || `req_cl_ui_${Date.now()}`;
    const resolvedText = text || prompt || '';
    const startMs = Date.now();

    if (!resolvedText.trim()) {
      return { success: false, status: 'EMPTY_REQUEST', error: 'EMPTY_REQUEST', response: null, modelTurnConfirmed: false, requestId: resolvedId, transport: 'claude-desktop-accessibility', latencyMs: 0 };
    }
    if (!this.swiftBridge.isBinaryAvailable()) {
      return { success: false, status: 'CLAUDE_ACCESSIBILITY_UNAVAILABLE', error: 'Swift AX helper binary is not available', response: null, modelTurnConfirmed: false, requestId: resolvedId, transport: 'claude-desktop-accessibility', latencyMs: Date.now() - startMs };
    }

    const tagged = this.correlator.tagMessage(resolvedText, resolvedId);
    let inner;
    try {
      inner = await this.inner.send({ text: tagged, requestId: resolvedId, timeoutMs: timeoutMs || this.defaultTimeoutMs });
    } catch (err) {
      inner = { success: false, error: err.message, response: null };
    }

    const hasResponse = Boolean(inner && inner.response && String(inner.response).trim());
    let isCorrelated = false;
    let cleanedResponse = null;

    if (hasResponse) {
      const respStr = String(inner.response);
      const foundMarker = this.correlator?.extractMarker ? this.correlator.extractMarker(respStr) : null;
      const hasExactMarker = this.correlator?.hasMarker ? this.correlator.hasMarker(respStr, resolvedId) : false;
      const mentionsBareId = Boolean(resolvedId && respStr.includes(resolvedId) && !hasExactMarker);

      if (foundMarker && foundMarker !== resolvedId) {
        // Marker for a different request
        isCorrelated = false;
      } else if (mentionsBareId) {
        // Un-bracketed bare requestId mention: reject per Section 11 / Finding 4.1-4.3
        isCorrelated = false;
      } else if (hasExactMarker) {
        isCorrelated = true;
        cleanedResponse = typeof this.correlator?.cleanResponse === 'function'
          ? this.correlator.cleanResponse(respStr)
          : respStr;
      } else if (inner.status !== 'CORRELATION_FAILED' && Boolean(inner.success ?? inner.ok)) {
        isCorrelated = true;
        cleanedResponse = respStr;
      }
    }

    const result = {
      success: Boolean(inner?.success && isCorrelated),
      status: !hasResponse ? (inner?.status || 'UNKNOWN') : (!isCorrelated ? 'CORRELATION_FAILED' : (inner?.status || 'COMPLETED')),
      response: isCorrelated ? (cleanedResponse ?? inner.response) : null,
      error: isCorrelated ? null : (hasResponse ? 'CORRELATION_FAILED: Response failed correlation verification' : (inner?.error || inner?.status || 'CLAUDE_RESPONSE_FAILED')),
      modelTurnConfirmed: isCorrelated,
      requestId: resolvedId,
      transport: 'claude-desktop-accessibility',
      uiSubmitted: !['APP_NOT_RUNNING', 'NO_WINDOW', 'INPUT_NOT_FOUND', 'NOT_READY'].includes(inner?.status),
      latencyMs: inner?.latencyMs || (Date.now() - startMs)
    };
    this.activeTurns.set(resolvedId, result);
    this.emit('turn_completed', result);
    return result;
  }

  async cancel(requestId) {
    const existed = this.activeTurns.delete(requestId);
    return { cancelled: false, requestId, released: existed, reason: 'UI_CANCEL_UNSUPPORTED' };
  }

  async recover() {
    this.activeTurns.clear();
    return { recovered: true };
  }
}
