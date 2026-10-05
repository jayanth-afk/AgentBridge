import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { PermissionGuard } from '../src/permission-guard.js';
import { CONFIG } from '../src/config.js';

const guard = new PermissionGuard(CONFIG);
const HOME = os.homedir();
const WORKSPACE = CONFIG.TEST_WORKSPACE;
const SRC = path.join(CONFIG.BRIDGE_ROOT, 'src');

test('direct file access: credential paths are denied even inside allowed roots', () => {
  for (const p of [
    path.join(HOME, '.ssh', 'id_ed25519'),
    path.join(HOME, '.ssh', 'config'),
    path.join(HOME, '.codex', 'auth.json'),
    path.join(HOME, '.gemini', 'oauth_creds.json'),
    path.join(HOME, '.aws', 'credentials'),
    path.join(HOME, 'Library', 'Keychains', 'login.keychain-db'),
    path.join(WORKSPACE, '.env')
  ]) {
    assert.equal(guard.validatePathAccess(p, 'READ').allowed, false, `expected denial for ${p}`);
  }
});

test('direct file access: ordinary workspace and source files stay allowed', () => {
  assert.equal(guard.validatePathAccess(path.join(WORKSPACE, 'notes.txt'), 'READ').allowed, true);
  assert.equal(guard.validatePathAccess(path.join(SRC, 'config.js'), 'READ').allowed, true);
});

test('command arguments: credential paths are blocked for whitelisted commands', () => {
  for (const cmd of [
    'cat ~/.ssh/id_ed25519',
    `cat ${path.join(HOME, '.gemini', 'oauth_creds.json')}`,
    `cat "${path.join(HOME, '.codex', 'auth.json')}"`,
    'cat --out=~/.ssh/id_rsa',
    'grep -r token ~/.aws'
  ]) {
    const res = guard.validateCommand(cmd, WORKSPACE);
    assert.equal(res.allowed, false, `expected block for: ${cmd}`);
  }
});

test('command arguments: relative references to forbidden files are blocked', () => {
  const res = guard.validateCommand('cat .env', WORKSPACE);
  assert.equal(res.allowed, false);
});

test('command arguments: absolute paths outside allowed roots are blocked', () => {
  assert.equal(guard.validateCommand('ls /Applications', WORKSPACE).allowed, false);
  assert.equal(guard.validateCommand('cat /etc/hosts', WORKSPACE).allowed, false);
});

test('command arguments: glob characters in absolute paths are rejected', () => {
  assert.equal(guard.validateCommand('cat ~/.s?h/id_ed25519', WORKSPACE).allowed, false);
  assert.equal(guard.validateCommand(`ls ${SRC}/*.js`, WORKSPACE).allowed, false);
});

test('command arguments: legitimate commands still pass', () => {
  assert.equal(guard.validateCommand(`ls ${SRC}`, WORKSPACE).allowed, true);
  assert.equal(guard.validateCommand('ls -la', WORKSPACE).allowed, true);
  assert.equal(guard.validateCommand('git status', WORKSPACE).allowed, true);
  assert.equal(guard.validateCommand('echo hello', WORKSPACE).allowed, true);
  // A quoted message containing a slash is a word, not a path outside the roots.
  assert.equal(guard.validateCommand('git commit -m "fix: handle /etc note"', WORKSPACE).allowed, true);
});

test('COMMAND_ARG_PATH_CHECK=false restores the previous behaviour (explicit opt-out)', () => {
  const lax = new PermissionGuard({ ...CONFIG, COMMAND_ARG_PATH_CHECK: false });
  assert.equal(lax.validateCommand('ls /Applications', WORKSPACE).allowed, true);
});
