import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { ModelOrchestrator } from './model-orchestrator.js';
import { DesktopInvisibilityMonitor } from './desktop-invisibility-monitor.js';

export const CollaborationStatus = Object.freeze({
  PENDING: 'pending',
  ACTIVE: 'active',
  COMPLETED: 'completed',
  FAILED: 'failed',
  PAUSED: 'paused',
  CYCLE_DETECTED: 'cycle_detected',
  HOP_LIMIT_EXCEEDED: 'hop_limit_exceeded',
  DUPLICATE_MESSAGE_DETECTED: 'duplicate_message_detected'
});

/**
 * AutonomousCollaborationOrchestrator
 *
 * Implements genuine multi-turn, agent-to-agent autonomous collaboration
 * across ChatGPT Desktop, Claude Desktop, Google Gemini, and Antigravity IDE.
 *
 * Guarantees:
 *  - Zero User Relay Loop: Intermediate messages are routed directly through
 *    Agent Bridge; the user does not copy-paste or manually prompt between turns.
 *  - Real Model Execution Only: Every turn originates from the actual desktop/model
 *    execution route. EXECUTED_BY_AGENT and canned stubs are strictly rejected.
 *  - Background Execution & Focus Preservation: Application windows are driven
 *    via native Accessibility without stealing foreground typing focus.
 *  - Conversation State Tracking: Preserves collaboration ID, request IDs, turn
 *    ordering, parent/child relationships, and full dialogue context.
 *  - Loop & Runaway Protection: Enforces maxHops, per-agent turn limits, cycle
 *    detection, duplicate message suppression, and deadline management.
 *  - Complete Observability: Full audit trail of every hop in SQLite.
 */
export class AutonomousCollaborationOrchestrator extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.modelOrchestrator = options.modelOrchestrator || new ModelOrchestrator(options);
    this.mailbox = options.mailboxHub || null;
    this.logger = options.auditLogger || options.logger || null;
    this.collabManager = options.collaborationManager || null;
    this.defaultMaxHops = options.maxHops || 12;
    this.defaultMaxTurnsPerAgent = options.maxTurnsPerAgent || 6;
    this.defaultTimeoutMs = options.timeoutMs || 180000;
    // Per-turn character cap for each prior turn's response when building the
    // carried context. Bounds prompt growth without dropping earlier turns.
    this.historySnippetChars = options.historySnippetChars || 300;
    // `null` is an intentional test/embedded-mode opt-out. `||` previously
    // recreated a live monitor in that case, making pure state tests depend on
    // the user's desktop focus.
    this.invisibilityMonitor = Object.hasOwn(options, 'invisibilityMonitor')
      ? options.invisibilityMonitor
      : new DesktopInvisibilityMonitor(options);
    this.activeCollaborations = new Map();
  }

  /**
   * Start a new authorized collaboration session.
   */
  createCollaboration({
    objective,
    authorizedAgents = ['chatgpt', 'gemini', 'claude'],
    initiator = 'chatgpt',
    title = null,
    maxHops = null,
    metadata = {}
  }) {
    if (!objective || typeof objective !== 'string' || !objective.trim()) {
      throw new Error('Objective is required for autonomous collaboration');
    }

    const collaborationId = `collab_auto_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const normalizedAgents = new Set(authorizedAgents.map(a => a.toLowerCase().trim()));

    // Verify authorized agents are valid system identities (cannot grant self-proclaimed privileges)
    const validIdentities = ['chatgpt', 'chatgpt-desktop', 'claude', 'claude-desktop', 'gemini', 'antigravity', 'antigravity-ide', 'freebuff', 'system'];
    for (const agent of normalizedAgents) {
      if (!validIdentities.some(v => v.includes(agent) || agent.includes(v))) {
        throw new Error(`SECURITY_BOUNDARY: Agent '${agent}' is not a recognized system identity`);
      }
    }

    const resolvedTitle = title || `Autonomous Collaboration: ${objective.slice(0, 40)}...`;
    const now = new Date().toISOString();

    const session = {
      id: collaborationId,
      title: resolvedTitle,
      objective: objective.trim(),
      initiator: initiator.toLowerCase(),
      authorizedAgents: normalizedAgents,
      maxHops: maxHops || this.defaultMaxHops,
      turns: [],
      turnCount: 0,
      agentTurnCounts: new Map(),
      recentSignatures: [],
      status: CollaborationStatus.ACTIVE,
      createdAt: now,
      updatedAt: now,
      metadata: { ...metadata, autonomous: true },
      finalResult: null
    };

    this.activeCollaborations.set(collaborationId, session);

    // Persist to CollaborationManager if available
    if (this.collabManager?.create) {
      try {
        this.collabManager.create({
          ownerAgent: initiator,
          title: resolvedTitle,
          objective: objective.trim(),
          metadata: { collaborationId, authorizedAgents: [...normalizedAgents] }
        });
      } catch {}
    }

    if (this.logger?.log) {
      try {
        this.logger.log({
          agentId: initiator,
          action: 'autonomous_collaboration_created',
          targetPath: null,
          command: null,
          status: 'success',
          details: { collaborationId, objective, authorizedAgents: [...normalizedAgents] }
        });
      } catch {}
    }

    this.emit('collaboration_created', { collaborationId, session });
    return session;
  }

  /**
   * Format the contextual prompt with accumulated conversation state.
   *
   * Token discipline: every character here is re-sent to the provider on every
   * turn. The objective, the accumulated turns, and the current instruction are
   * all semantically required and are always preserved (each prior response is
   * bounded per turn by `historySnippetChars`). Everything else is decorative
   * framing and is deliberately kept to one short line per concern:
   *   - the `[AB:<requestId>]` correlation marker is added downstream, so it is
   *     not duplicated here;
   *   - the authorized-agent list is enforced server-side and is not model input;
   *   - ASCII banner rules carry no information and were removed.
   */
  formatContextualPrompt({ session, toAgent, instruction }) {
    const limit = this.historySnippetChars;
    const historyLines = session.turns.map(t => {
      const summary = t.response.length > limit ? t.response.slice(0, limit) + '... [truncated]' : t.response;
      return `[Turn ${t.turnNumber}] (${t.fromAgent} -> ${t.toAgent}): ${summary}`;
    }).join('\n');

    const blocks = [
      `AUTONOMOUS AGENT COLLABORATION OBJECTIVE: ${session.objective}\nSession: ${session.id} | Turn: ${session.turns.length + 1}`
    ];

    if (historyLines.length > 0) {
      blocks.push(`--- PREVIOUS COLLABORATION CONTEXT ---\n${historyLines}\n--- END PREVIOUS CONTEXT ---`);
    }

    blocks.push(`INSTRUCTION FOR ${toAgent.toUpperCase()}:\n${instruction}\nGive your authentic technical response for this turn; no pleasantries or boilerplate.`);

    return blocks.join('\n\n');
  }

  /**
   * Execute an autonomous turn between two authorized agents.
   */
  async executeTurn({
    collaborationId,
    fromAgent,
    toAgent,
    instruction,
    context = {},
    deadline = null
  }) {
    const session = this.activeCollaborations.get(collaborationId);
    if (!session) {
      throw new Error(`COLLABORATION_NOT_FOUND: ${collaborationId}`);
    }

    if (session.status !== CollaborationStatus.ACTIVE) {
      throw new Error(`COLLABORATION_INACTIVE: Session is ${session.status}`);
    }

    const normFrom = fromAgent.toLowerCase();
    const normTo = toAgent.toLowerCase();

    // 1. Authorization validation: neither agent may participate without authorization
    const isFromAuthorized = [...session.authorizedAgents].some(a => normFrom.includes(a) || a.includes(normFrom));
    const isToAuthorized = [...session.authorizedAgents].some(a => normTo.includes(a) || a.includes(normTo));

    if (!isFromAuthorized || !isToAuthorized) {
      const unauth = !isFromAuthorized ? fromAgent : toAgent;
      const errorMsg = `SECURITY_BOUNDARY_VIOLATION: Agent '${unauth}' is not authorized in collaboration ${session.id}`;
      session.status = CollaborationStatus.FAILED;
      session.updatedAt = new Date().toISOString();
      return { success: false, status: 'AUTHORIZATION_DENIED', error: errorMsg };
    }

    // 2. Loop & Runaway Protection
    if (session.turnCount >= session.maxHops) {
      session.status = CollaborationStatus.HOP_LIMIT_EXCEEDED;
      session.updatedAt = new Date().toISOString();
      const errorMsg = `HOP_LIMIT_EXCEEDED: Collaboration reached maximum permitted hops (${session.maxHops})`;
      return { success: false, status: 'HOP_LIMIT_EXCEEDED', error: errorMsg };
    }

    const toTurnCount = session.agentTurnCounts.get(normTo) || 0;
    if (toTurnCount >= this.defaultMaxTurnsPerAgent) {
      session.status = CollaborationStatus.PAUSED;
      session.updatedAt = new Date().toISOString();
      const errorMsg = `RUNAWAY_PROTECTION: Agent '${toAgent}' reached turn limit (${this.defaultMaxTurnsPerAgent})`;
      return { success: false, status: 'RUNAWAY_PROTECTION', error: errorMsg };
    }

    // 3. Cycle & Duplicate Detection
    const instructionClean = instruction.trim().toLowerCase();
    const hopSig = `${normFrom}->${normTo}:${instructionClean.slice(0, 40)}`;

    const lastDuplicates = session.turns.slice(-3).filter(t => t.instruction.trim().toLowerCase() === instructionClean);
    if (lastDuplicates.length > 0) {
      session.status = CollaborationStatus.DUPLICATE_MESSAGE_DETECTED;
      session.updatedAt = new Date().toISOString();
      const errorMsg = `DUPLICATE_MESSAGE_DETECTED: Identical message submitted in recent turn`;
      return { success: false, status: 'DUPLICATE_MESSAGE_DETECTED', error: errorMsg };
    }

    const signatureCount = session.recentSignatures.filter(s => s === hopSig).length;
    if (signatureCount >= 2) {
      session.status = CollaborationStatus.CYCLE_DETECTED;
      session.updatedAt = new Date().toISOString();
      const errorMsg = `CYCLE_DETECTED: Cyclic delegation detected without progression`;
      return { success: false, status: 'CYCLE_DETECTED', error: errorMsg };
    }

    session.recentSignatures.push(hopSig);
    if (session.recentSignatures.length > 10) session.recentSignatures.shift();

    // 4. Construct contextual prompt with complete conversation state
    const contextualPrompt = this.formatContextualPrompt({ session, toAgent, instruction });
    const requestId = `req_collab_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const startMs = Date.now();

    this.emit('turn_started', {
      collaborationId: session.id,
      turnNumber: session.turns.length + 1,
      fromAgent,
      toAgent,
      requestId
    });

    // 5. Delegate turn to real model execution route with continuous invisibility monitoring
    let modelResult;
    let invisibilityReport = null;

    if (this.invisibilityMonitor) {
      await this.invisibilityMonitor.startTurnSampling({
        collaborationId: session.id,
        requestId,
        fromAgent,
        toAgent
      });
    }

    try {
      modelResult = await this.modelOrchestrator.delegateModelTask({
        fromAgent,
        toAgent,
        message: contextualPrompt,
        context: { ...context, collaborationId: session.id, turnNumber: session.turns.length + 1 },
        conversationId: session.id,
        deadline
      });
    } finally {
      if (this.invisibilityMonitor) {
        try {
          invisibilityReport = await this.invisibilityMonitor.stopTurnSampling();
        } catch (invisErr) {
          session.status = CollaborationStatus.FAILED;
          session.updatedAt = new Date().toISOString();
          this.emit('turn_failed', { collaborationId: session.id, requestId, error: invisErr.message });
          return {
            success: false,
            status: invisErr.code || 'VISIBLE_TAKEOVER_DETECTED',
            error: invisErr.message,
            report: invisErr.report,
            latencyMs: Date.now() - startMs
          };
        }
      }
    }

    // 6. Enforce Real Model Responses Only
    if (!modelResult.success || !modelResult.response) {
      const error = modelResult.error || 'MODEL_INVOCATION_FAILED';
      session.updatedAt = new Date().toISOString();
      this.emit('turn_failed', { collaborationId: session.id, requestId, error });
      return {
        success: false,
        status: 'MODEL_TURN_FAILED',
        error,
        latencyMs: Date.now() - startMs
      };
    }

    const responseText = String(modelResult.response).trim();
    // AgentRunner-style acknowledgement envelopes are transport receipts, not
    // model answers. Reject both the bare marker and its historical JSON
    // envelope so a collaboration cannot claim an invisible model turn that
    // never occurred.
    let syntheticEnvelope = false;
    try {
      syntheticEnvelope = JSON.parse(responseText)?.status === 'EXECUTED_BY_AGENT';
    } catch {}
    if (responseText === 'EXECUTED_BY_AGENT' || syntheticEnvelope || responseText.length === 0) {
      session.status = CollaborationStatus.FAILED;
      session.updatedAt = new Date().toISOString();
      const errorMsg = 'NON_MODEL_RESPONSE_REJECTED: Received synthetic or empty response';
      return { success: false, status: 'SYNTHETIC_RESPONSE_REJECTED', error: errorMsg };
    }

    // 7. Update Session State
    const turn = {
      turnNumber: session.turns.length + 1,
      requestId,
      fromAgent,
      toAgent,
      instruction,
      response: responseText,
      transport: modelResult.transport,
      latencyMs: Date.now() - startMs,
      timestamp: new Date().toISOString()
    };

    session.turns.push({
      ...turn,
      invisibility: invisibilityReport
    });
    session.turnCount += 1;
    session.agentTurnCounts.set(normTo, toTurnCount + 1);
    session.updatedAt = new Date().toISOString();

    // 8. Observability & Audit Logging
    if (this.logger?.log) {
      try {
        this.logger.log({
          agentId: fromAgent,
          action: 'autonomous_collaboration_turn',
          targetPath: null,
          command: null,
          status: 'success',
          details: {
            collaborationId: session.id,
            turnNumber: turn.turnNumber,
            fromAgent,
            toAgent,
            transport: modelResult.transport,
            latencyMs: turn.latencyMs,
            responseSnippet: responseText.slice(0, 120)
          }
        });
      } catch {}
    }

    if (this.collabManager?.event) {
      try {
        this.collabManager.event({
          collaborationId: session.id,
          agentId: toAgent,
          eventType: 'turn_completed',
          payload: { turnNumber: turn.turnNumber, fromAgent, toAgent, latencyMs: turn.latencyMs }
        });
      } catch {}
    }

    this.emit('turn_completed', { collaborationId: session.id, turn });
    return { success: true, turn };
  }

  /**
   * Execute an autonomous multi-turn collaboration chain without user intervention.
   * Runs sequentially until completion or error.
   */
  async runCollaborationChain({
    objective,
    steps,
    initiator = 'chatgpt',
    authorizedAgents = ['chatgpt', 'gemini', 'claude'],
    timeoutMs = null
  }) {
    const session = this.createCollaboration({
      objective,
      initiator,
      authorizedAgents,
      maxHops: steps.length + 2
    });

    const chainStartMs = Date.now();
    let previousTurnResult = null;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const fromAgent = step.fromAgent || (previousTurnResult ? previousTurnResult.toAgent : initiator);
      const toAgent = step.toAgent;
      let instruction = step.instruction;

      // Allow dynamic instruction generation based on previous turn
      if (typeof instruction === 'function') {
        instruction = instruction(previousTurnResult);
      } else if (!instruction && previousTurnResult) {
        instruction = `Review and build upon the findings from ${previousTurnResult.fromAgent}:\n${previousTurnResult.response}`;
      }

      const turnOutcome = await this.executeTurn({
        collaborationId: session.id,
        fromAgent,
        toAgent,
        instruction,
        deadline: Date.now() + (timeoutMs || 120000)
      });

      if (!turnOutcome.success) {
        session.status = CollaborationStatus.FAILED;
        return {
          success: false,
          collaborationId: session.id,
          failedStep: i + 1,
          error: turnOutcome.error,
          turns: session.turns,
          durationMs: Date.now() - chainStartMs
        };
      }

      previousTurnResult = turnOutcome.turn;
    }

    session.status = CollaborationStatus.COMPLETED;
    session.finalResult = previousTurnResult ? previousTurnResult.response : null;
    session.updatedAt = new Date().toISOString();

    return {
      success: true,
      collaborationId: session.id,
      objective: session.objective,
      turnsCompleted: session.turns.length,
      turns: session.turns,
      finalResult: session.finalResult,
      durationMs: Date.now() - chainStartMs
    };
  }

  /**
   * Get collaboration transcript by ID.
   */
  getCollaboration(collaborationId) {
    return this.activeCollaborations.get(collaborationId) || null;
  }
}
