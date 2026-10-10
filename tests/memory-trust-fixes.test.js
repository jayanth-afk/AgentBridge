import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { KnowledgeStore, KNOWLEDGE_STATUS } from '../src/memory/knowledge-store.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { AuditLogger } from '../src/audit-logger.js';
import { AgentIdentityManager } from '../src/agent-identity.js';

test('Stage 4 — Memory Trust, Provenance & Immutability Fixes Suite', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-trust-'));
  const dbPath = path.join(tmpDir, 'memory_trust.sqlite');
  const logger = new AuditLogger(dbPath);
  const store = new KnowledgeStore(logger);

  t.after(() => {
    store.close();
    logger.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  await t.test('1. Secure Default: Agent-supplied content without evidence defaults to agent-claimed, not verified', () => {
    const item = store.store({
      key: 'agent_finding_1',
      title: 'Agent Memory Finding',
      content: 'Agent claims cache speedup is 5x.',
      authorAgent: 'claude-desktop'
    });

    assert.strictEqual(item.status, KNOWLEDGE_STATUS.AGENT_CLAIMED, 'Agent content without evidence must default to agent-claimed');
    assert.notStrictEqual(item.status, KNOWLEDGE_STATUS.VERIFIED, 'Agent content must NOT default to verified');
  });

  await t.test('2. "verified" status requires explicit evidence fields or user_instruction', () => {
    // Unverified claim requested as 'verified' without evidence must be rejected
    assert.throws(() => {
      store.store({
        key: 'unverified_claim',
        title: 'Unverified Claim',
        content: 'Claiming verified without any evidence.',
        authorAgent: 'chatgpt-desktop',
        status: 'verified'
      });
    }, /VERIFICATION_EVIDENCE_REQUIRED/);

    // Supplying valid verificationCommand or sourceReference allows 'verified'
    const verifiedItem = store.store({
      key: 'verified_with_evidence',
      title: 'Verified with Evidence',
      content: 'Verified by deterministic unit test.',
      authorAgent: 'chatgpt-desktop',
      status: 'verified',
      provenance: {
        verificationCommand: 'npm test',
        sourceReference: 'tests/memory-trust-fixes.test.js'
      }
    });

    assert.strictEqual(verifiedItem.status, KNOWLEDGE_STATUS.VERIFIED);
  });

  await t.test('3. Invalid statuses are strictly REJECTED, never coerced', () => {
    assert.throws(() => {
      store.store({
        key: 'invalid_status_item',
        title: 'Bogus Status',
        content: 'Invalid status string.',
        authorAgent: 'antigravity-ide',
        status: 'absolute-truth-trust-me'
      });
    }, /INVALID_KNOWLEDGE_STATUS/);
  });

  await t.test('4. Cross-agent author protection: updates by different agent are rejected (no silent overwrite)', () => {
    // Claude creates an entry
    store.store({
      key: 'claude_secret_fact',
      title: 'Claude Architecture Decision',
      content: 'Claude original design choice.',
      authorAgent: 'claude-desktop'
    });

    // ChatGPT attempts to overwrite Claude's record under same key -> must be REJECTED
    assert.throws(() => {
      store.store({
        key: 'claude_secret_fact',
        title: 'ChatGPT Overwrite Attempt',
        content: 'Malicious or accidental overwrite of Claude record.',
        authorAgent: 'chatgpt-desktop'
      });
    }, /KNOWLEDGE_ACCESS_DENIED/);

    // Claude can update its own record
    const updated = store.store({
      key: 'claude_secret_fact',
      title: 'Claude Architecture Decision v2',
      content: 'Claude updated design choice.',
      authorAgent: 'claude-desktop'
    });
    assert.strictEqual(updated.title, 'Claude Architecture Decision v2');
  });

  await t.test('5. Append-only history table records all meaningful updates and status changes', () => {
    const history = store.getHistory('claude_secret_fact');
    assert.ok(history.length >= 2, 'History must record creation and update');
    assert.strictEqual(history[0].author_agent, 'claude-desktop');
    assert.strictEqual(history[1].modifier_agent, 'claude-desktop');
    assert.ok(history[0].new_sha256);
    assert.ok(history[1].old_sha256);
  });

  await t.test('6. FTS consistency check and reindex routine verify lexical index integrity', () => {
    const consistency = store.checkFtsConsistency();
    assert.strictEqual(consistency.consistent, true);
    assert.ok(consistency.rowCount > 0);

    const reindexRes = store.reindexFts();
    assert.strictEqual(reindexRes.reindexed, consistency.rowCount);
  });

  await t.test('7. Search and get results carry untrustedData, contentHash, and trustLevel', () => {
    const results = store.search({ query: 'Claude updated design' });
    assert.ok(results.length > 0);
    const item = results[0];
    assert.strictEqual(item.untrustedData, true, 'Search results must carry untrustedData marker');
    assert.ok(item.sha256);
    assert.ok(item.trustLevel);
    assert.strictEqual(item.authorAgent, 'claude-desktop');
  });

  await t.test('8. ToolRegistry integration enforces connection-bound identity on author', async () => {
    const registry = new ToolRegistry();
    const identity = new AgentIdentityManager(logger, 'antigravity-ide');
    const ctx = { logger, db: logger.db, identity, requireAuthentication: true };

    // Caller attempts to claim authorAgent: 'claude-desktop', but connection is bound to 'antigravity-ide'
    const stored = await registry.executeTool('bridge_store_knowledge', {
      title: 'Bound Author Test',
      content: 'Testing connection binding on memory store.',
      agentId: 'claude-desktop' // Spoofed in args
    }, ctx);

    // Stored record author must be 'antigravity-ide' (bound), NOT 'claude-desktop' (args)
    const record = store.get(stored.id);
    assert.strictEqual(record.authorAgent, 'antigravity-ide', 'Author must come from bound connection, not args');
  });
});
