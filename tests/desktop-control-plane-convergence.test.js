import test from 'node:test';
import assert from 'node:assert';
import { DesktopControlPlane } from '../src/control-plane/desktop-control-plane.js';
import { SafeRouteScheduler, TransportOutcome, TransportResult } from '../src/transports/transport-contract.js';
import { ResponseCorrelatorV2, CorrelationTier, CorrelationConfidence } from '../src/correlation/response-correlator-v2.js';
import { RequestEnvelope, RequestState } from '../src/protocol/envelope.js';

test('Desktop Control Plane Convergence & Honest Correlation Suite', async (t) => {
  await t.test('1. SafeRouteScheduler actually selects and dispatches through registered route', async () => {
    const scheduler = new SafeRouteScheduler({ capabilityRegistry: null });
    let customRouteDispatched = false;

    scheduler.registerTransport('custom-test-route', {
      send: async (env) => {
        customRouteDispatched = true;
        return new TransportResult({
          outcome: TransportOutcome.DELIVERED_CONFIRMED,
          routeId: 'custom-test-route',
          details: { echo: env.message }
        });
      }
    });

    const plane = new DesktopControlPlane({ routeScheduler: scheduler });
    // Candidate route uses the custom route
    plane.getCandidateRouteIds = () => ['custom-test-route'];

    const res = await plane.dispatch('Test message via scheduler', {
      targetAgent: 'freebuff',
      requestId: 'req_sched_01'
    });

    assert.strictEqual(customRouteDispatched, true);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.route, 'custom-test-route');
    assert.strictEqual(res.outcome, TransportOutcome.DELIVERED_CONFIRMED);
    assert.strictEqual(res.echo, 'Test message via scheduler');
  });

  await t.test('2. ResponseCorrelatorV2 evaluates responses across hierarchy tiers', async () => {
    const correlator = new ResponseCorrelatorV2();
    const nonce = 'ABN-12345678abcdef01';

    // Tier 1: Authenticated tool call
    const t1 = correlator.correlate({
      requestId: 'req_01',
      attemptId: 'att_01',
      epoch: 1,
      isAuthenticatedToolCall: true,
      rawResponse: { result: 'done' }
    });
    assert.strictEqual(t1.tier, CorrelationTier.TIER_1_AUTHENTICATED_TOOL_CALL);
    assert.strictEqual(t1.confidence, CorrelationConfidence.VERIFIED);
    assert.strictEqual(t1.isAcceptableForSuccess(), true);

    // Tier 2: Structured process stream
    const t2 = correlator.correlate({
      requestId: 'req_02',
      attemptId: 'att_02',
      epoch: 1,
      isStructuredStream: true,
      rawResponse: '{"event":"turn_complete"}'
    });
    assert.strictEqual(t2.tier, CorrelationTier.TIER_2_STRUCTURED_STREAM);
    assert.strictEqual(t2.confidence, CorrelationConfidence.VERIFIED);

    // Tier 3: Nonce echo in response text
    const t3 = correlator.correlate({
      requestId: 'req_03',
      expectedNonce: nonce,
      rawResponse: `Here is your result <!-- [AgentBridge Correlation: ${nonce}] -->\nFinished.`
    });
    assert.strictEqual(t3.tier, CorrelationTier.TIER_3_NONCE_TOKEN_ECHO);
    assert.strictEqual(t3.confidence, CorrelationConfidence.VERIFIED);
    assert.ok(t3.cleanedResponse.includes('Here is your result'));
    assert.ok(t3.cleanedResponse.includes('Finished.'));
    assert.ok(!t3.cleanedResponse.includes(nonce));
  });

  await t.test('3. UI scrape response evaluates to UNVERIFIED confidence (never masquerades as verified)', async () => {
    const correlator = new ResponseCorrelatorV2();
    const uiDelta = { hasNewMessage: true, isAmbiguous: false };

    const res = correlator.correlate({
      requestId: 'req_ui_01',
      uiDeltaSnapshot: uiDelta,
      rawResponse: 'The task appears to have been completed in the chat window.'
    });

    assert.strictEqual(res.tier, CorrelationTier.TIER_4_SCOPED_UI_DELTA);
    assert.strictEqual(res.confidence, CorrelationConfidence.UNVERIFIED);
    // Hard invariant: UNVERIFIED is NOT acceptable for terminal success!
    assert.strictEqual(res.isAcceptableForSuccess(), false);
  });

  await t.test('4. Ambiguous UI response evaluates to AMBIGUOUS confidence', async () => {
    const correlator = new ResponseCorrelatorV2();
    const ambiguousSnapshot = { hasNewMessage: true, isAmbiguous: true };

    const res = correlator.correlate({
      requestId: 'req_ui_ambiguous',
      uiDeltaSnapshot: ambiguousSnapshot,
      rawResponse: 'Multiple candidate messages detected in window.'
    });

    assert.strictEqual(res.tier, CorrelationTier.TIER_4_SCOPED_UI_DELTA);
    assert.strictEqual(res.confidence, CorrelationConfidence.AMBIGUOUS);
    assert.strictEqual(res.isAcceptableForSuccess(), false);
  });

  await t.test('5. Authenticated completion is VERIFIED', async () => {
    const correlator = new ResponseCorrelatorV2();
    const res = correlator.correlate({
      requestId: 'req_tool_01',
      attemptId: 'att_01',
      epoch: 1,
      isAuthenticatedToolCall: true,
      rawResponse: { status: 'completed' }
    });

    assert.strictEqual(res.confidence, CorrelationConfidence.VERIFIED);
    assert.strictEqual(res.tier, CorrelationTier.TIER_1_AUTHENTICATED_TOOL_CALL);
    assert.strictEqual(res.isAcceptableForSuccess(), true);
  });

  await t.test('6. Uncertain send (SENT_UNCONFIRMED) strictly refuses blind fallback', async () => {
    const scheduler = new SafeRouteScheduler({ capabilityRegistry: null });
    let fallbackExecuted = false;

    // Route A: UI Keystrokes dispatched (uncertain send)
    scheduler.registerTransport('ui-route', {
      send: async () => new TransportResult({
        outcome: TransportOutcome.SENT_UNCONFIRMED,
        routeId: 'ui-route',
        evidence: 'Keystrokes typed'
      })
    });

    // Route B: Notification fallback (must NOT be called!)
    scheduler.registerTransport('fallback-route', {
      send: async () => {
        fallbackExecuted = true;
        return new TransportResult({
          outcome: TransportOutcome.DELIVERED_CONFIRMED,
          routeId: 'fallback-route'
        });
      }
    });

    const plane = new DesktopControlPlane({ routeScheduler: scheduler });
    plane.getCandidateRouteIds = () => ['ui-route', 'fallback-route'];

    const res = await plane.dispatch('Message', {
      targetAgent: 'freebuff',
      requestId: 'req_uncertain_send'
    });

    // Verification: Fallback route was NEVER executed
    assert.strictEqual(fallbackExecuted, false);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.route, 'ui-route');
    assert.strictEqual(res.outcome, TransportOutcome.SENT_UNCONFIRMED);
    assert.strictEqual(res.fallbackRefused, true);
  });
});
