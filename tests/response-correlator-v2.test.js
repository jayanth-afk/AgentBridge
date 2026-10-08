import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ResponseCorrelatorV2,
  CorrelationTier,
  CorrelationConfidence
} from '../src/correlation/response-correlator-v2.js';

test('ResponseCorrelatorV2: Evidence-Backed Correlation Tiers', async (t) => {
  const correlator = new ResponseCorrelatorV2();

  await t.test('1. Nonce Generation & Embedding', () => {
    const nonce = correlator.generateNonce('req_1', 'att_1', 1, 'route_test');
    assert.ok(nonce.startsWith('ABN-'));
    assert.equal(nonce.length, 20); // 'ABN-' + 16 hex chars

    const tagged = correlator.embedNonceInPrompt('Execute plan', nonce);
    assert.ok(tagged.includes(nonce));

    const extracted = correlator.extractNonce(tagged);
    assert.equal(extracted, nonce);
  });

  await t.test('2. Tier 1: Authenticated Tool Call yields VERIFIED confidence', () => {
    const res = correlator.correlate({
      requestId: 'req_1',
      attemptId: 'att_1',
      epoch: 1,
      rawResponse: 'Task completed cleanly',
      isAuthenticatedToolCall: true
    });

    assert.equal(res.tier, CorrelationTier.TIER_1_AUTHENTICATED_TOOL_CALL);
    assert.equal(res.confidence, CorrelationConfidence.VERIFIED);
    assert.equal(res.isAcceptableForSuccess(), true);
  });

  await t.test('3. Tier 2: Structured Stream yields VERIFIED confidence', () => {
    const res = correlator.correlate({
      requestId: 'req_1',
      attemptId: 'att_1',
      epoch: 1,
      rawResponse: JSON.stringify({ message: 'JSONL result' }),
      isStructuredStream: true
    });

    assert.equal(res.tier, CorrelationTier.TIER_2_STRUCTURED_STREAM);
    assert.equal(res.confidence, CorrelationConfidence.VERIFIED);
    assert.equal(res.isAcceptableForSuccess(), true);
  });

  await t.test('4. Tier 3: Nonce Token Echo yields VERIFIED confidence', () => {
    const nonce = correlator.generateNonce('req_2', 'att_2', 1, 'route_ax');
    const rawText = `Here is the architectural review.\n\n<!-- [AgentBridge Correlation: ${nonce}] -->\nLGTM.`;

    const res = correlator.correlate({
      requestId: 'req_2',
      attemptId: 'att_2',
      epoch: 1,
      expectedNonce: nonce,
      rawResponse: rawText
    });

    assert.equal(res.tier, CorrelationTier.TIER_3_NONCE_TOKEN_ECHO);
    assert.equal(res.confidence, CorrelationConfidence.VERIFIED);
    assert.equal(res.isAcceptableForSuccess(), true);
    assert.equal(res.cleanedResponse, 'Here is the architectural review.\n\nLGTM.');
  });

  await t.test('5. Tier 4: Scoped UI Delta is marked UNVERIFIED (demoted UI authority)', () => {
    const res = correlator.correlate({
      requestId: 'req_3',
      attemptId: 'att_3',
      epoch: 1,
      rawResponse: 'Scraped UI text from window',
      uiDeltaSnapshot: { hasNewMessage: true, isAmbiguous: false }
    });

    assert.equal(res.tier, CorrelationTier.TIER_4_SCOPED_UI_DELTA);
    assert.equal(res.confidence, CorrelationConfidence.UNVERIFIED);
    // Hard Invariant 10: UI scraping is never equivalent to trusted execution
    assert.equal(res.isAcceptableForSuccess(), false);
  });

  await t.test('6. Ambiguous UI Delta is strictly AMBIGUOUS', () => {
    const res = correlator.correlate({
      requestId: 'req_4',
      attemptId: 'att_4',
      epoch: 1,
      rawResponse: 'Ambiguous text',
      uiDeltaSnapshot: { hasNewMessage: true, isAmbiguous: true }
    });

    assert.equal(res.confidence, CorrelationConfidence.AMBIGUOUS);
    assert.equal(res.isAcceptableForSuccess(), false);
  });
});
