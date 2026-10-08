/**
 * Standard Transport Outcomes
 * Guarantees truthful delivery reporting across all adapters.
 */
export const TransportOutcome = Object.freeze({
  DELIVERED_CONFIRMED: 'DELIVERED_CONFIRMED', // Definitive proof message reached agent
  SENT_UNCONFIRMED: 'SENT_UNCONFIRMED',       // Dispatched over uncertain channel (e.g. UI keystrokes, no ACK yet)
  NOT_SENT: 'NOT_SENT',                       // Pre-flight check failed before transmission
  UNSUPPORTED: 'UNSUPPORTED',                 // Capability unsupported by this transport
  FAILED: 'FAILED'                            // Definitive transmission failure
});

/**
 * Structured outcome returned by every transport send operation
 */
export class TransportResult {
  constructor({
    outcome,
    routeId,
    attemptId = null,
    epoch = null,
    nonce = null,
    evidence = null,
    nonDeliveryProven = false,
    details = {}
  }) {
    if (!Object.values(TransportOutcome).includes(outcome)) {
      throw new Error(`Invalid TransportOutcome: ${outcome}`);
    }
    this.outcome = outcome;
    this.routeId = routeId;
    this.attemptId = attemptId;
    this.epoch = epoch;
    this.nonce = nonce;
    this.evidence = evidence;
    this.nonDeliveryProven = nonDeliveryProven;
    this.details = details;
    this.timestamp = new Date().toISOString();
  }

  /**
   * CRITICAL INVARIANT: Blind fallback rule.
   * If SENT_UNCONFIRMED or DELIVERED_CONFIRMED, fallback is STRICTLY FORBIDDEN
   * to prevent duplicate model turns and duplicate side effects.
   */
  canFallback() {
    if (this.outcome === TransportOutcome.NOT_SENT) return true;
    if (this.outcome === TransportOutcome.UNSUPPORTED) return true;
    if (this.outcome === TransportOutcome.FAILED && this.nonDeliveryProven) return true;
    return false;
  }
}

/**
 * Base transport adapter defining the unified contract
 */
export class BaseTransportAdapter {
  constructor(routeId, options = {}) {
    this.routeId = routeId;
    this.options = options;
  }

  async probe(context = {}) {
    throw new Error(`probe() not implemented for transport '${this.routeId}'`);
  }

  async send(envelope, attemptContext = {}) {
    throw new Error(`send() not implemented for transport '${this.routeId}'`);
  }

  async observe(envelope, attemptContext = {}) {
    return { observed: false, routeId: this.routeId, reason: 'Observation not implemented' };
  }

  async cancel(attemptContext = {}) {
    return { cancelled: false, routeId: this.routeId, reason: 'Cancel not implemented' };
  }
}

/**
 * Safe Route Scheduler
 * Selects optimal verified route and strictly enforces fallback safety rules.
 */
export class SafeRouteScheduler {
  constructor({ capabilityRegistry, auditLogger = null }) {
    this.capabilities = capabilityRegistry;
    this.logger = auditLogger;
    this.adapters = new Map(); // routeId -> adapter
  }

  registerTransport(routeId, adapter) {
    this.adapters.set(routeId, adapter);
  }

  /**
   * Dispatches envelope through the highest-trust candidate route.
   * Enforces that uncertain sends NEVER blindly fall back to alternative routes.
   */
  async dispatchWithSafeFallback(envelope, candidateRouteIds, attemptContext = {}) {
    const dispatchTrace = [];

    for (let i = 0; i < candidateRouteIds.length; i++) {
      const routeId = candidateRouteIds[i];
      const adapter = this.adapters.get(routeId);

      if (!adapter) {
        dispatchTrace.push({ routeId, outcome: TransportOutcome.UNSUPPORTED, reason: 'Adapter not registered' });
        continue;
      }

      const t0 = Date.now();
      let result;
      try {
        result = await adapter.send(envelope, attemptContext);
      } catch (err) {
        result = new TransportResult({
          outcome: TransportOutcome.FAILED,
          routeId,
          attemptId: attemptContext.attemptId,
          epoch: attemptContext.epoch,
          nonDeliveryProven: false,
          evidence: err.message
        });
      }

      dispatchTrace.push({
        routeId,
        outcome: result.outcome,
        latencyMs: Date.now() - t0,
        evidence: result.evidence
      });

      this.logger?.log({
        agentId: envelope.toAgent,
        action: 'route_dispatch_attempt',
        status: result.outcome,
        details: { routeId, attemptId: attemptContext.attemptId, outcome: result.outcome }
      });

      // 1. Success confirmed -> Return immediately, do not fall back!
      if (result.outcome === TransportOutcome.DELIVERED_CONFIRMED) {
        return {
          result,
          routeId,
          finalStatus: 'DELIVERED',
          dispatchTrace
        };
      }

      // 2. Sent unconfirmed -> Invariant: STOP! NEVER blindly resend through another route!
      if (result.outcome === TransportOutcome.SENT_UNCONFIRMED) {
        this.logger?.log({
          agentId: envelope.toAgent,
          action: 'blind_fallback_refused',
          status: 'reconciling',
          details: {
            routeId,
            reason: 'Result is SENT_UNCONFIRMED. Fallback refused to prevent duplicate model actions.'
          }
        });

        return {
          result,
          routeId,
          finalStatus: 'SENT_UNCONFIRMED_AWAITING_RECONCILIATION',
          fallbackRefused: true,
          dispatchTrace
        };
      }

      // 3. Check if fallback to next candidate route is permitted
      if (!result.canFallback()) {
        return {
          result,
          routeId,
          finalStatus: 'DELIVERY_UNCERTAIN_NO_FALLBACK',
          fallbackRefused: true,
          dispatchTrace
        };
      }

      // 4. Fallback is safely allowed (e.g. NOT_SENT or UNSUPPORTED) -> proceed to next route
      this.logger?.log({
        agentId: envelope.toAgent,
        action: 'route_fallback_allowed',
        status: 'fallback',
        details: { fromRoute: routeId, outcome: result.outcome, nextIndex: i + 1 }
      });
    }

    return {
      result: new TransportResult({
        outcome: TransportOutcome.FAILED,
        routeId: 'none',
        evidence: 'All candidate routes exhausted'
      }),
      routeId: null,
      finalStatus: 'ALL_ROUTES_EXHAUSTED',
      dispatchTrace
    };
  }
}
