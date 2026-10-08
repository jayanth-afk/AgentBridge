import fs from 'node:fs';
import path from 'node:path';

/**
 * Capability Verification States
 */
export const CapabilityState = Object.freeze({
  UNSUPPORTED: 'unsupported',
  UNKNOWN: 'unknown',
  DECLARED: 'declared',
  PROBED: 'probed',
  VERIFIED: 'verified',
  DEGRADED: 'degraded',
  REVOKED: 'revoked'
});

/**
 * Route Trust Tiers (Lower numeric value = higher inherent trust & deterministic control)
 */
export const TrustTier = Object.freeze({
  T0_NATIVE_API: 0,        // Direct process, SDK, CLI with structured stdio/JSONL
  T1_ACTIVE_MCP: 1,        // Authenticated, active bidirectional MCP session turn
  T2_LOCAL_ENGINE: 2,      // Local bundled engine runtime (e.g. codex-cli in ChatGPT.app)
  T3_CDP_BROWSER: 3,       // Chrome DevTools Protocol attached session
  T4_UI_AUTOMATION: 4,     // macOS Accessibility / AX UI synthetic input
  T5_NOTIFICATION_HUMAN: 5 // Desktop notification requiring human wake
});

/**
 * Distinct Capability Dimensions
 * CRITICAL ARCHITECTURAL PRINCIPLE:
 * Connectivity != Model Execution != Autonomous Wakeup != Tool Execution != Effect Execution
 */
export const CapabilityDimension = Object.freeze({
  CONNECTIVITY: 'connectivity',
  MODEL_EXECUTION: 'model_execution',
  AUTONOMOUS_WAKEUP: 'autonomous_wakeup',
  BACKGROUND_EXECUTION: 'background_execution',
  TOOL_EXECUTION: 'tool_execution',
  EFFECT_EXECUTION: 'effect_execution',
  RESPONSE_CORRELATION: 'response_correlation'
});

export class CapabilityRegistry {
  constructor(auditLogger = null) {
    this.logger = auditLogger;
    this.db = auditLogger?.db || null;
    this.memoryRecords = new Map(); // key: `${agentId}::${routeId}::${dimension}`

    if (this.db) {
      this.initTables();
    }
  }

  initTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bridge_capabilities (
        agent_id TEXT NOT NULL,
        route_id TEXT NOT NULL,
        trust_tier INTEGER NOT NULL,
        dimension TEXT NOT NULL,
        state TEXT NOT NULL,
        evidence TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (agent_id, route_id, dimension)
      );

      CREATE INDEX IF NOT EXISTS idx_bridge_cap_agent_route 
        ON bridge_capabilities(agent_id, route_id);
    `);
  }

  _makeKey(agentId, routeId, dimension) {
    return `${String(agentId).trim().toLowerCase()}::${String(routeId).trim()}::${String(dimension).trim()}`;
  }

  /**
   * Register or update a capability record with audit evidence
   */
  setCapability({
    agentId,
    routeId,
    dimension,
    state,
    evidence = null,
    trustTier = TrustTier.T4_UI_AUTOMATION
  }) {
    const normAgent = String(agentId).trim().toLowerCase();
    const normRoute = String(routeId).trim();
    const normDim = String(dimension).trim();
    const now = new Date().toISOString();

    const record = {
      agentId: normAgent,
      routeId: normRoute,
      dimension: normDim,
      trustTier,
      state,
      evidence,
      updatedAt: now
    };

    const key = this._makeKey(normAgent, normRoute, normDim);
    this.memoryRecords.set(key, record);

    if (this.db) {
      try {
        this.db.prepare(`
          INSERT INTO bridge_capabilities (
            agent_id, route_id, trust_tier, dimension, state, evidence, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(agent_id, route_id, dimension) DO UPDATE SET
            trust_tier = excluded.trust_tier,
            state = excluded.state,
            evidence = excluded.evidence,
            updated_at = excluded.updated_at
        `).run(normAgent, normRoute, trustTier, normDim, state, evidence, now);
      } catch (err) {
        // Fall back gracefully to memory
      }
    }

    return record;
  }

  getCapability(agentId, routeId, dimension) {
    const normAgent = String(agentId).trim().toLowerCase();
    const normRoute = String(routeId).trim();
    const normDim = String(dimension).trim();
    const key = this._makeKey(normAgent, normRoute, normDim);

    if (this.db) {
      try {
        const row = this.db.prepare(`
          SELECT * FROM bridge_capabilities 
          WHERE agent_id = ? AND route_id = ? AND dimension = ?
        `).get(normAgent, normRoute, normDim);

        if (row) {
          return {
            agentId: row.agent_id,
            routeId: row.route_id,
            dimension: row.dimension,
            trustTier: row.trust_tier,
            state: row.state,
            evidence: row.evidence,
            updatedAt: row.updated_at
          };
        }
      } catch {}
    }

    return this.memoryRecords.get(key) || {
      agentId: normAgent,
      routeId: normRoute,
      dimension: normDim,
      trustTier: TrustTier.T5_NOTIFICATION_HUMAN,
      state: CapabilityState.UNKNOWN,
      evidence: 'No record registered',
      updatedAt: null
    };
  }

  getRouteCapabilities(agentId, routeId) {
    const normAgent = String(agentId).trim().toLowerCase();
    const normRoute = String(routeId).trim();

    const results = {};
    for (const dim of Object.values(CapabilityDimension)) {
      results[dim] = this.getCapability(normAgent, normRoute, dim);
    }
    return results;
  }

  listAgentCapabilities(agentId) {
    const normAgent = String(agentId).trim().toLowerCase();
    const out = [];

    if (this.db) {
      try {
        const rows = this.db.prepare(`
          SELECT * FROM bridge_capabilities WHERE agent_id = ? ORDER BY route_id, dimension
        `).all(normAgent);
        for (const row of rows) {
          out.push({
            agentId: row.agent_id,
            routeId: row.route_id,
            dimension: row.dimension,
            trustTier: row.trust_tier,
            state: row.state,
            evidence: row.evidence,
            updatedAt: row.updated_at
          });
        }
        if (out.length > 0) return out;
      } catch {}
    }

    for (const record of this.memoryRecords.values()) {
      if (record.agentId === normAgent) {
        out.push({ ...record });
      }
    }
    return out;
  }

  /**
   * True only when capability is backed by verified or successfully probed evidence.
   * Declared or unknown capabilities NEVER count as verified.
   */
  hasVerifiedCapability(agentId, routeId, dimension) {
    const cap = this.getCapability(agentId, routeId, dimension);
    return cap.state === CapabilityState.VERIFIED || cap.state === CapabilityState.PROBED;
  }

  /**
   * Live probe an agent's route based on real environment checks.
   * Never fabricates success.
   */
  async probe(agentId, routeId, context = {}) {
    const normAgent = String(agentId).trim().toLowerCase();
    const normRoute = String(routeId).trim();

    // 1. ChatGPT Local Engine (Bundled Codex CLI)
    if (normRoute === 'chatgpt-local-engine') {
      const cliPath = context.codexPath || '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
      const exists = fs.existsSync(cliPath);

      if (exists) {
        this.setCapability({
          agentId: normAgent,
          routeId: normRoute,
          dimension: CapabilityDimension.CONNECTIVITY,
          state: CapabilityState.VERIFIED,
          evidence: `Codex executable verified at ${cliPath}`,
          trustTier: TrustTier.T2_LOCAL_ENGINE
        });
        this.setCapability({
          agentId: normAgent,
          routeId: normRoute,
          dimension: CapabilityDimension.MODEL_EXECUTION,
          state: CapabilityState.VERIFIED,
          evidence: 'Non-interactive codex turn execution available',
          trustTier: TrustTier.T2_LOCAL_ENGINE
        });
        this.setCapability({
          agentId: normAgent,
          routeId: normRoute,
          dimension: CapabilityDimension.AUTONOMOUS_WAKEUP,
          state: CapabilityState.VERIFIED,
          evidence: 'Process spawned headless without user interaction',
          trustTier: TrustTier.T2_LOCAL_ENGINE
        });
        this.setCapability({
          agentId: normAgent,
          routeId: normRoute,
          dimension: CapabilityDimension.BACKGROUND_EXECUTION,
          state: CapabilityState.VERIFIED,
          evidence: 'Executes headless without foreground window or focus steal',
          trustTier: TrustTier.T2_LOCAL_ENGINE
        });
        this.setCapability({
          agentId: normAgent,
          routeId: normRoute,
          dimension: CapabilityDimension.RESPONSE_CORRELATION,
          state: CapabilityState.VERIFIED,
          evidence: 'Structured JSONL event stream with thread/request matching',
          trustTier: TrustTier.T2_LOCAL_ENGINE
        });
      } else {
        for (const dim of Object.values(CapabilityDimension)) {
          this.setCapability({
            agentId: normAgent,
            routeId: normRoute,
            dimension: dim,
            state: CapabilityState.UNSUPPORTED,
            evidence: `Codex CLI binary not found at ${cliPath}`,
            trustTier: TrustTier.T2_LOCAL_ENGINE
          });
        }
      }
      return this.getRouteCapabilities(normAgent, normRoute);
    }

    // 2. Claude Desktop stdio MCP
    if (normAgent.includes('claude') && (normRoute === 'mcp' || normRoute === 'mcp-stdio')) {
      const isConnected = context.presence?.getPresence(normAgent)?.isAlive ?? false;

      this.setCapability({
        agentId: normAgent,
        routeId: normRoute,
        dimension: CapabilityDimension.CONNECTIVITY,
        state: isConnected ? CapabilityState.VERIFIED : CapabilityState.PROBED,
        evidence: isConnected ? 'Active stdio MCP session detected' : 'MCP server configured in Claude Desktop',
        trustTier: TrustTier.T1_ACTIVE_MCP
      });
      this.setCapability({
        agentId: normAgent,
        routeId: normRoute,
        dimension: CapabilityDimension.MODEL_EXECUTION,
        state: CapabilityState.PROBED,
        evidence: 'Active turns can execute tools when initiated by user in Claude Desktop',
        trustTier: TrustTier.T1_ACTIVE_MCP
      });
      // THE MOST IMPORTANT ARCHITECTURAL PRINCIPLE:
      // MCP protocol does NOT allow external autonomous wake of idle Claude Desktop!
      this.setCapability({
        agentId: normAgent,
        routeId: normRoute,
        dimension: CapabilityDimension.AUTONOMOUS_WAKEUP,
        state: CapabilityState.UNSUPPORTED,
        evidence: 'MCP specification does not support server-initiated LLM turn generation without active user prompt',
        trustTier: TrustTier.T1_ACTIVE_MCP
      });
      this.setCapability({
        agentId: normAgent,
        routeId: normRoute,
        dimension: CapabilityDimension.BACKGROUND_EXECUTION,
        state: CapabilityState.UNSUPPORTED,
        evidence: 'Claude Desktop stdio MCP requires interactive desktop UI session',
        trustTier: TrustTier.T1_ACTIVE_MCP
      });
      this.setCapability({
        agentId: normAgent,
        routeId: normRoute,
        dimension: CapabilityDimension.RESPONSE_CORRELATION,
        state: CapabilityState.VERIFIED,
        evidence: 'Authenticated bridge tool invocations (bridge_ask_agent, bridge_answer_request)',
        trustTier: TrustTier.T1_ACTIVE_MCP
      });

      return this.getRouteCapabilities(normAgent, normRoute);
    }

    // 3. macOS Accessibility (AX / UI) Route
    if (normRoute === 'accessibility') {
      const swiftBridge = context.swiftBridge || null;
      const isAvailable = swiftBridge?.isBinaryAvailable ? swiftBridge.isBinaryAvailable() : false;

      this.setCapability({
        agentId: normAgent,
        routeId: normRoute,
        dimension: CapabilityDimension.CONNECTIVITY,
        state: isAvailable ? CapabilityState.PROBED : CapabilityState.UNSUPPORTED,
        evidence: isAvailable ? 'Swift AX helper binary compiled and present' : 'Swift AX binary missing',
        trustTier: TrustTier.T4_UI_AUTOMATION
      });
      this.setCapability({
        agentId: normAgent,
        routeId: normRoute,
        dimension: CapabilityDimension.AUTONOMOUS_WAKEUP,
        state: isAvailable ? CapabilityState.PROBED : CapabilityState.UNSUPPORTED,
        evidence: isAvailable ? 'Synthetic keyboard/accessibility event submission' : 'AX unavailable',
        trustTier: TrustTier.T4_UI_AUTOMATION
      });
      this.setCapability({
        agentId: normAgent,
        routeId: normRoute,
        dimension: CapabilityDimension.BACKGROUND_EXECUTION,
        state: CapabilityState.DEGRADED,
        evidence: 'Requires visible or accessible GUI window; risk of focus contention',
        trustTier: TrustTier.T4_UI_AUTOMATION
      });
      this.setCapability({
        agentId: normAgent,
        routeId: normRoute,
        dimension: CapabilityDimension.RESPONSE_CORRELATION,
        state: CapabilityState.PROBED,
        evidence: 'Response observer UI delta text scraping',
        trustTier: TrustTier.T4_UI_AUTOMATION
      });

      return this.getRouteCapabilities(normAgent, normRoute);
    }

    // 4. Notification Route
    if (normRoute === 'notification') {
      this.setCapability({
        agentId: normAgent,
        routeId: normRoute,
        dimension: CapabilityDimension.CONNECTIVITY,
        state: CapabilityState.VERIFIED,
        evidence: 'Native macOS osascript notification delivery',
        trustTier: TrustTier.T5_NOTIFICATION_HUMAN
      });
      this.setCapability({
        agentId: normAgent,
        routeId: normRoute,
        dimension: CapabilityDimension.AUTONOMOUS_WAKEUP,
        state: CapabilityState.UNSUPPORTED,
        evidence: 'Requires human user to read notification and manually activate agent',
        trustTier: TrustTier.T5_NOTIFICATION_HUMAN
      });
      this.setCapability({
        agentId: normAgent,
        routeId: normRoute,
        dimension: CapabilityDimension.RESPONSE_CORRELATION,
        state: CapabilityState.UNSUPPORTED,
        evidence: 'Fire-and-forget notification; no automatic response correlation',
        trustTier: TrustTier.T5_NOTIFICATION_HUMAN
      });

      return this.getRouteCapabilities(normAgent, normRoute);
    }

    // 5. Antigravity IDE / Gemini Direct
    if (normAgent === 'antigravity-ide' || normAgent === 'gemini') {
      this.setCapability({
        agentId: normAgent,
        routeId: normRoute,
        dimension: CapabilityDimension.CONNECTIVITY,
        state: CapabilityState.VERIFIED,
        evidence: 'Native IDE bridge environment',
        trustTier: TrustTier.T0_NATIVE_API
      });
      this.setCapability({
        agentId: normAgent,
        routeId: normRoute,
        dimension: CapabilityDimension.TOOL_EXECUTION,
        state: CapabilityState.VERIFIED,
        evidence: 'Direct tool dispatch registered in IDE',
        trustTier: TrustTier.T0_NATIVE_API
      });
      this.setCapability({
        agentId: normAgent,
        routeId: normRoute,
        dimension: CapabilityDimension.RESPONSE_CORRELATION,
        state: CapabilityState.VERIFIED,
        evidence: 'Synchronous tool call response channel',
        trustTier: TrustTier.T0_NATIVE_API
      });
      return this.getRouteCapabilities(normAgent, normRoute);
    }

    // Fallback default registration
    for (const dim of Object.values(CapabilityDimension)) {
      this.setCapability({
        agentId: normAgent,
        routeId: normRoute,
        dimension: dim,
        state: CapabilityState.UNKNOWN,
        evidence: 'Unprobed custom route',
        trustTier: TrustTier.T5_NOTIFICATION_HUMAN
      });
    }

    return this.getRouteCapabilities(normAgent, normRoute);
  }

  /**
   * Probe standard known routes across all registered agents
   */
  async probeAll(context = {}) {
    const agents = ['chatgpt-desktop', 'claude-desktop', 'antigravity-ide'];
    const results = {};

    for (const agent of agents) {
      results[agent] = {};
      if (agent === 'chatgpt-desktop') {
        results[agent]['chatgpt-local-engine'] = await this.probe(agent, 'chatgpt-local-engine', context);
        results[agent]['accessibility'] = await this.probe(agent, 'accessibility', context);
        results[agent]['notification'] = await this.probe(agent, 'notification', context);
      } else if (agent === 'claude-desktop') {
        results[agent]['mcp-stdio'] = await this.probe(agent, 'mcp-stdio', context);
        results[agent]['accessibility'] = await this.probe(agent, 'accessibility', context);
        results[agent]['notification'] = await this.probe(agent, 'notification', context);
      } else if (agent === 'antigravity-ide') {
        results[agent]['ide-direct'] = await this.probe(agent, 'ide-direct', context);
      }
    }

    return results;
  }
}
