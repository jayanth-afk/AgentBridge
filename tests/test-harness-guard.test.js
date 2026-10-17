import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BridgeHttpServer } from '../src/http-server.js';
import { CONFIG } from '../src/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TESTS_DIR = __dirname;

test('A7 Test-Harness Hermetic Guard: Tests must never bind port 8765 or open live database', async (t) => {
  await t.test('1. Runtime guard: BridgeHttpServer strictly rejects binding production port 8765 in tests', async () => {
    const server = new BridgeHttpServer({
      port: 8765,
      host: '127.0.0.1'
    });

    await assert.rejects(
      async () => {
        await server.start();
      },
      /Safety violation: Tests are forbidden from binding the production bridge port \(8765\)/
    );
  });

  await t.test('2. Static test suite inspection: No test binds port 8765 or opens live data/bridge.sqlite', () => {
    const testFiles = fs.readdirSync(TESTS_DIR)
      .filter(f => f.endsWith('.test.js'))
      .map(f => path.join(TESTS_DIR, f));

    const violations = [];

    for (const file of testFiles) {
      if (path.basename(file) === 'test-harness-guard.test.js') continue;
      const content = fs.readFileSync(file, 'utf8');

      // Check for live database opening
      if (content.includes("'data/bridge.sqlite'") || content.includes('"data/bridge.sqlite"')) {
        violations.push(`${path.basename(file)}: Hardcoded reference to live 'data/bridge.sqlite'`);
      }

      // Check for binding 8765 on servers
      const lines = content.split('\n');
      lines.forEach((line, idx) => {
        if (/(?:new\s+BridgeHttpServer|\.listen|\bstartHttpServer)\s*\(.*8765/.test(line) && !line.includes('//') && !line.includes('safety') && !line.includes('rejects')) {
          violations.push(`${path.basename(file)}:${idx + 1}: Binds or references live port 8765 on server (${line.trim()})`);
        }
      });
    }

    assert.strictEqual(
      violations.length,
      0,
      `Hermetic test guard violations found:\n${violations.join('\n')}`
    );
  });
});
