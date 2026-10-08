import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentBridgeClient } from '../src/client/bridge-client.js';

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
});
