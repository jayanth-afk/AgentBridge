import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { ToolRegistry } from '../src/tool-registry.js';

// The HTTP control plane builds a fresh tool context per `tools/call`. The
// knowledge store is now cached on the durable DB handle, so knowledge tools no
// longer re-instantiate the store (and re-run its schema DDL) per request.
//
// The important half of the invariant is the negative one: without a durable DB
// the store owns a private in-memory database and MUST NOT be shared, or two
// callers would silently see each other's knowledge.

function handlers(registry) {
  return {
    store: registry.tools.get('bridge_store_knowledge').handler,
    search: registry.tools.get('bridge_search_knowledge').handler
  };
}

test('Knowledge store caching: shared per durable DB, private without one', async (t) => {
  const registry = new ToolRegistry();
  const { store, search } = handlers(registry);

  await t.test('1. One durable DB -> a store written through one context is visible through another', async () => {
    const db = new DatabaseSync(':memory:');
    const ctxA = { db, logger: { log() {} } };
    const ctxB = { db, logger: { log() {} } };

    const written = await store(
      { title: 'Shared store handle', content: 'KnowledgeStore is cached on the durable DB handle so HTTP tool calls do not rebuild it.', tags: ['perf'] },
      ctxA
    );
    assert.equal(written.success, true);

    const found = await search({ query: 'durable DB handle' }, ctxB);
    assert.ok(found.count >= 1, 'a different context on the same DB must see the stored item');
    assert.ok(found.results.some(r => r.title === 'Shared store handle'));
    db.close();
  });

  await t.test('2. No durable DB -> stores stay private to each context', async () => {
    const ctx1 = { logger: { log() {} } };
    const ctx2 = { logger: { log() {} } };

    await store(
      { title: 'Private store', content: 'This entry must not leak into another context without a shared DB.' },
      ctx1
    );

    const found = await search({ query: 'must not leak' }, ctx2);
    assert.equal(found.count, 0, 'without a shared DB each context owns a private in-memory store');
  });
});
