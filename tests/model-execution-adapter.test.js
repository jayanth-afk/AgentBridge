import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ModelExecutionRegistry,
  ChatGptModelAdapter,
  ClaudeModelAdapter,
  AntigravityModelAdapter
} from '../src/control-plane/model-execution-adapter.js';

test('Unified ModelExecutionAdapter Contract Suite', async (t) => {
  const registry = new ModelExecutionRegistry();

  await t.test('1. Registry discovers and registers all 3 core model agents', () => {
    const caps = registry.allCapabilities();
    assert.ok(caps.chatgpt);
    assert.ok(caps.claude);
    assert.ok(caps.antigravity);

    assert.equal(caps.chatgpt.engine, 'codex-cli');
    assert.equal(caps.chatgpt.trueIdleModelWake, true);
    assert.equal(caps.chatgpt.trueHeadlessEngine, true);

    assert.equal(caps.claude.engine, 'claude-desktop');
    assert.equal(caps.claude.trueIdleModelWake, true);
    assert.equal(caps.claude.trueHeadlessEngine, false);
    assert.equal(caps.claude.uiSubmissionSupported, true);

    assert.equal(caps.antigravity.engine, 'autonomous-worker');
    assert.equal(caps.antigravity.trueIdleModelWake, true);
    assert.equal(caps.antigravity.trueHeadlessEngine, true);
  });

  await t.test('2. Target resolution by fuzzy and exact agent name', () => {
    const a1 = registry.getAdapter('chatgpt');
    assert.ok(a1 instanceof ChatGptModelAdapter);

    const a2 = registry.getAdapter('ChatGPT Desktop');
    assert.ok(a2 instanceof ChatGptModelAdapter);

    const a3 = registry.getAdapter('Claude');
    assert.ok(a3 instanceof ClaudeModelAdapter);

    const a4 = registry.getAdapter('claude-desktop');
    assert.ok(a4 instanceof ClaudeModelAdapter);

    const a5 = registry.getAdapter('antigravity');
    assert.ok(a5 instanceof AntigravityModelAdapter);

    const none = registry.getAdapter('unknown-ai');
    assert.equal(none, null);
  });

  await t.test('3. Health reporting across all unified adapters', async () => {
    const health = await registry.allHealth();
    assert.ok(health.chatgpt);
    assert.ok(health.claude);
    assert.ok(health.antigravity);
    assert.equal(health.antigravity.healthy, true);
  });

  await t.test('4. Antigravity worker execution via ModelExecutionAdapter', async () => {
    const adapter = registry.getAdapter('antigravity');
    const res = await adapter.send({
      prompt: 'Execute prime factorization of 851',
      requestId: 'req_ag_test_01'
    });

    assert.equal(res.success, true);
    assert.equal(res.modelTurnConfirmed, true);
    assert.ok(res.response.includes('851'));
    assert.ok(res.latencyMs >= 0);
  });

  await t.test('5. Cancellation and recovery contract', async () => {
    const adapter = registry.getAdapter('antigravity');
    const cancelRes = await adapter.cancel('req_ag_test_01');
    assert.equal(cancelRes.cancelled, true);

    const recRes = await adapter.recover();
    assert.equal(recRes.recovered, true);
  });
});
