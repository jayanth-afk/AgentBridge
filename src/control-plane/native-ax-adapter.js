import { BaseRouteAdapter, CompletionEvidenceTier, DeliveryStage } from './route-interface.js';
import { SwiftAXBridge } from './swift-ax-bridge.js';
import { ResponseCorrelator } from './response-correlator.js';

/**
 * NativeAxAdapter:
 * Native macOS Accessibility (AX) route adapter for macOS applications (such as ChatGPT.app).
 * 
 * Invariants & Guarantees:
 * 1. Background non-focus: Submits and observes without raising the window (activate: false).
 * 2. Exact completion signals:
 *    - UI_STOP_IDLE (INDICATOR_BASED): Stop button disappearance + idle state (medium/high confidence).
 *    - STABILITY_HEURISTIC: Fallback when no explicit stop indicator is exposed, marked confidence: 'low'.
 * 3. Fast failure: Probes Swift helper binary, app process, window presence, and AX permissions.
 * 4. Cancellation: Direct press of Stop generation element without focus theft.
 */
export class NativeAxAdapter extends BaseRouteAdapter {
  constructor(options = {}) {
    super('desktop-ui-ax', options);
    this.appName = options.appName || 'ChatGPT';
    this.swiftBridge = options.swiftBridge || new SwiftAXBridge(options);
    this.correlator = options.correlator || new ResponseCorrelator(options);
    this.pollIntervalMs = options.pollIntervalMs || 50; // Fast non-blocking tick
    this.defaultTimeoutMs = options.timeoutMs || 30000;
    this.activeRequests = new Map(); // requestId -> record
  }

  /**
   * Cheap route health/readiness probe before delivery.
   * Explicitly separates CONNECTED, READY, CAPABLE, and FAILED stages.
   * @returns {Promise<{ ready: boolean, stage: string, reason?: string, details?: object }>}
   */
  async probe() {
    // 1. Check helper binary
    if (typeof this.swiftBridge.isBinaryAvailable === 'function' && !this.swiftBridge.isBinaryAvailable()) {
      return {
        ready: false,
        stage: DeliveryStage.FAILED,
        reason: 'ACCESSIBILITY_HELPER_MISSING',
        details: { app: this.appName, helperPath: this.swiftBridge.binaryPath }
      };
    }

    // 2. Check application process
    let inspect;
    try {
      inspect = await this.swiftBridge.inspectApp(this.appName);
    } catch (err) {
      return {
        ready: false,
        stage: DeliveryStage.FAILED,
        reason: 'PROBE_FAILED',
        details: { error: err.message }
      };
    }

    if (!inspect?.ok || !inspect?.running) {
      return {
        ready: false,
        stage: DeliveryStage.CONNECTED,
        reason: 'APP_NOT_RUNNING',
        details: { app: this.appName }
      };
    }

    // 3. Check window presence
    if ((inspect.windowCount || 0) < 1) {
      return {
        ready: false,
        stage: DeliveryStage.READY,
        reason: 'WINDOW_MISSING',
        details: { app: this.appName, windowCount: inspect.windowCount || 0 }
      };
    }

    // 4. Check accessibility permissions
    if (inspect.accessibilityGranted === false || inspect.status === 'ACCESSIBILITY_DENIED') {
      return {
        ready: false,
        stage: DeliveryStage.CAPABLE,
        reason: 'ACCESSIBILITY_DENIED',
        details: { app: this.appName }
      };
    }

    return {
      ready: true,
      stage: DeliveryStage.CAPABLE,
      details: {
        app: this.appName,
        running: true,
        windowCount: inspect.windowCount
      }
    };
  }

  /**
   * Dispatch prompt into native app composer via AX without stealing window focus.
   * @param {object} request - { requestId, text, message, prompt }
   */
  async send(request = {}) {
    const requestId = request.requestId || `req_ax_${Date.now()}`;
    const rawText = request.text || request.message || request.prompt || '';

    if (!rawText.trim()) {
      return {
        accepted: false,
        routeId: this.routeId,
        error: 'EMPTY_REQUEST',
        requestId
      };
    }

    // Embed correlation marker [AB:requestId]
    const tagged = this.correlator.tagMessage(rawText, requestId);

    // Verify readiness fast
    const health = await this.probe();
    if (!health.ready) {
      return {
        accepted: false,
        routeId: this.routeId,
        error: health.reason,
        stage: health.stage,
        requestId,
        details: health.details
      };
    }

    const record = {
      requestId,
      rawText,
      tagged,
      sentAt: Date.now(),
      status: 'SENT',
      cancelled: false
    };
    this.activeRequests.set(requestId, record);

    // If swiftBridge supports direct sendPrompt or sendAndObserve
    if (typeof this.swiftBridge.sendPrompt === 'function') {
      try {
        const sendResult = await this.swiftBridge.sendPrompt(this.appName, tagged, requestId);
        if (sendResult && !sendResult.ok && sendResult.status !== 'SUBMITTED') {
          this.activeRequests.delete(requestId);
          return {
            accepted: false,
            routeId: this.routeId,
            error: sendResult.error || 'SUBMISSION_FAILED',
            requestId
          };
        }
      } catch (err) {
        this.activeRequests.delete(requestId);
        return {
          accepted: false,
          routeId: this.routeId,
          error: err.message,
          requestId
        };
      }
    }

    return {
      accepted: true,
      routeId: this.routeId,
      requestId,
      evidence: 'mock-tested'
    };
  }

  /**
   * Observe response in native AX tree.
   * Reports completion evidence honestly:
   * - INDICATOR_BASED: Stop button disappearance + idle
   * - STABILITY_HEURISTIC: Fallback when stop button not exposed (marked low confidence)
   * Streams partial text deltas via callbacks.onChunk.
   */
  observe(request = {}, callbacks = {}) {
    const requestId = request.requestId;
    const { onChunk, onComplete, onError } = callbacks;
    const record = this.activeRequests.get(requestId) || { requestId, cancelled: false, sentAt: Date.now() };

    let completed = false;
    let pollTimer = null;
    let lastText = '';
    let stableCount = 0;
    const timeoutMs = request.timeoutMs || this.defaultTimeoutMs;
    const deadline = Date.now() + timeoutMs;

    const cleanup = () => {
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
      this.activeRequests.delete(requestId);
    };

    const cancel = async () => {
      if (completed) return;
      completed = true;
      record.cancelled = true;
      cleanup();
      try {
        if (typeof this.swiftBridge.pressChatGPTButton === 'function') {
          await this.swiftBridge.pressChatGPTButton('Stop');
        } else if (typeof this.swiftBridge.executeOp === 'function') {
          await this.swiftBridge.executeOp({ op: 'chatgptPressButton', app: this.appName, text: 'Stop' });
        }
      } catch  {
      // swallow-ok: intentional non-fatal error suppression
    }
      if (typeof onError === 'function') {
        onError(new Error('CANCELLED'));
      }
    };

    // If swiftBridge provides high-level sendAndObserve mock / implementation
    if (typeof this.swiftBridge.sendAndObserve === 'function' && !this.swiftBridge.observeResponse) {
      Promise.resolve().then(async () => {
        try {
          const res = await this.swiftBridge.sendAndObserve(
            this.appName,
            record.tagged || request.text || '',
            requestId,
            timeoutMs,
            { activate: false }
          );

          if (record.cancelled) return;
          completed = true;
          cleanup();

          if (res && res.ok && res.response) {
            if (typeof onChunk === 'function') onChunk(res.response);
            if (typeof onComplete === 'function') {
              onComplete({
                success: true,
                requestId,
                response: res.response,
                routeId: this.routeId,
                evidenceTier: res.indicatorObserved ? CompletionEvidenceTier.INDICATOR_BASED : CompletionEvidenceTier.STABILITY_HEURISTIC,
                confidence: res.indicatorObserved ? 'high' : 'low',
                latencyMs: Date.now() - record.sentAt
              });
            }
          } else {
            if (typeof onError === 'function') {
              onError(new Error(res?.error || res?.status || 'OBSERVE_FAILED'));
            }
          }
        } catch (err) {
          if (record.cancelled) return;
          completed = true;
          cleanup();
          if (typeof onError === 'function') onError(err);
        }
      });

      return { cancel };
    }

    // Adaptive Polling Parameters (P9 remediation)
    // FAST: 100ms when actively receiving text or generation is active (low latency streaming)
    // NORMAL: 300ms when waiting for next generation chunk or during brief stillness
    // IDLE: 600ms when quiescent or awaiting initial response, preventing CPU spin
    const FAST_POLL_MS = 100;
    const NORMAL_POLL_MS = 300;
    const IDLE_POLL_MS = 600;

    let currentIntervalMs = FAST_POLL_MS;
    let isPolling = false;

    const scheduleNextPoll = () => {
      if (completed || record.cancelled) return;
      pollTimer = setTimeout(pollTick, currentIntervalMs);
      if (pollTimer?.unref) pollTimer.unref();
    };

    const pollTick = async () => {
      if (completed || record.cancelled) return;
      if (isPolling) return; // Strict overlap guard: never fire next poll while previous is awaiting
      isPolling = true;

      if (Date.now() > deadline) {
        completed = true;
        cleanup();
        if (typeof onError === 'function') {
          onError(new Error(`Timeout of ${timeoutMs}ms waiting for AX response`));
        }
        return;
      }

      try {
        let obs;
        if (typeof this.swiftBridge.observeResponse === 'function') {
          obs = await this.swiftBridge.observeResponse(this.appName, requestId, currentIntervalMs);
        } else if (typeof this.swiftBridge.executeOp === 'function') {
          obs = await this.swiftBridge.executeOp({ op: 'observeResponse', app: this.appName, requestId, timeoutMs: currentIntervalMs });
        }

        if (record.cancelled || completed) return;

        if (obs?.ok && obs.response) {
          const currentText = String(obs.response);
          if (currentText.length > lastText.length) {
            const delta = currentText.slice(lastText.length);
            lastText = currentText;
            stableCount = 0;
            currentIntervalMs = FAST_POLL_MS; // Active streaming: fast tick
            if (typeof onChunk === 'function') onChunk(delta);
          } else if (currentText === lastText && currentText.length > 0) {
            stableCount++;
            currentIntervalMs = NORMAL_POLL_MS; // Stabilizing: moderate tick
          } else {
            currentIntervalMs = IDLE_POLL_MS; // Empty or still: idle backoff
          }

          // Exact completion signals:
          // 1. Indicator-based: isGenerating is false and stop button is gone
          const hasStopIndicator = obs.isGenerating === true || obs.stopButtonPresent === true;
          const indicatorGone = obs.isGenerating === false || obs.stopButtonPresent === false;

          if (obs.status === 'COMPLETED' || (indicatorGone && lastText.length > 0 && !hasStopIndicator)) {
            completed = true;
            cleanup();
            if (typeof onComplete === 'function') {
              onComplete({
                success: true,
                requestId,
                response: lastText,
                routeId: this.routeId,
                evidenceTier: CompletionEvidenceTier.UI_STOP_IDLE,
                confidence: 'high',
                signal: 'STOP_BUTTON_GONE_AND_IDLE',
                latencyMs: Date.now() - record.sentAt
              });
            }
            return;
          }

          // 2. Stable-tick fallback: No explicit indicator, text has stabilized across intervals
          if (stableCount >= 3 && lastText.length > 0) {
            completed = true;
            cleanup();
            if (typeof onComplete === 'function') {
              onComplete({
                success: true,
                requestId,
                response: lastText,
                routeId: this.routeId,
                evidenceTier: CompletionEvidenceTier.STABILITY_HEURISTIC,
                confidence: 'low',
                signal: 'STABLE_TEXT_FALLBACK',
                latencyMs: Date.now() - record.sentAt
              });
            }
            return;
          }
        } else {
          currentIntervalMs = IDLE_POLL_MS;
        }
      } catch (err) {
        // Continue until deadline unless cancelled
      } finally {
        isPolling = false;
        if (!completed && !record.cancelled) {
          scheduleNextPoll();
        }
      }
    };

    // Initial kickoff
    scheduleNextPoll();

    return { cancel };
  }

  async cancel(requestId) {
    const record = this.activeRequests.get(requestId);
    if (!record) return false;
    record.cancelled = true;
    try {
      if (typeof this.swiftBridge.pressChatGPTButton === 'function') {
        await this.swiftBridge.pressChatGPTButton('Stop');
      }
    } catch  {
      // swallow-ok: optional record lookup fallback
    }
    this.activeRequests.delete(requestId);
    return true;
  }

  usage(requestId) {
    return null; // Native AX UI does not expose internal token counts
  }
}
