import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';

import { CONFIG } from '../src/config.js';
import { AuditLogger } from '../src/audit-logger.js';
import { PermissionGuard } from '../src/permission-guard.js';
import { ProjectController } from '../src/project-controller.js';
import { ConcurrencyManager } from '../src/concurrency-manager.js';
import { CacheManager } from '../src/cache-manager.js';
import { DiagnosticsManager } from '../src/diagnostics-manager.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { GitController } from '../src/git-controller.js';

const TEST_DB = path.join(CONFIG.DATA_DIR, 'test_opt.sqlite');
const TEST_WORKSPACE = CONFIG.TEST_WORKSPACE;

test('Optimizations, Atomic Patching & Token Efficiency Suite', async (t) => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  const logger = new AuditLogger(TEST_DB);
  const guard = new PermissionGuard();
  const concurrency = new ConcurrencyManager();
  const cache = new CacheManager({ defaultTtlMs: 5000 });
  const diagnostics = new DiagnosticsManager();
  const git = new GitController(guard, logger);
  const controller = new ProjectController(guard, logger, concurrency, null, cache, git);
  const registry = new ToolRegistry();

  t.after(() => {
    try {
      if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    } catch {}
  });

  await t.test('1. Atomic Patch with ExpectedHash & Conflict Detection', async () => {
    const patchFile = path.join(TEST_WORKSPACE, 'atomic_patch_test.txt');
    // Create base file
    const created = await controller.createFile(patchFile, 'antigravity-ide', 'Line 1\nTarget Block\nLine 3', true);
    assert.ok(created.fileHash);

    const initialHash = created.fileHash;

    // Apply patch with correct expectedHash
    const patchRes = await controller.applyPatch(
      patchFile,
      'antigravity-ide',
      { targetContent: 'Target Block', replacementContent: 'Replaced Block' },
      initialHash
    );

    assert.strictEqual(patchRes.status, 'applied');
    assert.strictEqual(patchRes.conflict, false);
    assert.notStrictEqual(patchRes.newHash, initialHash);

    // Verify content was updated
    const readUpdated = await controller.readFile(patchFile, 'antigravity-ide', 1, 10, true);
    assert.ok(readUpdated.content.includes('Replaced Block'));

    // Attempt patch with STALE expectedHash (should detect conflict!)
    const staleRes = await controller.applyPatch(
      patchFile,
      'chatgpt-desktop',
      { targetContent: 'Replaced Block', replacementContent: 'New Block' },
      initialHash // Old hash!
    );

    assert.strictEqual(staleRes.status, 'conflict');
    assert.strictEqual(staleRes.conflict, true);
    assert.ok(staleRes.message.includes('ConflictDetected'));
  });

  await t.test('2. Batch Operations (Read, Write, Stat)', async () => {
    const file1 = path.join(TEST_WORKSPACE, 'batch_1.txt');
    const file2 = path.join(TEST_WORKSPACE, 'batch_2.txt');

    // Batch Write
    const batchWriteRes = await controller.batchWrite([
      { filePath: file1, content: 'Content of file 1' },
      { filePath: file2, content: 'Content of file 2' }
    ], 'antigravity-ide');

    assert.strictEqual(batchWriteRes.count, 2);
    assert.strictEqual(batchWriteRes.results[0].status, 'created');
    assert.strictEqual(batchWriteRes.results[1].status, 'created');

    // Batch Read
    const batchReadRes = await controller.batchRead([
      { filePath: file1, startLine: 1, endLine: 5 },
      { filePath: file2, startLine: 1, endLine: 5 }
    ], 'claude-desktop', true);

    assert.strictEqual(batchReadRes.count, 2);
    assert.ok(batchReadRes.results[0].content.includes('Content of file 1'));
    assert.ok(batchReadRes.results[1].content.includes('Content of file 2'));

    // Batch Stat
    const batchStatRes = await controller.batchStat([file1, file2, '/non/existent/path'], 'antigravity-ide');
    assert.strictEqual(batchStatRes.count, 3);
    assert.strictEqual(batchStatRes.items[0].exists, true);
    assert.strictEqual(batchStatRes.items[1].exists, true);
    assert.strictEqual(batchStatRes.items[2].exists, false);
  });

  await t.test('3. Fast Search with Noise Directory Exclusion & Snippet Bounds', async () => {
    const searchRes = await controller.searchFiles(CONFIG.BRIDGE_ROOT, 'antigravity-ide', 'BridgeMcpServer', false, 10, ['.js']);
    assert.ok(searchRes.results.length > 0);
    assert.ok(searchRes.count <= 10);
    // Ensure snippets are bounded
    for (const match of searchRes.results) {
      assert.ok(match.line.length <= 150);
      assert.ok(!match.file.includes('node_modules'));
      assert.ok(!match.file.includes('.git'));
    }
  });

  await t.test('4. Project Snapshot Operation', async () => {
    const snap = await controller.projectSnapshot(CONFIG.BRIDGE_ROOT, 'antigravity-ide');
    assert.ok(snap.root);
    assert.ok(snap.structure);
    assert.ok(Array.isArray(snap.structure.directories));
    assert.ok(snap.structure.directories.includes('src'));
    assert.ok(snap.structure.keyFiles.includes('package.json'));
    assert.ok(snap.git);
  });

  await t.test('5. Cache Manager Invalidation on Mutation', async () => {
    const testFile = path.join(TEST_WORKSPACE, 'cache_test.txt');
    await controller.createFile(testFile, 'antigravity-ide', 'Original Cache Value', true);

    // First read -> cache miss, populates cache
    const read1 = await controller.readFile(testFile, 'antigravity-ide', 1, 10, true);
    assert.ok(read1.content.includes('Original Cache Value'));

    // Second read -> cache hit
    const read2 = await controller.readFile(testFile, 'antigravity-ide', 1, 10, true);
    assert.strictEqual(read1.fileHash, read2.fileHash);

    // Edit file -> should invalidate cache for this path
    await controller.createFile(testFile, 'antigravity-ide', 'Updated Cache Value', true);

    // Third read -> reads fresh content
    const read3 = await controller.readFile(testFile, 'antigravity-ide', 1, 10, true);
    assert.ok(read3.content.includes('Updated Cache Value'));
    assert.notStrictEqual(read3.fileHash, read1.fileHash);
  });

  await t.test('6. Directory-scoped cache invalidation after file mutation', () => {
    const root = path.join(TEST_WORKSPACE, 'cache-root');
    const file = path.join(root, 'changed.txt');
    cache.set('directory-search', { value: 'stale' }, root, 5000);
    cache.set('file-read', { value: 'stale' }, file, 5000);
    assert.ok(cache.get('directory-search'));
    assert.ok(cache.get('file-read'));
    cache.invalidatePath(file);
    assert.strictEqual(cache.get('directory-search'), null);
    assert.strictEqual(cache.get('file-read'), null);
  });

  await t.test('7. Cache eviction is LRU', () => {
    const lru = new CacheManager({ maxEntries: 2, defaultTtlMs: 5000 });
    lru.set('a', 'A');
    lru.set('b', 'B');
    assert.strictEqual(lru.get('a'), 'A');
    lru.set('c', 'C');
    assert.strictEqual(lru.get('a'), 'A');
    assert.strictEqual(lru.get('b'), null);
    assert.strictEqual(lru.get('c'), 'C');

    // Refreshing an existing key must not evict the other entry.
    lru.set('a', 'A2');
    assert.strictEqual(lru.get('a'), 'A2');
    assert.strictEqual(lru.get('c'), 'C');
  });

  await t.test('8. Read cache rejects external file mutation', async () => {
    const externalFile = path.join(TEST_WORKSPACE, 'external_cache_test.txt');
    try {
      await controller.createFile(externalFile, 'antigravity-ide', 'Version One', true);
      const first = await controller.readFile(externalFile, 'antigravity-ide', 1, 10, true);
      fs.writeFileSync(externalFile, 'Version Two', 'utf8');
      const second = await controller.readFile(externalFile, 'antigravity-ide', 1, 10, true);
      assert.ok(first.content.includes('Version One'));
      assert.ok(second.content.includes('Version Two'));
      assert.notStrictEqual(first.fileHash, second.fileHash);
    } finally {
      try { if (fs.existsSync(externalFile)) fs.unlinkSync(externalFile); } catch {}
    }
  });

  await t.test('9. Context engine and symbol navigation', async () => {
    const symbolFile = path.join(TEST_WORKSPACE, 'symbol_context_test.js');
    await controller.createFile(symbolFile, 'antigravity-ide', 'function targetSymbol() {\n  return 42;\n}\n', true);
    const context = await controller.buildContext(TEST_WORKSPACE, 'antigravity-ide', 'targetSymbol', 5);
    assert.strictEqual(context.query, 'targetSymbol');
    assert.ok(context.relevant.some(r => r.file === symbolFile));
    const found = await controller.findSymbol(TEST_WORKSPACE, 'antigravity-ide', 'targetSymbol', 5);
    assert.strictEqual(found.count, 1);
    const symbol = await controller.readSymbol(symbolFile, 'antigravity-ide', 'targetSymbol', 1, 10);
    assert.ok(symbol.content.includes('return 42'));

    const compactRead = await controller.readFile(symbolFile, 'antigravity-ide', 1, 10, true);
    const unchanged = await controller.readFile(symbolFile, 'antigravity-ide', 1, 10, true, compactRead.fileHash);
    assert.strictEqual(unchanged.unchanged, true);
    assert.strictEqual(unchanged.fileHash, compactRead.fileHash);

    const toolContext = await registry.executeTool('bridge_context', {
      rootPath: TEST_WORKSPACE, query: 'targetSymbol', agentId: 'antigravity-ide'
    }, { controller, taskManager: null, presence: null, diagnostics });
    assert.ok(Array.isArray(toolContext.relevant));
    const plan = await controller.testPlan(TEST_WORKSPACE, 'antigravity-ide');
    assert.ok(Array.isArray(plan.selectedTests));
    assert.ok(typeof plan.command === 'string');
    try { if (fs.existsSync(symbolFile)) fs.unlinkSync(symbolFile); } catch {}
  });

  await t.test('10. Diagnostics Manager', () => {
    diagnostics.recordToolExecution('bridge_read_file', 15, true);
    diagnostics.recordToolExecution('bridge_read_file', 25, true);
    diagnostics.recordToolExecution('bridge_read_file', 100, false);
    diagnostics.recordTaskCompletion(450, true);

    const snapshot = diagnostics.getSnapshot(cache);
    assert.ok(snapshot.tools.bridge_read_file);
    assert.strictEqual(snapshot.tools.bridge_read_file.calls, 3);
    assert.strictEqual(snapshot.tools.bridge_read_file.errors, 1);
    assert.strictEqual(snapshot.tasks.completed, 1);
    assert.ok(snapshot.memoryMb);
  });
});
