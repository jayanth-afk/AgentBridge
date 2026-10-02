import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AuditLogger } from '../src/audit-logger.js';
import { CollaborationManager } from '../src/collaboration-manager.js';
import { FileActivityManager } from '../src/file-activity-manager.js';

const helper = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers', 'db-writer.js');
const AGENTS = ['chatgpt-desktop', 'claude-desktop', 'antigravity-ide'];
const PER_AGENT = 100;

function runChild(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [helper, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

test('three agent processes can write the shared DB simultaneously (no SQLITE_BUSY)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-mp-'));
  const dbPath = path.join(dir, 'shared.sqlite');
  const logger = new AuditLogger(dbPath);
  t.after(() => { logger.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const collab = new CollaborationManager(logger);
  const activity = new FileActivityManager(logger, { ttlMs: 120000 });
  const board = collab.create({ ownerAgent: 'chatgpt-desktop', title: 'mp', objective: 'contention' });
  const file = '/tmp/mp-shared-file.swift';

  const results = await Promise.all(
    AGENTS.map((agentId) => runChild([dbPath, agentId, board.id, file, String(PER_AGENT)]))
  );

  for (const [i, r] of results.entries()) {
    assert.equal(r.code, 0, `${AGENTS[i]} child failed: ${r.stderr.split('\n').find((l) => /Error|locked|busy/i.test(l)) || r.stderr}`);
  }

  // All three agents' activity on the SAME file is visible at once (awareness, not a lock).
  const rows = activity.get(file);
  assert.deepEqual(new Set(rows.map((r) => r.agent_id)), new Set(AGENTS));

  const state = collab.get(board.id);
  assert.equal(state.events.length, 1 + AGENTS.length * PER_AGENT);
  assert.equal(state.members.length, AGENTS.length);

  const delivered = logger.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE to_agent='system'").get().n;
  assert.equal(delivered, AGENTS.length * PER_AGENT);
});
