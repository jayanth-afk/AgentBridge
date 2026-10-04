import http from 'node:http';
import { CONFIG } from './config.js';
import { timingSafeEqualString } from './config-resolver.js';
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

    // Authentication boundary for network-exposed control plane requests.
    // Enforced when `requireApiKey` is on (operator opt-in) or an explicit
    // `apiKey` is supplied. When required without a usable key, startup fails
    // loudly rather than running unauthenticated. Local desktop usage defaults
    // to no network auth because no HTTP listener is started by default.
    this.requireApiKey = options.requireApiKey !== undefined
      ? options.requireApiKey
      : CONFIG.CONTROL_PLANE.REQUIRE_API_KEY;
    const configKey = this.requireApiKey ? CONFIG.CONTROL_PLANE.API_KEY : null;
    this.apiKey = options.apiKey !== undefined ? options.apiKey : configKey;
    this.server = null;
  }

  extractApiKey(req) {
    const header = req.headers['x-api-key'];
    if (typeof header === 'string' && header.length > 0) return header;
    const auth = req.headers['authorization'];
    if (typeof auth === 'string' && /^Bearer\s+/i.test(auth)) {
      return auth.replace(/^Bearer\s+/i, '').trim();
    }
    return null;
  }

  isAuthorized(req) {
    if (!this.apiKey) return true; // no key configured -> local-only mode
    const presented = this.extractApiKey(req);
    return timingSafeEqualString(presented, this.apiKey);
  }

  start() {
    if (this.requireApiKey && !this.apiKey) {
      return Promise.reject(new Error(
        'Authentication required but no control_plane.api_key is configured. ' +
        'Set CONTROL_PLANE_API_KEY (or provide a literal api_key) before starting the HTTP control plane.'
      ));
    }

    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        // Use the WHATWG URL parser: it normalizes dot segments and percent
        // encoding deterministically, unlike the deprecated url.parse().
        const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const pathname = parsedUrl.pathname;
        const query = Object.fromEntries(parsedUrl.searchParams);
        const method = req.method;

        // CORS headers for local/trusted interaction
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

        if (method === 'OPTIONS') {
          res.writeHead(204);
          return res.end();
        }

        // Enforce the authentication boundary before any handler runs. This is
        // the authoritative gate: every route below is only reachable once
        // this check passes.
        if (!this.isAuthorized(req)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Unauthorized: missing or invalid API key.' }));
        }

        const readBody = () => new Promise((resBody, rejBody) => {
          let body = '';
          let aborted = false;
          req.on('data', chunk => {
            body += chunk;
            if (body.length > 5 * 1024 * 1024 && !aborted) {
              aborted = true;
              const err = new Error('Request body too large (limit 5MB).');
              err.statusCode = 413;
              rejBody(err);
            }
          });
          req.on('end', () => {
            if (aborted) return;
            if (!body) return resBody({});
            try { resBody(JSON.parse(body)); }
            catch {
              const err = new Error('Malformed JSON request body.');
              err.statusCode = 400;
              rejBody(err);
            }
          });
          req.on('error', rejBody);
        });

        try {
          if (pathname === '/health' && method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
              status: 'healthy',
              service: 'agent-bridge',
              authEnabled: Boolean(this.apiKey),
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
                const isError = Boolean(out && typeof out === 'object' && out.isError === true);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({
                  jsonrpc: '2.0',
                  id,
                  result: {
                    ...(isError ? { isError: true } : {}),
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
          const status = err && err.statusCode ? err.statusCode : 500;
          if (!res.headersSent) {
            res.writeHead(status, { 'Content-Type': 'application/json' });
          }
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
