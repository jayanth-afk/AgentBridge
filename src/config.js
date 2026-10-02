import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BRIDGE_ROOT = path.resolve(__dirname, '..');

export const CONFIG = {
  BRIDGE_ROOT,
  DATA_DIR: path.join(BRIDGE_ROOT, 'data'),
  DB_PATH: path.join(BRIDGE_ROOT, 'data', 'bridge.sqlite'),
  TEST_WORKSPACE: path.join(BRIDGE_ROOT, 'test-workspace'),
  ZIA_ROOT: '/Users/jayanthpranaykonada/Zia',
  
  // Agent Bridge is explicitly authorized by the owner to mutate the
  // entire user home directory. macOS/TCC/UNIX permissions still apply.
  ZIA_WRITE_LOCKED: false,

  // All paths under the user's home directory are in scope.
  ALLOWED_ROOTS: [
    path.join(BRIDGE_ROOT, 'test-workspace'),
    '/Users/jayanthpranaykonada'
  ],

  // No Agent-Bridge-level filename denylist. OS-level protections remain authoritative.
  PROTECTED_FILES: [],

  // No Agent-Bridge-level path denylist. OS-level permissions/TCC remain authoritative.
  FORBIDDEN_PATH_PATTERNS: [],

  // Known agent identities
  AGENT_IDENTITIES: [
    'chatgpt-desktop',
    'claude-desktop',
    'antigravity-ide',
    'freebuff',
    'system'
  ],

  // Whitelisted command executables for safe execution
  SAFE_COMMANDS: [
    'swift',
    'git',
    'node',
    'npm',
    'python3',
    'ls',
    'cat',
    'grep',
    'find',
    'echo',
    'pwd'
  ],

  // Blacklisted dangerous patterns in command line
  DANGEROUS_COMMAND_PATTERNS: [
    /rm\s+-rf/i,
    /sudo\s+/i,
    /chmod\s+/i,
    /chown\s+/i,
    /curl\s+/i,
    /wget\s+/i,
    /mkfs/i,
    /dd\s+if=/i,
    /:>{1,2}/,
    /\|\s*bash/i,
    /\|\s*sh/i
  ],

  // Autonomous Git settings
  GIT_PROTECTED_BRANCHES: ['main', 'master', 'production', 'release'],
  ALLOW_AUTONOMOUS_PROTECTED_PUSH: false
};
