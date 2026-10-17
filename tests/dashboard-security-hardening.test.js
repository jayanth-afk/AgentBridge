import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DashboardServer } from '../src/dashboard/dashboard-server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('Part C: Dashboard Security Hardening Invariants', async (t) => {
  await t.test('1. Throws at construction if authToken is explicitly empty or null', () => {
    assert.throws(() => new DashboardServer({ authToken: '' }), /requires an authToken/);
    assert.throws(() => new DashboardServer({ authToken: null }), /requires an authToken/);
  });

  await t.test('2. No default token: generates strong random token per-run when none passed', () => {
    const s1 = new DashboardServer();
    const s2 = new DashboardServer();
    assert.ok(s1.authToken.length >= 32);
    assert.notStrictEqual(s1.authToken, s2.authToken);
    assert.notStrictEqual(s1.authToken, 'secret-operator-token');
  });

  await t.test('3. Strict Content-Security-Policy header sent on all responses', async () => {
    const server = new DashboardServer({ port: 9877, host: '127.0.0.1' });
    await server.start();
    try {
      const res = await fetch('http://127.0.0.1:9877/', {
        headers: { Host: '127.0.0.1:9877' }
      });
      const csp = res.headers.get('content-security-policy');
      assert.ok(csp, 'CSP header must be present');
      assert.match(csp, /default-src 'self'/);
      assert.strictEqual(res.headers.get('x-frame-options'), 'DENY');
    } finally {
      await server.stop();
    }
  });

  await t.test('4. index.html contains zero innerHTML with data assignments', () => {
    const htmlPath = path.resolve(__dirname, '../src/dashboard/public/index.html');
    const html = fs.readFileSync(htmlPath, 'utf8');

    // Ensure no dynamic string interpolation into innerHTML
    assert.doesNotMatch(html, /innerHTML\s*=\s*data\./);
    assert.doesNotMatch(html, /innerHTML\s*=\s*items\./);
    assert.doesNotMatch(html, /innerHTML\s*=\s*`[^`]*\${/);
    assert.doesNotMatch(html, /innerHTML\s*=\s*'[^']*'<div/);

    // Verify safe DOM methods are used
    assert.ok(html.includes('document.createElement'));
    assert.ok(html.includes('textContent'));
    assert.ok(html.includes('appendChild'));
  });

  await t.test('5. index.html makes the expected API calls to populated endpoints', () => {
    const htmlPath = path.resolve(__dirname, '../src/dashboard/public/index.html');
    const html = fs.readFileSync(htmlPath, 'utf8');

    assert.ok(html.includes("fetchWithAuth('/api/tokens')"));
    assert.ok(html.includes("fetchWithAuth('/api/health')"));
    assert.ok(html.includes("fetchWithAuth('/api/approvals')"));
  });

  await t.test('6. Host and Origin rejections block CSRF and DNS rebinding', async () => {
    const token = 'token_' + 'b'.repeat(32);
    const server = new DashboardServer({ port: 9878, host: '127.0.0.1', authToken: token });
    await server.start();
    try {
      // Rebind Host via raw http.request
      const resHost = await new Promise((resolve, reject) => {
        const req = http.request({
          hostname: '127.0.0.1',
          port: 9878,
          path: '/api/tokens',
          method: 'GET',
          headers: {
            Host: 'malicious.attacker.com',
            Authorization: `Bearer ${token}`
          }
        }, (r) => {
          let body = '';
          r.on('data', c => body += c);
          r.on('end', () => resolve({ status: r.statusCode, body }));
        });
        req.on('error', reject);
        req.end();
      });
      assert.strictEqual(resHost.status, 403);

      // Malicious Origin
      const resOrigin = await fetch('http://127.0.0.1:9878/api/approvals', {
        method: 'POST',
        headers: {
          Host: '127.0.0.1:9878',
          Origin: 'http://malicious.attacker.com',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ approvalId: 'appr_seed_1', decision: 'approve' })
      });
      assert.strictEqual(resOrigin.status, 403);
    } finally {
      await server.stop();
    }
  });

  await t.test('7. Agent identity cannot approve privileged items', async () => {
    const token = 'token_' + 'c'.repeat(32);
    const server = new DashboardServer({ port: 9879, host: '127.0.0.1', authToken: token });
    await server.start();
    try {
      const res = await fetch('http://127.0.0.1:9879/api/approvals', {
        method: 'POST',
        headers: {
          Host: '127.0.0.1:9879',
          Authorization: `Bearer ${token}`,
          'X-Approver-Identity': 'agent:gemini',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ approvalId: 'appr_seed_1', decision: 'approve' })
      });
      assert.strictEqual(res.status, 403);
      const data = await res.json();
      assert.match(data.error, /Agents cannot approve privileged actions/);
    } finally {
      await server.stop();
    }
  });
});
