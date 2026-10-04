import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';

import { CONFIG } from '../src/config.js';
import { AuditLogger } from '../src/audit-logger.js';
import { PermissionGuard } from '../src/permission-guard.js';
import { ProjectController } from '../src/project-controller.js';

const TEST_DB = path.join(CONFIG.DATA_DIR, 'test_shell_sec.sqlite');
const WS = CONFIG.TEST_WORKSPACE;
const AGENT = 'claude-desktop';

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test('Shell execution security boundary', async (t) => {
  for (const s of ['', '-wal', '-shm']) {
    const p = `${TEST_DB}${s}`;
    if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch {} }
  }
  if (!fs.existsSync(WS)) fs.mkdirSync(WS, { recursive: true });
  const logger = new AuditLogger(TEST_DB);
  const guard = new PermissionGuard(CONFIG);
  const controller = new ProjectController(guard, logger);
  const guardContext = new PermissionGuard(CONFIG);
  const controllerForGuard = new ProjectController(guardContext, logger);

  t.after(() => {
    try { logger.close(); } catch {}
    for (const s of ['', '-wal', '-shm']) {
      const p = `${TEST_DB}${s}`;
      if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch {} }
    }
  });

  await t.test('command chaining/substitution/redirection is rejected', () => {
    const injections = [
      'echo hi; touch /tmp/ab_pwn',
      'echo hi && touch /tmp/ab_pwn',
      'echo hi || touch /tmp/ab_pwn',
      'echo hi | cat',
      'echo hi & touch /tmp/ab_pwn',
      'echo $(whoami)',
      'echo `whoami`',
      'echo ${HOME}',
      'echo hi > /tmp/ab_pwn',
      'echo hi < /etc/passwd',
      "echo 'unterminated"
    ];
    for (const cmd of injections) {
      assert.strictEqual(guard.validateCommand(cmd, WS).allowed, false, `must reject: ${cmd}`);
    }
  });

  await t.test('legitimate quoted commands remain allowed', () => {
    for (const cmd of ['echo "Hello World"', 'git status', 'node -e "setTimeout(()=>{}, 10)"', 'echo "a; b | c"']) {
      assert.strictEqual(guard.validateCommand(cmd, WS).allowed, true, `must allow: ${cmd}`);
    }
  });

  await t.test('injection attempt cannot create a file via a whitelisted prefix', async () => {
    const proof = path.join(WS, 'shell_inject_proof.txt');
    if (fs.existsSync(proof)) fs.unlinkSync(proof);
    await assert.rejects(
      () => controllerForGuard.executeCommand(`echo hi; touch ${proof}`, WS, AGENT),
      /not permitted|dangerous pattern/
    );
    assert.strictEqual(fs.existsSync(proof), false, 'injection must not create a file');
  });

  await t.test('command success returns stdout and exit 0', async () => {
    const res = await controller.executeCommand('echo shell_ok', WS, AGENT);
    assert.strictEqual(res.exitCode, 0);
    assert.strictEqual(res.stdout, 'shell_ok');
    assert.strictEqual(res.isError, false);
  });

  await t.test('stderr is captured on a zero-exit command', async () => {
    const res = await controller.executeCommand('node -e "console.error(\'errtext\')"', WS, AGENT);
    assert.strictEqual(res.exitCode, 0);
    assert.match(res.stderr, /errtext/);
  });

  await t.test('timeout terminates the process (no lingering child)', async () => {
    const pidFile = path.join(WS, 'shell_timeout_pid.txt');
    if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
    const cmd = `node -e "require('fs').writeFileSync('${pidFile}', String(process.pid)); setTimeout(()=>{}, 60000)"`;
    const res = await controller.executeCommand(cmd, WS, AGENT, 600);
    assert.strictEqual(res.timedOut, true);
    assert.strictEqual(res.isError, true);

    let pid = null;
    for (let i = 0; i < 40 && !pid; i++) {
      if (fs.existsSync(pidFile)) {
        const txt = fs.readFileSync(pidFile, 'utf8').trim();
        if (txt) pid = Number(txt);
      }
      if (!pid) await new Promise(r => setTimeout(r, 25));
    }
    assert.ok(pid, 'child must have written its pid');
    let dead = false;
    for (let i = 0; i < 80; i++) {
      if (!alive(pid)) { dead = true; break; }
      await new Promise(r => setTimeout(r, 25));
    }
    assert.ok(dead, `timed-out child pid ${pid} must not survive`);
    if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
  });

  await t.test('disallowed executable is rejected', async () => {
    await assert.rejects(() => controller.executeCommand('nc -l 1234', WS, AGENT), /not in the safe whitelist/);
  });

  await t.test('cwd outside allowed roots is rejected', async () => {
    await assert.rejects(() => controller.executeCommand('echo hi', '/etc', AGENT), /working directory disallowed/);
  });
});
