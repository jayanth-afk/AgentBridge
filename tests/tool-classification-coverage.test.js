import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { ToolRegistry } from '../src/tool-registry.js';
import {
  TOOL_EFFECT_CLASSIFICATIONS,
  EffectClassification,
  getToolClassification,
  isEffectfulTool,
  PUBLIC_TOOLS
} from '../src/effects/effects-ledger.js';
import { BridgeHttpServer } from '../src/http-server.js';
import { AuditLogger } from '../src/audit-logger.js';
import { EventBus } from '../src/event-bus.js';
import { TaskManager } from '../src/task-manager.js';
import { MailboxHub } from '../src/mailbox-hub.js';

test('A2: Every registered tool has an explicit classification (Default-Deny CI check)', () => {
  const registry = new ToolRegistry();
  const allTools = registry.getToolDefinitions('all');

  // Dynamic tools in ToolRegistry that may be handled lazily
  const dynamicTools = [
    'bridge_acknowledge_delivery',
    'bridge_explain_request',
    'bridge_request_ledger',
    'bridge_wait_for_response',
    'bridge_slice_fetch',
    'bridge_get_protocol_snippet',
    'bridge_list_skills',
    'bridge_get_skill',
    'bridge_get_skill_resource',
    'bridge_search_skills',
    'bridge_skill_load'
  ];

  const toolNames = new Set([
    ...allTools.map(t => t.name),
    ...dynamicTools
  ]);

  const missingClassification = [];
  for (const name of toolNames) {
    if (!TOOL_EFFECT_CLASSIFICATIONS[name]) {
      missingClassification.push(name);
    }
  }

  assert.deepStrictEqual(
    missingClassification,
    [],
    `The following registered tools lack explicit classification in TOOL_EFFECT_CLASSIFICATIONS: ${missingClassification.join(', ')}`
  );

  // Assert unclassified tools default to NON_IDEMPOTENT (fail-closed effectful)
  const unclassified = 'unclassified_future_tool';
  assert.strictEqual(getToolClassification(unclassified), EffectClassification.NON_IDEMPOTENT);
  assert.strictEqual(isEffectfulTool(unclassified), true);
});

test('A2: HTTP default-deny gate: unauthenticated loopback rejected for non-public tools', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'classification-http-'));
  const logger = new AuditLogger(path.join(tmpDir, 'test.sqlite'));
  const eventBus = new EventBus(logger);
  const taskManager = new TaskManager(logger, null, eventBus);
  const mailbox = new MailboxHub(logger, taskManager, eventBus);
  const registry = new ToolRegistry();

  const server = new BridgeHttpServer({
    port: 0,
    host: '127.0.0.1',
    apiKey: null, // No control-plane key configured
    auditLogger: logger,
    mailboxHub: mailbox,
    toolRegistry: registry
  });

  const bound = await server.start();

  t.after(async () => {
    try { await server.stop(); } catch {}
    try { eventBus.close(); } catch {}
    try { logger.close(); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  function rpc(body) {
    return fetch(`http://127.0.0.1:${bound.port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(async res => ({ status: res.status, json: await res.json().catch(() => null) }));
  }

  // 1. Explicitly public tool (bridge_ping) succeeds without credentials
  const pingRes = await rpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'bridge_ping', arguments: {} }
  });
  assert.strictEqual(pingRes.status, 200, 'Public tool bridge_ping must succeed with status 200');

  // 2. Sensitive and effectful tools must be rejected with 401 when no credentials are provided
  const toolsToVerifyRejected = [
    'bridge_request_ledger',
    'bridge_slice_fetch',
    'bridge_wait_for_response',
    'bridge_skill_load',
    'bridge_get_protocol_snippet',
    'bridge_discover_tools',
    'bridge_artifact_get',
    'bridge_artifact_read',
    'bridge_artifact_cleanup',
    'bridge_delete_file',
    'bridge_execute_command',
    'bridge_git_commit'
  ];

  for (const toolName of toolsToVerifyRejected) {
    const res = await rpc({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: toolName, arguments: {} }
    });
    assert.strictEqual(
      res.status,
      401,
      `Expected tool '${toolName}' to be rejected with HTTP 401 on unauthenticated loopback, got status ${res.status}`
    );
    assert.strictEqual(res.json?.ok, false);
    assert.match(res.json?.error, /Unauthorized/i);
  }
});
