import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TransportOutcome,
  TransportResult,
  BaseTransportAdapter,
  SafeRouteScheduler
} from '../src/transports/transport-contract.js';

class MockAdapter extends BaseTransportAdapter {
  constructor(routeId, outcomeToReturn) {
    super(routeId);
    this.outcomeToReturn = outcomeToReturn;
    this.sendCallCount = 0;
  }

  async send(envelope, attemptContext) {
    this.sendCallCount++;
    return new TransportResult({
      outcome: this.outcomeToReturn,
      routeId: this.routeId,
      attemptId: attemptContext.attemptId,
      epoch: attemptContext.epoch,
      evidence: `Mock response ${this.outcomeToReturn}`
    });
  }
}

test('TransportContract & Fallback Safety Invariant', async (t) => {
  await t.test('1. canFallback() honesty matrix', () => {
    const unconfirmed = new TransportResult({ outcome: TransportOutcome.SENT_UNCONFIRMED, routeId: 'ui' });
    const confirmed = new TransportResult({ outcome: TransportOutcome.DELIVERED_CONFIRMED, routeId: 'engine' });
    const notSent = new TransportResult({ outcome: TransportOutcome.NOT_SENT, routeId: 'cdp' });
    const unsupported = new TransportResult({ outcome: TransportOutcome.UNSUPPORTED, routeId: 'mcp' });

    assert.equal(unconfirmed.canFallback(), false);
    assert.equal(confirmed.canFallback(), false);
    assert.equal(notSent.canFallback(), true);
    assert.equal(unsupported.canFallback(), true);
  });

  await t.test('2. Blind Fallback Refused when Route A is SENT_UNCONFIRMED', async () => {
    const scheduler = new SafeRouteScheduler({ capabilityRegistry: null });
    const adapterA = new MockAdapter('route_a', TransportOutcome.SENT_UNCONFIRMED);
    const adapterB = new MockAdapter('route_b', TransportOutcome.DELIVERED_CONFIRMED);

    scheduler.registerTransport('route_a', adapterA);
    scheduler.registerTransport('route_b', adapterB);

    const outcome = await scheduler.dispatchWithSafeFallback(
      { toAgent: 'chatgpt-desktop', message: 'Hello' },
      ['route_a', 'route_b'],
      { attemptId: 'att_123', epoch: 1 }
    );

    assert.equal(adapterA.sendCallCount, 1);
    // CRITICAL: Route B was NEVER invoked because Route A was unconfirmed!
    assert.equal(adapterB.sendCallCount, 0);
    assert.equal(outcome.fallbackRefused, true);
    assert.equal(outcome.finalStatus, 'SENT_UNCONFIRMED_AWAITING_RECONCILIATION');
  });

  await t.test('3. Fallback safely allowed when Route A is definitively NOT_SENT', async () => {
    const scheduler = new SafeRouteScheduler({ capabilityRegistry: null });
    const adapterA = new MockAdapter('route_a', TransportOutcome.NOT_SENT);
    const adapterB = new MockAdapter('route_b', TransportOutcome.DELIVERED_CONFIRMED);

    scheduler.registerTransport('route_a', adapterA);
    scheduler.registerTransport('route_b', adapterB);

    const outcome = await scheduler.dispatchWithSafeFallback(
      { toAgent: 'claude-desktop', message: 'Hello' },
      ['route_a', 'route_b'],
      { attemptId: 'att_456', epoch: 1 }
    );

    assert.equal(adapterA.sendCallCount, 1);
    assert.equal(adapterB.sendCallCount, 1);
    assert.equal(outcome.finalStatus, 'DELIVERED');
    assert.equal(outcome.routeId, 'route_b');
  });
});
