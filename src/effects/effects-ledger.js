import crypto from 'node:crypto';

function runInImmediateTx(db, fn) {
  let started = false;
  try {
    db.exec('BEGIN IMMEDIATE;');
    started = true;
  } catch (err) {
    if (err.message && err.message.includes('cannot start a transaction')) {
      return fn();
    }
    throw err;
  }
  try {
    const res = fn();
    if (started) db.exec('COMMIT;');
    return res;
  } catch (err) {
    if (started) {
      try { db.exec('ROLLBACK;'); } catch  {
      // swallow-ok: transaction may already be resolved or closed
    }
    }
    throw err;
  }
}

/**
 * Operation Side-Effect Classifications
 */
export const EffectClassification = Object.freeze({
  PURE: 'pure',                         // Read-only (e.g. read_file, ping)
  IDEMPOTENT: 'idempotent',             // Repeatable safely (e.g. write with overwrite, mkdir)
  NON_IDEMPOTENT: 'non_idempotent',     // State changes on each execution (e.g. append, git commit)
  EXTERNAL: 'external'                  // External side effect (e.g. git push, external network)
});

/**
 * Lifecycle states of an effectful operation
 */
export const EffectState = Object.freeze({
  INTENT_RECORDED: 'INTENT_RECORDED',
  EXECUTING: 'EXECUTING',
  COMMITTED: 'COMMITTED',
  FAILED: 'FAILED',
  UNKNOWN: 'UNKNOWN' // When process crashed or timed out during execution; NEVER silently marked FAILED
});

export const PUBLIC_TOOLS = Object.freeze(new Set([
  'bridge_ping'
]));

/**
 * Authoritative mapping of Tool names to side-effect classification
 */
export const TOOL_EFFECT_CLASSIFICATIONS = Object.freeze({
  // PURE Read-only Tools (no state mutation, CAS read, metadata read)
  bridge_ping: EffectClassification.PURE,
  bridge_agent_presence: EffectClassification.PURE,
  bridge_context: EffectClassification.PURE,
  bridge_diagnostics: EffectClassification.PURE,
  bridge_discover_agents: EffectClassification.PURE,
  bridge_discover_tools: EffectClassification.PURE,
  bridge_find_symbol: EffectClassification.PURE,
  bridge_get_adapter_capabilities: EffectClassification.PURE,
  bridge_get_all_file_activity: EffectClassification.PURE,
  bridge_get_audit_log: EffectClassification.PURE,
  bridge_get_collaboration: EffectClassification.PURE,
  bridge_get_events: EffectClassification.PURE,
  bridge_get_file_activity: EffectClassification.PURE,
  bridge_get_knowledge: EffectClassification.PURE,
  bridge_get_pending_requests: EffectClassification.PURE,
  bridge_get_request_status: EffectClassification.PURE,
  bridge_get_response: EffectClassification.PURE,
  bridge_get_task_status: EffectClassification.PURE,
  bridge_git_blame: EffectClassification.PURE,
  bridge_git_branches: EffectClassification.PURE,
  bridge_git_diff: EffectClassification.PURE,
  bridge_git_log: EffectClassification.PURE,
  bridge_git_status: EffectClassification.PURE,
  bridge_git_summary: EffectClassification.PURE,
  bridge_inspect_project: EffectClassification.PURE,
  bridge_list_collaborations: EffectClassification.PURE,
  bridge_project_snapshot: EffectClassification.PURE,
  bridge_read_file: EffectClassification.PURE,
  bridge_read_symbol: EffectClassification.PURE,
  bridge_search_files: EffectClassification.PURE,
  bridge_search_knowledge: EffectClassification.PURE,
  bridge_test_plan: EffectClassification.PURE,
  bridge_tool_info: EffectClassification.PURE,
  bridge_check_syntax: EffectClassification.PURE,
  bridge_extract_data: EffectClassification.PURE,
  bridge_batch_read: EffectClassification.PURE,
  bridge_batch_stat: EffectClassification.PURE,
  bridge_check_inbox: EffectClassification.PURE,
  bridge_artifact_get: EffectClassification.PURE,
  bridge_artifact_read: EffectClassification.PURE,
  bridge_explain_request: EffectClassification.PURE,
  bridge_request_ledger: EffectClassification.PURE,
  bridge_slice_fetch: EffectClassification.PURE,
  bridge_get_protocol_snippet: EffectClassification.PURE,
  bridge_list_skills: EffectClassification.PURE,
  bridge_get_skill: EffectClassification.PURE,
  bridge_get_skill_resource: EffectClassification.PURE,
  bridge_search_skills: EffectClassification.PURE,

  // IDEMPOTENT Side-Effect Tools (safe to repeat with identical inputs)
  bridge_create_file: EffectClassification.IDEMPOTENT,
  bridge_delete_file: EffectClassification.IDEMPOTENT,
  bridge_batch_write: EffectClassification.IDEMPOTENT,
  bridge_git_stage: EffectClassification.IDEMPOTENT,
  bridge_git_create_branch: EffectClassification.IDEMPOTENT,
  bridge_git_switch_branch: EffectClassification.IDEMPOTENT,
  bridge_git_delete_branch: EffectClassification.IDEMPOTENT,
  bridge_artifact_cleanup: EffectClassification.IDEMPOTENT,
  bridge_store_knowledge: EffectClassification.IDEMPOTENT,
  bridge_acknowledge_delivery: EffectClassification.IDEMPOTENT,
  bridge_skill_load: EffectClassification.IDEMPOTENT,
  bridge_close_collaboration: EffectClassification.IDEMPOTENT,
  bridge_leave_collaboration: EffectClassification.IDEMPOTENT,
  bridge_file_activity_stop: EffectClassification.IDEMPOTENT,

  // NON_IDEMPOTENT Side-Effect Tools (state mutations that advance epochs/state)
  bridge_edit_file: EffectClassification.NON_IDEMPOTENT,
  bridge_apply_patch: EffectClassification.NON_IDEMPOTENT,
  bridge_execute_command: EffectClassification.NON_IDEMPOTENT,
  bridge_git_commit: EffectClassification.NON_IDEMPOTENT,
  bridge_artifact_store: EffectClassification.NON_IDEMPOTENT,
  bridge_ask_agent: EffectClassification.NON_IDEMPOTENT,
  bridge_send_message: EffectClassification.NON_IDEMPOTENT,
  bridge_broadcast_message: EffectClassification.NON_IDEMPOTENT,
  bridge_delegate_task: EffectClassification.NON_IDEMPOTENT,
  bridge_claim_task: EffectClassification.NON_IDEMPOTENT,
  bridge_submit_task_result: EffectClassification.NON_IDEMPOTENT,
  bridge_answer_request: EffectClassification.NON_IDEMPOTENT,
  bridge_request_review: EffectClassification.NON_IDEMPOTENT,
  bridge_create_collaboration: EffectClassification.NON_IDEMPOTENT,
  bridge_join_collaboration: EffectClassification.NON_IDEMPOTENT,
  bridge_heartbeat_collaboration: EffectClassification.NON_IDEMPOTENT,
  bridge_post_collaboration_event: EffectClassification.NON_IDEMPOTENT,
  bridge_file_activity_start: EffectClassification.NON_IDEMPOTENT,
  bridge_file_activity_heartbeat: EffectClassification.NON_IDEMPOTENT,
  bridge_wait_for_response: EffectClassification.NON_IDEMPOTENT,

  // EXTERNAL Side-Effect Tools (reach network, external repositories, remotes)
  bridge_git_fetch: EffectClassification.EXTERNAL,
  bridge_git_pull: EffectClassification.EXTERNAL,
  bridge_git_push: EffectClassification.EXTERNAL
});

export const ToolSecurityCategory = Object.freeze({
  PURE_LOCAL: 'pure_local',                 // Read-only, unprivileged, local or public information
  WORKSPACE_READ: 'workspace_read',         // Reads workspace filesystem or git history
  WORKSPACE_MUTATING: 'workspace_mutating', // Modifies workspace files or git state
  SYSTEM_EXECUTING: 'system_executing',     // Shell command execution
  STATEFUL_MESSAGING: 'stateful_messaging', // Mutates tasks, messages, collaborations, or delivery
  CROSS_AGENT_DATA: 'cross_agent_data'      // Accesses private inter-agent requests, responses, inboxes, events, audit
});

export const TOOL_SECURITY_CLASSIFICATIONS = Object.freeze({
  // PURE_LOCAL (12 tools)
  bridge_ping: ToolSecurityCategory.PURE_LOCAL,
  bridge_discover_agents: ToolSecurityCategory.PURE_LOCAL,
  bridge_agent_presence: ToolSecurityCategory.PURE_LOCAL,
  bridge_diagnostics: ToolSecurityCategory.PURE_LOCAL,
  bridge_context: ToolSecurityCategory.PURE_LOCAL,
  bridge_discover_tools: ToolSecurityCategory.PURE_LOCAL,
  bridge_tool_info: ToolSecurityCategory.PURE_LOCAL,
  bridge_search_knowledge: ToolSecurityCategory.PURE_LOCAL,
  bridge_get_knowledge: ToolSecurityCategory.PURE_LOCAL,
  bridge_get_adapter_capabilities: ToolSecurityCategory.PURE_LOCAL,
  bridge_get_file_activity: ToolSecurityCategory.PURE_LOCAL,
  bridge_get_all_file_activity: ToolSecurityCategory.PURE_LOCAL,

  // WORKSPACE_READ (17 tools)
  bridge_read_file: ToolSecurityCategory.WORKSPACE_READ,
  bridge_batch_read: ToolSecurityCategory.WORKSPACE_READ,
  bridge_batch_stat: ToolSecurityCategory.WORKSPACE_READ,
  bridge_search_files: ToolSecurityCategory.WORKSPACE_READ,
  bridge_find_symbol: ToolSecurityCategory.WORKSPACE_READ,
  bridge_read_symbol: ToolSecurityCategory.WORKSPACE_READ,
  bridge_inspect_project: ToolSecurityCategory.WORKSPACE_READ,
  bridge_project_snapshot: ToolSecurityCategory.WORKSPACE_READ,
  bridge_check_syntax: ToolSecurityCategory.WORKSPACE_READ,
  bridge_extract_data: ToolSecurityCategory.WORKSPACE_READ,
  bridge_test_plan: ToolSecurityCategory.WORKSPACE_READ,
  bridge_git_status: ToolSecurityCategory.WORKSPACE_READ,
  bridge_git_branches: ToolSecurityCategory.WORKSPACE_READ,
  bridge_git_log: ToolSecurityCategory.WORKSPACE_READ,
  bridge_git_diff: ToolSecurityCategory.WORKSPACE_READ,
  bridge_git_summary: ToolSecurityCategory.WORKSPACE_READ,
  bridge_git_blame: ToolSecurityCategory.WORKSPACE_READ,

  // WORKSPACE_MUTATING (16 tools)
  bridge_create_file: ToolSecurityCategory.WORKSPACE_MUTATING,
  bridge_edit_file: ToolSecurityCategory.WORKSPACE_MUTATING,
  bridge_delete_file: ToolSecurityCategory.WORKSPACE_MUTATING,
  bridge_apply_patch: ToolSecurityCategory.WORKSPACE_MUTATING,
  bridge_batch_write: ToolSecurityCategory.WORKSPACE_MUTATING,
  bridge_git_stage: ToolSecurityCategory.WORKSPACE_MUTATING,
  bridge_git_commit: ToolSecurityCategory.WORKSPACE_MUTATING,
  bridge_git_create_branch: ToolSecurityCategory.WORKSPACE_MUTATING,
  bridge_git_switch_branch: ToolSecurityCategory.WORKSPACE_MUTATING,
  bridge_git_delete_branch: ToolSecurityCategory.WORKSPACE_MUTATING,
  bridge_git_push: ToolSecurityCategory.WORKSPACE_MUTATING,
  bridge_git_pull: ToolSecurityCategory.WORKSPACE_MUTATING,
  bridge_git_fetch: ToolSecurityCategory.WORKSPACE_MUTATING,
  bridge_artifact_store: ToolSecurityCategory.WORKSPACE_MUTATING,
  bridge_artifact_cleanup: ToolSecurityCategory.WORKSPACE_MUTATING,
  bridge_store_knowledge: ToolSecurityCategory.WORKSPACE_MUTATING,

  // SYSTEM_EXECUTING (1 tool)
  bridge_execute_command: ToolSecurityCategory.SYSTEM_EXECUTING,

  // STATEFUL_MESSAGING (17 tools)
  bridge_ask_agent: ToolSecurityCategory.STATEFUL_MESSAGING,
  bridge_send_message: ToolSecurityCategory.STATEFUL_MESSAGING,
  bridge_broadcast_message: ToolSecurityCategory.STATEFUL_MESSAGING,
  bridge_delegate_task: ToolSecurityCategory.STATEFUL_MESSAGING,
  bridge_claim_task: ToolSecurityCategory.STATEFUL_MESSAGING,
  bridge_submit_task_result: ToolSecurityCategory.STATEFUL_MESSAGING,
  bridge_answer_request: ToolSecurityCategory.STATEFUL_MESSAGING,
  bridge_request_review: ToolSecurityCategory.STATEFUL_MESSAGING,
  bridge_create_collaboration: ToolSecurityCategory.STATEFUL_MESSAGING,
  bridge_join_collaboration: ToolSecurityCategory.STATEFUL_MESSAGING,
  bridge_leave_collaboration: ToolSecurityCategory.STATEFUL_MESSAGING,
  bridge_heartbeat_collaboration: ToolSecurityCategory.STATEFUL_MESSAGING,
  bridge_post_collaboration_event: ToolSecurityCategory.STATEFUL_MESSAGING,
  bridge_close_collaboration: ToolSecurityCategory.STATEFUL_MESSAGING,
  bridge_file_activity_start: ToolSecurityCategory.STATEFUL_MESSAGING,
  bridge_file_activity_heartbeat: ToolSecurityCategory.STATEFUL_MESSAGING,
  bridge_file_activity_stop: ToolSecurityCategory.STATEFUL_MESSAGING,

  // CROSS_AGENT_DATA (11 tools)
  bridge_check_inbox: ToolSecurityCategory.CROSS_AGENT_DATA,
  bridge_get_response: ToolSecurityCategory.CROSS_AGENT_DATA,
  bridge_get_request_status: ToolSecurityCategory.CROSS_AGENT_DATA,
  bridge_get_task_status: ToolSecurityCategory.CROSS_AGENT_DATA,
  bridge_get_pending_requests: ToolSecurityCategory.CROSS_AGENT_DATA,
  bridge_get_events: ToolSecurityCategory.CROSS_AGENT_DATA,
  bridge_get_audit_log: ToolSecurityCategory.CROSS_AGENT_DATA,
  bridge_artifact_get: ToolSecurityCategory.CROSS_AGENT_DATA,
  bridge_artifact_read: ToolSecurityCategory.CROSS_AGENT_DATA,
  bridge_get_collaboration: ToolSecurityCategory.CROSS_AGENT_DATA,
  bridge_list_collaborations: ToolSecurityCategory.CROSS_AGENT_DATA,

  // Dynamic / unlisted tools (mapped for complete security coverage)
  bridge_acknowledge_delivery: ToolSecurityCategory.STATEFUL_MESSAGING,
  bridge_explain_request: ToolSecurityCategory.CROSS_AGENT_DATA,
  bridge_request_ledger: ToolSecurityCategory.CROSS_AGENT_DATA,
  bridge_wait_for_response: ToolSecurityCategory.CROSS_AGENT_DATA,
  bridge_slice_fetch: ToolSecurityCategory.CROSS_AGENT_DATA,
  bridge_get_protocol_snippet: ToolSecurityCategory.PURE_LOCAL,
  bridge_list_skills: ToolSecurityCategory.PURE_LOCAL,
  bridge_skill_load: ToolSecurityCategory.PURE_LOCAL
});

export function getToolSecurityCategory(toolName) {
  return (toolName && TOOL_SECURITY_CLASSIFICATIONS[toolName]) || ToolSecurityCategory.CROSS_AGENT_DATA;
}

export function isEffectfulTool(toolName) {
  if (!toolName) return true;
  const classification = TOOL_EFFECT_CLASSIFICATIONS[toolName];
  if (!classification) return true; // Default-deny: unclassified tools are effectful
  return classification !== EffectClassification.PURE;
}

export function getToolClassification(toolName) {
  if (toolName && TOOL_EFFECT_CLASSIFICATIONS[toolName]) {
    return TOOL_EFFECT_CLASSIFICATIONS[toolName];
  }
  // Default-deny: unclassified tools default to NON_IDEMPOTENT side-effect
  return EffectClassification.NON_IDEMPOTENT;
}

export class EffectsLedger {
  constructor(auditLogger) {
    this.logger = auditLogger;
    this.db = auditLogger.db;
    this.initTables();
  }

  initTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bridge_effects_ledger (
        effect_id TEXT PRIMARY KEY,
        idempotency_key TEXT UNIQUE,
        attempt_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        agent_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        classification TEXT NOT NULL,
        state TEXT NOT NULL,
        params TEXT,
        result TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_effects_attempt ON bridge_effects_ledger(attempt_id, epoch);
      CREATE INDEX IF NOT EXISTS idx_effects_state ON bridge_effects_ledger(state);
    `);
  }

  /**
   * Records intent before performing side-effectful operation.
   * Validates attempt epoch fencing and enforces idempotency deduplication.
   */
  recordIntent({
    idempotencyKey = null,
    attemptId,
    taskId,
    epoch,
    agentId,
    operation,
    classification = EffectClassification.NON_IDEMPOTENT,
    params = {},
    attemptLedger = null
  }) {
    // 1. Monotonic Fencing Check: Stale attempt can NEVER produce effects
    if (attemptLedger) {
      attemptLedger.validateFencing({ taskId, attemptId, epoch, agentId });
    }

    const resolvedKey = idempotencyKey || `idem_${operation}_${attemptId}_${epoch}_${crypto.randomBytes(6).toString('hex')}`;
    let result = null;

    runInImmediateTx(this.db, () => {
      // 2. Idempotency Check: Return committed cached result if already completed
      const existing = this.db.prepare(`
        SELECT * FROM bridge_effects_ledger WHERE idempotency_key = ?
      `).get(resolvedKey);

      if (existing) {
        if (existing.state === EffectState.COMMITTED) {
          result = {
            effectId: existing.effect_id,
            idempotencyKey: resolvedKey,
            alreadyCommitted: true,
            result: existing.result ? (() => { try { return JSON.parse(existing.result); } catch { return existing.result; } })() : null
          };
          return;
        }
        if (existing.state === EffectState.EXECUTING || existing.state === EffectState.UNKNOWN) {
          const err = new Error(
            `EFFECT_IN_FLIGHT_OR_UNKNOWN: Operation '${operation}' with key '${resolvedKey}' is in state '${existing.state}'. Automated repeat refused.`
          );
          err.code = 'EFFECT_UNRECONCILED';
          err.state = existing.state;
          throw err;
        }
      }

      const effectId = `eff_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      const now = new Date().toISOString();
      const paramsStr = typeof params === 'object' ? JSON.stringify(params) : String(params);

      this.db.prepare(`
        INSERT INTO bridge_effects_ledger (
          effect_id, idempotency_key, attempt_id, task_id, epoch, agent_id,
          operation, classification, state, params, result, error, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'INTENT_RECORDED', ?, NULL, NULL, ?)
      `).run(
        effectId,
        resolvedKey,
        attemptId,
        taskId || null,
        epoch,
        agentId,
        operation,
        classification,
        paramsStr,
        now
      );

      this.logger?.log({
        agentId,
        action: 'record_effect_intent',
        status: 'intent_recorded',
        details: { effectId, idempotencyKey: resolvedKey, operation, classification, epoch }
      });

      result = {
        effectId,
        idempotencyKey: resolvedKey,
        alreadyCommitted: false,
        state: EffectState.INTENT_RECORDED
      };
    });

    return result;
  }

  markExecuting(effectId) {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE bridge_effects_ledger
      SET state = 'EXECUTING', started_at = ?
      WHERE effect_id = ?
    `).run(now, effectId);
  }

  commitEffect(effectIdOrObj, resultArg = null) {
    const effectId = (typeof effectIdOrObj === 'object' && effectIdOrObj !== null) ? effectIdOrObj.effectId : effectIdOrObj;
    const result = (typeof effectIdOrObj === 'object' && effectIdOrObj !== null) ? (effectIdOrObj.result ?? resultArg) : resultArg;
    const now = new Date().toISOString();
    const resStr = typeof result === 'object' && result !== null ? JSON.stringify(result) : result;
    runInImmediateTx(this.db, () => {
      this.db.prepare(`
        UPDATE bridge_effects_ledger
        SET state = 'COMMITTED', completed_at = ?, result = ?
        WHERE effect_id = ?
      `).run(now, resStr, effectId);
    });

    return { effectId, state: EffectState.COMMITTED, result };
  }

  failEffect(effectIdOrObj, errorArg = null) {
    const effectId = (typeof effectIdOrObj === 'object' && effectIdOrObj !== null) ? effectIdOrObj.effectId : effectIdOrObj;
    const error = (typeof effectIdOrObj === 'object' && effectIdOrObj !== null) ? (effectIdOrObj.error ?? errorArg) : errorArg;
    const now = new Date().toISOString();
    const errStr = error instanceof Error ? error.message : String(error || 'Failed');
    runInImmediateTx(this.db, () => {
      this.db.prepare(`
        UPDATE bridge_effects_ledger
        SET state = 'FAILED', completed_at = ?, error = ?
        WHERE effect_id = ?
      `).run(now, errStr, effectId);
    });

    return { effectId, state: EffectState.FAILED, error: errStr };
  }

  /**
   * Sweeps in-flight operations after crash/restart and transitions them to UNKNOWN
   */
  sweepIncompleteEffects(timeoutMs = 30000) {
    const cutoff = new Date(Date.now() - timeoutMs).toISOString();
    const rows = this.db.prepare(`
      SELECT * FROM bridge_effects_ledger
      WHERE state IN ('INTENT_RECORDED', 'EXECUTING') AND created_at <= ?
    `).all(cutoff);

    const transitioned = [];
    const now = new Date().toISOString();

    for (const row of rows) {
      this.db.prepare(`
        UPDATE bridge_effects_ledger
        SET state = 'UNKNOWN', error = 'Process interrupted during execution; marked UNKNOWN for reconciliation'
        WHERE effect_id = ?
      `).run(row.effect_id);

      this.logger?.log({
        agentId: row.agent_id,
        action: 'effect_marked_unknown',
        status: 'unknown',
        details: { effectId: row.effect_id, operation: row.operation, classification: row.classification }
      });

      transitioned.push(row.effect_id);
    }

    return transitioned;
  }

  getEffect(effectId) {
    return this.db.prepare(`SELECT * FROM bridge_effects_ledger WHERE effect_id = ?`).get(effectId);
  }
}
