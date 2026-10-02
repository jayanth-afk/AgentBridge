import http from 'node:http';
import { parse } from 'node:url';
import { ToolRegistry } from './tool-registry.js';
import { TaskManager } from './task-manager.js';
import { CacheManager } from './cache-manager.js';
import { DiagnosticsManager } from './diagnostics-manager.js';
import { PresenceManager } from './presence-manager.js';
import { AgentIdentityManager } from './agent-identity.js';
import { GitController } from './git-controller.js';

export class BridgeHttpServer {
  constructor(options = {}) {
    this.port = options.port || 8765;
    this.host = options.host || '127.0.0.1';
    this.logger = options.auditLogger;
    this.guard = options.permissionGuard;
    this.mailbox = options.mailboxHub;
    this.controller = options.projectController;
    this.collaboration = options.collaborationManager;
    this.fileActivity = options.fileActivityManager;
    this.cache = options.cacheManager || new CacheManager();
    this.diagnostics = options.diagnosticsManager || new DiagnosticsManager();
    this.presence = options.presenceManager || (this.logger ? new PresenceManager(this.logger) : null);
    this.identity = options.identityManager || (this.logger ? new AgentIdentityManager(this.logger) : null);
    this.git = options.gitController || (this.guard && this.logger ? new GitController(this.guard, this.logger) : null);
    this.registry = options.toolRegistry || new ToolRegistry();
    this.server = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        const parsedUrl = parse(req.url, true);
        const { pathname, query } = parsedUrl;
        const method = req.method;

        // CORS headers for local/trusted interaction
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

        if (method === 'OPTIONS') {
          res.writeHead(204);
          return res.end();
        }

        const readBody = () => new Promise((resBody) => {
          let body = '';
          req.on('data', chunk => { body += chunk; });
          req.on('end', () => {
            try { resBody(body ? JSON.parse(body) : {}); }
            catch { resBody({}); }
          });
        });

        try {
          if (pathname === '/health' && method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
              status: 'healthy',
              service: 'agent-bridge',
              ziaWriteLocked: this.guard.config.ZIA_WRITE_LOCKED,
              allowedRoots: this.guard.config.ALLOWED_ROOTS,
              activeAgents: this.guard.config.AGENT_IDENTITIES,
              liveAgents: this.presence ? this.presence.listAgents() : []
            }));
          }

          if (pathname === '/api/agents' && method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
              agents: this.guard.config.AGENT_IDENTITIES,
              liveAgents: this.presence ? this.presence.listAgents() : [],
              policies: this.guard.agentPolicies
            }));
          }

          if (pathname.startsWith('/api/inbox/') && method === 'GET') {
            const agentId = pathname.replace('/api/inbox/', '');
            const unreadOnly = query.unreadOnly === 'true';
            const compact = query.compact === 'true';
            const messages = this.mailbox.getInbox({ agentId, unreadOnly, compact });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(messages));
          }

          if (pathname === '/api/message' && method === 'POST') {
            const body = await readBody();
            const msg = this.mailbox.sendMessage(body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(msg));
          }

          if (pathname === '/api/task' && method === 'POST') {
            const body = await readBody();
            const task = this.mailbox.delegateTask(body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(task));
          }

          if (pathname.startsWith('/api/task/') && method === 'GET') {
            const taskId = pathname.replace('/api/task/', '');
            const compact = query.compact !== 'false';
            const task = this.mailbox.getTask(taskId, compact);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(task || { error: 'Not found' }));
          }

          if (pathname === '/api/audit' && method === 'GET') {
            const limit = parseInt(query.limit, 10) || 50;
            const compact = query.compact === 'true';
            const logs = this.logger.getRecentLogs(limit);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(logs));
          }

          // JSON-RPC / Streamable HTTP endpoint for tool calls derived from ToolRegistry
          if (pathname === '/mcp' && method === 'POST') {
            const body = await readBody();
            const { method: rpcMethod, params = {}, id = 1 } = body;

            if (rpcMethod === 'tools/list') {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({
                jsonrpc: '2.0',
                id,
                result: {
                  tools: this.registry.getToolDefinitions()
                }
              }));
            }

            if (rpcMethod === 'tools/call') {
              const { name, arguments: args = {} } = params;
              const toolContext = {
                controller: this.controller,
                mailbox: this.mailbox,
                collaboration: this.collaboration,
                fileActivity: this.fileActivity,
                logger: this.logger,
                git: this.git,
                presence: this.presence,
                identity: this.identity,
                diagnostics: this.diagnostics,
                cache: this.cache
              };

              try {
                const out = await this.registry.executeTool(name, args, toolContext);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({
                  jsonrpc: '2.0',
                  id,
                  result: {
                    content: [
                      {
                        type: 'text',
                        text: typeof out === 'string' ? out : JSON.stringify(out, null, 2)
                      }
                    ]
                  }
                }));
              } catch (toolErr) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({
                  jsonrpc: '2.0',
                  id,
                  result: {
                    isError: true,
                    content: [
                      {
                        type: 'text',
                        text: `Error executing ${name}: ${toolErr.message}`
                      }
                    ]
                  }
                }));
              }
            }
          }

          // 404 fallback
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Endpoint not found' }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });

      this.server.listen(this.port, this.host, () => {
        resolve({ host: this.host, port: this.port });
      });

      this.server.on('error', reject);
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(resolve);
      } else {
        resolve();
      }
    });
  }
}
