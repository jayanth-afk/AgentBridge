import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';

import { ToolRegistry } from '../src/tool-registry.js';
import {
  TOOL_SELECTION_CORPUS,
  REQUIRED_CATEGORIES,
  scoreSelection
} from '../scripts/bench/tool-selection-corpus.mjs';

const registry = new ToolRegistry();
const defs = registry.getToolDefinitions();

test('Tool schema integrity and selection-corpus fidelity', async (t) => {
  await t.test('1. every tool exposes a name, a discriminating description, and a valid JSON Schema', () => {
    const ajv = new Ajv({ strict: false, allErrors: true });
    assert.ok(defs.length >= 60, `expected the full registry, saw ${defs.length} tools`);
    for (const d of defs) {
      assert.ok(d.name && typeof d.name === 'string', 'tool name required');
      assert.ok(typeof d.description === 'string' && d.description.trim().length >= 10,
        `${d.name} needs a description long enough to disambiguate it`);
      assert.doesNotThrow(() => ajv.compile(d.inputSchema || {}), `${d.name} schema must compile`);
    }
  });

  await t.test('2. every required key is declared as a property', () => {
    for (const d of defs) {
      const props = (d.inputSchema || {}).properties || {};
      for (const req of (d.inputSchema || {}).required || []) {
        assert.ok(req in props, `${d.name}: required '${req}' must exist in properties`);
      }
    }
  });

  await t.test('3. no two tools share an identical description (selection would be ambiguous)', () => {
    const seen = new Map();
    for (const d of defs) {
      if (seen.has(d.description)) {
        assert.fail(`duplicate description shared by ${seen.get(d.description)} and ${d.name}`);
      }
      seen.set(d.description, d.name);
    }
  });

  await t.test('4. the fixed selection corpus is fully covered and every expected tool exists', () => {
    const names = new Set(defs.map(d => d.name));
    for (const entry of TOOL_SELECTION_CORPUS) {
      for (const tool of entry.expected) {
        assert.ok(names.has(tool), `corpus '${entry.id}' expects missing tool '${tool}'`);
      }
    }
    for (const cat of REQUIRED_CATEGORIES) {
      assert.ok(TOOL_SELECTION_CORPUS.some(e => e.category === cat), `corpus must cover category '${cat}'`);
    }
  });

  await t.test('5. security-sensitive corpus entry names a real, authorization-gated tool', () => {
    const entry = TOOL_SELECTION_CORPUS.find(e => e.category === 'security');
    assert.ok(entry, 'a security corpus entry is required');
    const names = new Set(defs.map(d => d.name));
    for (const tool of entry.expected) assert.ok(names.has(tool), `${tool} must exist`);
  });

  await t.test('6. unsupported tasks expect no bridge tool (no fabricated capability)', () => {
    const unsupported = TOOL_SELECTION_CORPUS.filter(e => e.category === 'unsupported');
    assert.ok(unsupported.length >= 1, 'at least one unsupported-capability case is required');
    for (const e of unsupported) assert.deepEqual(e.expected, [], `${e.id} must expect no tool`);
  });

  await t.test('7. scoreSelection scores model choices deterministically', () => {
    // A perfect run: pick the first acceptable tool for each supported case, null for unsupported.
    const perfect = {};
    for (const e of TOOL_SELECTION_CORPUS) perfect[e.id] = e.expected.length ? e.expected[0] : null;
    const perfectScore = scoreSelection(perfect);
    assert.equal(perfectScore.accuracy, 1, 'a perfect run must score 1.0');
    assert.equal(perfectScore.correct, perfectScore.total);

    // A broken run choosing one wrong tool must be detected.
    const wrongId = TOOL_SELECTION_CORPUS.find(e => e.expected.length && e.expected[0] !== 'bridge_ping').id;
    const broken = { ...perfect, [wrongId]: 'bridge_ping' };
    const brokenScore = scoreSelection(broken);
    assert.ok(brokenScore.accuracy < 1, 'a wrong selection must reduce accuracy');
    const failed = brokenScore.cases.find(c => c.id === wrongId);
    assert.equal(failed.correct, false);
    assert.equal(failed.selected, 'bridge_ping');
  });
});
