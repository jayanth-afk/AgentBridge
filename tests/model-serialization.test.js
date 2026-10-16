import test from 'node:test';
import assert from 'node:assert/strict';

import { serializeModelResult, serializeModelError } from '../src/utils/model-serializer.js';
import { HonestTokenizer } from '../src/tokenizer/honest-tokenizer.js';

// Model-facing tool results are pasted into a host model's prompt, so the bridge
// serializes them as compact JSON. These tests pin the two properties that make
// that safe (information-preserving, whitespace-only) and the size benefit that
// makes it worthwhile.

test('Model serialization: compact result is a whitespace-only transform', async (t) => {
  const representative = {
    ok: true,
    tool: 'bridge_inspect_project',
    files: [
      { path: 'src/index.js', size: 1024, language: 'javascript', symbols: ['main', 'start'] },
      { path: 'src/http-server.js', size: 40960, language: 'javascript', symbols: ['BridgeHttpServer'] }
    ],
    nested: { a: [1, 2, 3], b: { c: null, d: false, e: 'text with, punctuation: and "quotes"' } }
  };

  await t.test('1. Parsed compact JSON is deep-equal to the original value', () => {
    const compact = serializeModelResult(representative);
    assert.deepEqual(JSON.parse(compact), representative);
  });

  await t.test('2. Compact form is strictly smaller than pretty-printed JSON', () => {
    const compact = serializeModelResult(representative);
    const pretty = JSON.stringify(representative, null, 2);
    assert.ok(compact.length < pretty.length, 'compact must be smaller than pretty');
    assert.ok(compact.includes('\n') === false, 'compact JSON must not contain newlines');
  });

  await t.test('3. Strings pass through verbatim (never re-quoted or re-escaped)', () => {
    const raw = 'line one\nline two\t"quoted" — unicode ✓';
    assert.equal(serializeModelResult(raw), raw);
  });

  await t.test('4. undefined normalizes to valid JSON null', () => {
    assert.equal(serializeModelResult(undefined), 'null');
    assert.equal(JSON.parse(serializeModelResult(undefined)), null);
  });

  await t.test('5. Errors are formatted consistently', () => {
    assert.equal(serializeModelError('bridge_ping', new Error('boom')), 'Error executing bridge_ping: boom');
    assert.equal(serializeModelError('bridge_ping', 'plain'), 'Error executing bridge_ping: plain');
  });
});

test('Model serialization: measurable token reduction on a large tool result', async (t) => {
  // A realistic shape for a large tool result: an ordered list of records.
  const records = Array.from({ length: 60 }, (_, i) => ({
    requestId: `req_${String(i).padStart(4, '0')}`,
    fromAgent: 'chatgpt-desktop',
    toAgent: 'claude-desktop',
    status: 'completed',
    hops: i % 4,
    deliveredAt: '2026-10-17T00:00:00.000Z'
  }));
  const result = { totalAvailable: records.length, tools: records };

  const compact = serializeModelResult(result);
  const pretty = JSON.stringify(result, null, 2);

  const compactTokens = HonestTokenizer.countTokens(compact);
  const prettyTokens = HonestTokenizer.countTokens(pretty);
  const reductionPct = (1 - compactTokens / prettyTokens) * 100;

  await t.test('a. Compact JSON retains every field and value', () => {
    assert.deepEqual(JSON.parse(compact), result);
  });

  await t.test('b. Reduction is material (>= 10% of estimated tokens)', () => {
    assert.ok(
      reductionPct >= 10,
      `expected >= 10% estimated token reduction, got ${reductionPct.toFixed(2)}%`
    );
  });
});
