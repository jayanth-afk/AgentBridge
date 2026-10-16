import test from 'node:test';
import assert from 'node:assert/strict';

import { ToolRegistry, getCanonicalToolCounts, PROFILE_TOOLS } from '../src/tool-registry.js';

// `tools/list` and `bridge_discover_tools` both read the tool surface, which is
// rebuilt from the full registry if not memoized. These tests pin the cache
// behaviour: stable identity per profile, correct isolation between profiles,
// and invalidation on registration.

test('Tool surface cache: memoization', async (t) => {
  const registry = new ToolRegistry();

  await t.test('1. Repeated calls for the same profile return the identical array', () => {
    const a = registry.getToolDefinitions('minimal');
    const b = registry.getToolDefinitions('minimal');
    assert.equal(a, b, 'memoized surface must be reference-stable');
  });

  await t.test('2. Profiles stay isolated', () => {
    const minimal = registry.getToolDefinitions('minimal');
    const developer = registry.getToolDefinitions('developer');
    const all = registry.getToolDefinitions('all');
    assert.notEqual(minimal, developer);
    assert.notEqual(developer, all);
    assert.ok(minimal.length < developer.length);
    assert.ok(developer.length < all.length);
  });

  await t.test('3. Contents match the declared profile membership', () => {
    const developer = registry.getToolDefinitions('developer');
    const names = developer.map(d => d.name);
    assert.equal(developer.length, PROFILE_TOOLS.developer.length);
    for (const name of PROFILE_TOOLS.developer) {
      assert.ok(names.includes(name), `developer profile must include ${name}`);
    }
  });

  await t.test('4. Registering a tool invalidates the cache', () => {
    const before = registry.getToolDefinitions('all');
    registry.registerTool({
      name: 'bridge_cache_probe_tool',
      description: 'cache probe',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({ ok: true })
    });
    const after = registry.getToolDefinitions('all');
    assert.notEqual(before, after, 'registration must invalidate the memoized surface');
    assert.equal(after.length, before.length + 1);
    assert.ok(after.some(d => d.name === 'bridge_cache_probe_tool'));
  });

  await t.test('5. Canonical counts are unaffected by memoization', () => {
    const counts = getCanonicalToolCounts();
    assert.equal(counts.registeredTools, 74);
    assert.equal(counts.totalSystemTools, 81);
  });

  await t.test('6. Every definition carries name, description and inputSchema', () => {
    for (const def of registry.getToolDefinitions('all')) {
      assert.equal(typeof def.name, 'string');
      assert.equal(typeof def.description, 'string');
      assert.equal(typeof def.inputSchema, 'object');
    }
  });
});
