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
    maxTurnsPerAgent: 3
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
});
