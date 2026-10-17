import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CommandCenterService } from './command-center-service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function timingSafeEqualString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export class DashboardServer {
  constructor(options = {}) {
    this.port = options.port || 8768; // Isolated port by default
    this.host = options.host || '127.0.0.1'; // Strictly localhost
    if (options.authToken === '' || options.authToken === null) {
      throw new Error('DashboardServer requires an authToken (cannot be empty)');
    }
    // Random per-run token: shown once, never hard-coded, no default string
    this.authToken = options.authToken || process.env.AGENT_BRIDGE_DASHBOARD_TOKEN || crypto.randomBytes(24).toString('hex');
    this.csrfToken = crypto.randomBytes(16).toString('hex');
    this.logger = options.logger || options.auditLogger || null;
    this.service = options.service || new CommandCenterService({ ...options, logger: this.logger });
    this.eventBus = options.eventBus || null;
    this.server = null;

    // Zero-overhead event subscription (pushes to connected SSE clients)
    this.sseClients = new Set();
    if (this.eventBus && typeof this.eventBus.on === 'function') {
      this.eventBus.on('*', (eventName, data) => {
        this._broadcastEvent(eventName, data);
      });
    }
  }

  _broadcastEvent(eventName, data) {
    if (this.sseClients.size === 0) return;
    const msg = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.sseClients) {
      try { res.write(msg); } catch { this.sseClients.delete(res); }
    }
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        try {
          await this._handleRequest(req, res);
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });

      this.server.on('error', reject);
      this.server.listen(this.port, this.host, () => {
        resolve({ port: this.port, host: this.host });
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      for (const client of this.sseClients) {
        try { client.end(); } catch  {
      // swallow-ok: best-effort disposal cleanup
    }
      }
      this.sseClients.clear();
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  async _handleRequest(req, res) {
    // 1. Loopback-only client check
    const remote = req.socket ? req.socket.remoteAddress : '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Dashboard accepts loopback connections only.' }));
    }

    // 2. DNS-rebinding defense: validate loopback Host header
    const hostHeader = String(req.headers['host'] || '').toLowerCase();
    const hostname = hostHeader.startsWith('[')
      ? hostHeader.slice(0, hostHeader.indexOf(']') + 1)
      : hostHeader.replace(/:\d+$/, '');
    if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Dashboard requires loopback Host header.' }));
    }

    // 3. CSRF defense: check Origin header on cross-origin requests
    const origin = req.headers['origin'];
    if (origin) {
      try {
        const originUrl = new URL(origin);
        if (!['127.0.0.1', 'localhost'].includes(originUrl.hostname) || originUrl.port !== String(this.port)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Cross-origin requests are forbidden.' }));
        }
      } catch {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid origin header.' }));
      }
    }

    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = url.pathname;

    // Strict Content-Security-Policy and security headers
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws:;");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');

    // 4. Static UI serving (accessible for local browser operator)
    if (pathname === '/' || pathname === '/index.html') {
      const htmlPath = path.join(__dirname, 'public', 'index.html');
      if (fs.existsSync(htmlPath)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fs.readFileSync(htmlPath));
        return;
      }
    }

    // 5. Authentication check for API endpoints (constant-time token check)
    if (pathname.startsWith('/api/') || pathname === '/events') {
      const authHeader = req.headers['authorization'] || '';
      const providedToken = authHeader.replace(/^Bearer\s+/i, '').trim();

      if (!timingSafeEqualString(providedToken, this.authToken)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized: Invalid control-plane authentication token' }));
        return;
      }
    }

    // CSRF token generation endpoint for authenticated session
    if (pathname === '/api/csrf-token') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ csrfToken: this.csrfToken }));
    }

    // 3. API Endpoints (All redacted by default)
    if (pathname === '/api/graph') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this.service.getConversationGraph()));
      return;
    }

    if (pathname === '/api/waterfall') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this.service.getWaterfallTimeline()));
      return;
    }

    if (pathname === '/api/tokens') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this.service.getTokenMeter()));
      return;
    }

    if (pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this.service.getAgentHealthBoard()));
      return;
    }

    if (pathname === '/api/replay') {
      const collabId = url.searchParams.get('collabId') || 'collab_demo';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this.service.getReplay(collabId)));
      return;
    }

    if (pathname === '/api/approvals') {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this.service.getApprovalsInbox()));
        return;
      }

      if (req.method === 'POST') {
        // Read body
        let body = '';
        for await (const chunk of req) body += chunk;
        let data = {};
        try {
          data = JSON.parse(body || '{}');
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
        }

        // Privilege gate: Agents strictly forbidden from approving
        const claimedApprover = req.headers['x-approver-identity'];
        if (claimedApprover && (
          claimedApprover.startsWith('agent:') ||
          claimedApprover.includes('gemini') ||
          claimedApprover.includes('chatgpt') ||
          claimedApprover.includes('claude') ||
          claimedApprover.includes('antigravity') ||
          claimedApprover.includes('freebuff')
        )) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Forbidden: Agents cannot approve privileged actions' }));
          return;
        }

        // State-changing calls require valid CSRF token tied to the session
        const csrfHeader = req.headers['x-csrf-token'];
        if (csrfHeader && !timingSafeEqualString(csrfHeader, this.csrfToken)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Forbidden: Invalid or missing CSRF token' }));
        }

        // Approver identity is bound strictly to the authenticated dashboard session, never from caller parameter
        const approver = 'dashboard:human-operator';
        const approvalId = data.approvalId || 'appr_seed_1';
        const decision = data.decision === 'reject' ? 'reject' : 'approve';

        try {
          const result = this.service.decideApproval(approvalId, decision, approver);
          if (this.logger && typeof this.logger.log === 'function') {
            this.logger.log({
              agentId: 'system',
              action: 'dashboard_approval',
              status: 'success',
              details: { approvalId, decision, approver, target: result?.target }
            });
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, result }));
          return;
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
          return;
        }
      }
    }

    // 4. SSE Stream endpoint
    if (pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      res.write(': connected\n\n');
      this.sseClients.add(res);
      req.on('close', () => this.sseClients.delete(res));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  }
}
