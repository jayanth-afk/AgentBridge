/**
 * RequestExplainer:
 * Deep observability and forensic explanation for any Agent Bridge request.
 * Answers: "What happened to request X?" with evidence-backed causal trace.
 */
export class RequestExplainer {
  constructor(auditLogger) {
    this.logger = auditLogger;
    this.db = auditLogger.db;
  }

  explainRequest(requestId) {
    if (!requestId) throw new Error('requestId is required');

    // 1. Fetch Request
    const requestRow = this.db.prepare(`
      SELECT * FROM bridge_requests WHERE request_id = ?
    `).get(requestId);

    if (!requestRow) {
      return {
        found: false,
        requestId,
        error: `Request '${requestId}' not found in bridge_requests.`
      };
    }

    const taskId = requestRow.task_id;

    // 2. Fetch Backing Task
    let taskRow = null;
    if (taskId) {
      taskRow = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId);
    }

    // 3. Fetch Attempts
    const attempts = this.db.prepare(`
      SELECT * FROM bridge_attempts
      WHERE request_id = ? OR task_id = ?
      ORDER BY epoch ASC
    `).all(requestId, taskId || '');

    // 4. Fetch Events
    const events = this.db.prepare(`
      SELECT * FROM bridge_events
      WHERE request_id = ? OR task_id = ?
      ORDER BY event_id ASC
    `).all(requestId, taskId || '');

    // 5. Fetch Effects
    let effects = [];
    if (attempts.length > 0) {
      try {
        const attemptIds = attempts.map(a => a.attempt_id);
        const placeholders = attemptIds.map(() => '?').join(',');
        effects = this.db.prepare(`
          SELECT * FROM bridge_effects_ledger
          WHERE attempt_id IN (${placeholders})
          ORDER BY created_at ASC
        `).all(...attemptIds);
      } catch {}
    }

    // 6. Fetch Quarantined Responses
    let quarantined = [];
    try {
      quarantined = this.db.prepare(`
        SELECT * FROM bridge_quarantined_responses
        WHERE request_id = ?
      `).all(requestId);
    } catch {}

    // 7. Synthesize Chronological Causal Timeline
    const timeline = [];

    // Request creation
    timeline.push({
      timestamp: requestRow.created_at,
      phase: 'REQUEST_CREATED',
      actor: requestRow.from_agent,
      target: requestRow.to_agent,
      details: `Request initialized: "${requestRow.question?.slice(0, 80)}..."`
    });

    // Task binding
    if (taskRow) {
      timeline.push({
        timestamp: taskRow.created_at,
        phase: 'TASK_BOUND',
        actor: 'bridge',
        taskId: taskRow.id,
        status: taskRow.status,
        details: `Backing task bound: ${taskRow.title} (status: ${taskRow.status})`
      });
    }

    // Attempt executions & fencing transitions
    for (const att of attempts) {
      timeline.push({
        timestamp: att.created_at,
        phase: 'ATTEMPT_CREATED',
        attemptId: att.attempt_id,
        epoch: att.epoch,
        agentId: att.agent_id,
        routeId: att.route_id,
        nonce: att.nonce,
        state: att.state,
        details: `Attempt #${att.attempt_number} (epoch ${att.epoch}) assigned to route '${att.route_id}'`
      });

      if (att.started_at) {
        timeline.push({
          timestamp: att.started_at,
          phase: 'ATTEMPT_ACTIVE',
          attemptId: att.attempt_id,
          epoch: att.epoch,
          details: `Attempt acquired by agent '${att.agent_id}'`
        });
      }

      if (att.completed_at) {
        timeline.push({
          timestamp: att.completed_at,
          phase: att.state === 'completed' ? 'ATTEMPT_COMPLETED' : 'ATTEMPT_TERMINATED',
          attemptId: att.attempt_id,
          epoch: att.epoch,
          state: att.state,
          error: att.error || null,
          details: `Attempt ended in state '${att.state}'`
        });
      }
    }

    // Quarantined responses
    for (const q of quarantined) {
      timeline.push({
        timestamp: q.quarantined_at,
        phase: 'RESPONSE_QUARANTINED',
        attemptId: q.attempt_id,
        epoch: q.epoch,
        reason: q.reason,
        details: `Late/fenced response safely quarantined: ${q.reason}`
      });
    }

    // Sort timeline strictly by timestamp
    timeline.sort((a, b) => (a.timestamp > b.timestamp ? 1 : -1));

    return {
      found: true,
      requestId,
      conversationId: requestRow.conversation_id,
      fromAgent: requestRow.from_agent,
      toAgent: requestRow.to_agent,
      currentStatus: requestRow.status,
      question: requestRow.question,
      response: requestRow.response,
      error: requestRow.error,
      completedAt: requestRow.completed_at,
      totalAttempts: attempts.length,
      attemptsSummary: attempts.map(a => ({
        attemptId: a.attempt_id,
        epoch: a.epoch,
        routeId: a.route_id,
        state: a.state,
        nonce: a.nonce
      })),
      effectsCount: effects.length,
      quarantinedCount: quarantined.length,
      timeline
    };
  }
}
