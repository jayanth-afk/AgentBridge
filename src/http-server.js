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
import { ZiABackgroundGPT } from './control-plane/zia-background-gpt.js';
import { ChatGptLocalEngineAdapter } from './control-plane/chatgpt-local-engine.js';
import { AdapterHealth } from './control-plane/desktop-control-adapter.js';

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
    // The ChatGPT brain endpoints (/api/chatgpt/*) ALWAYS require a key, so the
    // configured key is resolved independently of the general `requireApiKey`
    // opt-in. When none is configured those routes fail closed (503). The key is
    // never logged.
    this.chatGPTApiKey = options.apiKey !== undefined ? options.apiKey : CONFIG.CONTROL_PLANE.API_KEY;
    this.server = null;
    this.backgroundGPT = null;
    this.backgroundGPTPromise = null;
    this.localEngine = null;
  }

  /** Lazily-created headless engine (bundled Codex CLI inside ChatGPT.app). */
  getLocalEngine() {
    if (!this.localEngine) {
      this.localEngine = new ChatGptLocalEngineAdapter({ defaultTimeoutMs: 60000 });
    }
    return this.localEngine;
  }

  /**
   * Decide which transport answers a ChatGPT request.
   *   - 'ui'     -> the Accessibility-driven ChatGPT Desktop app
   *   - 'engine' -> the bundled headless Codex engine (fails loudly if absent)
   *   - 'auto'   -> engine when installed AND healthy, otherwise the UI route
   * The chosen transport is always reported back to the caller.
   */
  async resolveChatGPTTransport(requested) {
    if (requested === 'ui') return 'ui';
    const engine = this.getLocalEngine();
    if (requested === 'engine') return 'engine';
    if (engine.isInstalled()) {
      const health = await engine.health();
      if (health.status === AdapterHealth.AVAILABLE) return 'engine';
    }
    return 'ui';
  }

  async getBackgroundGPT() {
    if (this.backgroundGPT) return this.backgroundGPT;
    if (!this.backgroundGPTPromise) {
      this.backgroundGPTPromise = Promise.resolve().then(() => new ZiABackgroundGPT({
        timeoutMs: 45000,
        backgroundTransport: 'auto'
      }));
    }
    this.backgroundGPT = await this.backgroundGPTPromise;
    this.backgroundGPTPromise = null;
    return this.backgroundGPT;
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

  /**
   * Stricter, dedicated boundary for the ChatGPT brain endpoints. These routes
   * can invoke the user's own authenticated ChatGPT, so they never rely on the
   * general control-plane default:
   *   1. loopback clients only (blocks LAN access even if the bind host changes)
   *   2. no browser `Origin` header (blocks CSRF from any web page)
   *   3. a validated loopback `Host` header (blocks DNS-rebinding)
   *   4. a mandatory, constant-time API key — fails closed (503) when none is set
   *
   * Returns true when the request may proceed; otherwise the response has already
   * been written. The key value is never logged.
   */
  guardChatGPTRequest(req, res) {
    const remote = req.socket ? req.socket.remoteAddress : '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) {
      return this.rejectChatGPT(res, 403, 'ChatGPT brain endpoints accept loopback clients only.');
    }

    const origin = req.headers['origin'];
    if (typeof origin === 'string' && origin.length > 0) {
      return this.rejectChatGPT(res, 403, 'Browser-originated requests are not accepted on ChatGPT brain endpoints.');
    }

    const host = String(req.headers['host'] || '').toLowerCase();
    const hostname = host.startsWith('[')
      ? host.slice(0, host.indexOf(']') + 1)
      : host.replace(/:\d+$/, '');
    if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname)) {
      return this.rejectChatGPT(res, 403, 'ChatGPT brain endpoints require a loopback Host header.');
    }

    if (!this.chatGPTApiKey) {
      return this.rejectChatGPT(res, 503,
        'ChatGPT brain is unavailable: no control-plane API key is configured.');
    }

    if (!timingSafeEqualString(this.extractApiKey(req), this.chatGPTApiKey)) {
      return this.rejectChatGPT(res, 401, 'Unauthorized: missing or invalid API key.');
    }

    return true;
  }

  /** Write a rejection for a ChatGPT-brain request. Always returns false. */
  rejectChatGPT(res, status, message) {
    if (!res.headersSent) {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: message }));
    }
    return false;
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
          // A browser preflight against the ChatGPT brain is itself a web-origin
          // request; refuse it rather than advertising CORS access.
          if (pathname.startsWith('/api/chatgpt/') && typeof req.headers['origin'] === 'string') {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
              ok: false,
              error: 'Browser-originated requests are not accepted on ChatGPT brain endpoints.'
            }));
          }
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

          if (pathname === '/api/chatgpt/health' && method === 'GET') {
            if (!this.guardChatGPTRequest(req, res)) return;
            try {
              const brain = await this.getBackgroundGPT();
              const health = await brain.health();
              const targetStatus = brain.backgroundTarget?.hasTarget() ? 'configured' : 'unconfigured';
              const isHealthy = Boolean(health.healthy && health.running && health.windowCount > 0);
              res.writeHead(isHealthy ? 200 : 503, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({
                ok: isHealthy,
                service: 'chatgpt-desktop',
                running: Boolean(health.running),
                windowCount: health.windowCount || 0,
                targetStatus,
                activeTurns: health.activeTurns || 0,
                status: isHealthy ? 'READY' : (health.running ? 'NO_WINDOW' : 'NOT_RUNNING')
              }));
            } catch (err) {
              res.writeHead(503, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({
                ok: false,
                service: 'chatgpt-desktop',
                error: err.message
              }));
            }
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
          // Direct local brain endpoint backed by the proven real ChatGPT
          // Desktop worker. This never exposes ChatGPT credentials or private APIs.
          if (pathname === '/api/chatgpt/complete' && method === 'POST') {
            if (!this.guardChatGPTRequest(req, res)) return;
            const brainBody = await readBody();
            const messages = Array.isArray(brainBody?.messages) ? brainBody.messages : [];
            const text = messages.map(message => {
              const role = typeof message?.role === 'string' ? message.role : 'user';
              const content = typeof message?.content === 'string' ? message.content : '';
              return { role, content };
            }).filter(message => message.content.length > 0);

            if (text.length === 0) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ ok: false, error: 'messages must contain at least one non-empty message' }));
            }

            const requestId = typeof brainBody.requestId === 'string' && brainBody.requestId.length > 0
              ? brainBody.requestId
              : 'zia_brain_' + Date.now() + '_' + Math.random().toString(16).slice(2);

            const wantStream = Boolean(brainBody?.stream || parsedUrl.searchParams.get('stream') === 'true');
            const requestedTransport = ['auto', 'engine', 'ui'].includes(brainBody?.transport)
              ? brainBody.transport
              : 'auto';
            const activeTransport = await this.resolveChatGPTTransport(requestedTransport);

            const prompt = [
              "You are ZiA's primary intelligence engine.",
              "Answer the request directly, accurately, and efficiently.",
              "Do not discuss internal routing, Agent Bridge, or this worker unless explicitly asked.",
              "",
              ...text.map(message => message.role.toUpperCase() + ":\n" + message.content)
            ].join('\n');

            // ---- Engine transport: stateless, hardened headless Q&A ----
            if (activeTransport === 'engine') {
              const engine = this.getLocalEngine();
              if (wantStream) {
                res.writeHead(200, {
                  'Content-Type': 'text/event-stream',
                  'Cache-Control': 'no-cache',
                  'Connection': 'keep-alive'
                });
                const onTextDelta = (delta) => {
                  res.write(`data: ${JSON.stringify({ chunk: delta })}\n\n`);
                };
                const result = await engine.answer({ prompt, requestId, onTextDelta });
                res.write(`data: ${JSON.stringify({
                  done: true,
                  ok: Boolean(result.success && result.response),
                  provider: 'chatgpt-desktop',
                  transport: 'engine',
                  response: result.response || null,
                  requestId,
                  modelTurnConfirmed: Boolean(result.success && result.response),
                  usage: result.usage || null,
                  error: result.error || null
                })}\n\n`);
                return res.end();
              }
              const result = await engine.answer({ prompt, requestId });
              res.writeHead(result.success ? 200 : 502, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({
                ok: Boolean(result.success && result.response),
                provider: 'chatgpt-desktop',
                transport: 'engine',
                response: result.response || null,
                requestId,
                modelTurnConfirmed: Boolean(result.success && result.response),
                usage: result.usage || null,
                latencyMs: result.latencyMs,
                error: result.error || null,
                status: result.success ? 'completed' : (result.error || 'failed')
              }));
            }

            // ---- UI transport (fallback): behavior unchanged ----
            if (wantStream) {
              res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive'
              });
              const onChunk = (delta) => {
                res.write(`data: ${JSON.stringify({ chunk: delta })}\n\n`);
              };
              try {
                const brain = await this.getBackgroundGPT();
                const result = await brain.send({ requestId, text: prompt, onChunk });
                res.write(`data: ${JSON.stringify({
                  done: true,
                  ok: Boolean(result.success && result.modelTurnConfirmed),
                  provider: 'chatgpt-desktop',
                  transport: 'ui',
                  response: result.response || null,
                  requestId,
                  modelTurnConfirmed: Boolean(result.modelTurnConfirmed),
                  error: result.error || null,
                  status: result.status || null
                })}\n\n`);
                return res.end();
              } catch (error) {
                res.write(`data: ${JSON.stringify({
                  done: true,
                  ok: false,
                  provider: 'chatgpt-desktop',
                  transport: 'ui',
                  requestId,
                  error: error instanceof Error ? error.message : String(error)
                })}\n\n`);
                return res.end();
              }
            }

            try {
              const brain = await this.getBackgroundGPT();
              const result = await brain.send({ requestId, text: prompt });

              res.writeHead(result.success ? 200 : 502, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({
                ok: Boolean(result.success && result.modelTurnConfirmed),
                provider: 'chatgpt-desktop',
                transport: 'ui',
                response: result.response || null,
                requestId,
                modelTurnConfirmed: Boolean(result.modelTurnConfirmed),
                uiSubmitted: Boolean(result.uiSubmitted),
                error: result.error || null,
                status: result.status || null
              }));
            } catch (error) {
              res.writeHead(502, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({
                ok: false,
                provider: 'chatgpt-desktop',
                transport: 'ui',
                requestId,
                error: error instanceof Error ? error.message : String(error)
              }));
            }
          }

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
