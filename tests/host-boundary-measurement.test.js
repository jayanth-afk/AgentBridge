import test from 'node:test';
import assert from 'node:assert/strict';

import { runHostBoundaryHarness } from '../scripts/bench/host-boundary-measurement.js';

test('Host-Boundary Measurement Harness Suite (Phase 2)', async (t) => {
  const result = await runHostBoundaryHarness({ port: 9123, iterations: 3 });

  assert.strictEqual(result.success, true);
  assert.ok(Array.isArray(result.matrix));
  assert.strictEqual(result.matrix.length, 5, 'Must evaluate all 5 target integration paths');

  const [sdkRow, mcpRow, claudeRow, agyRow, chatGptRow] = result.matrix;

  // 1. SDK Client
  await t.test('1. SDK Client achieves zero requester model turns and exact verbatim delivery', () => {
    assert.strictEqual(sdkRow.requesterModelTurns, 0, 'SDK caller requires zero model turns');
    assert.strictEqual(sdkRow.isEstimatedTokens, false);
    assert.ok(sdkRow.textEquality.includes('EXACT'));
    assert.ok(sdkRow.reconnectRecovery.includes('VERIFIED'));
  });

  // 2. MCP stdio / HTTP JSON-RPC
  await t.test('2. MCP stdio / HTTP JSON-RPC achieves zero requester turns at transport boundary', () => {
    assert.strictEqual(mcpRow.requesterModelTurns, 0, 'Transport boundary requires zero model turns');
    assert.strictEqual(mcpRow.isEstimatedTokens, false);
    assert.ok(mcpRow.textEquality.includes('EXACT'));
    assert.ok(mcpRow.reconnectRecovery.includes('VERIFIED'));
  });

  // 3. Claude Desktop
  await t.test('3. Claude Desktop honestly records 1 requester model turn with documented limitation', () => {
    assert.strictEqual(claudeRow.requesterModelTurns, 1, 'Claude Desktop runs assistant turn to render tool output');
    assert.strictEqual(claudeRow.isEstimatedTokens, true, 'Flagged as estimated tokens');
    assert.ok(claudeRow.textEquality.includes('HOST-WRAPPED'));
    assert.ok(claudeRow.platformLimitation.length > 20);
    assert.ok(claudeRow.supportedAlternative.length > 20);
  });

  // 4. Antigravity IDE
  await t.test('4. Antigravity IDE honestly records 1 requester model turn with documented limitation', () => {
    assert.strictEqual(agyRow.requesterModelTurns, 1, 'Antigravity IDE runs assistant turn to render observation');
    assert.strictEqual(agyRow.isEstimatedTokens, true);
    assert.ok(agyRow.platformLimitation.length > 20);
  });

  // 5. ChatGPT Desktop UI
  await t.test('5. ChatGPT Desktop UI honestly records 1 requester turn with headless alternative', () => {
    assert.strictEqual(chatGptRow.requesterModelTurns, 1, 'Consumer app runs assistant chat bubble generation');
    assert.strictEqual(chatGptRow.isEstimatedTokens, true);
    assert.ok(chatGptRow.platformLimitation.includes('Accessibility'));
    assert.ok(chatGptRow.supportedAlternative.includes('Headless'));
  });
});
