import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { BridgeHttpServer } from '../src/http-server.js';
import { AuditLogger } from '../src/audit-logger.js';

test('MCP Transport Conformance Suite', async (t) => {
  const testPort = 19890;
  const logger = new AuditLogger(':memory:');
  const server = new BridgeHttpServer({
    port: testPort,
    host: '127.0.0.1',
    auditLogger: logger,
    permissionGuard: { config: { AGENT_IDENTITIES: ['chatgpt-desktop', 'claude-desktop', 'antigravity-ide'] } },
    toolRegistry: {
      getToolDefinitions: () => [
        {
          name: 'bridge_ping',
          description: 'Ping tool',
          inputSchema: { type: 'object', properties: {} }
        },
        {
          name: 'bridge_echo',
          description: 'Echo tool',
          inputSchema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] }
        }
      ],
      executeTool: async (name, args) => {
        if (name === 'bridge_ping') return { status: 'healthy', timestamp: Date.now() };
        if (name === 'bridge_echo') return { echoed: args.msg };
        throw new Error(`Tool ${name} not found`);
      }
    }
  });

  await server.start();

  try {
    await t.test('1. Official MCP SDK Client + SSEClientTransport End-to-End Interop', async () => {
      const sseUrl = new URL(`http://127.0.0.1:${testPort}/sse`);
      const transport = new SSEClientTransport(sseUrl);
      const client = new Client(
        { name: 'conformance-test-client', version: '1.0.0' },
        { capabilities: {} }
      );

      await client.connect(transport);

      // Verify tools/list
      const toolList = await client.listTools();
      assert.ok(Array.isArray(toolList.tools));
      const toolNames = toolList.tools.map(tool => tool.name);
      assert.ok(toolNames.includes('bridge_ping'));
      assert.ok(toolNames.includes('bridge_echo'));

      // Verify tools/call
      const pingResult = await client.callTool({ name: 'bridge_ping', arguments: {} });
      assert.ok(pingResult.content && pingResult.content.length > 0);
      const pingText = pingResult.content[0].text;
      assert.ok(pingText.includes('healthy'));

      const echoResult = await client.callTool({ name: 'bridge_echo', arguments: { msg: 'Hello MCP' } });
      assert.ok(echoResult.content[0].text.includes('Hello MCP'));

      await client.close();
    });

    await t.test('2. Direct HTTP JSON-RPC Client (Without SSE Session) returns 200 with JSON body', async () => {
      // POST to canonical /mcp
      const res = await fetch(`http://127.0.0.1:${testPort}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'test_direct_1',
          method: 'tools/call',
          params: { name: 'bridge_echo', arguments: { msg: 'Direct HTTP' } }
        })
      });

      assert.equal(res.status, 200);
      assert.ok(res.headers.get('content-type')?.includes('application/json'));
      const json = await res.json();
      assert.equal(json.jsonrpc, '2.0');
      assert.equal(json.id, 'test_direct_1');
      assert.ok(json.result.content[0].text.includes('Direct HTTP'));

      // POST to SDK alias /api/mcp/call
      const aliasRes = await fetch(`http://127.0.0.1:${testPort}/api/mcp/call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'test_direct_alias',
          method: 'tools/call',
          params: { name: 'bridge_ping', arguments: {} }
        })
      });
      assert.equal(aliasRes.status, 200);
      const aliasJson = await aliasRes.json();
      assert.ok(aliasJson.result.content[0].text.includes('healthy'));
    });

    await t.test('3. Notifications (without id or notifications/*) return 202 Accepted without response body', async () => {
      const res = await fetch(`http://127.0.0.1:${testPort}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/initialized'
        })
      });

      assert.equal(res.status, 202);
      const text = await res.text();
      assert.equal(text, 'Accepted');
    });

    await t.test('4. Invalid or Stale Session ID on POST returns 404 with code -32001', async () => {
      const res = await fetch(`http://127.0.0.1:${testPort}/mcp?sessionId=non_existent_session_id`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 999,
          method: 'tools/list'
        })
      });

      assert.equal(res.status, 404);
      const json = await res.json();
      assert.equal(json.error.code, -32001);
      assert.ok(json.error.message.includes('Session not found'));
    });

    await t.test('5. Session Termination via DELETE /mcp closes session cleanly', async () => {
      // Connect SSE to obtain a session ID
      const sseRes = await fetch(`http://127.0.0.1:${testPort}/sse`);
      assert.equal(sseRes.status, 200);

      const reader = sseRes.body.getReader();
      const { value } = await reader.read();
      const sseText = new TextDecoder().decode(value);
      const match = sseText.match(/sessionId=([a-f0-9-]+)/);
      assert.ok(match, 'Must find sessionId in endpoint event');
      const sessionId = match[1];

      // Send DELETE /mcp?sessionId=...
      const delRes = await fetch(`http://127.0.0.1:${testPort}/mcp?sessionId=${sessionId}`, {
        method: 'DELETE'
      });
      assert.equal(delRes.status, 204);

      // Verify that subsequent POST with that sessionId now returns 404
      const postAfterDel = await fetch(`http://127.0.0.1:${testPort}/mcp?sessionId=${sessionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1001,
          method: 'tools/list'
        })
      });
      assert.equal(postAfterDel.status, 404);
      reader.cancel();
    });

    await t.test('6. Concurrent SSE Clients: Independent sessions do not cross-deliver or conflict', async () => {
      const t1 = new SSEClientTransport(new URL(`http://127.0.0.1:${testPort}/sse`));
      const c1 = new Client({ name: 'client-1', version: '1.0' }, { capabilities: {} });
      await c1.connect(t1);

      const t2 = new SSEClientTransport(new URL(`http://127.0.0.1:${testPort}/sse`));
      const c2 = new Client({ name: 'client-2', version: '1.0' }, { capabilities: {} });
      await c2.connect(t2);

      const [r1, r2] = await Promise.all([
        c1.callTool({ name: 'bridge_echo', arguments: { msg: 'Client 1 message' } }),
        c2.callTool({ name: 'bridge_echo', arguments: { msg: 'Client 2 message' } })
      ]);

      assert.ok(r1.content[0].text.includes('Client 1 message'));
      assert.ok(r2.content[0].text.includes('Client 2 message'));

      await Promise.all([c1.close(), c2.close()]);
    });

    await t.test('7. Error Handling: Unknown method returns code -32601, missing params returns -32602', async () => {
      const unkRes = await fetch(`http://127.0.0.1:${testPort}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 404,
          method: 'non_existent_method'
        })
      });
      const unkJson = await unkRes.json();
      assert.equal(unkJson.error.code, -32601);

      const noNameRes = await fetch(`http://127.0.0.1:${testPort}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 405,
          method: 'tools/call',
          params: {}
        })
      });
      const noNameJson = await noNameRes.json();
      assert.equal(noNameJson.error.code, -32602);
    });
  } finally {
    await server.stop();
  }
});
