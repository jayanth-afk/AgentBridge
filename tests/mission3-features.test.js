import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { KnowledgeStore } from '../src/memory/knowledge-store.js';
import { ContextCache } from '../src/artifacts/context-cache.js';
import { ProjectController } from '../src/project-controller.js';
import { GitController } from '../src/git-controller.js';
import { PermissionGuard } from '../src/permission-guard.js';
import { AuditLogger } from '../src/audit-logger.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { AutonomousCollaborationOrchestrator, CollaborationStatus } from '../src/control-plane/autonomous-collaboration-orchestrator.js';
import { CapabilityRegistry, TrustTier, CapabilityDimension, CapabilityState } from '../src/capabilities/capability-registry.js';
import { CONFIG } from '../src/config.js';

test('Mission 3: KnowledgeStore SQLite FTS5 BM25 search & provenance', async (t) => {
  const store = new KnowledgeStore(); // In-memory SQLite FTS5 database

  // 1. Store knowledge items
  const item1 = store.storeKnowledge({
    agentId: 'claude',
    title: 'Ripgrep Acceleration Architecture',
    content: 'Ripgrep provides sub-5ms repository search using SIMD acceleration and respecting gitignore rules.',
    category: 'architecture',
    tags: ['performance', 'search', 'ripgrep'],
    provenance: 'agent_finding',
    sourceFile: 'src/project-controller.js'
  });

  const item2 = store.storeKnowledge({
    agentId: 'chatgpt',
    title: 'Zero Token Transport Rule',
    content: 'Deterministic infrastructure operations such as task claiming, leasing, and recovery must consume zero model tokens.',
    category: 'constraint',
    tags: ['tokens', 'transport', 'efficiency'],
    provenance: 'user_instruction'
  });

  assert.ok(item1.id);
  assert.ok(item1.contentHash.startsWith('sha256:'));
  assert.equal(item1.title, 'Ripgrep Acceleration Architecture');

  // 2. FTS5 BM25 search
  const results1 = store.searchKnowledge('ripgrep acceleration');
  assert.ok(results1.length >= 1);
  assert.equal(results1[0].id, item1.id);
  assert.ok(results1[0].snippet.toLowerCase().includes('ripgrep'));
  assert.ok(typeof results1[0].rank === 'number');

  // 3. Category & tag filtering
  const constraintResults = store.searchKnowledge('tokens', { category: 'constraint' });
  assert.equal(constraintResults.length, 1);
  assert.equal(constraintResults[0].id, item2.id);

  // 4. Retrieve by ID and by Hash
  const fetchedById = store.getKnowledge(item1.id);
  assert.equal(fetchedById.title, item1.title);

  const fetchedByHash = store.getByHash(item2.contentHash);
  assert.equal(fetchedByHash.title, item2.title);

  // 5. Store stats
  const stats = store.getStats();
  assert.equal(stats.totalEntries, 2);
  assert.ok(stats.categories.architecture >= 1);
  assert.ok(stats.categories.constraint >= 1);

  store.close();
});

test('Mission 3: ContextCache Content-Addressed Storage & Diff computation', async (t) => {
  const cache = new ContextCache();

  // 1. Store immutable context blocks
  const textA = 'Line 1: System prompt\nLine 2: Objective description\nLine 3: Tool constraints';
  const blockA = cache.storeContextBlock('session_1', textA);
  assert.ok(blockA.hash.startsWith('sha256:'));
  assert.equal(blockA.hit, false);

  // 2. Content-address deduplication hit
  const blockA2 = cache.storeContextBlock('session_2', textA);
  assert.equal(blockA2.hit, true);
  assert.equal(blockA2.hash, blockA.hash);

  // 3. Retrieve block
  const retrieved = cache.retrieveContextBlock(blockA.hash);
  assert.equal(retrieved.content, textA);

  // 4. Compute line-level delta
  const textB = 'Line 1: System prompt\nLine 2: Updated objective\nLine 3: Tool constraints';
  const diff = cache.computeDelta(textA, textB);
  assert.equal(diff.identical, false);
  assert.ok(diff.diffLines.some(l => l.startsWith('-')));
  assert.ok(diff.diffLines.some(l => l.startsWith('+')));

  // 5. Delta on identical text
  const sameDiff = cache.computeDelta(textA, textA);
  assert.equal(sameDiff.identical, true);
  assert.equal(sameDiff.diffLines.length, 0);

  // 6. Snapshot creation
  const snap = cache.createSnapshot('collab_101', ['Turn 1 instruction', 'Turn 1 answer']);
  assert.ok(snap.snapshotId.startsWith('snap_'));
  assert.equal(snap.itemCount, 2);
});

test('Mission 3: ProjectController Ripgrep acceleration & JS fallback', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-mission3-search-'));
  const subFile = path.join(tempDir, 'sample.js');
  fs.writeFileSync(subFile, 'export function findMissionThreeTarget() { return 42; }\nconst other = 100;');

  const logger = new AuditLogger();
  const guard = new PermissionGuard({
    ...CONFIG,
    ALLOWED_ROOTS: [tempDir, CONFIG.BRIDGE_ROOT]
  });
  const controller = new ProjectController(guard, logger);

  // Search inside temp directory
  const searchRes = await controller.searchFiles(tempDir, 'freebuff', 'findMissionThreeTarget');
  assert.ok(searchRes.count >= 1);
  assert.equal(searchRes.results[0].lineNumber, 1);
  assert.ok(searchRes.results[0].line.includes('findMissionThreeTarget'));
  assert.ok(['ripgrep', 'javascript_walk'].includes(searchRes.accelerator));

  // Search in real repo root to verify ripgrep speed
  const repoRes = await controller.searchFiles(CONFIG.BRIDGE_ROOT, 'freebuff', 'ProjectController', false, 5, ['.js']);
  assert.ok(repoRes.count >= 1);
  assert.ok(repoRes.executionMs < 500); // Ripgrep finishes in milliseconds

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('Mission 3: ProjectController checkSyntax and extractData', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-mission3-syntax-'));
  const validJs = path.join(tempDir, 'valid.js');
  const invalidJs = path.join(tempDir, 'invalid.js');
  const validJson = path.join(tempDir, 'data.json');
  const validCsv = path.join(tempDir, 'data.csv');
  const validMd = path.join(tempDir, 'doc.md');

  fs.writeFileSync(validJs, 'const x = 10;\nfunction test() { return x * 2; }\n');
  fs.writeFileSync(invalidJs, 'const x = ; // syntax error\n');
  fs.writeFileSync(validJson, JSON.stringify({ name: 'agent-bridge', version: '1.2.0', config: { port: 8765 } }));
  fs.writeFileSync(validCsv, 'id,name,role\n1,chatgpt,orchestrator\n2,claude,coder\n3,gemini,reviewer\n');
  fs.writeFileSync(validMd, '# Project Overview\nText\n## Architecture\nMore text\n### Ripgrep Engine\nDeep details\n');

  const logger = new AuditLogger();
  const guard = new PermissionGuard({
    ...CONFIG,
    ALLOWED_ROOTS: [tempDir]
  });
  const controller = new ProjectController(guard, logger);

  // 1. Valid JS syntax check
  const check1 = await controller.checkSyntax(validJs, 'freebuff');
  assert.equal(check1.supported, true);
  assert.equal(check1.valid, true);
  assert.equal(check1.error, null);

  // 2. Invalid JS syntax check
  const check2 = await controller.checkSyntax(invalidJs, 'freebuff');
  assert.equal(check2.supported, true);
  assert.equal(check2.valid, false);
  assert.ok(check2.error.length > 0);

  // 3. Valid JSON syntax check
  const check3 = await controller.checkSyntax(validJson, 'freebuff');
  assert.equal(check3.supported, true);
  assert.equal(check3.valid, true);

  // 4. Extract data: JSON with jsonPath
  const extJson = await controller.extractData(validJson, 'freebuff', { jsonPath: 'config.port' });
  assert.equal(extJson.format, 'json');
  assert.equal(extJson.data, 8765);

  // 5. Extract data: CSV structured parsing
  const extCsv = await controller.extractData(validCsv, 'freebuff', { limit: 10 });
  assert.equal(extCsv.format, 'csv');
  assert.deepEqual(extCsv.data.headers, ['id', 'name', 'role']);
  assert.equal(extCsv.data.totalRows, 3);
  assert.equal(extCsv.data.sampleRows[1].name, 'claude');

  // 6. Extract data: Markdown outline extraction
  const extMd = await controller.extractData(validMd, 'freebuff');
  assert.equal(extMd.format, 'md');
  assert.equal(extMd.data.totalHeadings, 3);
  assert.equal(extMd.data.headings[0].text, 'Project Overview');
  assert.equal(extMd.data.headings[1].level, 2);

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('Mission 3: GitController getSummary & getBlame', async (t) => {
  const logger = new AuditLogger();
  const guard = new PermissionGuard(CONFIG);
  const git = new GitController(guard, logger);

  // Inspect current agent-bridge repo
  const summary = await git.getSummary(CONFIG.BRIDGE_ROOT, 'freebuff');
  assert.ok(summary.branch);
  assert.ok(summary.commit);
  assert.ok(typeof summary.isClean === 'boolean');
  assert.ok(typeof summary.totalDirtyFiles === 'number');

  // Blame package.json lines 1-10
  const blame = await git.getBlame(CONFIG.BRIDGE_ROOT, 'freebuff', 'package.json', 1, 10);
  assert.ok(blame.entries.length >= 1);
  assert.ok(blame.entries[0].commit);
  assert.ok(blame.entries[0].author);
});

test('Mission 3: ToolRegistry discover_tools and tool execution', async (t) => {
  const registry = new ToolRegistry();
  const logger = new AuditLogger();
  const guard = new PermissionGuard(CONFIG);
  const controller = new ProjectController(guard, logger);
  const git = new GitController(guard, logger);

  const context = {
    logger,
    guard,
    controller,
    git,
    db: logger.db
  };

  // 1. Tool discovery tool
  const discRes = await registry.executeTool('bridge_discover_tools', { category: 'knowledge' }, context);
  assert.ok(discRes.tools.length >= 3);
  assert.ok(discRes.tools.some(t => t.name === 'bridge_store_knowledge'));
  assert.ok(discRes.tools.some(t => t.name === 'bridge_search_knowledge'));

  // 2. Query filter
  const searchTool = await registry.executeTool('bridge_discover_tools', { query: 'syntax' }, context);
  assert.ok(searchTool.tools.some(t => t.name === 'bridge_check_syntax'));

  // 3. Tool info
  const info = await registry.executeTool('bridge_tool_info', { toolName: 'bridge_check_syntax' }, context);
  assert.equal(info.name, 'bridge_check_syntax');
  assert.equal(info.isEffectful, false);
  assert.ok(info.inputSchema.properties.filePath);

  // 4. Store and search knowledge via ToolRegistry
  const storeRes = await registry.executeTool('bridge_store_knowledge', {
    title: 'Deterministic Recovery Invariants',
    content: 'Transactional outbox dispatches only after SQLite COMMIT succeeds.',
    category: 'architecture',
    tags: ['recovery', 'invariants']
  }, context);
  assert.equal(storeRes.success, true);
  assert.ok(storeRes.id);

  const searchRes = await registry.executeTool('bridge_search_knowledge', { query: 'transactional outbox' }, context);
  assert.ok(searchRes.count >= 1);
  assert.equal(searchRes.results[0].id, storeRes.id);

  // 5. Get knowledge by ID
  const getRes = await registry.executeTool('bridge_get_knowledge', { id: storeRes.id }, context);
  assert.equal(getRes.title, 'Deterministic Recovery Invariants');
});

test('Mission 3: AutonomousCollaborationOrchestrator capability routing & single-agent bypass', async (t) => {
  const logger = new AuditLogger();
  const capRegistry = new CapabilityRegistry(logger);

  // Register verified capabilities
  capRegistry.setCapability({
    agentId: 'claude',
    routeId: 'claude',
    dimension: CapabilityDimension.MODEL_EXECUTION,
    state: CapabilityState.VERIFIED,
    trustTier: TrustTier.T1_ACTIVE_MCP,
    evidence: 'Active MCP connection established'
  });

  capRegistry.setCapability({
    agentId: 'gemini',
    routeId: 'gemini',
    dimension: CapabilityDimension.MODEL_EXECUTION,
    state: CapabilityState.DECLARED,
    trustTier: TrustTier.T4_UI_AUTOMATION,
    evidence: 'Declared in config'
  });

  const orchestrator = new AutonomousCollaborationOrchestrator({
    logger,
    capabilityRegistry: capRegistry,
    invisibilityMonitor: null
  });

  // 1. Capability-based selection prefers verified agent with higher trust tier
  const best = orchestrator.selectBestAgent({
    requiredDimension: CapabilityDimension.MODEL_EXECUTION,
    candidateAgents: ['gemini', 'claude']
  });
  assert.equal(best.selectedAgent, 'claude');
  assert.equal(best.verified, true);

  // 2. Single-agent bypass: simple brief task avoids unnecessary multi-hop collaboration
  const simpleBypass = orchestrator.shouldCollaborate({
    task: 'Format this JSON string: {"a": 1}',
    complexity: 'low'
  });
  assert.equal(simpleBypass.collaborate, false);
  assert.equal(simpleBypass.reason, 'SIMPLE_TASK_SINGLE_AGENT_SUFFICIENT');

  // 3. Multi-agent justified for complex tasks or independent review
  const complexDecision = orchestrator.shouldCollaborate({
    task: 'Refactor database migration system to support multi-region replication',
    complexity: 'high'
  });
  assert.equal(complexDecision.collaborate, true);
  assert.equal(complexDecision.reason, 'HIGH_COMPLEXITY');
});
