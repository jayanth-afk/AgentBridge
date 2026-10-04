import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { CONFIG } from '../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..');
const MCP_JSON = path.join(REPO, 'plugins', 'agent-bridge-test', '.mcp.json');

test('Plugin path: agent-bridge-test MCP server actually works', async (t) => {
  assert.ok(fs.existsSync(MCP_JSON), 'plugin .mcp.json must exist');
  const cfg = JSON.parse(fs.readFileSync(MCP_JSON, 'utf8'));
  const entry = cfg.mcpServers['agent-bridge-test'];
  assert.ok(entry, 'plugin must define agent-bridge-test server');

  // The configured server entrypoint must exist.
  const entryArg = entry.args.find(a => a.endsWith('mcp-server.js'));
  assert.ok(entryArg, 'plugin must launch mcp-server.js');
  assert.ok(fs.existsSync(entryArg), `plugin entrypoint missing: ${entryArg}`);

  // Prefer the plugin's declared runtime; fall back to the current one.
  const command = fs.existsSync(entry.command) ? entry.command : process.execPath;

  const client = new Client({ name: 'plugin-path-test', version: '1.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command,
    args: entry.args,
    cwd: entry.cwd || REPO,
    env: { ...process.env },
    stderr: 'pipe'
  });

  await client.connect(transport);
  t.after(async () => { try { await client.close(); } catch {} });

  await t.test('plugin tools/list is populated', async () => {
    const { tools } = await client.listTools();
    assert.ok(tools.length >= 25);
    assert.ok(tools.some(t => t.name === 'bridge_ping'));
  });

  await t.test('plugin bridge_ping returns a real bridge response', async () => {
    const res = await client.callTool({ name: 'bridge_ping', arguments: {} });
    assert.ok(!res.isError);
    const text = res.content.map(c => c.text).join('');
    assert.ok(text.includes(CONFIG.RESPONSE_TOKEN), 'plugin must reach the real bridge');
    assert.ok(text.includes(CONFIG.BRIDGE_ROOT));
  });

  await t.test('plugin tool error propagates (unknown tool)', async () => {
    const res = await client.callTool({ name: 'not_a_real_tool', arguments: {} });
    assert.strictEqual(res.isError, true);
  });
});
