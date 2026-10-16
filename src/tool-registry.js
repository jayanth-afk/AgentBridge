import path from 'node:path';
import os from 'node:os';
import { CONFIG } from './config.js';
import { createSessionAdapter } from './session-adapters/index.js';
import { isEffectfulTool, getToolClassification, EffectsLedger } from './effects/effects-ledger.js';
import { AttemptLedger } from './attempts/attempt-ledger.js';
import { ArtifactStore, ArtifactError } from './artifacts/artifact-store.js';
import { KnowledgeStore } from './memory/knowledge-store.js';
import { applyContractToField } from './protocol/response-contract.js';
import { SkillsManager } from './skills/skills-manager.js';
import { SignedSkillRegistry } from './skills/skill-registry.js';

// Lazily-created per-context artifact store, so every transport (stdio MCP, HTTP
// MCP, plugins) can store/retrieve real bytes without each wiring its own.
const artifactStoreCache = new WeakMap();
// Trusted identity for tool authorization.
//
// `args.agentId` must NEVER be used for authorization: on an unbound connection
// it is whatever the caller supplied, so it can be pointed at the owner of a
// resource to satisfy an ownership check. The trusted sources are the transport
// context (`ctx.agentId`, set from the authenticated credential) and, for stdio
// MCP servers which carry only `boundAgentId`, the connection binding.
function trustedCallerAgentId(ctx) {
  if (!ctx || typeof ctx !== 'object') return null;
  return ctx.agentId || ctx.boundAgentId || ctx.identity?.boundAgentId || null;
}

function assertGitMutationAllowed(ctx, callerAgent) {
  if (ctx && ctx.isPrivileged) return;
  const allowed = (CONFIG.GIT_MUTATION_ALLOWED_AGENTS || []).map(a => a.toLowerCase());
  const normCaller = callerAgent ? String(callerAgent).trim().toLowerCase() : 'anonymous';
  if (!normCaller || normCaller === 'anonymous' || !allowed.includes(normCaller)) {
    const err = new Error(`Unauthorized: agent '${callerAgent || 'anonymous'}' is not permitted to mutate git state (commit/push/branch). Git mutations are default-denied for all agents unless explicitly configured in GIT_MUTATION_ALLOWED_AGENTS.`);
    err.code = 'UNAUTHORIZED_GIT_MUTATION';
    throw err;
  }
}

async function resolveArtifactStore(ctx) {
  if (ctx.artifactStore) return ctx.artifactStore;
  let store = artifactStoreCache.get(ctx);
  if (!store && ctx.logger) {
    store = new ArtifactStore(ctx.logger);
    artifactStoreCache.set(ctx, store);
  }
  if (!store) throw new ArtifactError('Artifact store unavailable: no audit logger in context', 'ARTIFACT_STORE_UNAVAILABLE');
  return store;
}

const knowledgeStoreCache = new WeakMap();
function resolveKnowledgeStore(ctx) {
  if (ctx.knowledgeStore) return ctx.knowledgeStore;
  const db = ctx.db || ctx.logger?.db || null;
  // Cache the store on the durable DB handle when one exists. The store is
  // bound to that handle (it only creates tables and prepares statements), so
  // sharing it avoids re-running schema DDL and re-preparing statements for
  // every request. Transports that build a fresh context object per call (e.g.
  // the HTTP control plane) therefore stop re-instantiating it per tool call.
  // Without a DB the store owns a private in-memory database, so it must stay
  // keyed to the context and never be shared.
  const key = db && typeof db === 'object' ? db : ctx;
  let store = knowledgeStoreCache.get(key);
  if (!store) {
    store = new KnowledgeStore(db);
    knowledgeStoreCache.set(key, store);
  }
  return store;
}

const skillsManagerCache = new WeakMap();
export function resolveSkillsManager(ctx) {
  if (ctx && ctx.skillsManager) return ctx.skillsManager;
  let manager = (ctx && typeof ctx === 'object') ? skillsManagerCache.get(ctx) : null;
  if (!manager) {
    const isTest = Boolean(
      process.env.NODE_TEST_CONTEXT ||
      process.env.NODE_ENV === 'test' ||
      (Array.isArray(process.execArgv) && process.execArgv.some(a => a.startsWith('--test'))) ||
      (Array.isArray(process.argv) && process.argv.some(a => a.includes('node:test') || (a.includes('tests/') && a.endsWith('.test.js'))))
    );
    if (isTest) {
      const tmpDir = path.join(os.tmpdir(), 'ab-tool-skills-temp');
      manager = new SkillsManager({
        skillsRoot: path.join(tmpDir, 'skills'),
        lockfilePath: path.join(tmpDir, 'skills.lock.json')
      });
    } else {
      manager = new SkillsManager();
    }
    if (ctx && typeof ctx === 'object') {
      skillsManagerCache.set(ctx, manager);
    }
  }
  return manager;
}

export const SKILLS_TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'bridge_list_skills',
    description: 'List installed agent skills from .agents/skills with source, version, license, and risk tier.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Filter by source (inhouse, anthropics, composio, etc.)' },
        riskTier: { type: 'string', enum: ['A', 'B', 'C'], description: 'Filter by risk tier (A, B, C)' },
        limit: { type: 'number', description: 'Maximum skills to return (default 50)' },
        agentId: { type: 'string' }
      }
    }
  },
  {
    name: 'bridge_get_skill',
    description: 'Retrieve full skill metadata, SKILL.md body, and file manifest for an installed skill.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name' },
        source: { type: 'string', description: 'Skill source namespace (optional)' },
        agentId: { type: 'string' }
      },
      required: ['name']
    }
  },
  {
    name: 'bridge_get_skill_resource',
    description: 'Safely read a resource, script, or reference file within an installed skill.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name' },
        source: { type: 'string', description: 'Skill source namespace (optional)' },
        path: { type: 'string', description: 'Relative path to file within skill directory' },
        agentId: { type: 'string' }
      },
      required: ['name', 'path']
    }
  },
  {
    name: 'bridge_search_skills',
    description: 'Search installed skills by keywords, name, description, and markdown content relevance.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keywords or prompt' },
        source: { type: 'string', description: 'Filter by source (optional)' },
        riskTier: { type: 'string', enum: ['A', 'B', 'C'], description: 'Filter by risk tier (optional)' },
        limit: { type: 'number', description: 'Maximum skills to return (default 10)' },
        agentId: { type: 'string' }
      },
      required: ['query']
    }
  },
  {
    name: 'bridge_skill_load',
    description: 'Fetch skill body on demand by content hash, with hash cache deduplication.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name' },
        contentHash: { type: 'string', description: 'Client cached SHA-256 hash (optional)' },
        profile: { type: 'string', description: 'Agent profile (optional, defaults to default)' },
        agentId: { type: 'string' }
      },
      required: ['name']
    }
  }
]);

export const TOOL_PROFILES = Object.freeze({
  ALL: 'all',
  COMMUNICATION: 'communication',
  MINIMAL: 'minimal',
  COLLABORATOR: 'collaborator',
  DEVELOPER: 'developer',
  SKILLS: 'skills'
});

export const COMMUNICATION_TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'bridge_wait_for_response',
    description: 'Await correlated response for a request without polling. Registers waiter before durable check and returns instant result.',
    inputSchema: {
      type: 'object',
      properties: {
        requestId: { type: 'string', description: 'The unique request ID to wait for' },
        timeoutMs: { type: 'number', description: 'Timeout in milliseconds (default 60000)' }
      },
      required: ['requestId']
    }
  },
  {
    name: 'bridge_slice_fetch',
    description: 'Fetch bounded slice of content-addressed payload by hash reference (ref:<sha256>) without pulling large bodies into model context.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Content hash or reference (ref:<sha256>)' },
        offset: { type: 'number', description: 'Starting byte offset (default 0)' },
        length: { type: 'number', description: 'Number of bytes to fetch (default 4000)' }
      },
      required: ['ref']
    }
  }
]);

export const PROFILE_TOOLS = Object.freeze({
  communication: Object.freeze([
    'bridge_ask_agent',
    'bridge_wait_for_response',
    'bridge_submit_task_result',
    'bridge_slice_fetch',
    'bridge_discover_tools'
  ]),
  skills: Object.freeze([
    'bridge_ping',
    'bridge_list_skills',
    'bridge_get_skill',
    'bridge_get_skill_resource',
    'bridge_search_skills',
    'bridge_skill_load'
  ]),
  minimal: Object.freeze([
    'bridge_ping',
    'bridge_discover_agents',
    'bridge_agent_presence',
    'bridge_discover_tools',
    'bridge_tool_info',
    'bridge_ask_agent',
    'bridge_get_response',
    'bridge_answer_request'
  ]),
  collaborator: Object.freeze([
    'bridge_ping',
    'bridge_discover_agents',
    'bridge_agent_presence',
    'bridge_discover_tools',
    'bridge_tool_info',
    'bridge_ask_agent',
    'bridge_get_response',
    'bridge_answer_request',
    'bridge_send_message',
    'bridge_check_inbox',
    'bridge_delegate_task',
    'bridge_claim_task',
    'bridge_submit_task_result',
    'bridge_get_task_status',
    'bridge_get_pending_requests',
    'bridge_get_events'
  ]),
  developer: Object.freeze([
    'bridge_ping',
    'bridge_discover_agents',
    'bridge_agent_presence',
    'bridge_discover_tools',
    'bridge_tool_info',
    'bridge_ask_agent',
    'bridge_get_response',
    'bridge_answer_request',
    'bridge_send_message',
    'bridge_check_inbox',
    'bridge_delegate_task',
    'bridge_claim_task',
    'bridge_submit_task_result',
    'bridge_get_task_status',
    'bridge_get_pending_requests',
    'bridge_get_events',
    'bridge_inspect_project',
    'bridge_project_snapshot',
    'bridge_check_syntax',
    'bridge_read_file',
    'bridge_create_file',
    'bridge_edit_file',
    'bridge_delete_file',
    'bridge_search_files',
    'bridge_git_status',
    'bridge_git_diff',
    'bridge_git_commit',
    'bridge_git_branches',
    'bridge_git_switch_branch',
    'bridge_git_summary',
    'bridge_execute_command',
    'bridge_diagnostics'
  ]),
  all: null
});

/**
 * Canonical tool-count accessor (AR-10)
 * Derives accurate, verified tool counts dynamically from runtime definitions.
 *
 * Truth: 74 registered in core registry + 5 skills tools + 2 communication tools = 81 total tools.
 */
export function getCanonicalToolCounts() {
  const reg = new ToolRegistry();
  const registered = reg.getToolDefinitions('all');
  const registeredNames = new Set(registered.map(t => t.name));

  const allNames = new Set(registeredNames);
  for (const s of SKILLS_TOOL_DEFINITIONS) allNames.add(s.name);
  for (const c of COMMUNICATION_TOOL_DEFINITIONS) allNames.add(c.name);

  const profileCounts = {};
  for (const [prof, list] of Object.entries(PROFILE_TOOLS)) {
    if (Array.isArray(list)) {
      profileCounts[prof] = list.length;
    } else if (prof === 'all') {
      profileCounts[prof] = registered.length;
    }
  }

  return {
    totalSystemTools: allNames.size, // 81
    registeredTools: registered.length, // 74
    skillsTools: SKILLS_TOOL_DEFINITIONS.length, // 5
    communicationTools: COMMUNICATION_TOOL_DEFINITIONS.length, // 2
    profiles: profileCounts
  };
}

/**
 * Unified Tool Registry: Single Source of Truth for all Bridge tools across
 * stdio MCP, HTTP MCP, SSE, and plugins.
 */
export class ToolRegistry {
  constructor(options = {}) {
    this.tools = new Map();
    this.profile = (options.profile || process.env.AGENT_BRIDGE_TOOL_PROFILE || 'all').toLowerCase();
    this.registerCoreTools();
  }

  registerTool(definition) {
    if (!definition.name || !definition.handler) {
      throw new Error('Tool definition must have name and handler');
    }
    this.tools.set(definition.name, definition);
    // Any registration invalidates cached per-profile surface definitions.
    this._toolDefinitionCache?.clear();
  }

  /**
   * Return the tool surface for a profile.
   *
   * Memoized per profile: the surface is rebuilt only when a tool is registered
   * (see `registerTool`). Every `tools/list` request and every
   * `bridge_discover_tools` call reads this, so avoiding the 74-entry rebuild on
   * the hot path removes repeated allocation for no behavioural change.
   * The returned array is shared and must be treated as read-only.
   */
  getToolDefinitions(profile = this.profile) {
    const norm = (profile || 'all').toLowerCase();
    if (!this._toolDefinitionCache) this._toolDefinitionCache = new Map();
    const cached = this._toolDefinitionCache.get(norm);
    if (cached) return cached;
    const definitions = this._computeToolDefinitions(norm);
    this._toolDefinitionCache.set(norm, definitions);
    return definitions;
  }

  _computeToolDefinitions(norm) {
    if (norm === 'skills') {
      const pingDef = this.tools.get('bridge_ping');
      const ping = pingDef ? [{ name: pingDef.name, description: pingDef.description, inputSchema: pingDef.inputSchema }] : [];
      return [...ping, ...SKILLS_TOOL_DEFINITIONS];
    }
    if (norm === 'communication') {
      const askDef = this.tools.get('bridge_ask_agent');
      const submitDef = this.tools.get('bridge_submit_task_result');
      const discoverDef = this.tools.get('bridge_discover_tools');
      const commTools = [];
      if (askDef) commTools.push({ name: askDef.name, description: askDef.description, inputSchema: askDef.inputSchema });
      commTools.push(...COMMUNICATION_TOOL_DEFINITIONS);
      if (submitDef) commTools.push({ name: submitDef.name, description: submitDef.description, inputSchema: submitDef.inputSchema });
      if (discoverDef) commTools.push({ name: discoverDef.name, description: discoverDef.description, inputSchema: discoverDef.inputSchema });
      return commTools;
    }
    const allowed = PROFILE_TOOLS[norm] ?? null;

    const all = Array.from(this.tools.values()).map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema
    }));

    if (!allowed) {
      return all;
    }

    const allowedSet = new Set(allowed);
    return all.filter(t => allowedSet.has(t.name));
  }

  async executeTool(name, rawArgs = {}, context = {}) {
    // Alias bridge_search_tools -> bridge_discover_tools
    const resolvedName = name === 'bridge_search_tools' ? 'bridge_discover_tools' : name;
    let tool = this.tools.get(resolvedName);
    if (!tool && resolvedName === 'bridge_acknowledge_delivery') {
      tool = {
        name: 'bridge_acknowledge_delivery',
        handler: async (args, ctx) => {
          const callerAgentId = trustedCallerAgentId(ctx) || 'anonymous';
          return ctx.mailbox.acknowledgeDelivery({
            requestId: args.requestId,
            agentId: callerAgentId
          });
        }
      };
    }
    if (!tool && resolvedName === 'bridge_explain_request') {
      tool = {
        name: 'bridge_explain_request',
        handler: async (args, ctx) => {
          const callerId = trustedCallerAgentId(ctx);
          if (!ctx.isPrivileged && (!callerId || callerId === 'anonymous')) {
            const noIdentErr = new Error(`Unauthorized: no authenticated identity on this connection; cannot explain request '${args.requestId}'`);
            noIdentErr.code = 'UNAUTHORIZED_EXPLAIN_ACCESS';
            throw noIdentErr;
          }
          const caller = { agentId: callerId, isPrivileged: Boolean(ctx.isPrivileged) };
          if (ctx.requestExplainer) {
            return ctx.requestExplainer.explainRequest(args.requestId, caller);
          }
          const { RequestExplainer } = await import('./diagnostics/request-explainer.js');
          const explainer = new RequestExplainer(ctx.db || ctx.audit?.db || ctx.logger?.db || ctx.logger || ctx.mailbox?.db);
          return explainer.explainRequest(args.requestId, caller);
        }
      };
    }
    if (!tool && resolvedName === 'bridge_request_ledger') {
      tool = {
        name: 'bridge_request_ledger',
        handler: async (args, ctx) => {
          const { RequestTracer } = await import('./diagnostics/request-tracer.js');
          const tracer = ctx.tracer || ctx.mailbox?.tracer || (ctx.db || ctx.audit?.db || ctx.logger?.db ? new RequestTracer({ db: ctx.db || ctx.audit?.db || ctx.logger?.db }) : null);
          // Authorization MUST come from the trusted transport context only.
          const callerId = ctx.isPrivileged ? null : trustedCallerAgentId(ctx);
          const ledger = tracer?.getLedger ? tracer.getLedger(args.requestId) : null;
          if (!ledger) {
            return { found: false, requestId: args.requestId, error: 'Ledger not found' };
          }
          if (!ctx.isPrivileged && (!callerId || callerId === 'anonymous')) {
            const noIdentErr = new Error(`Unauthorized: no authenticated identity on this connection; cannot inspect ledger for request '${args.requestId}'`);
            noIdentErr.code = 'UNAUTHORIZED_LEDGER_ACCESS';
            throw noIdentErr;
          }
          if (callerId && !ctx.isPrivileged) {
            const normCaller = String(callerId).trim().toLowerCase();
            const fromNorm = String(ledger.fromAgent || '').trim().toLowerCase();
            const toNorm = String(ledger.toAgent || '').trim().toLowerCase();
            if (normCaller !== fromNorm && normCaller !== toNorm) {
              const unauthErr = new Error(`Unauthorized: agent '${callerId}' is not authorized to inspect ledger for request '${args.requestId}'`);
              unauthErr.code = 'UNAUTHORIZED_LEDGER_ACCESS';
              throw unauthErr;
            }
          }
          return {
            found: true,
            requestId: args.requestId,
            status: ledger.status,
            failureStage: ledger.failureStage || null,
            ledger,
            formatted: tracer.formatLedgerText(ledger)
          };
        }
      };
    }
    if (!tool && resolvedName === 'bridge_wait_for_response') {
      tool = {
        name: 'bridge_wait_for_response',
        handler: async (args, ctx) => {
          const callerAgent = trustedCallerAgentId(ctx);
          if (!ctx.isPrivileged && (!callerAgent || callerAgent === 'anonymous')) {
            const unauthErr = new Error(`Unauthorized: no authenticated identity on this connection; cannot wait for response for request '${args.requestId}'`);
            unauthErr.code = 'UNAUTHORIZED_RESPONSE_ACCESS';
            throw unauthErr;
          }
          const mailbox = ctx.mailbox;
          const eventBus = ctx.eventBus || mailbox?.eventBus;
          const timeoutMs = args.timeoutMs || 60000;
          if (!eventBus) throw new Error('EventBus not available in execution context');
          const outcome = await eventBus.waitForResponse({
            requestId: args.requestId,
            agentId: ctx.isPrivileged ? (args.agentId || callerAgent) : callerAgent,
            attemptId: args.attemptId || ctx.attemptId || null,
            epoch: args.epoch !== undefined ? args.epoch : (ctx.epoch !== undefined ? ctx.epoch : null),
            timeoutMs
          });

          // Check response ownership on resolution
          if (outcome && !ctx.isPrivileged && callerAgent) {
            const normCaller = String(callerAgent).trim().toLowerCase();
            const fromNorm = outcome.fromAgent ? String(outcome.fromAgent).trim().toLowerCase() : null;
            const toNorm = outcome.toAgent ? String(outcome.toAgent).trim().toLowerCase() : null;
            if (fromNorm && toNorm && normCaller !== fromNorm && normCaller !== toNorm) {
              const err = new Error(`Unauthorized: agent '${callerAgent}' is not authorized to receive response for request '${args.requestId}'`);
              err.code = 'UNAUTHORIZED_RESPONSE_ACCESS';
              throw err;
            }
          }

          // Commit to bridge user display immediately upon resolution
          const { defaultDisplayManager } = await import('./display/bridge-display-manager.js');
          const displayMgr = ctx.displayManager || defaultDisplayManager;
          if (outcome && (outcome.status === 'completed' || outcome.response)) {
            await displayMgr.commitResult(args.requestId, outcome, {
              fromAgent: outcome.fromAgent || callerAgent || null
            });
          }

          if (args.compact !== false && outcome && outcome.status === 'completed') {
            return displayMgr.formatToolResult(outcome, { casStore: ctx.casStore });
          }

          return outcome;
        }
      };
    }
    if (!tool && resolvedName === 'bridge_slice_fetch') {
      tool = {
        name: 'bridge_slice_fetch',
        handler: async (args, ctx) => {
          const { defaultCASStore } = await import('./artifacts/content-addressed-store.js');
          const cas = ctx.casStore || defaultCASStore;
          const slice = cas.getSlice(args.ref, args.offset || 0, args.length || 4000);
          if (!slice) {
            if (ctx.artifactStore) {
              const callerAgent = trustedCallerAgentId(ctx);
              if (!ctx.isPrivileged && (!callerAgent || callerAgent === 'anonymous')) {
                const unauthErr = new Error(`Unauthorized: no authenticated identity on this connection; cannot fetch content slice '${args.ref}'`);
                unauthErr.code = 'ARTIFACT_UNAUTHORIZED';
                throw unauthErr;
              }
              try {
                return ctx.artifactStore.readChunk(args.ref, {
                  agentId: callerAgent,
                  offset: args.offset || 0,
                  length: args.length || 4000
                });
              } catch (artErr) {
                if (artErr?.code === 'ARTIFACT_UNAUTHORIZED') {
                  throw artErr;
                }
              }
            }
            return { found: false, error: `Content reference '${args.ref}' not found in CAS store` };
          }
          return { found: true, ...slice };
        }
      };
    }
    if (!tool && resolvedName === 'bridge_get_protocol_snippet') {
      tool = {
        name: 'bridge_get_protocol_snippet',
        handler: async (args, ctx) => {
          const { STABLE_PROTOCOL_INSTRUCTIONS } = await import('./protocol/stable-protocol.js');
          return {
            agentId: args.agentId || ctx.agentId || 'all',
            snippet: STABLE_PROTOCOL_INSTRUCTIONS,
            instructions: 'Paste this snippet into the agent custom instructions / system instructions.'
          };
        }
      };
    }
    if (!tool && resolvedName === 'bridge_list_skills') {
      tool = {
        name: 'bridge_list_skills',
        handler: async (args, ctx) => {
          const sm = resolveSkillsManager(ctx);
          return sm.listSkills({
            source: args.source,
            riskTier: args.riskTier,
            limit: args.limit
          });
        }
      };
    }
    if (!tool && resolvedName === 'bridge_get_skill') {
      tool = {
        name: 'bridge_get_skill',
        handler: async (args, ctx) => {
          const sm = resolveSkillsManager(ctx);
          return sm.getSkill({
            name: args.name,
            source: args.source
          });
        }
      };
    }
    if (!tool && resolvedName === 'bridge_get_skill_resource') {
      tool = {
        name: 'bridge_get_skill_resource',
        handler: async (args, ctx) => {
          const sm = resolveSkillsManager(ctx);
          return sm.getSkillResource({
            name: args.name,
            source: args.source,
            path: args.path
          });
        }
      };
    }
    if (!tool && resolvedName === 'bridge_search_skills') {
      tool = {
        name: 'bridge_search_skills',
        handler: async (args, ctx) => {
          const sm = resolveSkillsManager(ctx);
          return sm.searchSkills({
            query: args.query,
            source: args.source,
            riskTier: args.riskTier,
            limit: args.limit
          });
        }
      };
    }
    if (!tool && resolvedName === 'bridge_skill_load') {
      tool = {
        name: 'bridge_skill_load',
        handler: async (args, ctx) => {
          const sm = resolveSkillsManager(ctx);
          const reg = ctx.signedSkillRegistry || new SignedSkillRegistry({ skillsManager: sm, auditLogger: ctx.logger });
          return reg.loadSkill(args.name, {
            agentId: args.agentId || ctx.agentId || 'anonymous',
            agentProfile: args.profile || 'default',
            clientHash: args.contentHash || null
          });
        }
      };
    }
    if (!tool) {
      throw new Error(`Unknown tool: '${name}'`);
    }

    const t0 = Date.now();

    // Resolve caller identity through AgentIdentityManager. The resolved
    // identity is authoritative for authorization; a caller cannot substitute
    // an arbitrary agentId/fromAgent/approver/actor for a different identity.
    let callerAgentId = null;
    const rawBound = context.agentId || context.boundAgentId || null;
    const boundTransportId = rawBound && rawBound !== 'anonymous' ? rawBound : null;

    if (context.identity) {
      const candidate = rawArgs.agentId || rawArgs.fromAgent || context.agentId || context.boundAgentId || null;
      const resolved = context.identity.resolveIdentity(candidate, {
        token: rawArgs.token,
        allowCompatibility: context.allowIdentityCompatibility
      });
      const isAuthenticated = context.isPrivileged === true ||
        (Boolean(boundTransportId) && boundTransportId.toLowerCase() === (resolved.agentId || '').toLowerCase()) ||
        resolved.authenticated === true;
      if (context.requireAuthentication === true && !isAuthenticated) {
        throw new Error(`Unauthorized: caller for tool '${name}' could not be authenticated.`);
      }
      if (boundTransportId && !context.isPrivileged && rawArgs.agentId && String(rawArgs.agentId).trim().toLowerCase() !== String(boundTransportId).trim().toLowerCase()) {
        throw new Error(`Unauthorized: caller '${boundTransportId}' cannot impersonate or act as '${rawArgs.agentId}'.`);
      }
      if (boundTransportId && !context.isPrivileged && rawArgs.fromAgent && String(rawArgs.fromAgent).trim().toLowerCase() !== String(boundTransportId).trim().toLowerCase()) {
        throw new Error(`Unauthorized: caller '${boundTransportId}' cannot send as '${rawArgs.fromAgent}'.`);
      }
      if (boundTransportId && !context.isPrivileged && rawArgs.approver && String(rawArgs.approver).trim().toLowerCase() !== String(boundTransportId).trim().toLowerCase()) {
        throw new Error(`Unauthorized: caller '${boundTransportId}' cannot act as approver '${rawArgs.approver}'.`);
      }
      if (boundTransportId && !context.isPrivileged && rawArgs.actor && String(rawArgs.actor).trim().toLowerCase() !== String(boundTransportId).trim().toLowerCase()) {
        throw new Error(`Unauthorized: caller '${boundTransportId}' cannot act as '${rawArgs.actor}'.`);
      }

      if (!boundTransportId && !resolved.authenticated && !context.isPrivileged) {
        callerAgentId = 'anonymous';
      } else {
        callerAgentId = resolved.agentId;
      }
    } else if (context.isPrivileged === true) {
      callerAgentId = rawArgs.fromAgent || rawArgs.agentId || boundTransportId || 'system';
    } else if (boundTransportId) {
      // Bound/authenticated identity from transport
      const boundId = String(boundTransportId).trim().toLowerCase();
      if (!context.isPrivileged) {
        if (rawArgs.agentId && String(rawArgs.agentId).trim().toLowerCase() !== boundId) {
          throw new Error(`Unauthorized: caller '${boundTransportId}' cannot impersonate or act as '${rawArgs.agentId}'.`);
        }
        if (rawArgs.fromAgent && String(rawArgs.fromAgent).trim().toLowerCase() !== boundId) {
          throw new Error(`Unauthorized: caller '${boundTransportId}' cannot send as '${rawArgs.fromAgent}'.`);
        }
        if (rawArgs.approver && String(rawArgs.approver).trim().toLowerCase() !== boundId) {
          throw new Error(`Unauthorized: caller '${boundTransportId}' cannot act as approver '${rawArgs.approver}'.`);
        }
        if (rawArgs.actor && String(rawArgs.actor).trim().toLowerCase() !== boundId) {
          throw new Error(`Unauthorized: caller '${boundTransportId}' cannot act as '${rawArgs.actor}'.`);
        }
      }
      callerAgentId = boundTransportId;
    } else {
      callerAgentId = 'anonymous';
    }

    // Attach resolved agentId to arguments and context
    context.agentId = callerAgentId;
    const args = { ...rawArgs, agentId: callerAgentId };
    if (rawArgs.fromAgent) args.fromAgent = context.isPrivileged ? rawArgs.fromAgent : callerAgentId;
    if (rawArgs.approver) args.approver = context.isPrivileged ? rawArgs.approver : callerAgentId;
    if (rawArgs.actor) args.actor = context.isPrivileged ? rawArgs.actor : callerAgentId;

    // Classification & Authoritative Execution Boundary Check
    const effectful = isEffectfulTool(name);

    if (effectful && (callerAgentId === 'anonymous' || context.agentId === 'anonymous')) {
      throw new Error(`Unauthorized: anonymous callers cannot execute effectful tool '${name}'.`);
    }

    if (!effectful) {
      // PURE / READ-ONLY: Executed directly without requiring Attempt context
      try {
        const result = await tool.handler(args, context);
        const durationMs = Date.now() - t0;
        context.diagnostics?.recordToolExecution(name, durationMs, true);
        return result;
      } catch (err) {
        const durationMs = Date.now() - t0;
        context.diagnostics?.recordToolExecution(name, durationMs, false);
        throw err;
      }
    }

    // EFFECTFUL TOOL: Validate attempt context and enforce EffectsLedger
    const attemptId = rawArgs.attemptId || context.attemptId || null;
    const epoch = rawArgs.epoch !== undefined && rawArgs.epoch !== null
      ? Number(rawArgs.epoch)
      : (context.epoch !== undefined && context.epoch !== null ? Number(context.epoch) : null);
    const idempotencyKey = rawArgs.idempotencyKey || context.idempotencyKey || null;
    const taskId = rawArgs.taskId || context.taskId || null;

    const isV2Scoped = Boolean(attemptId);
    const strictEnforced = context.enforcementMode === 'V2_ATTEMPT_SCOPED' ||
      context.strictAttempts === true ||
      Boolean(CONFIG.STRICT_V2_ATTEMPTS) ||
      process.env.AGENT_BRIDGE_STRICT_ATTEMPTS === 'true';

    if (!isV2Scoped) {
      if (strictEnforced) {
        const err = new Error(
          `V2_ENFORCEMENT_ERROR: Effectful tool '${name}' requires an active Attempt context (attemptId, epoch). Operating under LEGACY_UNSCOPED is blocked in strict mode.`
        );
        err.code = 'V2_ENFORCEMENT_ERROR';
        throw err;
      }

      // Legacy Compatibility Mode: explicit audit warning and proceed
      context.logger?.log({
        agentId: callerAgentId,
        action: 'tool_execution_unscoped',
        status: 'warning',
        details: {
          tool: name,
          mode: 'LEGACY_UNSCOPED',
          warning: 'Effectful tool executed without active AttemptLedger/EffectsLedger fencing.'
        }
      });

      try {
        const result = await tool.handler(args, context);
        const durationMs = Date.now() - t0;
        context.diagnostics?.recordToolExecution(name, durationMs, true);
        return result;
      } catch (err) {
        const durationMs = Date.now() - t0;
        context.diagnostics?.recordToolExecution(name, durationMs, false);
        throw err;
      }
    }

    // V2_ATTEMPT_SCOPED Execution
    if (epoch === null || isNaN(epoch)) {
      throw new Error(`Fencing Error: epoch token is required when attemptId is provided for effectful tool '${name}'.`);
    }

    const attemptLedger = context.attemptLedger || context.taskManager?.attempts || (context.logger?.db ? new AttemptLedger(context.logger) : null);
    if (!attemptLedger) {
      throw new Error(`AttemptLedger unavailable to validate attempt '${attemptId}'.`);
    }

    const attempt = attemptLedger.getAttempt(attemptId);
    if (!attempt) {
      const err = new Error(`Attempt '${attemptId}' does not exist.`);
      err.code = 'ATTEMPT_NOT_FOUND';
      throw err;
    }

    if (taskId && attempt.taskId !== taskId) {
      const err = new Error(`Attempt '${attemptId}' is bound to task '${attempt.taskId}', not '${taskId}'.`);
      err.code = 'TASK_BINDING_MISMATCH';
      throw err;
    }

    // Monotonic fencing & lease check (throws FENCED_ATTEMPT_ERROR, LEASE_EXPIRED_ERROR, IMPERSONATION_ERROR)
    attemptLedger.validateFencing({
      taskId: attempt.taskId,
      attemptId,
      epoch,
      agentId: callerAgentId
    });

    // Derive Effective Authority / Grant check
    if (attempt.grant) {
      let grantObj = attempt.grant;
      if (typeof grantObj === 'string') {
        try { grantObj = JSON.parse(grantObj); } catch  {
      // swallow-ok: safe fallback for plaintext or non-JSON input
    }
      }
      if (typeof grantObj === 'object' && grantObj !== null) {
        if (grantObj.allowedTools && Array.isArray(grantObj.allowedTools)) {
          if (!grantObj.allowedTools.includes('*') && !grantObj.allowedTools.includes(name)) {
            const grantErr = new Error(`GRANT_VIOLATION_ERROR: Tool '${name}' is not permitted under attempt grant.`);
            grantErr.code = 'GRANT_VIOLATION_ERROR';
            throw grantErr;
          }
        }
        if ((grantObj.allowedPaths || grantObj.allowedRoots) && (rawArgs.filePath || rawArgs.rootPath)) {
          const target = path.resolve(rawArgs.filePath || rawArgs.rootPath);
          const allowedList = (grantObj.allowedPaths || grantObj.allowedRoots).map(p => path.resolve(p));
          const permitted = allowedList.some(p => target === p || target.startsWith(p + path.sep));
          if (!permitted) {
            const grantErr = new Error(`GRANT_VIOLATION_ERROR: Target path '${rawArgs.filePath || rawArgs.rootPath}' is outside attempt grant.`);
            grantErr.code = 'GRANT_VIOLATION_ERROR';
            throw grantErr;
          }
        }
      }
    }

    // Workspace Worktree Substitution check
    if (rawArgs.worktreePath && attempt.worktreePath) {
      if (path.resolve(rawArgs.worktreePath) !== path.resolve(attempt.worktreePath)) {
        const subErr = new Error(
          `WORKSPACE_ISOLATION_ERROR: Worktree substitution forbidden. Attempt '${attemptId}' is bound to '${attempt.worktreePath}', but '${rawArgs.worktreePath}' was provided.`
        );
        subErr.code = 'WORKSPACE_ISOLATION_ERROR';
        throw subErr;
      }
    }

    // Workspace Worktree Isolation check
    if (attempt.worktreePath && (rawArgs.filePath || rawArgs.rootPath)) {
      const target = path.resolve(rawArgs.filePath || rawArgs.rootPath);
      const authorizedWorktree = path.resolve(attempt.worktreePath);
      if (target !== authorizedWorktree && !target.startsWith(authorizedWorktree + path.sep)) {
        const wsErr = new Error(
          `WORKSPACE_ISOLATION_ERROR: Attempt '${attemptId}' is restricted to isolated worktree '${attempt.worktreePath}'. Target path '${rawArgs.filePath || rawArgs.rootPath}' is outside authorized worktree.`
        );
        wsErr.code = 'WORKSPACE_ISOLATION_ERROR';
        throw wsErr;
      }
    }

    // External write task mandatory worktree check
    const isExternalWriteTask = Boolean(rawArgs.isExternal || context.isExternal || rawArgs.isExternalWrite || context.isExternalWrite);
    if (isExternalWriteTask && !attempt.worktreePath && ['bridge_create_file', 'bridge_edit_file', 'bridge_delete_file', 'bridge_apply_patch'].includes(name)) {
      const noWsErr = new Error(
        `WORKSPACE_ISOLATION_ERROR: Mandatory workspace isolation: external write tasks require an isolated worktree under v2 enforcement.`
      );
      noWsErr.code = 'WORKSPACE_ISOLATION_ERROR';
      throw noWsErr;
    }

    // Protected project (e.g. Zia) check
    if (rawArgs.filePath || rawArgs.rootPath) {
      const target = path.resolve(rawArgs.filePath || rawArgs.rootPath);
      const isProtected = (context.workspaceManager && typeof context.workspaceManager.isProtectedProject === 'function' && context.workspaceManager.isProtectedProject(target)) ||
        Boolean(CONFIG.ZIA_ROOT && (target === path.resolve(CONFIG.ZIA_ROOT) || target.startsWith(path.resolve(CONFIG.ZIA_ROOT) + path.sep)));

      if (isProtected) {
        if (CONFIG.ZIA_WRITE_LOCKED || !attempt.worktreePath) {
          const ziaErr = new Error(`PROTECTED_PROJECT_ERROR: Direct writes to protected project (${target}) are strictly forbidden. Isolated worktree and human approval required.`);
          ziaErr.code = 'PROTECTED_PROJECT_ERROR';
          throw ziaErr;
        }
      }
    }

    // Enforce Idempotency & Effects Ledger
    const effectsLedger = context.effectsLedger || (context.logger?.db ? new EffectsLedger(context.logger) : null);
    if (!effectsLedger) {
      throw new Error('EffectsLedger unavailable for effectful tool execution.');
    }

    const classification = getToolClassification(name);
    const intent = effectsLedger.recordIntent({
      idempotencyKey,
      attemptId,
      taskId: attempt.taskId,
      epoch,
      agentId: callerAgentId,
      operation: name,
      classification,
      params: args,
      attemptLedger
    });

    if (intent.alreadyCommitted) {
      context.logger?.log({
        agentId: callerAgentId,
        action: 'idempotent_effect_replayed',
        status: 'replayed',
        details: { tool: name, effectId: intent.effectId, idempotencyKey: intent.idempotencyKey }
      });
      const durationMs = Date.now() - t0;
      context.diagnostics?.recordToolExecution(name, durationMs, true);
      return intent.result;
    }

    effectsLedger.markExecuting(intent.effectId);
    try {
      const result = await tool.handler(args, context);
      effectsLedger.commitEffect(intent.effectId, result);
      const durationMs = Date.now() - t0;
      context.diagnostics?.recordToolExecution(name, durationMs, true);
      return result;
    } catch (err) {
      effectsLedger.failEffect(intent.effectId, err);
      const durationMs = Date.now() - t0;
      context.diagnostics?.recordToolExecution(name, durationMs, false);
      throw err;
    }
  }

  registerCoreTools() {
    // 1. Diagnostics & Health
    this.registerTool({
      name: 'bridge_ping',
      description: 'Harmless health check tool verifying Agent Bridge connectivity.',
      inputSchema: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'Caller agent identity' }
        }
      },
      handler: async (args, ctx) => {
        const caller = args.agentId || 'unknown';
        const timestamp = new Date().toISOString();
        ctx.logger?.log({
          agentId: caller,
          action: 'bridge_ping',
          status: 'success',
          details: { responseToken: CONFIG.RESPONSE_TOKEN }
        });
        return {
          status: 'OK',
          token: CONFIG.RESPONSE_TOKEN,
          timestamp,
          caller,
          environment: CONFIG.ENVIRONMENT_LABEL,
          bridgePath: CONFIG.BRIDGE_ROOT,
          message: `${CONFIG.RESPONSE_TOKEN}: Agent Bridge is operational on ${CONFIG.ENVIRONMENT_LABEL}.`
        };
      }
    });

    this.registerTool({
      name: 'bridge_discover_agents',
      description: 'Discover active agents registered with the bridge, lock states, and allowed project roots.',
      inputSchema: {
        type: 'object',
        properties: {
          agentId: { type: 'string' }
        }
      },
      handler: async (args, ctx) => ({
        registeredAgents: CONFIG.AGENT_IDENTITIES,
        liveAgents: ctx.presence ? ctx.presence.listAgents() : [],
        ziaWriteLocked: CONFIG.ZIA_WRITE_LOCKED,
        allowedRoots: CONFIG.ALLOWED_ROOTS
      })
    });

    this.registerTool({
      name: 'bridge_agent_presence',
      description: 'Query live agent presence, connection states, and current active tasks.',
      inputSchema: {
        type: 'object',
        properties: {
          agentId: { type: 'string' }
        }
      },
      handler: async (args, ctx) => {
        return {
          agents: ctx.presence ? ctx.presence.listAgents() : [],
          timestamp: new Date().toISOString()
        };
      }
    });

    this.registerTool({
      name: 'bridge_diagnostics',
      description: 'Get compact performance metrics, tool latencies, cache statistics, per-agent observability, or request causal lifecycle traces.',
      inputSchema: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'Optional agent ID to retrieve specific agent state, cursor, and pending metrics' },
          requestId: { type: 'string', description: 'Optional request ID to explain the causal request lifecycle trace' }
        }
      },
      handler: async (args, ctx) => {
        if (args.requestId) {
          const callerId = trustedCallerAgentId(ctx);
          if (!ctx.isPrivileged && (!callerId || callerId === 'anonymous')) {
            const err = new Error(`Unauthorized: no authenticated identity on this connection; cannot inspect request diagnostics for '${args.requestId}'`);
            err.code = 'UNAUTHORIZED_DIAGNOSTICS_ACCESS';
            throw err;
          }
          const caller = { agentId: callerId, isPrivileged: Boolean(ctx.isPrivileged) };
          if (ctx.requestExplainer) {
            return ctx.requestExplainer.explainRequest(args.requestId, caller);
          }
          const { RequestExplainer } = await import('./diagnostics/request-explainer.js');
          const explainer = new RequestExplainer(ctx.db || ctx.audit?.db || ctx.logger?.db || ctx.mailbox?.db);
          return explainer.explainRequest(args.requestId, caller);
        }
        if (args.agentId && ctx.diagnostics) {
          const callerId = trustedCallerAgentId(ctx);
          if (!ctx.isPrivileged && (!callerId || callerId === 'anonymous' || callerId.toLowerCase() !== args.agentId.toLowerCase())) {
            const err = new Error(`Unauthorized: caller '${callerId || 'anonymous'}' cannot inspect diagnostics for agent '${args.agentId}'`);
            err.code = 'UNAUTHORIZED_DIAGNOSTICS_ACCESS';
            throw err;
          }
          return ctx.diagnostics.getAgentDiagnostics(args.agentId, {
            db: ctx.db || ctx.audit?.db,
            eventBus: ctx.eventBus,
            presenceManager: ctx.presence,
            taskManager: ctx.taskManager
          });
        }
        return ctx.diagnostics ? ctx.diagnostics.getSnapshot(ctx.cache) : { status: 'no_diagnostics' };
      }
    });

    // 2. Project & Filesystem
    this.registerTool({
      name: 'bridge_context',
      description: 'Return compact task-oriented project context: git state, structure, and optional relevant search hits.',
      inputSchema: {
        type: 'object',
        properties: {
          rootPath: { type: 'string' },
          query: { type: 'string' },
          maxResults: { type: 'number' },
          agentId: { type: 'string' }
        },
        required: ['agentId']
      },
      handler: async (args, ctx) => {
        const context = await ctx.controller.buildContext(args.rootPath, args.agentId, args.query, args.maxResults);
        context.tasks = ctx.taskManager ? ctx.taskManager.listTasks({ agentId: args.agentId, limit: 6, compact: true }) : [];
        context.agents = ctx.presence ? ctx.presence.listAgents() : [];
        context.pendingRequests = ctx.mailbox ? ctx.mailbox.getPendingRequests(args.agentId, 5) : [];
        return context;
      }
    });

    this.registerTool({
      name: 'bridge_find_symbol',
      description: 'Find code symbol definitions with compact file and line references.',
      inputSchema: {
        type: 'object',
        properties: {
          rootPath: { type: 'string' },
          symbol: { type: 'string' },
          maxResults: { type: 'number' },
          agentId: { type: 'string' }
        },
        required: ['rootPath', 'symbol', 'agentId']
      },
      handler: async (args, ctx) => ctx.controller.findSymbol(args.rootPath, args.agentId, args.symbol, args.maxResults)
    });

    this.registerTool({
      name: 'bridge_read_symbol',
      description: 'Read a bounded source window around a symbol definition instead of an entire file.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          symbol: { type: 'string' },
          contextLines: { type: 'number' },
          maxLines: { type: 'number' },
          agentId: { type: 'string' }
        },
        required: ['filePath', 'symbol', 'agentId']
      },
      handler: async (args, ctx) => ctx.controller.readSymbol(args.filePath, args.agentId, args.symbol, args.contextLines, args.maxLines)
    });


    this.registerTool({
      name: 'bridge_test_plan',
      description: 'Build a compact test plan from changed files and available test files, with a full-suite fallback.',
      inputSchema: {
        type: 'object',
        properties: { rootPath: { type: 'string' }, agentId: { type: 'string' } },
        required: ['agentId']
      },
      handler: async (args, ctx) => ctx.controller.testPlan(args.rootPath, args.agentId)
    });

    this.registerTool({
      name: 'bridge_inspect_project',
      description: 'Inspect a project root directory, returning files and directories.',
      inputSchema: {
        type: 'object',
        properties: {
          rootPath: { type: 'string', description: 'Directory path' },
          agentId: { type: 'string' }
        },
        required: ['rootPath', 'agentId']
      },
      handler: async (args, ctx) => ctx.controller.inspectProject(args.rootPath, args.agentId)
    });

    this.registerTool({
      name: 'bridge_project_snapshot',
      description: 'Compact project snapshot with git branch, status, structure, and active tasks.',
      inputSchema: {
        type: 'object',
        properties: {
          rootPath: { type: 'string', description: 'Directory path (defaults to bridge root)' },
          agentId: { type: 'string' }
        }
      },
      handler: async (args, ctx) => ctx.controller.projectSnapshot(args.rootPath, args.agentId)
    });

    this.registerTool({
      name: 'bridge_read_file',
      description: 'Read file with line numbers and SHA-256 hash. Defaults to compact output.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Absolute file path' },
          agentId: { type: 'string' },
          startLine: { type: 'number', description: 'Starting line (default 1)' },
          endLine: { type: 'number', description: 'Ending line (default 100)' },
          compact: { type: 'boolean', description: 'Omit extra metadata for low token burn' },
          knownHash: { type: 'string', description: 'If unchanged, return only unchanged=true and the current hash' }
        },
        required: ['filePath', 'agentId']
      },
      handler: async (args, ctx) => ctx.controller.readFile(args.filePath, args.agentId, args.startLine, args.endLine, args.compact, args.knownHash)
    });

    this.registerTool({
      name: 'bridge_create_file',
      description: 'Create a new file in an authorized workspace.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          content: { type: 'string' },
          overwrite: { type: 'boolean' },
          agentId: { type: 'string' }
        },
        required: ['filePath', 'content', 'agentId']
      },
      handler: async (args, ctx) => ctx.controller.createFile(args.filePath, args.agentId, args.content, args.overwrite)
    });

    this.registerTool({
      name: 'bridge_edit_file',
      description: 'Replace an exact target content string with optimistic hash verification.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          targetContent: { type: 'string' },
          replacementContent: { type: 'string' },
          expectedHash: { type: 'string' },
          agentId: { type: 'string' }
        },
        required: ['filePath', 'targetContent', 'replacementContent', 'agentId']
      },
      handler: async (args, ctx) => ctx.controller.editFile(args.filePath, args.agentId, args.targetContent, args.replacementContent, args.expectedHash)
    });

    this.registerTool({
      name: 'bridge_apply_patch',
      description: 'Atomic compare-and-swap patch operation with expectedHash, conflict detection, and minimal response tokens.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          patch: {
            type: 'object',
            description: 'Patch object with targetContent/replacementContent or newContent'
          },
          expectedHash: { type: 'string', description: 'Expected current file SHA-256 hash' },
          agentId: { type: 'string' }
        },
        required: ['filePath', 'patch', 'agentId']
      },
      handler: async (args, ctx) => ctx.controller.applyPatch(args.filePath, args.agentId, args.patch, args.expectedHash)
    });

    this.registerTool({
      name: 'bridge_delete_file',
      description: 'Safely delete a file in an authorized workspace.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          agentId: { type: 'string' }
        },
        required: ['filePath', 'agentId']
      },
      handler: async (args, ctx) => ctx.controller.deleteFile(args.filePath, args.agentId)
    });

    this.registerTool({
      name: 'bridge_search_files',
      description: 'Fast search across project files with snippet bounds, filters, and noise directory skipping.',
      inputSchema: {
        type: 'object',
        properties: {
          rootPath: { type: 'string' },
          query: { type: 'string' },
          isRegex: { type: 'boolean' },
          maxResults: { type: 'number', description: 'Max results (default 20, max 100)' },
          extensions: { type: 'array', items: { type: 'string' }, description: 'e.g. [".js", ".swift"]' },
          agentId: { type: 'string' }
        },
        required: ['rootPath', 'query', 'agentId']
      },
      handler: async (args, ctx) => ctx.controller.searchFiles(args.rootPath, args.agentId, args.query, args.isRegex, args.maxResults, args.extensions)
    });

    this.registerTool({
      name: 'bridge_batch_read',
      description: 'Read multiple files in a single round-trip with line bounds and hashes.',
      inputSchema: {
        type: 'object',
        properties: {
          files: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                filePath: { type: 'string' },
                startLine: { type: 'number' },
                endLine: { type: 'number' }
              },
              required: ['filePath']
            }
          },
          compact: { type: 'boolean' },
          agentId: { type: 'string' }
        },
        required: ['files', 'agentId']
      },
      handler: async (args, ctx) => ctx.controller.batchRead(args.files, args.agentId, args.compact)
    });

    this.registerTool({
      name: 'bridge_batch_write',
      description: 'Batch write multiple files in a single call with optional optimistic expectedHash.',
      inputSchema: {
        type: 'object',
        properties: {
          files: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                filePath: { type: 'string' },
                content: { type: 'string' },
                expectedHash: { type: 'string' },
                overwrite: { type: 'boolean' }
              },
              required: ['filePath', 'content']
            }
          },
          agentId: { type: 'string' }
        },
        required: ['files', 'agentId']
      },
      handler: async (args, ctx) => ctx.controller.batchWrite(args.files, args.agentId)
    });

    this.registerTool({
      name: 'bridge_batch_stat',
      description: 'Stat multiple paths in a single round trip.',
      inputSchema: {
        type: 'object',
        properties: {
          paths: { type: 'array', items: { type: 'string' } },
          agentId: { type: 'string' }
        },
        required: ['paths', 'agentId']
      },
      handler: async (args, ctx) => ctx.controller.batchStat(args.paths, args.agentId)
    });

    this.registerTool({
      name: 'bridge_execute_command',
      description: 'Execute a whitelisted command within an authorized workspace.',
      inputSchema: {
        type: 'object',
        properties: {
          commandLine: { type: 'string' },
          cwd: { type: 'string' },
          timeoutMs: { type: 'number', description: 'Execution timeout in milliseconds (default 30000)' },
          agentId: { type: 'string' }
        },
        required: ['commandLine', 'agentId']
      },
      handler: async (args, ctx) => ctx.controller.executeCommand(
        args.commandLine,
        args.cwd,
        args.agentId,
        typeof args.timeoutMs === 'number' && args.timeoutMs > 0 ? args.timeoutMs : undefined
      )
    });

    // 3. Structured Git Tools
    this.registerTool({
      name: 'bridge_git_status',
      description: 'Get structured Git status with branch, tracking, staged, and unstaged change summaries.',
      inputSchema: {
        type: 'object',
        properties: {
          repoPath: { type: 'string' },
          agentId: { type: 'string' }
        },
        required: ['repoPath', 'agentId']
      },
      handler: async (args, ctx) => ctx.git.getStatus(args.repoPath, args.agentId)
    });

    this.registerTool({
      name: 'bridge_git_branches',
      description: 'List local and remote branches and indicate the current branch.',
      inputSchema: {
        type: 'object',
        properties: {
          repoPath: { type: 'string' },
          agentId: { type: 'string' }
        },
        required: ['repoPath', 'agentId']
      },
      handler: async (args, ctx) => ctx.git.getBranches(args.repoPath, args.agentId)
    });

    this.registerTool({
      name: 'bridge_git_create_branch',
      description: 'Create a new Git branch with name validation.',
      inputSchema: {
        type: 'object',
        properties: {
          repoPath: { type: 'string' },
          branchName: { type: 'string' },
          startPoint: { type: 'string' },
          agentId: { type: 'string' }
        },
        required: ['repoPath', 'branchName', 'agentId']
      },
      handler: async (args, ctx) => {
        const callerAgent = trustedCallerAgentId(ctx);
        assertGitMutationAllowed(ctx, callerAgent);
        return ctx.git.createBranch(args.repoPath, callerAgent, args.branchName, args.startPoint);
      }
    });

    this.registerTool({
      name: 'bridge_git_switch_branch',
      description: 'Switch or checkout a branch.',
      inputSchema: {
        type: 'object',
        properties: {
          repoPath: { type: 'string' },
          branchName: { type: 'string' },
          createIfMissing: { type: 'boolean' },
          agentId: { type: 'string' }
        },
        required: ['repoPath', 'branchName', 'agentId']
      },
      handler: async (args, ctx) => {
        const callerAgent = trustedCallerAgentId(ctx);
        if (args.createIfMissing) {
          assertGitMutationAllowed(ctx, callerAgent);
        }
        return ctx.git.switchBranch(args.repoPath, callerAgent, args.branchName, args.createIfMissing);
      }
    });

    this.registerTool({
      name: 'bridge_git_delete_branch',
      description: 'Delete a local Git branch.',
      inputSchema: {
        type: 'object',
        properties: {
          repoPath: { type: 'string' },
          branchName: { type: 'string' },
          force: { type: 'boolean' },
          agentId: { type: 'string' }
        },
        required: ['repoPath', 'branchName', 'agentId']
      },
      handler: async (args, ctx) => {
        const callerAgent = trustedCallerAgentId(ctx);
        assertGitMutationAllowed(ctx, callerAgent);
        return ctx.git.deleteBranch(args.repoPath, callerAgent, args.branchName, args.force);
      }
    });

    this.registerTool({
      name: 'bridge_git_stage',
      description: 'Stage files for Git commit.',
      inputSchema: {
        type: 'object',
        properties: {
          repoPath: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          stageAll: { type: 'boolean' },
          agentId: { type: 'string' }
        },
        required: ['repoPath', 'agentId']
      },
      handler: async (args, ctx) => {
        const callerAgent = trustedCallerAgentId(ctx);
        assertGitMutationAllowed(ctx, callerAgent);
        return ctx.git.stage(args.repoPath, callerAgent, args.files, args.stageAll);
      }
    });

    this.registerTool({
      name: 'bridge_git_commit',
      description: 'Stage files and create a structured Git commit with author metadata.',
      inputSchema: {
        type: 'object',
        properties: {
          repoPath: { type: 'string' },
          message: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          stageAll: { type: 'boolean' },
          agentId: { type: 'string' }
        },
        required: ['repoPath', 'message', 'agentId']
      },
      handler: async (args, ctx) => {
        const callerAgent = trustedCallerAgentId(ctx);
        assertGitMutationAllowed(ctx, callerAgent);
        return ctx.git.commit(args.repoPath, callerAgent, args.message, args.files, args.stageAll);
      }
    });

    this.registerTool({
      name: 'bridge_git_log',
      description: 'View compact Git commit history.',
      inputSchema: {
        type: 'object',
        properties: {
          repoPath: { type: 'string' },
          maxCommits: { type: 'number' },
          agentId: { type: 'string' }
        },
        required: ['repoPath', 'agentId']
      },
      handler: async (args, ctx) => ctx.git.getLog(args.repoPath, args.agentId, args.maxCommits)
    });

    this.registerTool({
      name: 'bridge_git_diff',
      description: 'View concise Git diff summary.',
      inputSchema: {
        type: 'object',
        properties: {
          repoPath: { type: 'string' },
          staged: { type: 'boolean' },
          maxLines: { type: 'number' },
          agentId: { type: 'string' }
        },
        required: ['repoPath', 'agentId']
      },
      handler: async (args, ctx) => ctx.git.getDiff(args.repoPath, args.agentId, args.staged, args.maxLines)
    });

    this.registerTool({
      name: 'bridge_git_push',
      description: 'Git push to remote with repo, remote, branch, and commit validation. Requires policy authorization and human confirmation.',
      inputSchema: {
        type: 'object',
        properties: {
          repoPath: { type: 'string' },
          remote: { type: 'string', description: 'Remote name (default origin)' },
          branch: { type: 'string', description: 'Target branch (defaults to current)' },
          allowProtected: { type: 'boolean', description: 'Allow pushing to main/master/production if policy requires' },
          dryRun: { type: 'boolean' },
          verbose: { type: 'boolean', description: 'Return full git command output' },
          agentId: { type: 'string' }
        },
        required: ['repoPath', 'agentId']
      },
      handler: async (args, ctx) => {
        const callerAgent = trustedCallerAgentId(ctx);
        assertGitMutationAllowed(ctx, callerAgent);
        return ctx.git.push(args.repoPath, callerAgent, {
          remote: args.remote,
          branch: args.branch,
          allowProtected: ctx.isPrivileged === true ? Boolean(args.allowProtected) : false,
          dryRun: args.dryRun,
          verbose: args.verbose
        });
      }
    });

    this.registerTool({
      name: 'bridge_git_pull',
      description: 'Pull latest changes from remote.',
      inputSchema: {
        type: 'object',
        properties: {
          repoPath: { type: 'string' },
          remote: { type: 'string' },
          branch: { type: 'string' },
          agentId: { type: 'string' }
        },
        required: ['repoPath', 'agentId']
      },
      handler: async (args, ctx) => ctx.git.pull(args.repoPath, args.agentId, {
        remote: args.remote,
        branch: args.branch
      })
    });

    this.registerTool({
      name: 'bridge_git_fetch',
      description: 'Fetch latest references from remote.',
      inputSchema: {
        type: 'object',
        properties: {
          repoPath: { type: 'string' },
          remote: { type: 'string' },
          agentId: { type: 'string' }
        },
        required: ['repoPath', 'agentId']
      },
      handler: async (args, ctx) => ctx.git.fetch(args.repoPath, args.agentId, {
        remote: args.remote
      })
    });

    // 4. Messaging & Tasks
    this.registerTool({
      name: 'bridge_send_message',
      description: 'Send an asynchronous message to another connected agent.',
      inputSchema: {
        type: 'object',
        properties: {
          fromAgent: { type: 'string' },
          toAgent: { type: 'string' },
          subject: { type: 'string' },
          content: { type: 'string' },
          replyToId: { type: 'string' }
        },
        required: ['fromAgent', 'toAgent', 'subject', 'content']
      },
      handler: async (args, ctx) => ctx.mailbox.sendMessage(args)
    });

    this.registerTool({
      name: 'bridge_broadcast_message',
      description: 'Fan out the same message to multiple agents concurrently.',
      inputSchema: {
        type: 'object',
        properties: {
          fromAgent: { type: 'string' },
          toAgents: { type: 'array', items: { type: 'string' } },
          subject: { type: 'string' },
          content: { type: 'string' },
          replyToId: { type: 'string' }
        },
        required: ['fromAgent', 'toAgents', 'subject', 'content']
      },
      handler: async (args, ctx) => ctx.mailbox.broadcastMessage(args)
    });

    this.registerTool({
      name: 'bridge_check_inbox',
      description: 'Check inbox messages addressed to this agent. Supports compact summary.',
      inputSchema: {
        type: 'object',
        properties: {
          agentId: { type: 'string' },
          unreadOnly: { type: 'boolean' },
          compact: { type: 'boolean', description: 'Omit full bodies for low token burn' },
          limit: { type: 'number' }
        },
        required: ['agentId']
      },
      handler: async (args, ctx) => {
        const callerAgent = trustedCallerAgentId(ctx);
        if (!ctx.isPrivileged && (!callerAgent || callerAgent === 'anonymous')) {
          const err = new Error('Unauthorized: no authenticated identity on this connection; cannot read inbox.');
          err.code = 'UNAUTHORIZED_INBOX_ACCESS';
          throw err;
        }
        const targetAgent = ctx.isPrivileged ? (args.agentId || callerAgent) : callerAgent;
        if (!ctx.isPrivileged && args.agentId && String(args.agentId).trim().toLowerCase() !== String(callerAgent).trim().toLowerCase()) {
          const err = new Error(`Unauthorized: caller '${callerAgent}' cannot read inbox for '${args.agentId}'.`);
          err.code = 'UNAUTHORIZED_INBOX_ACCESS';
          throw err;
        }
        return ctx.mailbox.getInbox({ ...args, agentId: targetAgent });
      }
    });

    this.registerTool({
      name: 'bridge_delegate_task',
      description: 'Delegate a discrete first-class task with priorities, parent taskId, and dependencies.',
      inputSchema: {
        type: 'object',
        properties: {
          fromAgent: { type: 'string' },
          toAgent: { type: 'string' },
          title: { type: 'string' },
          instructions: { type: 'string' },
          context: { type: 'string' },
          parentTaskId: { type: 'string' },
          priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
          dependencies: { type: 'array', items: { type: 'string' } },
          hops: { type: 'array', items: { type: 'string' }, description: 'Multi-hop forwarding sequence of agents' }
        },
        required: ['fromAgent', 'toAgent', 'title', 'instructions']
      },
      handler: async (args, ctx) => {
        if (Array.isArray(args.hops) && args.hops.length > 1) {
          const { MultiHopRouter } = await import('./control-plane/multi-hop-router.js');
          const router = ctx.multiHopRouter || new MultiHopRouter({
            mailboxHub: ctx.mailbox,
            taskManager: ctx.mailbox?.tasks,
            eventBus: ctx.eventBus || ctx.mailbox?.eventBus,
            guard: ctx.permissionGuard
          });
          return router.executeHopChain({
            hops: args.hops,
            initialInput: args.instructions || args.title,
            initiatorAgent: args.fromAgent,
            parentRequestId: args.requestId
          });
        }
        return ctx.mailbox.delegateTask(args);
      }
    });

    this.registerTool({
      name: 'bridge_claim_task',
      description: 'Claim the next available pending task for an agent, transitioning it to claimed/in_progress.',
      inputSchema: {
        type: 'object',
        properties: {
          agentId: { type: 'string' }
        },
        required: ['agentId']
      },
      handler: async (args, ctx) => {
        const callerAgent = trustedCallerAgentId(ctx);
        if (!ctx.isPrivileged && (!callerAgent || callerAgent === 'anonymous')) {
          const err = new Error('Unauthorized: no authenticated identity on this connection; cannot claim tasks.');
          err.code = 'UNAUTHORIZED_TASK_ACCESS';
          throw err;
        }
        const targetAgent = ctx.isPrivileged ? (args.agentId || callerAgent) : callerAgent;
        if (!ctx.isPrivileged && args.agentId && String(args.agentId).trim().toLowerCase() !== String(callerAgent).trim().toLowerCase()) {
          const err = new Error(`Unauthorized: caller '${callerAgent}' cannot claim tasks for '${args.agentId}'.`);
          err.code = 'UNAUTHORIZED_TASK_ACCESS';
          throw err;
        }
        const claimed = ctx.mailbox.claimNextTask(targetAgent);
        return claimed || { status: 'no_tasks_available', agentId: targetAgent };
      }
    });

    this.registerTool({
      name: 'bridge_get_task_status',
      description: 'Retrieve details, status, and compact outcome of a delegated task.',
      inputSchema: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          compact: { type: 'boolean', description: 'Return concise state by default' }
        },
        required: ['taskId']
      },
      handler: async (args, ctx) => {
        const compact = args.compact !== false; // default true
        const callerAgent = trustedCallerAgentId(ctx);
        if (!ctx.isPrivileged && (!callerAgent || callerAgent === 'anonymous')) {
          const err = new Error(`Unauthorized: no authenticated identity on this connection; cannot inspect task '${args.taskId}'.`);
          err.code = 'UNAUTHORIZED_TASK_ACCESS';
          throw err;
        }
        const caller = { agentId: callerAgent, isPrivileged: Boolean(ctx.isPrivileged) };
        return ctx.mailbox.getTask(args.taskId, compact, caller);
      }
    });

    this.registerTool({
      name: 'bridge_submit_task_result',
      description: 'Submit completion or failure outcome for an assigned task, delivering result to creator.',
      inputSchema: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          agentId: { type: 'string' },
          status: { type: 'string', enum: ['completed', 'failed', 'in_progress'] },
          result: { type: 'string' },
          error: { type: 'string' },
          attemptId: { type: 'string', description: 'Attempt ID for monotonic fencing' },
          epoch: { type: 'number', description: 'Attempt epoch token' },
          contract: {
            type: 'object',
            description: 'Optional answer-only contract ({ answerOnly, forbidPreamble, maxWords, format }): strips bare pleasantries and reports token savings.',
            properties: {
              answerOnly: { type: 'boolean' },
              forbidPreamble: { type: 'boolean' },
              maxWords: { type: 'number' },
              format: { type: 'string', enum: ['text', 'json', 'md'] }
            }
          }
        },
        required: ['taskId', 'agentId', 'status']
      },
      handler: async (args, ctx) => {
        if (args.contractType && args.status === 'completed' && args.result) {
          const { StructuredContractValidator } = await import('./contracts/structured-contracts.js');
          const val = StructuredContractValidator.validate(args.contractType, args.result);
          if (!val.valid) {
            return {
              ok: false,
              status: 'rejected',
              error: `CONTRACT_VIOLATION: Result does not conform to '${args.contractType}' contract: ${val.errors?.join(', ')}`
            };
          }
          if (val.compactText) {
            args.result = val.compactText;
          }
        }
        const contractReport = applyContractToField(args, 'result');
        if (contractReport?.applied) {
          ctx.logger?.log?.({
            agentId: args.agentId,
            action: 'response_contract_enforced',
            status: 'success',
            details: { taskId: args.taskId, ...contractReport }
          });
        }
        const outcome = await ctx.mailbox.submitTaskResult(args);
        try {
          const { defaultDisplayManager } = await import('./display/bridge-display-manager.js');
          const displayMgr = ctx.displayManager || defaultDisplayManager;
          if (displayMgr && args.result) {
            await displayMgr.commitResult(args.taskId, args.result, {
              agentId: args.agentId,
              status: args.status
            });
          }
        } catch  {
      // swallow-ok: intentional non-fatal error suppression
    }
        if (contractReport && outcome && typeof outcome === 'object') {
          return { ...outcome, contractReport };
        }
        return outcome;
      }
    });


    this.registerTool({
      name: 'bridge_ask_agent',
      description: 'Directly query another connected agent and await correlated response over cross-process event bus. Supports direct mode (zero post-processing model calls), assist mode (critique), and structured mode.',
      inputSchema: {
        type: 'object',
        properties: {
          fromAgent: { type: 'string' },
          toAgent: { type: 'string' },
          question: { type: 'string' },
          context: { type: 'string' },
          conversationId: { type: 'string' },
          requestId: { type: 'string' },
          timeoutMs: { type: 'number' },
          asyncMode: { type: 'boolean' },
          includeFullTrace: {
            type: 'boolean',
            default: false,
            description: 'If true, returns full outcome including traces, token metrics, and envelope. Default false returns compact shape.'
          },
          responseMode: {
            type: 'string',
            enum: ['direct', 'assist', 'structured'],
            default: 'direct',
            description: 'Delivery mode: direct (zero model post-processing calls), assist (critique/review), or structured (JSON output)'
          }
        },
        required: ['fromAgent', 'toAgent', 'question']
      },
      handler: async (args, ctx) => {
        const fullOutcome = await ctx.mailbox.askAgent(args);
        let pendingNotice = null;
        if (args.fromAgent && ctx.mailbox?.getPendingRequests) {
          try {
            const pending = ctx.mailbox.getPendingRequests(args.fromAgent, 5);
            if (pending && pending.length > 0) {
              pendingNotice = {
                pendingCount: pending.length,
                notice: `You have ${pending.length} pending request(s) queued for your attention. Use bridge_get_pending_requests and bridge_answer_request to view and settle them.`,
                items: pending.map(p => ({
                  requestId: p.requestId,
                  fromAgent: p.fromAgent,
                  question: p.question ? (p.question.length > 80 ? p.question.slice(0, 80) + '...' : p.question) : ''
                }))
              };
            }
          } catch  {
      // swallow-ok: intentional non-fatal error suppression
    }
        }

        if (args.includeFullTrace === true) {
          if (pendingNotice) {
            fullOutcome.pendingWorkNotice = pendingNotice;
          }
          return fullOutcome;
        }
        return {
          requestId: fullOutcome?.requestId || null,
          status: fullOutcome?.status || 'completed',
          response: fullOutcome?.response !== undefined ? fullOutcome.response : null,
          error: fullOutcome?.error || null,
          completionConfidence: fullOutcome?.completionConfidence || null,
          responseId: fullOutcome?.responseId || null,
          pendingWorkNotice: pendingNotice,
          untrustedData: true
        };
      }
    });

    this.registerTool({
      name: 'bridge_get_request_status',
      description: 'Get status and response details for a correlated request.',
      inputSchema: {
        type: 'object',
        properties: {
          requestId: { type: 'string' }
        },
        required: ['requestId']
      },
      handler: async (args, ctx) => {
        const callerAgent = trustedCallerAgentId(ctx);
        if (!ctx.isPrivileged && (!callerAgent || callerAgent === 'anonymous')) {
          const err = new Error(`Unauthorized: no authenticated identity on this connection; cannot inspect request status for '${args.requestId}'.`);
          err.code = 'UNAUTHORIZED_REQUEST_ACCESS';
          throw err;
        }
        const caller = { agentId: callerAgent, isPrivileged: Boolean(ctx.isPrivileged) };
        const req = ctx.mailbox.getRequest(args.requestId, caller);
        if (!req) {
          throw new Error(`Request not found: ${args.requestId}`);
        }
        return req;
      }
    });

    this.registerTool({
      name: 'bridge_get_response',
      description: 'Retrieve a preserved authentic response artifact, compact envelope, and token accounting metrics by responseId or requestId.',
      inputSchema: {
        type: 'object',
        properties: {
          responseId: { type: 'string', description: 'Unique response artifact ID' },
          requestId: { type: 'string', description: 'Correlated request ID' }
        }
      },
      handler: async (args, ctx) => {
        if (!args.responseId && !args.requestId) {
          throw new Error('Either responseId or requestId must be provided');
        }
        const callerAgent = trustedCallerAgentId(ctx);
        if (!ctx.isPrivileged && (!callerAgent || callerAgent === 'anonymous')) {
          const err = new Error('Unauthorized: no authenticated identity on this connection; cannot retrieve responses.');
          err.code = 'UNAUTHORIZED_RESPONSE_ACCESS';
          throw err;
        }
        const caller = { agentId: callerAgent, isPrivileged: Boolean(ctx.isPrivileged) };
        if (args.responseId) {
          const resp = ctx.mailbox.getResponse ? ctx.mailbox.getResponse(args.responseId, caller) : null;
          if (!resp) throw new Error(`Response not found: ${args.responseId}`);
          return resp;
        }
        const req = ctx.mailbox.getRequest ? ctx.mailbox.getRequest(args.requestId, caller) : null;
        if (!req) throw new Error(`Request not found: ${args.requestId}`);
        if (req.artifact) {
          return {
            ...req.artifact,
            response: req.quarantined ? null : req.artifact.responseText,
            status: req.status,
            envelope: req.envelope,
            tokenMetrics: req.tokenMetrics,
            bridgeUnaltered: req.bridgeUnaltered,
            untrustedData: true,
            quarantined: req.quarantined
          };
        }
        return req;
      }
    });

    this.registerTool({
      name: 'bridge_get_pending_requests',
      description: 'Get pending correlated requests awaiting answer for a specific agent.',
      inputSchema: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'Agent ID whose pending requests to list' },
          limit: { type: 'number', default: 10 }
        },
        required: ['agentId']
      },
      handler: async (args, ctx) => {
        const callerAgent = trustedCallerAgentId(ctx);
        if (!ctx.isPrivileged && (!callerAgent || callerAgent === 'anonymous')) {
          const err = new Error('Unauthorized: no authenticated identity on this connection; cannot retrieve pending requests.');
          err.code = 'UNAUTHORIZED_PENDING_ACCESS';
          throw err;
        }
        const targetAgent = ctx.isPrivileged ? (args.agentId || callerAgent) : callerAgent;
        if (!ctx.isPrivileged && args.agentId && String(args.agentId).trim().toLowerCase() !== String(callerAgent).trim().toLowerCase()) {
          const err = new Error(`Unauthorized: caller '${callerAgent}' cannot read pending requests for '${args.agentId}'.`);
          err.code = 'UNAUTHORIZED_PENDING_ACCESS';
          throw err;
        }
        return ctx.mailbox.getPendingRequests(targetAgent, args.limit || 10);
      }
    });

    this.registerTool({
      name: 'bridge_answer_request',
      description: 'Directly answer an incoming correlated request from another agent using requestId.',
      inputSchema: {
        type: 'object',
        properties: {
          requestId: { type: 'string', description: 'The requestId being answered' },
          agentId: { type: 'string', description: 'Responding agent ID' },
          response: { type: 'string', description: 'The answer content or result' },
          status: { type: 'string', enum: ['completed', 'failed'], default: 'completed' },
          error: { type: 'string', description: 'Optional error description if status is failed' },
          attemptId: { type: 'string', description: 'Attempt ID for monotonic fencing' },
          epoch: { type: 'number', description: 'Attempt epoch token' },
          contract: {
            type: 'object',
            description: 'Optional answer-only response contract: { answerOnly, forbidPreamble, maxWords, format }.',
            properties: {
              answerOnly: { type: 'boolean' },
              forbidPreamble: { type: 'boolean' },
              maxWords: { type: 'number' },
              format: { type: 'string', enum: ['text', 'json', 'md'] }
            }
          }
        },
        required: ['requestId', 'agentId', 'response']
      },
      handler: async (args, ctx) => {
        const contractReport = applyContractToField(args, 'response');
        const outcome = await ctx.mailbox.answerRequest(args);
        if (contractReport && outcome && typeof outcome === 'object') {
          return { ...outcome, contractReport };
        }
        return outcome;
      }
    });

    this.registerTool({
      name: 'bridge_get_events',
      description: 'Get compact events from the cross-process event bus with cursor support.',
      inputSchema: {
        type: 'object',
        properties: {
          agentId: { type: 'string' },
          afterEventId: { type: 'number' },
          limit: { type: 'number' },
          compact: { type: 'boolean' }
        }
      },
      handler: async (args, ctx) => {
        const callerAgent = trustedCallerAgentId(ctx);
        if (!ctx.isPrivileged && (!callerAgent || callerAgent === 'anonymous')) {
          const err = new Error('Unauthorized: no authenticated identity on this connection; cannot read event bus events.');
          err.code = 'UNAUTHORIZED_EVENTS_ACCESS';
          throw err;
        }
        const queryArgs = { ...args };
        if (!ctx.isPrivileged) {
          queryArgs.agentId = callerAgent;
        }
        return ctx.eventBus ? ctx.eventBus.getEvents(queryArgs) : [];
      }
    });

    this.registerTool({
      name: 'bridge_get_adapter_capabilities',
      description: 'Inspect session adapter capabilities and execution boundaries for connected agents.',
      inputSchema: {
        type: 'object',
        properties: {
          agentId: { type: 'string' }
        },
        required: ['agentId']
      },
      handler: async (args, ctx) => {
        const adapter = createSessionAdapter(args.agentId, { mailboxHub: ctx.mailbox, eventBus: ctx.eventBus });
        const legacy = adapter.capabilities();
        let v2Routes = [];
        if (ctx.capabilityRegistry) {
          v2Routes = ctx.capabilityRegistry.listAgentCapabilities(args.agentId);
        }
        return {
          ...legacy,
          autonomousModelWake: legacy.autonomousModelWake || (legacy.autonomousExecution ? 'supported' : 'unsupported; interactive client only'),
          v2Routes
        };
      }
    });

    this.registerTool({
      name: 'bridge_request_review',
      description: 'Request a peer code review for a file or change.',
      inputSchema: {
        type: 'object',
        properties: {
          fromAgent: { type: 'string' },
          toAgent: { type: 'string' },
          filePath: { type: 'string' },
          description: { type: 'string' }
        },
        required: ['fromAgent', 'toAgent', 'filePath', 'description']
      },
      handler: async (args, ctx) => ctx.mailbox.requestReview(args)
    });

    // 5. Collaboration Boards
    this.registerTool({
      name: 'bridge_create_collaboration',
      description: 'Create a persistent multi-agent collaboration board/session.',
      inputSchema: {
        type: 'object',
        properties: {
          ownerAgent: { type: 'string' },
          title: { type: 'string' },
          objective: { type: 'string' },
          metadata: { type: 'object' }
        },
        required: ['ownerAgent', 'title', 'objective']
      },
      handler: async (args, ctx) => ctx.collaboration.create(args)
    });

    this.registerTool({
      name: 'bridge_join_collaboration',
      description: 'Join or refresh presence in a collaboration.',
      inputSchema: {
        type: 'object',
        properties: {
          collaborationId: { type: 'string' },
          agentId: { type: 'string' },
          role: { type: 'string' },
          capabilities: { type: 'array' }
        },
        required: ['collaborationId', 'agentId']
      },
      handler: async (args, ctx) => ctx.collaboration.join(args)
    });

    this.registerTool({
      name: 'bridge_leave_collaboration',
      description: 'Leave a collaboration.',
      inputSchema: {
        type: 'object',
        properties: {
          collaborationId: { type: 'string' },
          agentId: { type: 'string' }
        },
        required: ['collaborationId', 'agentId']
      },
      handler: async (args, ctx) => ctx.collaboration.leave(args)
    });

    this.registerTool({
      name: 'bridge_heartbeat_collaboration',
      description: 'Refresh heartbeat in collaboration.',
      inputSchema: {
        type: 'object',
        properties: {
          collaborationId: { type: 'string' },
          agentId: { type: 'string' },
          status: { type: 'string' }
        },
        required: ['collaborationId', 'agentId']
      },
      handler: async (args, ctx) => ctx.collaboration.heartbeat(args)
    });

    this.registerTool({
      name: 'bridge_get_collaboration',
      description: 'Read the shared collaboration board, participants, and events.',
      inputSchema: {
        type: 'object',
        properties: {
          collaborationId: { type: 'string' }
        },
        required: ['collaborationId']
      },
      handler: async (args, ctx) => ctx.collaboration.get(args.collaborationId)
    });

    this.registerTool({
      name: 'bridge_list_collaborations',
      description: 'List collaboration boards visible to an agent.',
      inputSchema: {
        type: 'object',
        properties: {
          agentId: { type: 'string' },
          status: { type: 'string' }
        }
      },
      handler: async (args, ctx) => ctx.collaboration.list(args)
    });

    this.registerTool({
      name: 'bridge_post_collaboration_event',
      description: 'Post an event to a collaboration board.',
      inputSchema: {
        type: 'object',
        properties: {
          collaborationId: { type: 'string' },
          agentId: { type: 'string' },
          eventType: { type: 'string' },
          payload: { type: 'object' }
        },
        required: ['collaborationId', 'agentId', 'eventType']
      },
      handler: async (args, ctx) => ctx.collaboration.event(args)
    });

    this.registerTool({
      name: 'bridge_close_collaboration',
      description: 'Close a collaboration owned by the requesting agent.',
      inputSchema: {
        type: 'object',
        properties: {
          collaborationId: { type: 'string' },
          agentId: { type: 'string' },
          reason: { type: 'string' }
        },
        required: ['collaborationId', 'agentId']
      },
      handler: async (args, ctx) => ctx.collaboration.close(args)
    });

    // 6. File Activity
    this.registerTool({
      name: 'bridge_file_activity_start',
      description: 'Announce file activity for non-blocking awareness.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          agentId: { type: 'string' },
          activityType: { type: 'string' },
          collaborationId: { type: 'string' },
          taskId: { type: 'string' },
          description: { type: 'string' }
        },
        required: ['filePath', 'agentId']
      },
      handler: async (args, ctx) => ctx.fileActivity.start(args)
    });

    this.registerTool({
      name: 'bridge_file_activity_heartbeat',
      description: 'Refresh file activity presence.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          agentId: { type: 'string' },
          activityType: { type: 'string' }
        },
        required: ['filePath', 'agentId']
      },
      handler: async (args, ctx) => ctx.fileActivity.heartbeat(args)
    });

    this.registerTool({
      name: 'bridge_file_activity_stop',
      description: 'Clear file activity.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          agentId: { type: 'string' },
          activityType: { type: 'string' }
        },
        required: ['filePath', 'agentId']
      },
      handler: async (args, ctx) => ctx.fileActivity.stop(args)
    });

    this.registerTool({
      name: 'bridge_get_file_activity',
      description: 'See who is currently working on a file.',
      inputSchema: {
        type: 'object',
        properties: { filePath: { type: 'string' } },
        required: ['filePath']
      },
      handler: async (args, ctx) => ctx.fileActivity.get(args.filePath)
    });

    this.registerTool({
      name: 'bridge_get_all_file_activity',
      description: 'See all active file activity.',
      inputSchema: { type: 'object', properties: {} },
      handler: async (args, ctx) => ctx.fileActivity.getAll()
    });

    // 7. Audit Log
    this.registerTool({
      name: 'bridge_get_audit_log',
      description: 'View recent security audit log records with compact summaries.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Number of recent records (default 20)' },
          compact: { type: 'boolean' }
        }
      },
      handler: async (args, ctx) => {
        const isPrivileged = Boolean(ctx.isPrivileged) || Boolean(ctx.allowAuditRead);
        if (!isPrivileged) {
          const err = new Error('Forbidden: audit logs require privileged administrative access.');
          err.code = 'UNAUTHORIZED_AUDIT_ACCESS';
          err.statusCode = 403;
          throw err;
        }
        const limit = args.limit || 20;
        const logs = ctx.logger.getRecentLogs(limit);
        if (args.compact !== false) {
          return logs.map(l => ({
            id: l.id,
            timestamp: l.timestamp,
            agent: l.agent_id,
            action: l.action,
            status: l.status,
            target: l.target_path ? l.target_path.slice(-40) : null
          }));
        }
        return logs;
      }
    });

    // 8. Binary Artifacts (real image/video byte transport)
    this.registerTool({
      name: 'bridge_artifact_store',
      description: 'Store REAL binary artifact bytes (PNG/JPEG/MP4/...) and return a compact, SHA-256-verified retrieval reference. Bytes are never echoed back inline here; a stored reference carries metadata only.',
      inputSchema: {
        type: 'object',
        properties: {
          agentId: { type: 'string' },
          dataBase64: { type: 'string', description: 'Base64 of the actual artifact bytes' },
          mimeType: { type: 'string', description: 'Declared MIME type; must agree with the content magic bytes when recognized' },
          filename: { type: 'string' },
          taskId: { type: 'string' },
          attemptId: { type: 'string' },
          ttlMs: { type: 'number', description: 'Time-to-live in ms (default 24h)' },
          authorizedAgents: { type: 'array', items: { type: 'string' }, description: 'Additional agents allowed to retrieve' },
          metadata: { type: 'object', description: 'Optional provider/route metadata' }
        },
        required: ['dataBase64']
      },
      handler: async (args, ctx) => {
        const store = await resolveArtifactStore(ctx);
        const ref = store.put({
          base64: args.dataBase64,
          mimeType: args.mimeType || null,
          filename: args.filename || null,
          taskId: args.taskId || null,
          attemptId: args.attemptId || null,
          agentId: args.agentId,
          ttlMs: args.ttlMs,
          authorizedAgents: args.authorizedAgents,
          metadata: args.metadata || null
        });
        return ref;
      }
    });

    this.registerTool({
      name: 'bridge_artifact_get',
      description: 'Get compact metadata and retrievability for a stored artifact (no bytes).',
      inputSchema: {
        type: 'object',
        properties: {
          agentId: { type: 'string' },
          artifactId: { type: 'string' }
        },
        required: ['artifactId']
      },
      handler: async (args, ctx) => {
        const store = await resolveArtifactStore(ctx);
        // Trusted context only; `args.agentId` would let the caller name the owner.
        return store.getMetadata(args.artifactId, { agentId: trustedCallerAgentId(ctx) });
      }
    });

    this.registerTool({
      name: 'bridge_artifact_read',
      description: 'Authorized retrieval of an artifact\'s REAL bytes as base64, with SHA-256 integrity verification. Supports chunked reads for large files (> 8 MiB) via offset/length.',
      inputSchema: {
        type: 'object',
        properties: {
          agentId: { type: 'string' },
          artifactId: { type: 'string' },
          expectedSha256: { type: 'string', description: 'Optional hash to assert the retrieved bytes against' },
          offset: { type: 'number', description: 'Byte offset for chunked reading (0-indexed)' },
          length: { type: 'number', description: 'Chunk length in bytes (max 8 MiB)' }
        },
        required: ['artifactId']
      },
      handler: async (args, ctx) => {
        const store = await resolveArtifactStore(ctx);
        // Trusted context only; `read`/`readChunk` fail closed on a null identity.
        const callerAgent = trustedCallerAgentId(ctx);
        const isChunked = args.offset !== undefined || args.length !== undefined;

        if (isChunked) {
          const chunk = store.readChunk(args.artifactId, {
            agentId: callerAgent,
            offset: args.offset || 0,
            length: args.length || ArtifactStore.maxInlineBytes
          });
          const hashMatches = args.expectedSha256 ? chunk.overallSha256 === args.expectedSha256 : true;
          return {
            ...chunk.metadata,
            offset: chunk.offset,
            bytesRead: chunk.length,
            totalBytes: chunk.totalBytes,
            eof: chunk.eof,
            chunkSha256: chunk.chunkSha256,
            overallSha256: chunk.overallSha256,
            integrityVerified: chunk.integrityVerified && hashMatches,
            expectedSha256Matches: hashMatches,
            encoding: 'base64',
            dataBase64: chunk.bytes.toString('base64')
          };
        }

        const { bytes, metadata, integrityVerified } = store.read(args.artifactId, {
          agentId: callerAgent,
          maxBytes: ArtifactStore.maxInlineBytes
        });
        const hashMatches = args.expectedSha256 ? metadata.sha256 === args.expectedSha256 : true;
        return {
          ...metadata,
          integrityVerified: integrityVerified && hashMatches,
          expectedSha256Matches: hashMatches,
          encoding: 'base64',
          dataBase64: bytes.toString('base64')
        };
      }
    });

    this.registerTool({
      name: 'bridge_artifact_cleanup',
      description: 'Delete expired artifact bytes and mark their metadata expired. Non-privileged callers may only clean up their own artifacts.',
      inputSchema: { type: 'object', properties: { agentId: { type: 'string' } } },
      handler: async (args, ctx) => {
        const store = await resolveArtifactStore(ctx);
        // Trusted context only. Privilege comes from the authenticated context, not
        // from a caller-supplied 'system' string, and an absent identity fails
        // closed: `cleanupExpired` treats a null agentId as "every agent".
        const callerAgent = trustedCallerAgentId(ctx);
        const isPrivileged = Boolean(ctx.isPrivileged);
        if (!isPrivileged && !callerAgent) {
          const noIdentErr = new Error('Unauthorized: no authenticated identity on this connection; cannot run artifact cleanup.');
          noIdentErr.code = 'ARTIFACT_UNAUTHORIZED';
          throw noIdentErr;
        }
        const result = store.cleanupExpired(Date.now(), { agentId: callerAgent, isPrivileged });
        // Attribution only (never authorization): `audit_log.agent_id` is NOT NULL,
        // and a privileged control-plane caller has no agent identity of its own.
        const auditAgentId = callerAgent || 'system';
        ctx.logger?.log?.({
          agentId: auditAgentId,
          action: 'artifact_cleanup',
          status: 'success',
          details: result
        });
        return result;
      }
    });

    // 8. Tool Discovery & Prompt Efficiency
    this.registerTool({
      name: 'bridge_discover_tools',
      category: 'discovery',
      description: 'Discover available tools filtered by category or query to eliminate prompt bloat (alias: bridge_search_tools).',
      inputSchema: {
        type: 'object',
        properties: {
          category: { type: 'string', description: 'Filter: discovery, inspection, mutation, git, knowledge, artifacts, diagnostics, messaging' },
          query: { type: 'string', description: 'Keyword search for tool name or description' }
        }
      },
      handler: async (args, ctx) => {
        // Always search across the full registry regardless of active surface profile
        const all = this.getToolDefinitions('all');
        const results = [];
        const q = args.query ? args.query.toLowerCase() : null;
        const cat = args.category ? args.category.toLowerCase() : null;

        for (const t of all) {
          const toolObj = this.tools.get(t.name) || {};
          const toolCat = toolObj.category || 'core';
          if (cat && toolCat.toLowerCase() !== cat) continue;
          if (q && !t.name.toLowerCase().includes(q) && !t.description.toLowerCase().includes(q)) continue;

          results.push({
            name: t.name,
            description: t.description,
            category: toolCat,
            effect: getToolClassification(t.name)
          });
        }

        return {
          totalAvailable: all.length,
          matchedCount: results.length,
          tools: results
        };
      }
    });

    this.registerTool({
      name: 'bridge_tool_info',
      category: 'discovery',
      description: 'Retrieve detailed schema and permissions for a specific tool on demand.',
      inputSchema: {
        type: 'object',
        properties: {
          toolName: { type: 'string', description: 'Tool name to inspect (supports bridge_search_tools alias)' }
        },
        required: ['toolName']
      },
      handler: async (args, ctx) => {
        const lookup = args.toolName === 'bridge_search_tools' ? 'bridge_discover_tools' : args.toolName;
        const tool = this.tools.get(lookup);
        if (!tool) throw new Error(`Unknown tool: '${args.toolName}'`);
        return {
          name: tool.name,
          description: tool.description,
          category: tool.category || 'general',
          effectClassification: getToolClassification(tool.name),
          isEffectful: isEffectfulTool(tool.name),
          inputSchema: tool.inputSchema
        };
      }
    });

    // 9. Knowledge & Memory Management (SQLite FTS5 + BM25)
    this.registerTool({
      name: 'bridge_store_knowledge',
      category: 'knowledge',
      description: 'Store project facts and findings with SQLite FTS5 BM25 indexing and provenance tracking.',
      inputSchema: {
        type: 'object',
        properties: {
          agentId: { type: 'string' },
          title: { type: 'string', description: 'Knowledge item title' },
          content: { type: 'string', description: 'Finding or documentation' },
          category: { type: 'string', description: 'architecture, decision, finding, constraint, test_result, or general' },
          tags: { type: 'array', items: { type: 'string' } },
          status: {
            type: 'string',
            enum: ['verified', 'hypothesis', 'obsolete', 'failed-experiment', 'agent-claimed', 'unreviewed'],
            description: 'Item lifecycle status: verified (requires verifiable evidence), hypothesis, obsolete, failed-experiment, agent-claimed (default for agents), unreviewed'
          },
          validFrom: { type: 'string', description: 'ISO start validity timestamp' },
          validUntil: { type: 'string', description: 'ISO expiration timestamp' },
          provenance: { type: 'string', description: 'user_instruction, agent_finding, verified_test, or external_doc' },
          sourceFile: { type: 'string', description: 'Related source file path' }
        },
        required: ['title', 'content']
      },
      handler: async (args, ctx) => {
        const store = resolveKnowledgeStore(ctx);
        const boundAgent = ctx?.identity?.boundAgentId || ctx?.identity?.agentId || ctx?.agentId || (ctx?.requireAuthentication ? null : args.agentId) || 'system';
        const item = store.storeKnowledge({
          agentId: boundAgent,
          title: args.title,
          content: args.content,
          category: args.category || 'general',
          tags: args.tags || [],
          status: args.status,
          validFrom: args.validFrom || null,
          validUntil: args.validUntil || null,
          provenance: args.provenance || 'agent_finding',
          sourceFile: args.sourceFile || null
        });
        ctx.logger?.log?.({
          agentId: boundAgent,
          action: 'store_knowledge',
          status: 'success',
          details: { id: item.id, title: item.title, category: item.category, status: item.status }
        });
        return {
          success: true,
          id: item.id,
          contentHash: item.contentHash,
          title: item.title,
          category: item.category,
          status: item.status,
          trustLevel: item.trustLevel,
          untrustedData: true,
          validFrom: item.validFrom,
          validUntil: item.validUntil,
          sourceFile: item.sourceFile,
          provenance: item.provenance
        };
      }
    });

    this.registerTool({
      name: 'bridge_search_knowledge',
      category: 'knowledge',
      description: 'Search project knowledge using SQLite FTS5 BM25 ranking and snippet extraction.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search term or question' },
          category: { type: 'string', description: 'Filter by category' },
          tag: { type: 'string', description: 'Filter by tag' },
          status: { type: 'string', description: 'Filter by status: verified, hypothesis, obsolete, failed-experiment, agent-claimed, or all' },
          includeExpired: { type: 'boolean', description: 'Whether to include expired items (default false)' },
          limit: { type: 'number', description: 'Max results (default 5, max 20)' }
        },
        required: ['query']
      },
      handler: async (args, ctx) => {
        const store = resolveKnowledgeStore(ctx);
        const results = store.searchKnowledge(args.query, {
          category: args.category,
          tag: args.tag,
          status: args.status,
          includeExpired: args.includeExpired,
          limit: Math.min(args.limit || 5, 20)
        });
        return {
          query: args.query,
          count: results.length,
          results
        };
      }
    });

    this.registerTool({
      name: 'bridge_get_knowledge',
      category: 'knowledge',
      description: 'Retrieve a complete knowledge record by ID or SHA-256 content hash.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Knowledge record ID' },
          contentHash: { type: 'string', description: 'SHA-256 hash of content' }
        }
      },
      handler: async (args, ctx) => {
        const store = resolveKnowledgeStore(ctx);
        const record = args.id ? store.getKnowledge(args.id) : (args.contentHash ? store.getByHash(args.contentHash) : null);
        if (!record) throw new Error('Knowledge record not found.');
        return record;
      }
    });

    // 10. Code Quality & Syntax Validation
    this.registerTool({
      name: 'bridge_check_syntax',
      category: 'inspection',
      description: 'Non-destructive fast syntax and compilation validation for JS, JSON, and Python files.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Source file path' },
          agentId: { type: 'string' }
        },
        required: ['filePath']
      },
      handler: async (args, ctx) => {
        if (!ctx.controller) throw new Error('ProjectController unavailable in context');
        return ctx.controller.checkSyntax(args.filePath, args.agentId);
      }
    });

    // 11. Git Intelligence & Provenance
    this.registerTool({
      name: 'bridge_git_summary',
      category: 'git',
      description: 'Compact git repository summary (branch, commit, clean status, dirty count) consuming <50 tokens.',
      inputSchema: {
        type: 'object',
        properties: {
          repoPath: { type: 'string', description: 'Path to git repository' },
          agentId: { type: 'string' }
        },
        required: ['repoPath']
      },
      handler: async (args, ctx) => {
        if (!ctx.git) throw new Error('GitController unavailable in context');
        return ctx.git.getSummary(args.repoPath, args.agentId);
      }
    });

    this.registerTool({
      name: 'bridge_git_blame',
      category: 'git',
      description: 'Compact git blame inspection for a specific line range to verify author and commit provenance.',
      inputSchema: {
        type: 'object',
        properties: {
          repoPath: { type: 'string', description: 'Path to git repository' },
          filePath: { type: 'string', description: 'Relative path to file' },
          startLine: { type: 'number', description: 'Start line number (default 1)' },
          endLine: { type: 'number', description: 'End line number (default 50)' },
          agentId: { type: 'string' }
        },
        required: ['repoPath', 'filePath']
      },
      handler: async (args, ctx) => {
        if (!ctx.git) throw new Error('GitController unavailable in context');
        return ctx.git.getBlame(args.repoPath, args.agentId, args.filePath, args.startLine, args.endLine);
      }
    });

    // 12. Structured Data Extraction
    this.registerTool({
      name: 'bridge_extract_data',
      category: 'inspection',
      description: 'Bounded deterministic extraction of structured data (JSON, CSV, Markdown outline) without LLM tokens.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Path to data file (.json, .csv, .md)' },
          jsonPath: { type: 'string', description: 'Dot-separated key path for JSON extraction' },
          limit: { type: 'number', description: 'Maximum rows or entries to extract (default 50)' },
          agentId: { type: 'string' }
        },
        required: ['filePath']
      },
      handler: async (args, ctx) => {
        if (!ctx.controller) throw new Error('ProjectController unavailable in context');
        return ctx.controller.extractData(args.filePath, args.agentId, {
          jsonPath: args.jsonPath,
          limit: args.limit
        });
      }
    });
  }
}
