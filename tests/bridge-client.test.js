import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';

import { CONFIG } from '../src/config.js';
import { AuditLogger } from '../src/audit-logger.js';
import { PermissionGuard } from '../src/permission-guard.js';
import { MailboxHub } from '../src/mailbox-hub.js';
import { BridgeHttpServer } from '../src/http-server.js';
import { AgentBridgeClient } from '../src/client/bridge-client.js';

const TEST_DB = path.join(CONFIG.DATA_DIR, 'test_bridge_client.sqlite');

test('AgentBridgeClient: Zia-facing SDK Interface', async (t) => {
  const client = new AgentBridgeClient({
    baseUrl: 'http://127.0.0.1:8765',
    apiKey: 'test-secret-key-123',
    agentId: 'zia-core'
  });

  await t.test('1. Client formats tool call payloads with agent authentication', async () => {
    let capturedUrl = null;
    let capturedOptions = null;

    // Mock internal _request
    client._request = async (endpoint, options) => {
      capturedUrl = endpoint;
      capturedOptions = options;
      return { result: 'ok' };
    };

    await client.askAgent({
      toAgent: 'chatgpt-desktop',
      question: 'Evaluate migration plan'
    });

    assert.equal(capturedUrl, '/api/mcp/call');
    assert.equal(capturedOptions.method, 'POST');

    const body = JSON.parse(capturedOptions.body);
    assert.equal(body.method, 'tools/call');
    assert.equal(body.params.name, 'bridge_ask_agent');
    assert.equal(body.params.arguments.fromAgent, 'zia-core');
    assert.equal(body.params.arguments.toAgent, 'chatgpt-desktop');
    assert.equal(body.params.arguments.question, 'Evaluate migration plan');
  });

  await t.test('2. Client formats explainRequest calls', async () => {
    let capturedPayload = null;
    client._request = async (endpoint, options) => {
      capturedPayload = JSON.parse(options.body);
      return { found: true };
    };

    await client.explainRequest('req_test_123');
    assert.equal(capturedPayload.params.name, 'bridge_explain_request');
    assert.equal(capturedPayload.params.arguments.requestId, 'req_test_123');
  });

  await t.test('3. Client reaches the LIVE HTTP control plane end to end', async (sub) => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    const logger = new AuditLogger(TEST_DB);
    const mailbox = new MailboxHub(logger);
    const server = new BridgeHttpServer({
      port: 8791,
      host: '127.0.0.1',
      auditLogger: logger,
      permissionGuard: new PermissionGuard(CONFIG),
      mailboxHub: mailbox
    });
    await server.start();

    sub.after(async () => {
      await server.stop();
      try { mailbox.eventBus.close(); } catch {}
      try { logger.close(); } catch {}
      try { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); } catch {}
    });

    const live = new AgentBridgeClient({ baseUrl: 'http://127.0.0.1:8791', agentId: 'chatgpt-desktop' });

    // /health is served and reachable.
    const health = await live.ping();
    assert.equal(health.status, 'healthy');

    // A tool call must NOT 404 — this is the regression this test guards.
    const discovered = await live.discoverAgents();
    assert.ok(discovered && discovered.result, 'discoverAgents must return a JSON-RPC result, not a 404');
    assert.ok(Array.isArray(discovered.result.content), 'tool result content must be present');

    // Full correlated request/response through HTTP + registry + durable mailbox.
    const subscription = mailbox.eventBus.subscribe('claude-desktop', (event) => {
      if (event.type !== 'request_created' || !event.requestId) return;
      setTimeout(() => {
        const request = mailbox.getRequest(event.requestId);
        if (!request || request.status !== 'pending') return;
        mailbox.submitTaskResult({
          taskId: request.taskId,
          agentId: 'claude-desktop',
          status: 'completed',
          result: 'HTTP_ANSWER_OK'
        });
      }, 0);
    });

    const asked = await live.askAgent({ toAgent: 'claude-desktop', question: 'hello over http', timeoutMs: 5000 });
    assert.ok(asked && asked.result, 'askAgent must return a JSON-RPC result');
    const askedPayload = JSON.parse(asked.result.content[0].text);
    assert.equal(askedPayload.status, 'completed');
    assert.equal(askedPayload.response, 'HTTP_ANSWER_OK');

    subscription.unsubscribe();
  });
});
