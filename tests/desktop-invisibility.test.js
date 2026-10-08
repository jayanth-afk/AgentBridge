import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopInvisibilityMonitor } from '../src/control-plane/desktop-invisibility-monitor.js';

test('Desktop Invisibility Monitor Suite', async (t) => {
  await t.test('1. Clean execution with undisturbed user focus passes verification', async () => {
    let callCount = 0;
    const fakeBridge = {
      async getFrontmostApp() {
        callCount++;
        return { ok: true, pid: 1234, name: 'Google Chrome', bundleId: 'com.google.Chrome' };
      }
    };

    const monitor = new DesktopInvisibilityMonitor({ swiftBridge: fakeBridge, sampleIntervalMs: 5 });
    await monitor.startTurnSampling({
      collaborationId: 'collab_test_01',
      requestId: 'req_01',
      fromAgent: 'chatgpt',
      toAgent: 'gemini',
      providerPID: 9999
    });

    await new Promise(r => setTimeout(r, 40));

    const report = await monitor.stopTurnSampling();
    assert.equal(report.verdict, 'INVISIBILITY_VERIFIED');
    assert.equal(report.providerActivationDetected, false);
    assert.equal(report.focusChangeDetected, false);
    assert.equal(report.alienSamplesCount, 0);
    assert.ok(report.totalSamples >= 3, `Expected >= 3 samples, got ${report.totalSamples}`);
    assert.equal(report.initialFrontmostPID, 1234);
    assert.equal(report.finalFrontmostPID, 1234);
  });

  await t.test('2. Hard Failure: Provider activation during turn throws VISIBLE_PROVIDER_ACTIVATION', async () => {
    let callCount = 0;
    const fakeBridge = {
      async getFrontmostApp() {
        callCount++;
        // Second call simulates provider stealing focus
        if (callCount === 2) {
          return { ok: true, pid: 9999, name: 'Gemini', bundleId: 'com.google.GeminiMacOS' };
        }
        return { ok: true, pid: 1234, name: 'Google Chrome', bundleId: 'com.google.Chrome' };
      }
    };

    const monitor = new DesktopInvisibilityMonitor({ swiftBridge: fakeBridge, sampleIntervalMs: 5 });
    await monitor.startTurnSampling({
      collaborationId: 'collab_test_02',
      requestId: 'req_02',
      fromAgent: 'chatgpt',
      toAgent: 'gemini',
      providerPID: 9999
    });

    await new Promise(r => setTimeout(r, 30));

    await assert.rejects(
      async () => { await monitor.stopTurnSampling(); },
      (err) => {
        assert.equal(err.code, 'VISIBLE_PROVIDER_ACTIVATION');
        assert.ok(err.message.includes('VISIBLE_PROVIDER_ACTIVATION'));
        return true;
      }
    );
  });

  await t.test('3. Hard Failure: Alien focus change during turn throws FOCUS_STOLEN', async () => {
    let callCount = 0;
    const fakeBridge = {
      async getFrontmostApp() {
        callCount++;
        if (callCount === 2) {
          return { ok: true, pid: 5555, name: 'Random App', bundleId: 'com.random.app' };
        }
        return { ok: true, pid: 1234, name: 'Google Chrome', bundleId: 'com.google.Chrome' };
      }
    };

    const monitor = new DesktopInvisibilityMonitor({ swiftBridge: fakeBridge, sampleIntervalMs: 5 });
    await monitor.startTurnSampling({
      collaborationId: 'collab_test_03',
      requestId: 'req_03',
      fromAgent: 'chatgpt',
      toAgent: 'gemini',
      providerPID: 9999
    });

    await new Promise(r => setTimeout(r, 30));

    await assert.rejects(
      async () => { await monitor.stopTurnSampling(); },
      (err) => {
        assert.equal(err.code, 'FOCUS_STOLEN');
        assert.ok(err.message.includes('FOCUS_STOLEN'));
        return true;
      }
    );
  });
});
