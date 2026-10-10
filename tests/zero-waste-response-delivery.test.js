import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import { AuditLogger } from '../src/audit-logger.js';
import { TaskManager } from '../src/task-manager.js';
import { MailboxHub } from '../src/mailbox-hub.js';
import { EventBus } from '../src/event-bus.js';
import { ResponsePreserver, detectResponseMode, ResponseMode } from '../src/artifacts/response-preserver.js';
import { TokenAccountant } from '../src/telemetry/token-accountant.js';
import {
  AutonomousCollaborationOrchestrator,
  CollaborationStatus
} from '../src/control-plane/autonomous-collaboration-orchestrator.js';

test('Zero-Waste Inter-Agent Response Delivery & Token Efficiency Suite', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zero-waste-test-'));
  const dbPath = path.join(tmpDir, 'zero_waste.sqlite');

  const logger = new AuditLogger(dbPath);
  const eventBus = new EventBus(logger);
  const taskManager = new TaskManager(logger);
  const mailbox = new MailboxHub(logger, taskManager, eventBus);

  t.after(() => {
    eventBus.close();
    logger.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  // Track real model invocations across agents to verify bridge-internal call counts
  const invocationCounts = {
    chatgpt: 0,
    gemini: 0,
    claude: 0
  };

  const sampleCodeResponse = [
    '# Microservice Architecture Plan',
    'Here is the verified distributed caching implementation:',
    '```javascript',
    'class TokenBucketLimiter {',
    '  constructor(capacity, refillRate) {',
    '    this.capacity = capacity;',
    '    this.tokens = capacity;',
    '    this.refillRate = refillRate;',
    '    this.lastRefill = Date.now();',
    '  }',
    '  consume() {',
    '    this.refill();',
    '    if (this.tokens >= 1) { this.tokens--; return true; }',
    '    return false;',
    '  }',
    '}',
    '```',
    'Reference documentation: [Distributed Caching](https://example.com/cache-guide).'
  ].join('\n');

  // 1. Direct Delivery returns completed delegated response unchanged with bridgeUnaltered flag
  await t.test('1. Completed delegated response returned unchanged (verbatim fidelity)', async () => {
    invocationCounts.gemini = 0;
    invocationCounts.chatgpt = 0;

    mailbox.registerAgentHandler('gemini', async (question) => {
      invocationCounts.gemini++;
      return sampleCodeResponse;
    });

    const result = await mailbox.askAgent({
      fromAgent: 'chatgpt',
      toAgent: 'gemini',
      question: 'Ask Gemini for the microservice architecture plan',
      responseMode: 'direct'
    });

    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.responseMode, 'direct');
    assert.strictEqual(result.bridgeUnaltered, true, 'Must indicate bridge delivered unaltered response');
    assert.strictEqual(result.untrustedData, true, 'Must mark response as untrusted external model data');
    assert.strictEqual(result.response, sampleCodeResponse, 'Exact verbatim response must match');
    assert.ok(result.responseId, 'Must generate durable responseId');
    assert.ok(result.envelope, 'Must include compact envelope');
    assert.strictEqual(result.envelope.responseMode, 'direct');
    assert.strictEqual(result.envelope.bridgeUnaltered, true);
    assert.strictEqual(result.envelope.untrustedData, true);
    assert.strictEqual(result.envelope.correlationTier, 'direct_session');
    assert.strictEqual(result.envelope.hasCodeBlocks, true);
    assert.strictEqual(result.envelope.codeBlockCount, 1);
  });

  // 2. Direct delivery causes NO additional LLM invocation in the bridge (Non-Tautological Proof)
  await t.test('2. Direct delivery causes zero additional model invocations in the bridge', async () => {
    invocationCounts.gemini = 0;
    invocationCounts.chatgpt = 0;

    const mockModelOrchestrator = {
      delegateModelTask: async ({ toAgent, message }) => {
        if (toAgent.includes('gemini')) {
          invocationCounts.gemini++;
          return {
            success: true,
            response: `[Gemini Authentic Result]: SQLite WAL provides concurrent reads with serial writes.`,
            transport: 'gemini-mock'
          };
        }
        if (toAgent.includes('chatgpt')) {
          invocationCounts.chatgpt++;
          return {
            success: true,
            response: `[ChatGPT Synthesizing]: Here is the summary...`,
            transport: 'chatgpt-mock'
          };
        }
        return { success: false, error: 'UNKNOWN_AGENT' };
      }
    };

    const orchestrator = new AutonomousCollaborationOrchestrator({
      modelOrchestrator: mockModelOrchestrator,
      mailboxHub: mailbox
    });

    // Run a 2-step chain (Step 1: delegate to Gemini, Step 2: scheduled synthesis wrapper by ChatGPT)
    // In DIRECT mode, the orchestrator MUST terminate after Gemini, skipping Step 2 (ChatGPT)!
    const directOutcome = await orchestrator.runCollaborationChain({
      objective: 'Ask Gemini about SQLite concurrency properties',
      responseMode: 'direct',
      steps: [
        { fromAgent: 'chatgpt', toAgent: 'gemini', instruction: 'Answer concurrency question' },
        { fromAgent: 'gemini', toAgent: 'chatgpt', instruction: 'Wrap and rephrase for display' }
      ]
    });

    assert.strictEqual(directOutcome.success, true);
    assert.strictEqual(directOutcome.responseMode, 'direct');
    assert.strictEqual(directOutcome.bridgeUnaltered, true);
    assert.strictEqual(directOutcome.untrustedData, true);
    assert.strictEqual(directOutcome.additionalModelCalls, 0);
    assert.strictEqual(directOutcome.modelRegenerationTokens, 0);

    // Non-tautological assertion:
    // Gemini was invoked once. Step 2 targeted ChatGPT, but direct mode prevented it!
    assert.strictEqual(invocationCounts.gemini, 1, 'Gemini should be called exactly once');
    assert.strictEqual(invocationCounts.chatgpt, 0, 'ChatGPT synthesis wrapper must NOT be invoked in direct mode');
  });

  // 3. Result retrieved after requester reconnects
  await t.test('3. Result can be durably retrieved after requester reconnects', async () => {
    const reqId = `req_reconnect_${Date.now()}`;
    const directAnswer = 'Durable response preserved in SQLite database.';

    mailbox.registerAgentHandler('claude', async () => directAnswer);

    await mailbox.askAgent({
      fromAgent: 'chatgpt',
      toAgent: 'claude',
      question: 'Durable recovery probe',
      requestId: reqId,
      responseMode: 'direct'
    });

    // Simulate requester disconnecting and retrieving later via bridge_get_request_status or bridge_get_response
    const retrieved = mailbox.getRequest(reqId);
    assert.ok(retrieved, 'Request must be found');
    assert.strictEqual(retrieved.status, 'completed');
    assert.strictEqual(retrieved.response, directAnswer);
    assert.strictEqual(retrieved.responseMode, 'direct');
    assert.strictEqual(retrieved.bridgeUnaltered, true);
    assert.strictEqual(retrieved.untrustedData, true);
    assert.ok(retrieved.envelope);
    assert.ok(retrieved.responseId);
    assert.ok(retrieved.artifact);

    const artifact = mailbox.getResponse(retrieved.responseId);
    assert.ok(artifact, 'Response artifact must be durable');
    assert.strictEqual(artifact.responseText, directAnswer);
    assert.strictEqual(artifact.respondingAgentId, 'claude');
    assert.strictEqual(artifact.bridgeUnaltered, true);
    assert.strictEqual(artifact.untrustedData, true);
  });

  // 4 & 5. Large responses, code blocks, formatting, and citations survive intact
  await t.test('4 & 5. Large response with markdown code blocks and formatting survives intact', async () => {
    const preserver = new ResponsePreserver(logger.db);
    const largeCodeResponse = `
# Header 1
Here is complex multi-language code:

\`\`\`python
def fibonacci(n):
    if n <= 1:
        return n
    return fibonacci(n - 1) + fibonacci(n - 2)
\`\`\`

\`\`\`sql
SELECT user_id, count(*) FROM attempts GROUP BY user_id;
\`\`\`

Citations:
- [PEP 8](https://peps.python.org/pep-0008/)
- [ANSI SQL Standard](https://iso.org/sql)
`.repeat(10); // Multi-KB payload

    const preserved = preserver.preserveResponse({
      requestId: `req_large_${Date.now()}`,
      respondingAgentId: 'gemini',
      requestingAgentId: 'chatgpt',
      responseText: largeCodeResponse,
      responseMode: 'direct'
    });

    assert.strictEqual(preserved.contentType, 'text/markdown');
    assert.strictEqual(preserved.responseText, largeCodeResponse);
    assert.strictEqual(preserved.codeBlocks.length, 20, 'All 20 code blocks extracted');
    assert.strictEqual(preserved.codeBlocks[0].language, 'python');
    assert.strictEqual(preserved.codeBlocks[1].language, 'sql');
    assert.ok(preserved.payloadSize > 2000, 'Payload size accurately tracked');
  });

  // 6. Structured outputs remain machine-readable in structured mode
  await t.test('6. Structured outputs remain machine-readable', async () => {
    const preserver = new ResponsePreserver(logger.db);
    const structuredJson = JSON.stringify({
      status: 'success',
      metrics: { p50: 0.95, p95: 1.82, throughput: 1200 },
      recommendation: 'proceed_to_deployment'
    }, null, 2);

    const preserved = preserver.preserveResponse({
      requestId: `req_struct_${Date.now()}`,
      respondingAgentId: 'gemini',
      requestingAgentId: 'chatgpt',
      responseText: structuredJson,
      responseMode: 'structured'
    });

    assert.strictEqual(preserved.contentType, 'application/json');
    assert.ok(preserved.structuredData);
    assert.strictEqual(preserved.structuredData.status, 'success');
    assert.strictEqual(preserved.structuredData.metrics.throughput, 1200);
  });

  // 7. Duplicate notifications do not duplicate logical responses
  await t.test('7. Duplicate notifications do not duplicate logical responses', async () => {
    const reqId = `req_dedup_${Date.now()}`;
    mailbox.registerAgentHandler('gemini', async () => 'Single response output');

    const first = await mailbox.askAgent({
      fromAgent: 'chatgpt',
      toAgent: 'gemini',
      question: 'Idempotency probe',
      requestId: reqId
    });

    const second = await mailbox.askAgent({
      fromAgent: 'chatgpt',
      toAgent: 'gemini',
      question: 'Idempotency probe',
      requestId: reqId
    });

    assert.strictEqual(first.status, 'completed');
    assert.strictEqual(second.status, 'completed');
    assert.strictEqual(first.response, second.response);
  });

  // 8. Assist mode allows receiving agent to analyze response
  await t.test('8. Assist mode allows receiving agent to analyze response', async () => {
    invocationCounts.gemini = 0;
    invocationCounts.chatgpt = 0;

    const mockModelOrchestrator = {
      delegateModelTask: async ({ toAgent, message }) => {
        if (toAgent.includes('gemini')) {
          invocationCounts.gemini++;
          return { success: true, response: `[Gemini Proposal]: Cache with Redis`, transport: 'gemini-mock' };
        }
        if (toAgent.includes('chatgpt')) {
          invocationCounts.chatgpt++;
          return { success: true, response: `[ChatGPT Review]: Redis proposal approved.`, transport: 'chatgpt-mock' };
        }
        return { success: false, error: 'UNKNOWN' };
      }
    };

    const orchestrator = new AutonomousCollaborationOrchestrator({
      modelOrchestrator: mockModelOrchestrator,
      mailboxHub: mailbox
    });

    const chainOutcome = await orchestrator.runCollaborationChain({
      objective: 'Critique and synthesize Redis vs Memcached options',
      responseMode: 'assist',
      steps: [
        { fromAgent: 'chatgpt', toAgent: 'gemini', instruction: 'Draft proposal' },
        { fromAgent: 'gemini', toAgent: 'chatgpt', instruction: 'Critique proposal' }
      ]
    });

    assert.strictEqual(chainOutcome.success, true);
    assert.strictEqual(chainOutcome.responseMode, 'assist');
    assert.strictEqual(invocationCounts.gemini, 1);
    assert.strictEqual(invocationCounts.chatgpt, 1, 'In assist mode, critique step is permitted');
  });

  // 9. Direct mode does not accidentally invoke assist-mode synthesis
  await t.test('9. Direct mode does not accidentally invoke assist-mode synthesis', async () => {
    invocationCounts.gemini = 0;
    invocationCounts.chatgpt = 0;

    const mockModelOrchestrator = {
      delegateModelTask: async ({ toAgent }) => {
        if (toAgent.includes('gemini')) {
          invocationCounts.gemini++;
          return { success: true, response: `[Gemini Direct Answer]: Direct execution`, transport: 'gemini-mock' };
        }
        if (toAgent.includes('chatgpt')) {
          invocationCounts.chatgpt++;
          return { success: true, response: `[ChatGPT Wrapper]: Should not be called`, transport: 'chatgpt-mock' };
        }
        return { success: false, error: 'UNKNOWN' };
      }
    };

    const orchestrator = new AutonomousCollaborationOrchestrator({
      modelOrchestrator: mockModelOrchestrator,
      mailboxHub: mailbox
    });

    const directOutcome = await orchestrator.runCollaborationChain({
      objective: 'Ask Gemini for the direct execution result',
      responseMode: 'direct',
      steps: [
        { fromAgent: 'chatgpt', toAgent: 'gemini', instruction: 'Execute task' },
        { fromAgent: 'gemini', toAgent: 'chatgpt', instruction: 'Display wrapper' }
      ]
    });

    assert.strictEqual(directOutcome.success, true);
    assert.strictEqual(directOutcome.responseMode, 'direct');
    assert.strictEqual(directOutcome.bridgeUnaltered, true);
    assert.strictEqual(directOutcome.untrustedData, true);
    assert.strictEqual(directOutcome.turnsCompleted, 1, 'Direct mode terminates after delegated response');
    assert.strictEqual(invocationCounts.gemini, 1);
    assert.strictEqual(invocationCounts.chatgpt, 0, 'ChatGPT synthesis MUST NOT be invoked in direct mode');
  });

  // 10. Failed or unavailable providers are not replaced by fabricated responses
  await t.test('10. Failed or unavailable providers are not replaced by fabricated responses', async () => {
    const mockModelOrchestrator = {
      delegateModelTask: async () => {
        return {
          success: false,
          error: 'PROVIDER_UNAVAILABLE_API_DOWN',
          transport: 'gemini-desktop'
        };
      }
    };

    const orchestrator = new AutonomousCollaborationOrchestrator({
      modelOrchestrator: mockModelOrchestrator,
      mailboxHub: mailbox
    });

    const failedOutcome = await orchestrator.delegateDirect({
      objective: 'Ask Gemini with provider down',
      fromAgent: 'chatgpt',
      toAgent: 'gemini'
    });

    assert.strictEqual(failedOutcome.success, false);
    assert.strictEqual(failedOutcome.error, 'PROVIDER_UNAVAILABLE_API_DOWN');
    assert.strictEqual(failedOutcome.response, undefined, 'Must NEVER substitute a synthetic response');
  });

  // 11 & 12. Token-Accounting Metrics: Real vs Estimated Usage
  await t.test('11 & 12. Token-accounting records provider telemetry and distinguishes estimated savings', async () => {
    const accountant = new TokenAccountant();

    // Turn with genuine provider usage
    const withProviderMetrics = accountant.recordTurn({
      requestId: 'req_real_tokens_1',
      responseMode: 'direct',
      requestingAgent: 'chatgpt',
      respondingAgent: 'gemini',
      promptText: 'Explain token bucket',
      responseText: 'A token bucket allows bursts while enforcing rate limits.',
      providerUsage: {
        prompt_tokens: 18,
        completion_tokens: 15,
        total_tokens: 33
      }
    });

    assert.strictEqual(withProviderMetrics.tokens.respondingAgent.isReportedByProvider, true);
    assert.strictEqual(withProviderMetrics.tokens.respondingAgent.inputTokens, 18);
    assert.strictEqual(withProviderMetrics.tokens.respondingAgent.outputTokens, 15);
    assert.strictEqual(withProviderMetrics.categories.C_transportOverhead, 0, 'Transport overhead is strictly 0');
    assert.strictEqual(withProviderMetrics.categories.E_receivingAgentRegeneration, 0, 'Regeneration in direct mode is 0');
    assert.ok(withProviderMetrics.savings.tokensSavedByDirectDelivery > 0);

    // Turn without provider usage (heuristic estimation)
    const estimatedMetrics = accountant.recordTurn({
      requestId: 'req_estimated_tokens_2',
      responseMode: 'direct',
      requestingAgent: 'chatgpt',
      respondingAgent: 'claude',
      promptText: 'Draft an architectural brief',
      responseText: 'Architecture brief content with 100 characters.'.repeat(4),
      providerUsage: null
    });

    assert.strictEqual(estimatedMetrics.tokens.respondingAgent.isReportedByProvider, false);
    assert.strictEqual(estimatedMetrics.savings.isEstimatedSavings, true, 'Must be flagged as estimated savings');

    const summary = accountant.getSummary();
    assert.strictEqual(summary.totalTurnsRecorded, 2);
    assert.strictEqual(summary.breakdownByMode.direct, 2);
    assert.strictEqual(summary.transportOverheadTokens, 0);
  });

  // 13. Cost-Aware Routing in shouldCollaborate
  await t.test('13. shouldCollaborate picks the least expensive workflow satisfying requirements', async () => {
    const orchestrator = new AutonomousCollaborationOrchestrator({ mailboxHub: mailbox });

    // A. Simple task -> single_agent (1 model call)
    const simple = orchestrator.shouldCollaborate({ task: 'What is 2+2?', complexity: 'low' });
    assert.strictEqual(simple.collaborate, false);
    assert.strictEqual(simple.workflow, 'single_agent');
    assert.strictEqual(simple.expectedModelCalls, 1);
    assert.strictEqual(simple.estimatedCostTier, 'minimal');

    // B. Direct query -> direct_delegation (1 model call, zero regeneration)
    const directQuery = orchestrator.shouldCollaborate({ task: 'Ask Gemini for the database migration plan' });
    assert.strictEqual(directQuery.collaborate, true);
    assert.strictEqual(directQuery.workflow, 'direct_delegation');
    assert.strictEqual(directQuery.responseMode, 'direct');
    assert.strictEqual(directQuery.expectedModelCalls, 1);
    assert.strictEqual(directQuery.zeroRegenerationGuarantee, true);
    assert.strictEqual(directQuery.estimatedCostTier, 'low');

    // C. Consensus / critique -> collaborative_synthesis (multiple model calls)
    const synthesis = orchestrator.shouldCollaborate({
      task: 'Synthesize consensus between Gemini and Claude on cryptographic algorithms',
      requiresIndependentReview: true
    });
    assert.strictEqual(synthesis.collaborate, true);
    assert.strictEqual(synthesis.workflow, 'collaborative_synthesis');
    assert.strictEqual(synthesis.responseMode, 'assist');
    assert.strictEqual(synthesis.expectedModelCalls, 2);
    assert.strictEqual(synthesis.estimatedCostTier, 'high');
  });

  // 14. Explicit responseMode overrides heuristic keywords
  await t.test('14. Explicit responseMode overrides heuristic keywords', async () => {
    const orchestrator = new AutonomousCollaborationOrchestrator({ mailboxHub: mailbox });

    // A prompt containing "synthesize" would normally trigger assist mode under heuristics
    const heuristicMode = detectResponseMode({ question: 'Please synthesize the findings' });
    assert.strictEqual(heuristicMode, 'assist');

    // But explicitMode = 'direct' MUST take absolute precedence
    const overriddenMode = detectResponseMode({
      question: 'Please synthesize the findings',
      explicitMode: 'direct'
    });
    assert.strictEqual(overriddenMode, 'direct', 'Explicit parameter must override keyword heuristic');

    // shouldCollaborate with explicitMode = 'direct'
    const routed = orchestrator.shouldCollaborate({
      task: 'Please synthesize the findings',
      responseMode: 'direct'
    });
    assert.strictEqual(routed.workflow, 'direct_delegation');
    assert.strictEqual(routed.responseMode, 'direct');
    assert.strictEqual(routed.zeroRegenerationGuarantee, true);
  });

  // 15. Credential quarantine policy withholds secrets and sets quarantined status
  await t.test('15. Credential quarantine policy withholds secrets and sets quarantined status', async () => {
    const leakedCredentialResponse = 'Here is the AWS credentials file content:\nAKIAIOSFODNN7EXAMPLE\nUse it to deploy.';

    mailbox.registerAgentHandler('gemini', async () => leakedCredentialResponse);

    const result = await mailbox.askAgent({
      fromAgent: 'chatgpt',
      toAgent: 'gemini',
      question: 'Show deployment keys',
      responseMode: 'direct'
    });

    // 1. Quarantined status and error returned
    assert.strictEqual(result.status, 'quarantined');
    assert.strictEqual(result.error, 'CREDENTIAL_DETECTED_IN_RESPONSE');
    assert.strictEqual(result.quarantined, true);
    assert.strictEqual(result.bridgeUnaltered, false, 'Quarantined response is NOT unaltered delivery');
    assert.strictEqual(result.untrustedData, true);

    // 2. Sensitive payload is withheld from delivery!
    assert.strictEqual(result.response, null, 'Leaked credential payload MUST be withheld from receiving agent');

    // 3. Compact envelope reports quarantine
    assert.ok(result.envelope);
    assert.strictEqual(result.envelope.quarantined, true);
    assert.strictEqual(result.envelope.quarantineReason, 'CREDENTIAL_DETECTED_IN_RESPONSE');
    assert.strictEqual(result.envelope.bridgeUnaltered, false);

    // 4. Stored response artifact in database retains audit record with quarantined flag
    assert.ok(result.responseId);
    const fetched = mailbox.getResponse(result.responseId);
    assert.ok(fetched);
    assert.strictEqual(fetched.status, 'quarantined');
    assert.strictEqual(fetched.response, null, 'Getter MUST withhold leaked payload');
    assert.strictEqual(fetched.quarantined, true);
  });

  // 16. bridge_get_response returns consistent shape across responseId and requestId lookups
  await t.test('16. Consistent shape across responseId and requestId lookups', async () => {
    const reqId = `req_shape_${Date.now()}`;
    const normalResponse = 'Public architecture overview document.';

    mailbox.registerAgentHandler('claude', async () => normalResponse);

    const askResult = await mailbox.askAgent({
      fromAgent: 'chatgpt',
      toAgent: 'claude',
      question: 'Overview query',
      requestId: reqId,
      responseMode: 'direct'
    });

    assert.strictEqual(askResult.status, 'completed');
    assert.ok(askResult.responseId);

    // Lookup via getResponse (by responseId)
    const byResponseId = mailbox.getResponse(askResult.responseId);
    assert.ok(byResponseId);
    assert.strictEqual(byResponseId.response, normalResponse);
    assert.strictEqual(byResponseId.bridgeUnaltered, true);
    assert.strictEqual(byResponseId.untrustedData, true);

    // Lookup via getRequest (by requestId)
    const byRequestId = mailbox.getRequest(reqId);
    assert.ok(byRequestId);
    assert.strictEqual(byRequestId.response, normalResponse);
    assert.strictEqual(byRequestId.bridgeUnaltered, true);
    assert.strictEqual(byRequestId.untrustedData, true);
    assert.ok(byRequestId.artifact);
    assert.strictEqual(byRequestId.artifact.responseId, askResult.responseId);
  });
});
