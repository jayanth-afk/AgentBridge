import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { CONFIG } from '../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, '..', 'src', 'mcp-server.js');
const TEST_WORKSPACE = CONFIG.TEST_WORKSPACE;
const FIXTURE = path.join(TEST_WORKSPACE, 'mcp_stdio_fixture.txt');

function textOf(result) {
  assert.ok(Array.isArray(result?.content), 'result must have a content array');
  return result.content.map(c => c.text || '').join('\n');
}

test('Real MCP stdio client handshake (official SDK)', async (t) => {
  if (!fs.existsSync(TEST_WORKSPACE)) fs.mkdirSync(TEST_WORKSPACE, { recursive: true });
  fs.writeFileSync(FIXTURE, 'line one\nline two\nline three\n');

  const client = new Client(
    { name: 'agent-bridge-stdio-test', version: '1.0.0' },
    { capabilities: {} }
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, AGENT_ID: 'claude-desktop' },
    stderr: 'pipe'
  });

  await client.connect(transport);
  t.after(async () => {
    try { await client.close(); } catch {}
    try { fs.unlinkSync(FIXTURE); } catch {}
  });

  await t.test('initialize completed and tools/list returns the full registry', async () => {
    const { tools } = await client.listTools();
    assert.strictEqual(tools.length, 64, `expected 64 tools, got ${tools.length}`);
    const names = tools.map(tl => tl.name);
    assert.ok(names.includes('bridge_ping'));
    assert.ok(names.includes('bridge_read_file'));
    assert.ok(names.includes('bridge_git_push'));
    for (const tl of tools) {
      assert.ok(tl.name && tl.description, `tool ${tl.name} needs name+description`);
      assert.strictEqual(tl.inputSchema.type, 'object');
    }
  });

  await t.test('tools/call bridge_ping returns the real liveness token', async () => {
    const res = await client.callTool({ name: 'bridge_ping', arguments: { agentId: 'claude-desktop' } });
    assert.ok(!res.isError);
    assert.ok(textOf(res).includes(CONFIG.RESPONSE_TOKEN));
  });

  await t.test('tools/call bridge_read_file reads a real fixture', async () => {
    const res = await client.callTool({
      name: 'bridge_read_file',
      arguments: { filePath: FIXTURE, agentId: 'claude-desktop', startLine: 1, endLine: 2 }
    });
    assert.ok(!res.isError);
    const parsed = JSON.parse(textOf(res));
    // fixture is 'line one\nline two\nline three\n' -> 4 split segments
    assert.strictEqual(parsed.totalLines, 4);
    assert.ok(parsed.content.includes('line one'));
  });

  await t.test('tools/call bridge_execute_command success and failure', async () => {
    const ok = await client.callTool({
      name: 'bridge_execute_command',
      arguments: { commandLine: 'echo mcp_stdio_ok', cwd: TEST_WORKSPACE, agentId: 'claude-desktop' }
    });
    assert.ok(!ok.isError);
    assert.ok(textOf(ok).includes('mcp_stdio_ok'));

    const bad = await client.callTool({
      name: 'bridge_execute_command',
      arguments: { commandLine: 'node -e "process.exit(5)"', cwd: TEST_WORKSPACE, agentId: 'claude-desktop' }
    });
    assert.strictEqual(bad.isError, true, 'non-zero exit must be an error at the protocol level');
  });

  await t.test('unknown tool fails as a protocol error, not success', async () => {
    const res = await client.callTool({ name: 'definitely_not_a_tool', arguments: {} });
    assert.strictEqual(res.isError, true);
    assert.match(textOf(res), /Unknown tool/);
  });

  await t.test('missing required argument fails cleanly', async () => {
    const res = await client.callTool({ name: 'bridge_read_file', arguments: { agentId: 'claude-desktop' } });
    assert.strictEqual(res.isError, true);
  });

  await t.test('filesystem sandbox holds over the real MCP transport', async () => {
    const res = await client.callTool({
      name: 'bridge_read_file',
      arguments: { filePath: '/etc/passwd', agentId: 'claude-desktop' }
    });
    assert.strictEqual(res.isError, true);
    assert.match(textOf(res), /outside allowed roots/);
  });
});

test('MCP stdio JSON-RPC framing survives malformed input', async (t) => {
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, AGENT_ID: 'claude-desktop' },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const stdoutLines = [];
  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', line => stdoutLines.push(line));

  t.after(() => {
    try { child.kill('SIGKILL'); } catch {}
  });

  const waitFor = (predicate, timeoutMs = 5000) => new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      const found = stdoutLines.map(l => { try { return JSON.parse(l); } catch { return null; } }).find(predicate);
      if (found) { clearInterval(timer); resolve(found); }
      else if (Date.now() - start > timeoutMs) { clearInterval(timer); reject(new Error('timeout waiting for message')); }
    }, 25);
  });

  // 1. Malformed JSON must not crash or hang the server.
  child.stdin.write('{ this is not valid json\n');

  // 2. A valid initialize must still be answered.
  child.stdin.write(JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'raw', version: '1' } }
  }) + '\n');
  const init = await waitFor(m => m.id === 1 && m.result);
  assert.ok(init.result.serverInfo, 'initialize must return serverInfo');

  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  // 3. tools/list works after malformed input.
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');

  const list = await waitFor(m => m.id === 2 && m.result);
  assert.strictEqual(list.result.tools.length, 64);

  // 4. Unknown method yields a JSON-RPC error, not silence.
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'no/such/method' }) + '\n');
  const err = await waitFor(m => m.id === 3 && m.error);
  assert.ok(err.error.code, 'unknown method must return an error code');

  // No diagnostics may contaminate stdout: every non-empty line must be JSON.
  for (const line of stdoutLines) {
    if (!line.trim()) continue;
    assert.doesNotThrow(() => JSON.parse(line), `stdout line is not JSON: ${line}`);
  }

  child.stdin.end();
});
