import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ZiABackgroundGPTTarget } from '../src/control-plane/zia-background-gpt-target.js';

function makeElements() {
  return [
    { role: 'AXWebArea', title: 'ZiA worker readiness', depth: 8 },
    { role: 'AXButton', title: 'ZiA Response', depth: 23 },
    { role: 'AXStaticText', value: 'ZiA Response', depth: 25 },
    // ChatGPT currently exposes a second same-title representation at depth 23;
    // only the depth-26 project-sidebar entry is the navigation target.
    { role: 'AXButton', title: 'ZiA worker readiness', depth: 26 },
    { role: 'AXButton', title: 'ZiA worker readiness', depth: 23 },
    { role: 'AXStaticText', value: '[AB:boot]\nThis is the dedicated ZiA Background GPT worker conversation. Reply...' }
  ];
}

test('ZiA Background GPT target persists and resolves only the dedicated project chat', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zia-bg-target-'));
  const statePath = path.join(dir, 'target.json');
  const calls = [];
  const bridge = {
    inspectElements: async () => ({ ok: true, elements: makeElements() }),
    pressChatGPTButton: async title => {
      calls.push(title);
      return { ok: true, status: 'PRESSED' };
    }
  };

  const target = new ZiABackgroundGPTTarget({ swiftBridge: bridge, statePath });
  const adopted = await target.adoptVerifiedCurrentConversation({
    conversationTitle: 'ZiA worker readiness',
    anchorText: 'This is the dedicated ZiA Background GPT worker conversation.'
  });

  assert.equal(adopted.ok, true);
  assert.equal(fs.existsSync(statePath), true);

  const reloaded = new ZiABackgroundGPTTarget({ swiftBridge: bridge, statePath });
  const resolved = await reloaded.resolvePersisted();

  assert.equal(resolved.ok, true);
  // The resolver intentionally does not press the sidebar entry when the
  // dedicated conversation is already selected.
  assert.deepEqual(calls, []);
});

test('ZiA Background GPT target rejects ambiguous sidebar identity', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zia-bg-target-'));
  const statePath = path.join(dir, 'target.json');
  fs.writeFileSync(statePath, JSON.stringify({
    version: 1,
    projectTitle: 'ZiA Response',
    conversationTitle: 'ZiA worker readiness',
    anchorText: 'This is the dedicated ZiA Background GPT worker conversation.'
  }));

  const bridge = {
    inspectElements: async () => ({
      ok: true,
      elements: [
        { role: 'AXButton', title: 'ZiA Response', depth: 23 },
        { role: 'AXStaticText', value: 'ZiA Response', depth: 25 },
        { role: 'AXButton', title: 'ZiA worker readiness', depth: 26 },
        { role: 'AXButton', title: 'ZiA worker readiness', depth: 26 },
        { role: 'AXWebArea', title: 'ZiA worker readiness', depth: 8 }
      ]
    }),
    pressChatGPTButton: async () => ({ ok: true })
  };

  const target = new ZiABackgroundGPTTarget({ swiftBridge: bridge, statePath });
  const resolved = await target.resolvePersisted();

  assert.equal(resolved.ok, false);
  assert.equal(resolved.status, 'BACKGROUND_TARGET_AMBIGUOUS');
});
