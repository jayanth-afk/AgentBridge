import http from 'node:http';
import { parse } from 'node:url';

export class BridgeHttpServer {
  constructor(options = {}) {
    this.port = options.port || 8765;
    this.host = options.host || '127.0.0.1';
    this.logger = options.auditLogger;
    this.guard = options.permissionGuard;
    this.mailbox = options.mailboxHub;
    this.controller = options.projectController;
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
              activeAgents: this.guard.config.AGENT_IDENTITIES
            }));
          }

          if (pathname === '/api/agents' && method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
              agents: this.guard.config.AGENT_IDENTITIES,
              policies: this.guard.agentPolicies
            }));
          }

          if (pathname.startsWith('/api/inbox/') && method === 'GET') {
            const agentId = pathname.replace('/api/inbox/', '');
            const unreadOnly = query.unreadOnly === 'true';
            const messages = this.mailbox.getInbox({ agentId, unreadOnly });
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
            const task = this.mailbox.getTask(taskId);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(task || { error: 'Not found' }));
          }

          if (pathname === '/api/audit' && method === 'GET') {
            const limit = parseInt(query.limit, 10) || 50;
            const logs = this.logger.getRecentLogs(limit);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(logs));
          }

          // JSON-RPC / Streamable HTTP endpoint for tool calls
          if (pathname === '/mcp' && method === 'POST') {
            const body = await readBody();
            const { method: rpcMethod, params = {}, id = 1 } = body;

            if (rpcMethod === 'tools/list') {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({
                jsonrpc: '2.0',
                id,
                result: {
                  tools: [
                    { name: 'bridge_ping', description: 'Harmless health check tool that returns CHATGPT_BRIDGE_REAL_TEST_7F31' },
                    { name: 'bridge_discover_agents', description: 'Discover agents' },
                    { name: 'bridge_inspect_project', description: 'Inspect project structure' },
                    { name: 'bridge_read_file', description: 'Read file with line numbers and hash' },
                    { name: 'bridge_create_file', description: 'Create file in authorized workspace' },
                    { name: 'bridge_edit_file', description: 'Edit file with optimistic concurrency' },
                    { name: 'bridge_delete_file', description: 'Delete file with safety check' },
                    { name: 'bridge_search_files', description: 'Search project files' },
                    { name: 'bridge_execute_command', description: 'Execute safe whitelisted command' },
                    { name: 'bridge_send_message', description: 'Send inter-agent message' },
                    { name: 'bridge_check_inbox', description: 'Check agent inbox' },
                    { name: 'bridge_delegate_task', description: 'Delegate task to peer agent' },
                    { name: 'bridge_ask_agent', description: 'Synchronously query peer agent' }
                  ]
                }
              }));
            }

            if (rpcMethod === 'tools/call') {
              const { name, arguments: args = {} } = params;
              let out;

              switch (name) {
                case 'bridge_ping': {
                  const caller = args.agentId || 'unknown';
                  const timestamp = new Date().toISOString();
                  this.logger.log({
                    agentId: caller,
                    action: 'bridge_ping',
                    targetPath: null,
                    command: null,
                    status: 'success',
                    details: { responseToken: 'CHATGPT_BRIDGE_REAL_TEST_7F31' }
                  });
                  out = {
                    status: 'OK',
                    token: 'CHATGPT_BRIDGE_REAL_TEST_7F31',
                    timestamp,
                    caller,
                    environment: 'Jayanth\'s Mac (Apple Silicon arm64, Node v24.12.0)',
                    bridgePath: '/Users/jayanthpranaykonada/agent-bridge',
                    message: 'CHATGPT_BRIDGE_REAL_TEST_7F31: Agent Bridge is operational on Jayanth\'s Mac.'
                  };
                  break;
                }
                case 'bridge_inspect_project':
                  out = await this.controller.inspectProject(args.rootPath, args.agentId);
                  break;
                case 'bridge_read_file':
                  out = await this.controller.readFile(args.filePath, args.agentId, args.startLine, args.endLine);
                  break;
                case 'bridge_create_file':
                  out = await this.controller.createFile(args.filePath, args.agentId, args.content, args.overwrite);
                  break;
                case 'bridge_edit_file':
                  out = await this.controller.editFile(args.filePath, args.agentId, args.targetContent, args.replacementContent, args.expectedHash);
                  break;
                case 'bridge_delete_file':
                  out = await this.controller.deleteFile(args.filePath, args.agentId);
                  break;
                case 'bridge_search_files':
                  out = await this.controller.searchFiles(args.rootPath, args.agentId, args.query, args.isRegex);
                  break;
                case 'bridge_execute_command':
                  out = await this.controller.executeCommand(args.commandLine, args.cwd, args.agentId);
                  break;
                case 'bridge_send_message':
                  out = this.mailbox.sendMessage(args);
                  break;
                case 'bridge_check_inbox':
                  out = this.mailbox.getInbox(args);
                  break;
                case 'bridge_delegate_task':
                  out = this.mailbox.delegateTask(args);
                  break;
                case 'bridge_ask_agent':
                  out = await this.mailbox.askAgent(args);
                  break;
                default:
                  throw new Error(`Unknown tool: ${name}`);
              }

              res.writeHead(200, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({
                jsonrpc: '2.0',
                id,
                result: { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
              }));
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
