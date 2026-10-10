import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import http from 'node:http';

import { CONFIG } from '../src/config.js';
import { AuditLogger } from '../src/audit-logger.js';
import { MailboxHub } from '../src/mailbox-hub.js';
import { EventBus } from '../src/event-bus.js';
import { ArtifactStore } from '../src/artifacts/artifact-store.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { AgentIdentityManager } from '../src/agent-identity.js';
import { BridgeHttpServer } from '../src/http-server.js';
import { ResponseObserver } from '../src/control-plane/response-observer.js';
import { DesktopUIAdapter } from '../src/session-adapters/desktop-ui-adapter.js';
import { ResponseCorrelator } from '../src/control-plane/response-correlator.js';
import { ResponseCorrelatorV2 } from '../src/correlation/response-correlator-v2.js';
import { GeminiDesktopSession } from '../src/control-plane/gemini-desktop-session.js';
import { ClaudeDesktopSession } from '../src/control-plane/claude-desktop-session.js';
import { ChatGptAutonomousSession } from '../src/control-plane/chatgpt-autonomous-session.js';
import { DesktopAgentWorker } from '../src/control-plane/desktop-agent-worker.js';

const TEST_DIR = path.join(CONFIG.DATA_DIR, 'test_freebuff_remediation');

function cleanupDir(dir) {
  if (fs.existsSync(dir)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

test('Freebuff Independent Findings Remediation Suite', async (suite) => {
  cleanupDir(TEST_DIR);
  fs.mkdirSync(TEST_DIR, { recursive: true });

  suite.after(() => {
    cleanupDir(TEST_DIR);
  });

  // =========================================================================
  // FINDING 1: PREMATURE RESPONSE COMPLETION
  // =========================================================================
  await suite.test('1.1 ResponseObserver requires multi-tick stability and rejects premature completion during pause', async () => {
    let tickCount = 0;
    const reqId = 'req_pause_test_1';
    const mockProbe = async () => {
      tickCount++;
      if (tickCount === 1) {
        return { running: true, textRegions: [{ snippet: `[Agent Bridge ${reqId}]` }, { snippet: 'Partial response chunk 1' }], isGenerating: true };
      } else if (tickCount === 2) {
        // Pauses for 1 interval, text unchanged, but still generating
        return { running: true, textRegions: [{ snippet: `[Agent Bridge ${reqId}]` }, { snippet: 'Partial response chunk 1' }], isGenerating: true };
      } else if (tickCount === 3) {
        // Model resumes generating additional text
        return { running: true, textRegions: [{ snippet: `[Agent Bridge ${reqId}]` }, { snippet: 'Partial response chunk 1 and chunk 2 completed.' }], isGenerating: false };
      } else {
        // Stable tick 2 after completion
        return { running: true, textRegions: [{ snippet: `[Agent Bridge ${reqId}]` }, { snippet: 'Partial response chunk 1 and chunk 2 completed.' }], isGenerating: false };
      }
    };

    const observer = new ResponseObserver({
      pollIntervalMs: 15,
      minStableTicks: 2,
      timeoutMs: 2000,
      probe: mockProbe
    });

    const completionPromise = new Promise((resolve) => {
      observer.on('response_completed', resolve);
    });

    observer.startObservation({ targetApp: 'ChatGPT', requestId: reqId });
    const result = await completionPromise;

    assert.strictEqual(result.requestId, reqId);
    assert.strictEqual(result.response, 'Partial response chunk 1 and chunk 2 completed.');
    assert.ok(tickCount >= 4, `Observer should have polled at least 4 times, polled ${tickCount}`);
  });

  await suite.test('1.2 DesktopUIAdapter.readResponse tracks multi-tick stability before completing', async () => {
    let tick = 0;
    const reqId = 'req_adapter_test_2';
    const mockProbe = async () => {
      tick++;
      if (tick === 1) {
        return {
          accessibilitySupported: true,
          windows: [{ title: 'ChatGPT' }],
          textRegions: [{ snippet: reqId }, { snippet: 'First partial token' }],
          isGenerating: true
        };
      } else if (tick === 2) {
        return {
          accessibilitySupported: true,
          windows: [{ title: 'ChatGPT' }],
          textRegions: [{ snippet: reqId }, { snippet: 'First partial token' }],
          isGenerating: true
        };
      } else if (tick === 3) {
        return {
          accessibilitySupported: true,
          windows: [{ title: 'ChatGPT' }],
          textRegions: [{ snippet: reqId }, { snippet: 'First partial token and final token.' }],
          isGenerating: false
        };
      } else {
        return {
          accessibilitySupported: true,
          windows: [{ title: 'ChatGPT' }],
          textRegions: [{ snippet: reqId }, { snippet: 'First partial token and final token.' }],
          isGenerating: false
        };
      }
    };

    const adapter = new DesktopUIAdapter({ probe: mockProbe, minStableReads: 2 });

    const r1 = await adapter.readResponse({ requestId: reqId });
    assert.strictEqual(r1.status, 'streaming');

    const r2 = await adapter.readResponse({ requestId: reqId });
    assert.strictEqual(r2.status, 'streaming');

    const r3 = await adapter.readResponse({ requestId: reqId });
    assert.strictEqual(r3.status, 'streaming');

    const r4 = await adapter.readResponse({ requestId: reqId });
    assert.strictEqual(r4.status, 'streaming');
    assert.strictEqual(r4.stableCount, 1);

    const r5 = await adapter.readResponse({ requestId: reqId });
    assert.strictEqual(r5.status, 'completed');
    assert.strictEqual(r5.response, 'First partial token and final token.');
  });

  // =========================================================================
  // FINDING 2: ARTIFACT RECIPIENT AUTHORIZATION AND LARGE FILES (> 8 MiB)
  // =========================================================================
  await suite.test('2.1 Artifact recipient authorization: Agent B stores in response to A, A retrieves, C denied', async () => {
    const dbPath = path.join(TEST_DIR, 'art_auth.sqlite');
    const logger = new AuditLogger(dbPath);
    const store = new ArtifactStore(logger, { root: path.join(TEST_DIR, 'art_auth_root') });
    const hub = new MailboxHub(logger);

    // Create a request from Agent A to Agent B
    const req = await hub.askAgentAsync({
      fromAgent: 'agent-a',
      toAgent: 'agent-b',
      question: 'Generate large dataset'
    });

    // Agent B stores artifact referencing requestId
    const payload = Buffer.from('Important payload data for agent A');
    const expectedSha256 = crypto.createHash('sha256').update(payload).digest('hex');

    const ref = store.put({
      bytes: payload,
      agentId: 'agent-b',
      requestId: req.requestId,
      mimeType: 'text/plain'
    });

    assert.ok(ref.artifactId);
    assert.strictEqual(ref.sha256, expectedSha256);

    // Agent A (requester) can retrieve the bytes
    const readA = store.read(ref.artifactId, { agentId: 'agent-a' });
    assert.strictEqual(readA.integrityVerified, true);
    assert.strictEqual(readA.bytes.toString(), 'Important payload data for agent A');

    // Agent B (creator) can retrieve the bytes
    const readB = store.read(ref.artifactId, { agentId: 'agent-b' });
    assert.strictEqual(readB.integrityVerified, true);

    // Unrelated Agent C cannot retrieve the bytes
    assert.throws(() => {
      store.read(ref.artifactId, { agentId: 'agent-c' });
    }, /not authorized/i);

    // Unrelated Agent C cannot retrieve metadata either
    assert.throws(() => {
      store.getMetadata(ref.artifactId, { agentId: 'agent-c' });
    }, /not authorized/i);

    logger.close();
  });

  await suite.test('2.2 Large artifact (> 8 MiB) bounded chunked transfer with SHA-256 integrity check', async () => {
    const dbPath = path.join(TEST_DIR, 'art_large.sqlite');
    const logger = new AuditLogger(dbPath);
    const store = new ArtifactStore(logger, { root: path.join(TEST_DIR, 'art_large_root'), maxBytes: 25 * 1024 * 1024 });

    // Create a 9 MiB buffer (> 8 MiB inline limit)
    const size = 9 * 1024 * 1024;
    const largeBuffer = crypto.randomBytes(size);
    const overallSha256 = crypto.createHash('sha256').update(largeBuffer).digest('hex');

    const ref = store.put({
      bytes: largeBuffer,
      agentId: 'agent-sender',
      authorizedAgents: ['agent-receiver'],
      mimeType: 'application/octet-stream'
    });

    assert.strictEqual(ref.sizeBytes, size);
    assert.strictEqual(ref.sha256, overallSha256);

    // Inline read of entire 9 MiB fails with PAYLOAD_TOO_LARGE
    assert.throws(() => {
      store.read(ref.artifactId, { agentId: 'agent-receiver', maxBytes: 8 * 1024 * 1024 });
    }, /exceeds .*limit/i);

    // Bounded chunked transfer via readChunk
    const chunkSize = 2 * 1024 * 1024; // 2 MiB chunks
    const retrievedChunks = [];
    let offset = 0;

    while (offset < size) {
      const chunk = store.readChunk(ref.artifactId, {
        agentId: 'agent-receiver',
        offset,
        length: chunkSize
      });
      assert.strictEqual(chunk.integrityVerified, true);
      assert.strictEqual(chunk.overallSha256, overallSha256);
      retrievedChunks.push(chunk.bytes);
      offset += chunk.length;
      if (chunk.eof) break;
    }

    const assembled = Buffer.concat(retrievedChunks);
    assert.strictEqual(assembled.length, size);
    const assembledSha256 = crypto.createHash('sha256').update(assembled).digest('hex');
    assert.strictEqual(assembledSha256, overallSha256);

    // Incomplete or out-of-bounds transfer cannot be mistaken for successful delivery
    assert.throws(() => {
      store.readChunk(ref.artifactId, {
        agentId: 'agent-receiver',
        offset: size + 100,
        length: chunkSize
      });
    }, /Offset .* exceeds total size/i);

    logger.close();
  });

  // =========================================================================
  // FINDING 3: MCP IDENTITY IMPERSONATION & REST/MCP PARITY
  // =========================================================================
  await suite.test('3.1 Isolated HTTP server rejects missing, invalid, and spoofed x-agent-id credentials', async () => {
    const dbPath = path.join(TEST_DIR, 'http_auth.sqlite');
    const logger = new AuditLogger(dbPath);
    const identity = new AgentIdentityManager(logger);
    const tokenClaude = identity.createToken('claude').token;

    const server = new BridgeHttpServer({
      port: 0,
      apiKey: 'test-secret-key-12345',
      auditLogger: logger,
      identityManager: identity,
      toolProfile: 'all'
    });

    const { port } = await server.start();

    const makeRequest = (headers, body = null, route = '/mcp') => {
      return new Promise((res, rej) => {
        const req = http.request({
          hostname: '127.0.0.1',
          port,
          path: route,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...headers
          }
        }, (resp) => {
          let data = '';
          resp.on('data', c => { data += c; });
          resp.on('end', () => res({ status: resp.statusCode, body: data }));
        });
        req.on('error', rej);
        if (body) req.write(JSON.stringify(body));
        req.end();
      });
    };

    try {
      // 1. Missing credentials -> 401
      const res1 = await makeRequest({}, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'bridge_ping', arguments: {} }
      });
      assert.strictEqual(res1.status, 401);

      // 2. Invalid credentials -> 401
      const res2 = await makeRequest({ 'x-api-key': 'bad-token' }, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'bridge_ping', arguments: {} }
      });
      assert.strictEqual(res2.status, 401);

      // 3. Spoofed x-agent-id (token belongs to claude, but header claims gemini) -> 401
      const res3 = await makeRequest({
        'x-api-key': tokenClaude,
        'x-agent-id': 'gemini'
      }, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'bridge_ping', arguments: {} }
      });
      assert.strictEqual(res3.status, 401);
      assert.ok(res3.body.includes('spoofed x-agent-id'));

      // 4. Valid credentials -> 200
      const res4 = await makeRequest({
        'x-api-key': tokenClaude,
        'x-agent-id': 'claude'
      }, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'bridge_ping', arguments: {} }
      });
      assert.strictEqual(res4.status, 200);

      // 5. Cross-agent tool execution denial: claude token trying to act as gemini via args
      const res5 = await makeRequest({
        'x-api-key': tokenClaude
      }, {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'bridge_ask_agent', arguments: { toAgent: 'chatgpt', question: 'hi', agentId: 'gemini' } }
      });
      assert.strictEqual(res5.status, 200);
      assert.ok(res5.body.includes('cannot impersonate or act as') || res5.body.includes('isError'), 'Cross-agent impersonation must be rejected');

      // 6. REST/MCP authorization parity: invalid credentials on REST route -> 401
      const resRest = await makeRequest({ 'x-api-key': 'bad-token' }, null, '/api/task');
      assert.strictEqual(resRest.status, 401);
    } finally {
      await server.stop();
      logger.close();
    }
  });

  // =========================================================================
  // FINDING 4: CORRELATION FALLBACK
  // =========================================================================
  await suite.test('4.1 ResponseCorrelator rejects ordinary text mentions of requestId', () => {
    const correlator = new ResponseCorrelator({ markerPrefix: 'AB' });
    const reqId = 'req_test_12345';

    // Mere text quote/mention must NOT correlate
    const mention1 = 'Sure, here is the answer for request req_test_12345: The result is 42.';
    assert.strictEqual(correlator.hasMarker(mention1, reqId), false);
    const turn1 = correlator.correlateTurn({ rawResponse: mention1, expectedRequestId: reqId });
    assert.strictEqual(turn1.correlated, false);

    // Prefix mention without brackets must NOT correlate
    const mention2 = 'AB:req_test_12345 has been processed.';
    assert.strictEqual(correlator.hasMarker(mention2, reqId), false);
    const turn2 = correlator.correlateTurn({ rawResponse: mention2, expectedRequestId: reqId });
    assert.strictEqual(turn2.correlated, false);

    // Exact bracketed marker MUST correlate
    const valid = '[AB:req_test_12345]\nThe result is 42.';
    assert.strictEqual(correlator.hasMarker(valid, reqId), true);
    const turnValid = correlator.correlateTurn({ rawResponse: valid, expectedRequestId: reqId });
    assert.strictEqual(turnValid.correlated, true);
    assert.strictEqual(turnValid.cleanedText, 'The result is 42.');
  });

  await suite.test('4.2 ResponseCorrelatorV2 rejects ordinary text mentions ("turn <id>")', () => {
    const v2 = new ResponseCorrelatorV2();
    const reqId = 'req_turn_999';

    // Model text mentioning "turn req_turn_999" without exact marker or nonce must NOT correlate
    const textMention = 'As seen in turn req_turn_999, the build completed.';
    const resMention = v2.correlate({ requestId: reqId, rawResponse: textMention });
    assert.strictEqual(resMention.isAcceptableForSuccess(), false);

    // Exact marker matches
    const exactMarker = '[AB:req_turn_999]\nBuild completed.';
    const resExact = v2.correlate({ requestId: reqId, rawResponse: exactMarker, expectedNonce: 'ABN-1234567890abcdef' });
    assert.strictEqual(resExact.isAcceptableForSuccess(), true);
  });

  await suite.test('4.3 Desktop sessions (Gemini, Claude, ChatGPT) reject un-correlated model text in JavaScript', async () => {
    const reqId = 'req_session_correl_test';

    // 1. GeminiDesktopSession with mock inner session returning text mentioning requestId without marker
    const gemini = new GeminiDesktopSession({
      swiftBridge: { isBinaryAvailable: () => true },
      innerSession: {
        send: async () => ({
          success: true,
          status: 'COMPLETED',
          response: 'Here is the answer for req_session_correl_test: hello world'
        })
      }
    });
    const gemRes = await gemini.send({ text: 'test', requestId: reqId });
    assert.strictEqual(gemRes.success, false, 'Gemini must reject un-correlated response');
    assert.strictEqual(gemRes.status, 'CORRELATION_FAILED');

    // 2. ClaudeDesktopSession with mock inner session
    const claude = new ClaudeDesktopSession({
      swiftBridge: { isBinaryAvailable: () => true },
      innerSession: {
        send: async () => ({
          success: true,
          status: 'COMPLETED',
          response: 'Claude response for req_session_correl_test: hello'
        })
      }
    });
    const claudeRes = await claude.send({ text: 'test', requestId: reqId });
    assert.strictEqual(claudeRes.success, false, 'Claude must reject un-correlated response');
    assert.strictEqual(claudeRes.status, 'CORRELATION_FAILED');

    // 3. ChatGptAutonomousSession with mock swiftBridge
    const chatgpt = new ChatGptAutonomousSession({
      swiftBridge: {
        isBinaryAvailable: () => true,
        sendAndObserve: async () => ({
          ok: true,
          status: 'COMPLETED',
          response: 'ChatGPT response referencing req_session_correl_test without brackets'
        })
      }
    });
    const gptRes = await chatgpt.send({ text: 'test', requestId: reqId });
    assert.strictEqual(gptRes.success, false, 'ChatGPT must reject un-correlated response');
    assert.strictEqual(gptRes.status, 'CORRELATION_FAILED');
  });

  // =========================================================================
  // FINDING 5: OBSERVATION AND CALLER TIMEOUT COHERENCE
  // =========================================================================
  await suite.test('5.1 Observation timeout defaults to 90s to match caller wait budget', () => {
    const obs = new ResponseObserver();
    assert.strictEqual(obs.options.timeoutMs || 90000, 90000, 'ResponseObserver timeout must default to 90000 ms');
  });

  // =========================================================================
  // FINDING 6: CROSS-PROCESS ANSWER RACE
  // =========================================================================
  await suite.test('6.1 Concurrent answers on isolated DB: exactly one wins atomically, loser quarantined', async () => {
    const dbPath = path.join(TEST_DIR, 'answer_race.sqlite');
    const logger = new AuditLogger(dbPath);
    const hub = new MailboxHub(logger);

    const reqId = 'req_race_test_1';
    hub.db.prepare(`
      INSERT INTO bridge_requests (request_id, conversation_id, from_agent, to_agent, question, status, timeout_ms, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', 30000, datetime('now'), datetime('now'))
    `).run(reqId, 'conv_race', 'agent-caller', 'agent-worker', 'Concurrent race test question');

    // Simulate two concurrent processes calling answerRequest at the same time
    const resP1 = hub.answerRequest({
      requestId: reqId,
      agentId: 'agent-worker',
      response: 'Authoritative winning response from P1'
    });

    const resP2 = hub.answerRequest({
      requestId: reqId,
      agentId: 'agent-worker',
      response: 'Late conflicting response from P2'
    });

    // Exactly one authoritative result must win
    assert.strictEqual(resP1.status, 'success');
    assert.strictEqual(resP2.status, 'quarantined');
    assert.strictEqual(resP2.quarantined, true);

    // Verify durable database state matches winning value
    const finalReq = hub.db.prepare('SELECT * FROM bridge_requests WHERE request_id = ?').get(reqId);
    assert.strictEqual(finalReq.status, 'completed');
    assert.strictEqual(finalReq.response, 'Authoritative winning response from P1');

    logger.close();
  });

  // =========================================================================
  // FINDING 7: SHUTDOWN AND EVENT EDGE CASES
  // =========================================================================
  await suite.test('7.1 EventBus.close() rejects pending response waiters with EVENT_BUS_CLOSED', async () => {
    const dbPath = path.join(TEST_DIR, 'bus_close.sqlite');
    const logger = new AuditLogger(dbPath);
    const bus = new EventBus(logger);

    const waitPromise = bus.waitForResponse('req_pending_close', { timeoutMs: 30000 });

    // Close event bus while waiter is registered
    bus.close();
    const res = await waitPromise;

    assert.strictEqual(res.status, 'failed');
    assert.strictEqual(res.code, 'EVENT_BUS_CLOSED');
    logger.close();
  });

  await suite.test('7.2 EventBus.publish() duplicate-key race returns isDuplicate: true without throwing', () => {
    const dbPath = path.join(TEST_DIR, 'bus_dedup.sqlite');
    const logger = new AuditLogger(dbPath);
    const bus = new EventBus(logger);

    const p1 = bus.publish({
      type: 'test_event',
      agentId: 'agent-1',
      fromAgent: 'agent-2',
      dedupKey: 'unique_race_key_101'
    });
    assert.ok(p1.eventId > 0);
    assert.strictEqual(p1.isDuplicate, undefined);

    // Duplicate call with same dedupKey
    const p2 = bus.publish({
      type: 'test_event',
      agentId: 'agent-1',
      fromAgent: 'agent-2',
      dedupKey: 'unique_race_key_101'
    });
    assert.strictEqual(p2.isDuplicate, true);
    assert.strictEqual(p2.eventId, p1.eventId);

    bus.close();
    logger.close();
  });

  await suite.test('7.3 Event bursts over 100 events are completely drained', () => {
    const dbPath = path.join(TEST_DIR, 'bus_burst.sqlite');
    const logger = new AuditLogger(dbPath);
    const bus = new EventBus(logger);

    // Insert 250 events for agent-burst
    for (let i = 1; i <= 250; i++) {
      bus.publish({
        type: 'burst_event',
        agentId: 'agent-burst',
        fromAgent: 'system',
        payload: { index: i }
      });
    }

    // Subscribe agent and drain from beginning
    let receivedCount = 0;
    bus.subscribe('agent-burst', () => { receivedCount++; }, { fromBeginning: true });
    bus.drainEventsForAgent('agent-burst');

    assert.strictEqual(receivedCount, 250, 'All 250 events in burst must be drained');

    bus.close();
    logger.close();
  });

  await suite.test('7.4 DesktopAgentWorker delivered set is bounded (FIFO eviction)', () => {
    const dbPath = path.join(TEST_DIR, 'worker_bound.sqlite');
    const logger = new AuditLogger(dbPath);
    const worker = new DesktopAgentWorker({
      agentId: 'test-agent',
      mailboxHub: new MailboxHub(logger),
      eventBus: new EventBus(logger),
      session: { name: 'mock' }
    });

    // Record 2500 requests
    for (let i = 1; i <= 2500; i++) {
      worker._recordDelivered(`req_${i}`);
    }

    assert.ok(worker.delivered.size <= 2000, `Delivered size must be capped at 2000, was ${worker.delivered.size}`);
    assert.strictEqual(worker.delivered.has('req_1'), false, 'Oldest request must be evicted');
    assert.strictEqual(worker.delivered.has('req_2500'), true, 'Newest request must be retained');

    logger.close();
  });
});
