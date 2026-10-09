import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AutonomousCollaborationOrchestrator,
  CollaborationStatus
} from '../src/control-plane/autonomous-collaboration-orchestrator.js';
import { ModelOrchestrator } from '../src/control-plane/model-orchestrator.js';

test('Autonomous Collaboration Orchestrator Safety & State Unit Suite', async (t) => {
  // Mock model orchestrator for deterministic boundary verification
  class MockModelOrchestrator {
    constructor() {
      this.calls = [];
    }
    async delegateModelTask({ fromAgent, toAgent, message, conversationId, requestId }) {
      this.calls.push({ fromAgent, toAgent, message, conversationId, requestId });
      return {
        success: true,
        requestId,
        fromAgent,
        toAgent,
        transport: `${toAgent}-mock-transport`,
        response: `Analysis from ${toAgent} regarding: ${message.slice(0, 30)}...`,
        latencyMs: 15
      };
    }
  }

  const mockMo = new MockModelOrchestrator();
  const orchestrator = new AutonomousCollaborationOrchestrator({
    modelOrchestrator: mockMo,
    maxHops: 5,
    maxTurnsPerAgent: 3,
    // This suite verifies orchestration state with a mock model route. Focus
    // sampling has its own dedicated suite and otherwise makes these unit
    // assertions depend on the user's live desktop state.
    invisibilityMonitor: null
  });

  await t.test('1. Session creation and identity authorization boundary', () => {
    const session = orchestrator.createCollaboration({
      objective: 'Evaluate consensus algorithms',
      authorizedAgents: ['chatgpt', 'gemini', 'claude']
    });

    assert.equal(session.status, CollaborationStatus.ACTIVE);
    assert.equal(session.turnCount, 0);
    assert.ok(session.authorizedAgents.has('chatgpt'));
    assert.ok(session.authorizedAgents.has('gemini'));
    assert.ok(session.authorizedAgents.has('claude'));

    // Unauthorized agent identity must throw security exception
    assert.throws(() => {
      orchestrator.createCollaboration({
        objective: 'Test invalid',
        authorizedAgents: ['unauthorized_rogue_agent']
      });
    }, /SECURITY_BOUNDARY/);
  });

  await t.test('2. Turn execution enforces authorization boundaries', async () => {
    const session = orchestrator.createCollaboration({
      objective: 'Verify authorization boundaries',
      authorizedAgents: ['chatgpt', 'gemini']
    });

    // Delegating to unauthorized agent (claude is not in authorizedAgents for this session)
    const res = await orchestrator.executeTurn({
      collaborationId: session.id,
      fromAgent: 'chatgpt',
      toAgent: 'claude',
      instruction: 'Unauthorized query'
    });

    assert.equal(res.success, false);
    assert.equal(res.status, 'AUTHORIZATION_DENIED');
    assert.ok(res.error.includes('SECURITY_BOUNDARY_VIOLATION'));
  });

  await t.test('3. Context accumulation across multiple turns', async () => {
    const session = orchestrator.createCollaboration({
      objective: 'Multi-turn context tracking',
      authorizedAgents: ['chatgpt', 'gemini', 'claude']
    });

    // Turn 1
    const t1 = await orchestrator.executeTurn({
      collaborationId: session.id,
      fromAgent: 'chatgpt',
      toAgent: 'gemini',
      instruction: 'Initial query on Paxos'
    });
    assert.equal(t1.success, true);
    assert.equal(t1.turn.turnNumber, 1);

    // Turn 2
    const t2 = await orchestrator.executeTurn({
      collaborationId: session.id,
      fromAgent: 'gemini',
      toAgent: 'claude',
      instruction: 'Follow-up query on Raft'
    });
    assert.equal(t2.success, true);
    assert.equal(t2.turn.turnNumber, 2);

    // Verify context was passed into mock orchestrator call
    const lastCall = mockMo.calls[mockMo.calls.length - 1];
    assert.ok(lastCall.message.includes('PREVIOUS COLLABORATION CONTEXT'));
    assert.ok(lastCall.message.includes('Turn 1'));
  });

  await t.test('4. Runaway protection: maxHops limit', async () => {
    const session = orchestrator.createCollaboration({
      objective: 'Hop limit test',
      authorizedAgents: ['chatgpt', 'gemini'],
      maxHops: 2
    });

    await orchestrator.executeTurn({
      collaborationId: session.id,
      fromAgent: 'chatgpt',
      toAgent: 'gemini',
      instruction: 'Step 1'
    });

    await orchestrator.executeTurn({
      collaborationId: session.id,
      fromAgent: 'gemini',
      toAgent: 'chatgpt',
      instruction: 'Step 2'
    });

    // 3rd turn exceeds maxHops = 2
    const t3 = await orchestrator.executeTurn({
      collaborationId: session.id,
      fromAgent: 'chatgpt',
      toAgent: 'gemini',
      instruction: 'Step 3'
    });

    assert.equal(t3.success, false);
    assert.equal(t3.status, 'HOP_LIMIT_EXCEEDED');
  });

  await t.test('5. Cycle and duplicate message detection', async () => {
    const session = orchestrator.createCollaboration({
      objective: 'Duplicate & cycle prevention',
      authorizedAgents: ['chatgpt', 'gemini']
    });

    await orchestrator.executeTurn({
      collaborationId: session.id,
      fromAgent: 'chatgpt',
      toAgent: 'gemini',
      instruction: 'Identical message'
    });

    // Immediate duplicate
    const dupRes = await orchestrator.executeTurn({
      collaborationId: session.id,
      fromAgent: 'gemini',
      toAgent: 'chatgpt',
      instruction: 'Identical message'
    });

    assert.equal(dupRes.success, false);
    assert.equal(dupRes.status, 'DUPLICATE_MESSAGE_DETECTED');
  });

  await t.test('6. Rejects fake EXECUTED_BY_AGENT responses', async () => {
    class FakeModelOrchestrator {
      async delegateModelTask() {
        return {
          success: true,
          response: 'EXECUTED_BY_AGENT', // Fake stub!
          transport: 'stub'
        };
      }
    }

    const fakeOrch = new AutonomousCollaborationOrchestrator({
      modelOrchestrator: new FakeModelOrchestrator()
    });

    const session = fakeOrch.createCollaboration({
      objective: 'Reject fake responses',
      authorizedAgents: ['chatgpt', 'gemini']
    });

    const res = await fakeOrch.executeTurn({
      collaborationId: session.id,
      fromAgent: 'chatgpt',
      toAgent: 'gemini',
      instruction: 'Test fake response'
    });

    assert.equal(res.success, false);
    assert.equal(res.status, 'SYNTHETIC_RESPONSE_REJECTED');
  });

  await t.test('7. Rejects the historical AgentRunner acknowledgement envelope', async () => {
    const orchestrator = new AutonomousCollaborationOrchestrator({
      modelOrchestrator: {
        delegateModelTask: async () => ({
          success: true,
          response: JSON.stringify({ status: 'EXECUTED_BY_AGENT', agent: 'antigravity-ide' }),
          transport: 'synthetic-test'
        })
      },
      invisibilityMonitor: null
    });
    const session = orchestrator.createCollaboration({
      objective: 'reject acknowledgement envelope',
      authorizedAgents: ['chatgpt', 'gemini']
    });
    const result = await orchestrator.executeTurn({
      collaborationId: session.id,
      fromAgent: 'chatgpt',
      toAgent: 'gemini',
      instruction: 'test acknowledgement rejection'
    });
    assert.equal(result.success, false);
    assert.equal(result.status, 'SYNTHETIC_RESPONSE_REJECTED');
  });

  await t.test('8. Contextual prompt preserves required information without banner boilerplate', () => {
    const orch = new AutonomousCollaborationOrchestrator({ invisibilityMonitor: null });
    const session = {
      id: 'collab_prompt_test',
      objective: 'Verify prompt information preservation across turns.',
      authorizedAgents: new Set(['chatgpt', 'claude']),
      turns: []
    };
    for (let n = 1; n <= 6; n++) {
      session.turns.push({
        turnNumber: n,
        fromAgent: 'chatgpt',
        toAgent: 'claude',
        instruction: `step ${n}`,
        response: 'R'.repeat(500)
      });
    }

    const prompt = orch.formatContextualPrompt({ session, toAgent: 'claude', instruction: 'Final synthesis.' });

    // Required information is preserved verbatim.
    assert.ok(prompt.includes('Verify prompt information preservation across turns.'), 'objective must survive');
    assert.ok(prompt.includes('PREVIOUS COLLABORATION CONTEXT'), 'history section must survive');
    for (let n = 1; n <= 6; n++) assert.ok(prompt.includes(`[Turn ${n}]`), `turn ${n} must be present`);
    assert.ok(prompt.includes('Final synthesis.'), 'current instruction must survive');
    assert.ok(prompt.includes('INSTRUCTION FOR CLAUDE:'), 'instruction heading must survive');

    // Decorative ASCII banner rules are pure token overhead and must not be sent.
    assert.ok(!prompt.includes('====='), 'decorative banner rules must not be sent');

    // Each prior response is bounded by historySnippetChars, so a 6-turn prompt stays bounded.
    assert.ok(prompt.length < 3000, `prompt grew unexpectedly: ${prompt.length} chars`);
  });
});
