import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';

import { CONFIG } from './config.js';
import { AuditLogger } from './audit-logger.js';
import { PermissionGuard } from './permission-guard.js';
import { MailboxHub } from './mailbox-hub.js';
import { TaskManager } from './task-manager.js';
import { ProjectController } from './project-controller.js';
import { ConcurrencyManager } from './concurrency-manager.js';
import { CollaborationManager } from './collaboration-manager.js';
import { FileActivityManager } from './file-activity-manager.js';
import { CacheManager } from './cache-manager.js';
import { DiagnosticsManager } from './diagnostics-manager.js';
import { PresenceManager } from './presence-manager.js';
import { AgentIdentityManager } from './agent-identity.js';
import { GitController } from './git-controller.js';
import { ToolRegistry } from './tool-registry.js';
import { EventBus } from './event-bus.js';
import { createSessionAdapter } from './session-adapters/index.js';
import { BridgeHttpServer } from './http-server.js';
import { CapabilityRegistry } from './capabilities/capability-registry.js';
import { RequestExplainer } from './diagnostics/request-explainer.js';
import { EffectsLedger } from './effects/effects-ledger.js';
import { AttemptLedger } from './attempts/attempt-ledger.js';

export class BridgeMcpServer {
  constructor(options = {}) {
    // Default to the least-privileged broad identity, never the most-privileged
    // 'system'. A launched client binds its real identity via AGENT_ID.
    this.agentId = options.agentId || process.env.AGENT_ID || 'freebuff';
    this.startedAt = new Date().toISOString();
    this.instanceId = `bridge_${process.pid}_${Date.now()}`;

    // Subsystems
    this.logger = options.auditLogger || new AuditLogger();
    this.guard = options.permissionGuard || new PermissionGuard();
    this.concurrency = options.concurrencyManager || new ConcurrencyManager();
    this.cache = options.cacheManager || new CacheManager();
    this.diagnostics = options.diagnosticsManager || new DiagnosticsManager();
    this.presence = options.presenceManager || new PresenceManager(this.logger);
    this.identity = options.identityManager || new AgentIdentityManager(this.logger, this.agentId);
    this.eventBus = options.eventBus || new EventBus(this.logger);
    this.taskManager = options.taskManager || new TaskManager(this.logger);
    this.attempts = options.attemptLedger || this.taskManager?.attempts || (this.logger?.db ? new AttemptLedger(this.logger) : null);
    this.effectsLedger = options.effectsLedger || (this.logger?.db ? new EffectsLedger(this.logger) : null);
    this.mailbox = options.mailboxHub || new MailboxHub(this.logger, this.taskManager, this.eventBus);
    this.collaboration = options.collaborationManager || new CollaborationManager(this.logger);
    this.fileActivity = options.fileActivityManager || new FileActivityManager(this.logger);
    this.git = options.gitController || new GitController(this.guard, this.logger);
    this.controller = options.projectController || new ProjectController(
      this.guard,
      this.logger,
      this.concurrency,
      this.fileActivity,
      this.cache,
      this.git
    );
    this.sessionAdapter = options.sessionAdapter || createSessionAdapter(this.agentId, {
      mailboxHub: this.mailbox,
      eventBus: this.eventBus
    });

    this.capabilityRegistry = options.capabilityRegistry || new CapabilityRegistry(this.logger);
    this.requestExplainer = options.requestExplainer || new RequestExplainer(this.logger);

    // Single unified source of truth for tools
    this.registry = options.toolRegistry || new ToolRegistry();

    // Start HTTP control plane server for Zia brain and local HTTP clients
    this.httpServer = new BridgeHttpServer({
      port: Number(process.env.AGENT_BRIDGE_HTTP_PORT || 8765),
      host: '127.0.0.1',
      auditLogger: this.logger,
      permissionGuard: this.guard,
      mailboxHub: this.mailbox,
      projectController: this.controller,
      collaborationManager: this.collaboration,
      fileActivityManager: this.fileActivity,
      cacheManager: this.cache,
      diagnosticsManager: this.diagnostics,
      presenceManager: this.presence,
      identityManager: this.identity,
      gitController: this.git,
      toolRegistry: this.registry
    });

    // Start presence heartbeat loop for bound identity
    if (this.agentId && this.agentId !== 'system') {
      this.presenceSession = this.presence.startHeartbeatLoop(this.agentId, 5000, {
        transport: 'mcp-stdio'
      });
    }

    this.server = new Server(
      {
        name: 'agent-bridge',
        version: '1.2.0'
      },
      {
        capabilities: {
          tools: {}
        }
      }
    );

    this.setupHandlers();
  }

  setupHandlers() {
    // Shared execution context passed to all tools
    const toolContext = {
      controller: this.controller,
      mailbox: this.mailbox,
      taskManager: this.taskManager,
      collaboration: this.collaboration,
      fileActivity: this.fileActivity,
      logger: this.logger,
      git: this.git,
      presence: this.presence,
      identity: this.identity,
      diagnostics: this.diagnostics,
      cache: this.cache,
      eventBus: this.eventBus,
      sessionAdapter: this.sessionAdapter,
      capabilityRegistry: this.capabilityRegistry,
      requestExplainer: this.requestExplainer,
      boundAgentId: this.agentId,
      attemptLedger: this.attempts,
      effectsLedger: this.effectsLedger
    };

    // Tools list derived directly from unified registry
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.registry.getToolDefinitions()
    }));

    // Tool execution dispatched directly through unified registry
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args = {} } = request.params;

      try {
        const result = await this.registry.executeTool(name, args, toolContext);
        const isError = Boolean(result && typeof result === 'object' && result.isError === true);
        return {
          ...(isError ? { isError: true } : {}),
          content: [
            {
              type: 'text',
              text: typeof result === 'string' ? result : JSON.stringify(result, null, 2)
            }
          ]
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Error executing ${name}: ${err.message}`
            }
          ]
        };
      }
    });
  }

  async startStdio() {
    if (this.httpServer) {
      try {
        await this.httpServer.start();
      } catch (err) {
        if (err.code !== 'EADDRINUSE') {
          // If port is in use, another bridge instance is already providing HTTP
          console.error('Bridge HTTP server notice:', err.message);
        }
      }
    }
    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    const cleanup = () => {
      if (this.httpServer) {
        this.httpServer.stop().catch(() => {});
      }
      if (this.presenceSession) {
        this.presenceSession.cleanup();
      }
      if (this.eventBus) {
        this.eventBus.close();
      }
    };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
  }
}

if (process.argv[1] && process.argv[1].endsWith('mcp-server.js')) {
  let cliAgentId;
  const agentIdx = process.argv.indexOf('--agent');
  if (agentIdx >= 0 && process.argv[agentIdx + 1]) {
    cliAgentId = process.argv[agentIdx + 1];
  }
  const bridge = new BridgeMcpServer({ agentId: cliAgentId });
  bridge.startStdio().catch(err => {
    console.error('Bridge MCP server error:', err);
    process.exit(1);
  });
}
