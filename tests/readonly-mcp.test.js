import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  APPROVED_ROOT,
  READONLY_TOOLS,
  sanitizeAndValidatePath,
  executeReadonlyTool,
  startHttpServer
} from '../src/readonly-mcp-server.js';

test('Read-Only MCP Server Test Suite', async (t) => {
  const TEST_PORT = 8788;
  let serverInstance;

  await t.test('1. Tool definitions verification', () => {
    assert.equal(READONLY_TOOLS.length, 4, 'Must expose exactly 4 tools');
    const toolNames = READONLY_TOOLS.map(t => t.name).sort();
    assert.deepEqual(toolNames, [
      'readonly_file_info',
      'readonly_list_directory',
      'readonly_read_file',
      'readonly_search_files'
    ]);

    for (const tool of READONLY_TOOLS) {
      assert.equal(tool.readOnlyHint, true, `${tool.name} must have readOnlyHint: true`);
      assert.equal(tool.destructiveHint, false, `${tool.name} must have destructiveHint: false`);
      assert.equal(tool.openWorldHint, false, `${tool.name} must have openWorldHint: false`);
      assert.ok(tool.inputSchema, `${tool.name} must have an inputSchema`);
      assert.equal(tool.inputSchema.type, 'object');
    }
  });

  await t.test('2. Path Security & Traversal Prevention', () => {
    // Valid Zia paths
    const validRoot = sanitizeAndValidatePath('.');
    assert.equal(validRoot, APPROVED_ROOT);

    const validAgentsMd = sanitizeAndValidatePath('AGENTS.md');
    assert.equal(validAgentsMd, `${APPROVED_ROOT}/AGENTS.md`);

    // ../ Path Traversal Attempts
    assert.throws(() => {
      sanitizeAndValidatePath('../');
    }, /Security Violation/);

    assert.throws(() => {
      sanitizeAndValidatePath('../../etc/passwd');
    }, /Security Violation/);

    assert.throws(() => {
      sanitizeAndValidatePath('Sources/../../..');
    }, /Security Violation/);

    // Absolute paths outside Zia
    assert.throws(() => {
      sanitizeAndValidatePath('/etc/passwd');
    }, /Security Violation/);

    assert.throws(() => {
      sanitizeAndValidatePath('/Users/jayanthpranaykonada/.bash_profile');
    }, /Security Violation/);

    assert.throws(() => {
      sanitizeAndValidatePath('/Users/jayanthpranaykonada/agent-bridge');
    }, /Security Violation/);
  });

  await t.test('3. Read-only Tool Execution on Harmless Zia Text File', async () => {
    // Test readonly_file_info
    const info = await executeReadonlyTool('readonly_file_info', { path: 'AGENTS.md' });
    assert.equal(info.path, 'AGENTS.md');
    assert.equal(info.type, 'file');
    assert.equal(info.extension, '.md');
    assert.ok(info.size > 0);

    // Test readonly_read_file
    const file = await executeReadonlyTool('readonly_read_file', { path: 'AGENTS.md' });
    assert.equal(file.path, 'AGENTS.md');
    assert.ok(file.content.includes('Agent Architecture'));
    assert.ok(file.lineCount > 10);

    // Test readonly_list_directory
    const dir = await executeReadonlyTool('readonly_list_directory', { path: '.' });
    assert.equal(dir.path, '.');
    assert.ok(dir.count > 0);
    const hasAgents = dir.entries.some(e => e.name === 'AGENTS.md');
    assert.ok(hasAgents, 'Directory listing should include AGENTS.md');

    // Test readonly_search_files
    const search = await executeReadonlyTool('readonly_search_files', { query: 'AgentLoop' });
    assert.equal(search.query, 'AgentLoop');
    assert.ok(search.matchCount > 0);
    assert.ok(search.matches.some(m => m.file.includes('AGENTS.md')));
  });

  await t.test('4. Security Rejections on Tools', async () => {
    // Attempting to read outside Zia
    await assert.rejects(async () => {
      await executeReadonlyTool('readonly_read_file', { path: '../../.ssh/id_rsa' });
    }, /Security Violation/);

    await assert.rejects(async () => {
      await executeReadonlyTool('readonly_list_directory', { path: '/Users' });
    }, /Security Violation/);

    // Attempting non-existent tool
    await assert.rejects(async () => {
      await executeReadonlyTool('write_file', { path: 'test.txt' });
    }, /Unknown tool/);
  });

  await t.test('5. Streamable HTTP Server Lifecycle & JSON-RPC Protocol', async () => {
    const started = await startHttpServer(TEST_PORT, '127.0.0.1');
    serverInstance = started.server;
    assert.equal(started.port, TEST_PORT);

    const postRpc = (payload) => new Promise((resolve, reject) => {
      const body = JSON.stringify(payload);
      const req = http.request(`http://127.0.0.1:${TEST_PORT}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      }, (res) => {
        let respData = '';
        res.on('data', chunk => { respData += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(respData)); }
          catch (e) { resolve(respData); }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    // Test initialize
    const initRes = await postRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        clientInfo: { name: 'test-client', version: '1.0.0' }
      }
    });
    assert.equal(initRes.jsonrpc, '2.0');
    assert.equal(initRes.id, 1);
    assert.equal(initRes.result.protocolVersion, '2024-11-05');
    assert.equal(initRes.result.serverInfo.name, 'zia-readonly-bridge');

    // Test tools/list
    const listRes = await postRpc({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {}
    });
    assert.equal(listRes.jsonrpc, '2.0');
    assert.equal(listRes.id, 2);
    assert.equal(listRes.result.tools.length, 4);

    // Test tools/call (readonly_file_info on AGENTS.md)
    const callRes = await postRpc({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'readonly_file_info',
        arguments: { path: 'AGENTS.md' }
      }
    });
    assert.equal(callRes.jsonrpc, '2.0');
    assert.equal(callRes.id, 3);
    assert.ok(callRes.result.content);
    const parsedContent = JSON.parse(callRes.result.content[0].text);
    assert.equal(parsedContent.path, 'AGENTS.md');
    assert.equal(parsedContent.type, 'file');

    // Test tools/call with illegal path (security test over HTTP)
    const illegalCallRes = await postRpc({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'readonly_read_file',
        arguments: { path: '/etc/hosts' }
      }
    });
    assert.equal(illegalCallRes.result.isError, true);
    const errContent = JSON.parse(illegalCallRes.result.content[0].text);
    assert.ok(errContent.error.includes('Security Violation'));

    // Cleanly stop HTTP server
    await new Promise(r => serverInstance.close(r));
  });
});
