import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

import { KnowledgeStore, KNOWLEDGE_STATUS } from '../src/memory/knowledge-store.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { AuditLogger } from '../src/audit-logger.js';

test('Memory with Provenance & Lifecycle Validity Suite', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-prov-'));
  const dbPath = path.join(tmpDir, 'memory.sqlite');
  const logger = new AuditLogger(dbPath);
  const store = new KnowledgeStore(logger);

  t.after(() => {
    store.close();
    logger.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  await t.test('1. Knowledge items store and retrieve with lifecycle status (verified, hypothesis, obsolete, failed-experiment, agent-claimed)', () => {
    const statuses = Object.values(KNOWLEDGE_STATUS);
    assert.strictEqual(statuses.length, 5);

    for (const status of statuses) {
      const stored = store.store({
        key: `fact_${status}`,
        title: `Fact for ${status}`,
        content: `Detailed empirical evidence supporting ${status}.`,
        category: 'architecture',
        status
      });

      assert.strictEqual(stored.status, status);

      const retrieved = store.get(`fact_${status}`);
      assert.ok(retrieved);
      assert.strictEqual(retrieved.status, status);
      assert.strictEqual(retrieved.isExpired, false);
    }
  });

  await t.test('2. Default status is "verified"; invalid status safely defaults to "verified"', () => {
    const defaultItem = store.store({
      key: 'fact_default',
      title: 'Default Fact',
      content: 'No status passed in options.'
    });
    assert.strictEqual(defaultItem.status, 'verified');

    const invalidItem = store.store({
      key: 'fact_invalid_status',
      title: 'Invalid Status Fact',
      content: 'Bogus status passed in options.',
      status: 'super-certain-truth'
    });
    assert.strictEqual(invalidItem.status, 'verified');
  });

  await t.test('3. Validity windows: expired items (valid_until in past) are excluded from default search', () => {
    const past = new Date(Date.now() - 3600 * 1000).toISOString(); // 1 hour ago
    const future = new Date(Date.now() + 3600 * 1000).toISOString(); // 1 hour ahead

    store.store({
      key: 'fact_expired',
      title: 'Expired Fact about Redis Cache',
      content: 'Redis cache host was 10.0.0.5.',
      status: 'verified',
      validUntil: past
    });

    store.store({
      key: 'fact_active',
      title: 'Active Fact about Redis Cache',
      content: 'Redis cache host is 10.0.0.6.',
      status: 'verified',
      validUntil: future
    });

    // Default search excludes expired items
    const results = store.search({ query: 'Redis cache' });
    const keys = results.map(r => r.key);
    assert.ok(keys.includes('fact_active'), 'Active fact must be present');
    assert.ok(!keys.includes('fact_expired'), 'Expired fact must be excluded from default search');

    // Searching with includeExpired: true returns both
    const allResults = store.search({ query: 'Redis cache', includeExpired: true });
    const allKeys = allResults.map(r => r.key);
    assert.ok(allKeys.includes('fact_active'));
    assert.ok(allKeys.includes('fact_expired'));

    const expiredResult = allResults.find(r => r.key === 'fact_expired');
    assert.strictEqual(expiredResult.isExpired, true);
  });

  await t.test('4. Status filtering: search by status isolates hypotheses, failed-experiments, and excludes obsolete by default', () => {
    store.store({
      key: 'hypo_1',
      title: 'Hypothesis on SQLite WAL checkpointing',
      content: 'Passive checkpointing might reduce lock contention under concurrency.',
      status: 'hypothesis'
    });

    store.store({
      key: 'failed_exp_1',
      title: 'Failed Experiment with Memory mapped I/O',
      content: 'mmap size exceeding 1GB degraded Node SQLite stability on ARM64.',
      status: 'failed-experiment'
    });

    store.store({
      key: 'obs_1',
      title: 'Obsolete approach to JSON parsing',
      content: 'Manual regex parsing was replaced by JSON.parse.',
      status: 'obsolete'
    });

    // Default search for 'parsing' excludes obsolete items
    const defaultSearch = store.search({ query: 'parsing' });
    assert.ok(!defaultSearch.some(r => r.key === 'obs_1'), 'Default search excludes obsolete');

    // Filtering by status === 'hypothesis'
    const hypoSearch = store.search({ query: 'checkpointing', status: 'hypothesis' });
    assert.ok(hypoSearch.length > 0);
    assert.strictEqual(hypoSearch[0].status, 'hypothesis');

    // Filtering by status === 'failed-experiment'
    const failedSearch = store.search({ query: 'SQLite', status: 'failed-experiment' });
    assert.ok(failedSearch.length > 0);
    assert.strictEqual(failedSearch[0].status, 'failed-experiment');

    // Searching explicitly with status === 'obsolete'
    const obsSearch = store.search({ query: 'parsing', status: 'obsolete' });
    assert.ok(obsSearch.length > 0);
    assert.strictEqual(obsSearch[0].key, 'obs_1');
  });

  await t.test('5. Structured provenance (file_path, line_range, commit_sha, verification_command) survives round trip', () => {
    const prov = {
      sourceType: 'source_code_invariant',
      filePath: 'src/mailbox-hub.js',
      lineRange: '15-20',
      commitSha: '9cec79eb44d17613e9cff27423e7fc301399e7d7',
      verificationCommand: 'node --test tests/zero-waste-response-delivery.test.js',
      verifiedByAgent: 'antigravity',
      confidence: 1.0
    };

    const stored = store.store({
      key: 'prov_test_fact',
      title: 'Terminal States Immutability Invariant',
      content: 'Terminal request states (completed, failed, cancelled, quarantined) cannot be overwritten.',
      provenance: prov,
      sourceFile: 'src/mailbox-hub.js'
    });

    assert.ok(stored.success);

    const fetched = store.get('prov_test_fact');
    assert.ok(fetched);
    assert.deepStrictEqual(fetched.provenance, prov);
    assert.strictEqual(fetched.sourceFile, 'src/mailbox-hub.js');
  });

  await t.test('6. Content-addressing & deduplication via SHA-256 getByHash', () => {
    const text = 'Identical verifiable content that produces a predictable SHA-256 digest.';
    const stored = store.store({
      key: 'hash_test_1',
      title: 'Hash Test Title',
      content: text
    });

    const byHash = store.getByHash(stored.sha256);
    assert.ok(byHash);
    assert.strictEqual(byHash.key, 'hash_test_1');
    assert.strictEqual(byHash.content, text);

    // Also supports sha256: prefix
    const byPrefixedHash = store.getByHash(stored.contentHash);
    assert.ok(byPrefixedHash);
    assert.strictEqual(byPrefixedHash.key, 'hash_test_1');
  });

  await t.test('7. ToolRegistry integration: bridge_store_knowledge, bridge_search_knowledge, bridge_get_knowledge execute with status & validity', async () => {
    const registry = new ToolRegistry();
    const ctx = { logger, db: logger.db };

    // Store via ToolRegistry
    const storeRes = await registry.executeTool('bridge_store_knowledge', {
      title: 'Tool Surface Profile Reductions',
      content: 'Minimal profile delivers 87.51% byte reduction across 8 tools.',
      category: 'architecture',
      status: 'verified',
      tags: ['tokens', 'profiles'],
      sourceFile: 'src/tool-registry.js'
    }, ctx);

    assert.strictEqual(storeRes.success, true);
    assert.strictEqual(storeRes.status, 'verified');
    assert.strictEqual(storeRes.sourceFile, 'src/tool-registry.js');

    // Search via ToolRegistry
    const searchRes = await registry.executeTool('bridge_search_knowledge', {
      query: 'profile reductions',
      status: 'verified'
    }, ctx);

    assert.ok(searchRes.count >= 1);
    assert.strictEqual(searchRes.results[0].id, storeRes.id);
    assert.strictEqual(searchRes.results[0].status, 'verified');

    // Get via ToolRegistry
    const getRes = await registry.executeTool('bridge_get_knowledge', { id: storeRes.id }, ctx);
    assert.strictEqual(getRes.title, 'Tool Surface Profile Reductions');
    assert.strictEqual(getRes.status, 'verified');
  });

  await t.test('8. Safe migration on pre-existing database tables retains existing rows without error', () => {
    const rawDb = new DatabaseSync(':memory:');
    // Simulate legacy table without status, valid_from, valid_until, source_file
    rawDb.exec(`
      CREATE TABLE bridge_knowledge (
        key TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        author_agent TEXT NOT NULL,
        provenance TEXT,
        tags TEXT,
        sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO bridge_knowledge VALUES ('legacy_1', 'general', 'Legacy Title', 'Legacy Content', 'system', null, '', 'abc123hash', '2026-01-01', '2026-01-01');
    `);

    // Instantiating KnowledgeStore on rawDb runs migration
    const upgraded = new KnowledgeStore(rawDb);
    const legacyItem = upgraded.get('legacy_1');

    assert.ok(legacyItem);
    assert.strictEqual(legacyItem.status, 'verified');
    assert.strictEqual(legacyItem.validUntil, null);
    assert.strictEqual(legacyItem.isExpired, false);
    upgraded.close();
  });
});
