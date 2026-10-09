import EventEmitter from 'node:events';
import { probeApplicationUI } from '../../tools/mac-ui-probe/probe.js';

export const ObserverState = Object.freeze({
  IDLE: 'IDLE',
  REQUEST_SENT: 'REQUEST_SENT',
  ASSISTANT_STARTED: 'ASSISTANT_STARTED',
  ASSISTANT_STREAMING: 'ASSISTANT_STREAMING',
  ASSISTANT_COMPLETED: 'ASSISTANT_COMPLETED',
  ASSISTANT_FAILED: 'ASSISTANT_FAILED',
  TIMEOUT: 'TIMEOUT'
});

/**
 * ResponseObserver:
 * Event-driven response detection and streaming aggregator for macOS AI clients.
 * Emits response_started, response_delta, and response_completed events.
 * Intelligently chunks/aggregates text deltas to prevent flooding model context.
 */
export class ResponseObserver extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.pollIntervalMs = options.pollIntervalMs || 600;
    this.deltaAggregationThreshold = options.deltaAggregationThreshold || 40; // min characters for delta
    this.activeObservations = new Map(); // requestId -> observationState
    // Injectable UI probe. Defaults to the real accessibility probe; tests and
    // embedding hosts may supply a deterministic probe so completion detection
    // and delivery can be verified without the live desktop applications.
    this.probe = options.probe || probeApplicationUI;
  }

  /**
   * Begin observing target application for a response to requestId.
   */
  startObservation({ targetApp, requestId, timeoutMs = 25000 }) {
    if (this.activeObservations.has(requestId)) {
      return this.activeObservations.get(requestId);
    }

    const obs = {
      requestId,
      targetApp,
      state: ObserverState.REQUEST_SENT,
      startTime: Date.now(),
      timeoutMs,
      lastText: '',
      timer: null,
      completed: false
    };

    this.activeObservations.set(requestId, obs);
    this.emit('response_state', { requestId, state: ObserverState.REQUEST_SENT });

    obs.timer = setInterval(async () => {
      await this._pollTick(obs);
    }, this.pollIntervalMs);

    return obs;
  }

  async _pollTick(obs) {
    if (obs.completed) return;

    if (Date.now() - obs.startTime > obs.timeoutMs) {
      this._finish(obs, ObserverState.TIMEOUT, { error: 'RESPONSE_TIMEOUT' });
      return;
    }

    try {
      const probe = await this.probe(obs.targetApp);
      if (!probe.running || !probe.textRegions || probe.textRegions.length === 0) {
        return;
      }

      // Locate marker snippet [Agent Bridge <requestId>]
      const markerIdx = probe.textRegions.findIndex(r => r.snippet && r.snippet.includes(obs.requestId));
      if (markerIdx < 0) {
        return; // Marker not yet visible in UI text tree
      }

      // Any text regions appearing after marker belong to assistant response
      const followingRegions = probe.textRegions.slice(markerIdx + 1);
      const currentFullText = followingRegions.map(r => r.snippet).join('\n').trim();

      if (currentFullText.length > 0 && obs.state === ObserverState.REQUEST_SENT) {
        obs.state = ObserverState.ASSISTANT_STARTED;
        this.emit('response_started', { requestId: obs.requestId, targetApp: obs.targetApp });
        this.emit('response_state', { requestId: obs.requestId, state: ObserverState.ASSISTANT_STARTED });
      }

      if (currentFullText.length > obs.lastText.length) {
        const delta = currentFullText.slice(obs.lastText.length);
        obs.state = ObserverState.ASSISTANT_STREAMING;
        obs.lastText = currentFullText;

        // Emit aggregated delta
        if (delta.length >= this.deltaAggregationThreshold || followingRegions.length > 1) {
          this.emit('response_delta', {
            requestId: obs.requestId,
            delta,
            accumulatedLength: currentFullText.length
          });
        }
      } else if (currentFullText.length > 0 && currentFullText === obs.lastText && obs.state === ObserverState.ASSISTANT_STREAMING) {
        // Text has stabilized across ticks -> assistant has completed generation
        this._finish(obs, ObserverState.ASSISTANT_COMPLETED, {
          response: currentFullText,
          durationMs: Date.now() - obs.startTime
        });
      }
    } catch (err) {
      // Non-fatal error during tick, continue polling until timeout
    }
  }

  _finish(obs, finalState, details = {}) {
    if (obs.completed) return;
    obs.completed = true;
    obs.state = finalState;
    if (obs.timer) clearInterval(obs.timer);
    this.activeObservations.delete(obs.requestId);

    this.emit('response_state', { requestId: obs.requestId, state: finalState, ...details });
    if (finalState === ObserverState.ASSISTANT_COMPLETED) {
      this.emit('response_completed', {
        requestId: obs.requestId,
        targetApp: obs.targetApp,
        response: details.response || obs.lastText,
        durationMs: details.durationMs
      });
    } else if (finalState === ObserverState.TIMEOUT || finalState === ObserverState.ASSISTANT_FAILED) {
      this.emit('response_failed', {
        requestId: obs.requestId,
        error: details.error || 'OBSERVATION_FAILED'
      });
    }
  }

  cancel(requestId) {
    if (this.activeObservations.has(requestId)) {
      const obs = this.activeObservations.get(requestId);
      this._finish(obs, ObserverState.ASSISTANT_FAILED, { error: 'CANCELLED_BY_CALLER' });
      return true;
    }
    return false;
  }
}
