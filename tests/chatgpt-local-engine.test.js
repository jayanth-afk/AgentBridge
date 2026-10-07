import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ChatGptLocalEngineAdapter } from '../src/control-plane/chatgpt-local-engine.js';
import { BridgeHttpServer } from '../src/http-server.js';
import { AdapterHealth } from '../src/control-plane/desktop-control-adapter.js';

// A fake `codex` executable. Behavior is selected by FAKE_CODEX_MODE so this
// suite never touches a real model or the network.
const FAKE_SOURCE = [
  '#!/usr/bin/env node',
  "const mode = process.env.FAKE_CODEX_MODE || 'success';",
  "function line(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }",
  "if (mode === 'success') {",
  "  line({ type: 'diagnostic', cwd: process.cwd(), argv: process.argv.slice(2) });",
  "  line({ type: 'thread.started', thread_id: 't1' });",
  "  line({ type: 'item.completed', item: { type: 'agent_message', text: 'hello world' } });",
  "  line({ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 2 } });",
  '}',
  "if (mode === 'malformed') {",
  "  line({ type: 'diagnostic', cwd: process.cwd(), argv: process.argv.slice(2) });",
  "  process.stdout.write('not json at all\\n');",
  "  line({ type: 'item.completed', item: { type: 'agent_message', text: 'part1' } });",
  "  process.stdout.write('{ broken json\\n');",
  "  line({ type: 'item.completed', item: { type: 'agent_message', text: 'part2' } });",
  "  line({ type: 'turn.completed', usage: { total_tokens: 7 } });",
  '}',
  "if (mode === 'crash') {",
  "  process.stderr.write('boom: engine crashed\\n');",
  '  process.exitCode = 3;',
  '}',
  "if (mode === 'never-ends') {",
  "  line({ type: 'thread.started', thread_id: 't1' });",
  '  setInterval(function () {}, 1000);',
  '}',
  "if (mode === 'no-output') {",
  '  setInterval(function () {}, 1000);',
  '}',
  ''
].join('\n');

let fakeCli;

test('ChatGptLocalEngineAdapter — hardened headless Q&A', async (t) => {
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zia-fake-codex-'));
  fakeCli = path.join(fakeDir, 'codex');
  fs.writeFileSync(fakeCli, FAKE_SOURCE, { mode: 0o755 });

  function withMode(mode, fn) {
    const previous = process.env.FAKE_CODEX_MODE;
    process.env.FAKE_CODEX_MODE = mode;
    return Promise.resolve()
      .then(fn)
      .finally(() => {
        if (previous === undefined) delete process.env.FAKE_CODEX_MODE;
        else process.env.FAKE_CODEX_MODE = previous;
      });
  }

  function adapter(options = {}) {
    return new ChatGptLocalEngineAdapter({ cliPath: fakeCli, defaultTimeoutMs: 5000, ...options });
  }

  await t.test('success: assembles text and usage, runs in a fresh temp cwd', async () => {
    await withMode('success', async () => {
      const engine = adapter();
      let diagnostic = null;
      const result = await engine.answer({
        prompt: 'say hello',
        requestId: 'req_success',
        onEvent: (event) => { if (event.type === 'diagnostic') diagnostic = event; }
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.response, 'hello world');
      assert.deepStrictEqual(result.usage, { input_tokens: 5, output_tokens: 2 });
      assert.strictEqual(result.transport, 'chatgpt-local-engine');

      // Hardening: read-only sandbox, ephemeral session, temp cwd, no repo check.
      assert.ok(diagnostic, 'fake codex reported its cwd and argv');
      assert.ok(diagnostic.argv.includes('--sandbox'));
      assert.ok(diagnostic.argv.includes('read-only'));
      assert.ok(diagnostic.argv.includes('--ephemeral'));
      assert.ok(diagnostic.argv.includes('--skip-git-repo-check'));
      assert.ok(diagnostic.argv.includes('--json'));
      assert.ok(!diagnostic.argv.includes('--dangerously-bypass-approvals-and-sandbox'));

      // The working root is a throwaway temp dir — never the repo or $HOME.
      // (macOS reports the realpath /private/var/... for /var/folders/...)
      assert.ok(diagnostic.cwd.startsWith(fs.realpathSync(os.tmpdir())), `cwd ${diagnostic.cwd} is under tmpdir`);
      assert.ok(path.basename(diagnostic.cwd).startsWith('zia-codex-'));
      assert.notStrictEqual(diagnostic.cwd, process.cwd());
      assert.notStrictEqual(diagnostic.cwd, os.homedir());

      // And it is cleaned up afterwards.
      assert.strictEqual(fs.existsSync(diagnostic.cwd), false, 'temp cwd removed after the turn');
    });
  });

  await t.test('malformed JSONL is tolerated and valid events still assemble', async () => {
    await withMode('malformed', async () => {
      const engine = adapter();
      const result = await engine.answer({ prompt: 'x', requestId: 'req_malformed' });
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.response, 'part1\npart2');
      assert.deepStrictEqual(result.usage, { total_tokens: 7 });
    });
  });

  await t.test('crash: non-zero exit surfaces the engine stderr', async () => {
    await withMode('crash', async () => {
      const engine = adapter();
      const result = await engine.answer({ prompt: 'x', requestId: 'req_crash' });
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.code, 3);
      assert.ok(result.error.includes('boom: engine crashed'));
    });
  });

  await t.test('never-ends: total timeout kills the turn and settles once', async () => {
    await withMode('never-ends', async () => {
      const engine = adapter();
      const result = await engine.executeTurn({
        prompt: 'x', requestId: 'req_never', timeoutMs: 600, firstTokenTimeoutMs: 3000,
        useTempCwd: true, sandboxMode: 'read-only', detached: true, ephemeral: true
      });
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.error, 'TIMEOUT');
      assert.strictEqual(engine.activeJobs.size, 0, 'no zombie job left behind');
    });
  });

  await t.test('no-output: first-token timeout fires before the total timeout', async () => {
    await withMode('no-output', async () => {
      const engine = adapter();
      const result = await engine.executeTurn({
        prompt: 'x', requestId: 'req_noout', timeoutMs: 5000, firstTokenTimeoutMs: 250,
        useTempCwd: true, sandboxMode: 'read-only', detached: true, ephemeral: true
      });
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.error, 'FIRST_TOKEN_TIMEOUT');
    });
  });

  await t.test('cancel kills an in-flight turn', async () => {
    await withMode('never-ends', async () => {
      const engine = adapter();
      const pending = engine.executeTurn({
        prompt: 'x', requestId: 'req_cancel', timeoutMs: 5000, firstTokenTimeoutMs: 5000,
        useTempCwd: true, sandboxMode: 'read-only', detached: true, ephemeral: true
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      const cancelled = await engine.cancel('req_cancel');
      assert.strictEqual(cancelled.cancelled, true);
      const result = await pending;
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.error, 'CANCELLED');
    });
  });

  await t.test('concurrent turns are stateless: each gets its own temp cwd', async () => {
    await withMode('success', async () => {
      const engine = adapter();
      const cwds = [];
      const capture = (event) => { if (event.type === 'diagnostic') cwds.push(event.cwd); };
      const [a, b] = await Promise.all([
        engine.answer({ prompt: 'a', requestId: 'req_a', onEvent: capture }),
        engine.answer({ prompt: 'b', requestId: 'req_b', onEvent: capture })
      ]);
      assert.strictEqual(a.success, true);
      assert.strictEqual(b.success, true);
      assert.strictEqual(cwds.length, 2);
      assert.notStrictEqual(cwds[0], cwds[1], 'no shared working directory between turns');
    });
  });

  await t.test('transport resolution: auto prefers a healthy engine, else UI', async () => {
    const server = new BridgeHttpServer({ port: 0, host: '127.0.0.1', apiKey: 'k' });

    server.localEngine = { isInstalled: () => false, health: async () => ({ status: AdapterHealth.UNAVAILABLE }) };
    assert.strictEqual(await server.resolveChatGPTTransport('auto'), 'ui');
    assert.strictEqual(await server.resolveChatGPTTransport('ui'), 'ui');
    assert.strictEqual(await server.resolveChatGPTTransport('engine'), 'engine');

    server.localEngine = { isInstalled: () => true, health: async () => ({ status: AdapterHealth.AVAILABLE }) };
    assert.strictEqual(await server.resolveChatGPTTransport('auto'), 'engine');
  });

  fs.rmSync(fakeDir, { recursive: true, force: true });
});
