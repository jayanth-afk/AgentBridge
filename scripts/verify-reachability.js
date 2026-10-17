#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(REPO_ROOT, 'src');
const TESTS_DIR = path.join(REPO_ROOT, 'tests');

const ENTRY_POINTS = [
  path.join(SRC_DIR, 'index.js'),
  path.join(SRC_DIR, 'mcp-server.js'),
  path.join(SRC_DIR, 'http-server.js'),
  path.join(SRC_DIR, 'agent-runner.js'),
  path.join(SRC_DIR, 'cli.js'),
  path.join(REPO_ROOT, 'bin', 'bridge.js')
];

// Modules that are documented as default-on or core capabilities
const DEFAULT_ON_MODULES = [
  'src/contracts/structured-contracts.js',
  'src/collaboration/collaboration-guard.js',
  'src/collaboration/context-reference-manager.js',
  'src/collaboration/rolling-summary.js',
  'src/collaboration/collaboration-patterns.js',
  'src/code-intelligence/repo-code-map.js',
  'src/display/bridge-display-manager.js',
  'src/interop/a2a-adapter.js',
  'src/interop/hot-manifest-reloader.js',
  'src/testing/conformance-suite.js',
  'src/diagnostics/doctor.js',
  'src/storage/schema-migrator.js',
  'src/storage/backup-restore.js',
  'src/storage/retention-pruner.js',
  'src/skills/skill-registry.js',
  'src/capabilities/evidence-registry.js',
  'src/tokenizer/honest-tokenizer.js'
];

// Modules that are explicitly opt-in (disabled by default)
const OPT_IN_MODULES = [
  'src/routing/cheap-first-router.js',
  'src/cache/semantic-cache.js',
  'src/compression/prompt-compressor.js'
];

function getAllJsFiles(dir) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...getAllJsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      results.push(full);
    }
  }
  return results;
}

function resolveImport(sourceFile, importTarget) {
  if (!importTarget.startsWith('.') && !importTarget.startsWith('/')) {
    // External dependency (npm package)
    return null;
  }
  const dir = path.dirname(sourceFile);
  let resolved = path.resolve(dir, importTarget);
  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
    return resolved;
  }
  if (fs.existsSync(resolved + '.js')) {
    return resolved + '.js';
  }
  if (fs.existsSync(path.join(resolved, 'index.js'))) {
    return path.join(resolved, 'index.js');
  }
  return null;
}

function extractImports(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const imports = new Set();

  // Match import ... from '...' or import '...' or export ... from '...'
  const staticImportRe = /(?:(?:import|export)\s+(?:[\w*\s{},$]+\s+from\s+)?['"]([^'"]+)['"])/g;
  let match;
  while ((match = staticImportRe.exec(content)) !== null) {
    imports.add(match[1]);
  }

  // Match dynamic import('...')
  const dynamicImportRe = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = dynamicImportRe.exec(content)) !== null) {
    imports.add(match[1]);
  }

  return Array.from(imports);
}

/**
 * Map each `src/` module to the test files that import it directly.
 * Used to annotate unwired modules that are still covered by the test suite
 * (e.g. `src/gui-adapter.js`, exercised by tests/integration.test.js).
 */
function collectTestReferences() {
  const references = new Map();
  if (!fs.existsSync(TESTS_DIR)) return references;

  for (const entry of fs.readdirSync(TESTS_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    const testFile = path.join(TESTS_DIR, entry.name);
    for (const imp of extractImports(testFile)) {
      const resolved = resolveImport(testFile, imp);
      if (!resolved || !resolved.startsWith(SRC_DIR + path.sep)) continue;
      if (!references.has(resolved)) references.set(resolved, new Set());
      references.get(resolved).add(entry.name);
    }
  }

  return references;
}

function traceReachability() {
  const reachable = new Set();
  const queue = [...ENTRY_POINTS.filter(f => fs.existsSync(f))];

  for (const ep of queue) {
    reachable.add(ep);
  }

  while (queue.length > 0) {
    const current = queue.shift();
    const imports = extractImports(current);

    for (const imp of imports) {
      const resolved = resolveImport(current, imp);
      if (resolved && !reachable.has(resolved)) {
        reachable.add(resolved);
        queue.push(resolved);
      }
    }
  }

  return reachable;
}

function main() {
  const allSrcFiles = getAllJsFiles(SRC_DIR);
  const reachableSet = traceReachability();
  const testReferences = collectTestReferences();

  const reportRows = [];
  let failures = 0;

  for (const absPath of allSrcFiles) {
    const relPath = path.relative(REPO_ROOT, absPath);
    const isWired = reachableSet.has(absPath);
    const isDefaultOn = DEFAULT_ON_MODULES.includes(relPath);
    const isOptIn = OPT_IN_MODULES.includes(relPath);

    let status = isWired ? 'WIRED' : 'UNWIRED';
    let notes = '';

    if (isDefaultOn) {
      if (isWired) {
        notes = 'Default-On Core Component (Verified Wired)';
      } else {
        notes = 'CRITICAL FAILURE: Documented as Default-On but UNREACHABLE';
        failures++;
      }
    } else if (isOptIn) {
      notes = isWired ? 'Opt-In Capability (Wired, Off by Default)' : 'Opt-In Capability (Standalone Library)';
    } else if (isWired) {
      notes = 'Production Module (Wired)';
    } else {
      const testRefs = testReferences.get(absPath);
      notes = testRefs && testRefs.size > 0
        ? `Test-exercised only (${[...testRefs].sort().join(', ')})`
        : 'Standalone Library / Secondary Tool';
    }

    reportRows.push({ relPath, status, isDefaultOn, isOptIn, notes });
  }

  // Generate docs/reachability.md
  reportRows.sort((a, b) => a.relPath.localeCompare(b.relPath));

  const mdLines = [
    '# Agent Bridge Production Reachability Report',
    '',
    `*Generated by \`scripts/verify-reachability.js\` on ${new Date().toISOString()}*`,
    '',
    '## Entry Points Traced',
    ...ENTRY_POINTS.map(ep => `- \`${path.relative(REPO_ROOT, ep)}\``),
    '',
    '## Production Reachability Matrix',
    '',
    '| Module | Status | Mode | Invariants & Notes |',
    '|---|---|---|---|'
  ];

  for (const r of reportRows) {
    const mode = r.isDefaultOn ? 'Default-On' : (r.isOptIn ? 'Opt-In (Off by Default)' : 'Utility/Component');
    mdLines.push(`| \`${r.relPath}\` | **${r.status}** | ${mode} | ${r.notes} |`);
  }

  mdLines.push('', '## Summary');
  const wiredCount = reportRows.filter(r => r.status === 'WIRED').length;
  const unwiredCount = reportRows.filter(r => r.status === 'UNWIRED').length;
  mdLines.push(`- Total \`src/\` Modules: ${reportRows.length}`);
  mdLines.push(`- Production Wired: ${wiredCount}`);
  mdLines.push(`- Unwired Libraries: ${unwiredCount}`);
  mdLines.push(`- Default-On Reachability Failures: ${failures}`);

  const docPath = path.join(REPO_ROOT, 'docs', 'reachability.md');
  fs.writeFileSync(docPath, mdLines.join('\n') + '\n', 'utf8');
  console.log(`Reachability analysis complete. Report written to ${docPath}`);
  console.log(`Wired: ${wiredCount}, Unwired: ${unwiredCount}, Failures: ${failures}`);

  if (failures > 0) {
    console.error(`FAILED: ${failures} modules claimed as Default-On are unreachable from production entry points.`);
    process.exit(1);
  } else {
    console.log('✅ All default-on and opt-in modules verified reachable.');
    process.exit(0);
  }
}

main();
