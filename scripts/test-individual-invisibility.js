import { ModelOrchestrator } from '../src/control-plane/model-orchestrator.js';
import { DesktopInvisibilityMonitor } from '../src/control-plane/desktop-invisibility-monitor.js';
import { SwiftAXBridge } from '../src/control-plane/swift-ax-bridge.js';

async function runIndividualTest(provider, prompt) {
  console.log(`\n================================================================================`);
  console.log(`INDIVIDUAL INVISIBILITY TEST: ${provider.toUpperCase()}`);
  console.log(`================================================================================`);

  const swiftBridge = new SwiftAXBridge();
  const monitor = new DesktopInvisibilityMonitor({ swiftBridge, sampleIntervalMs: 15 });
  const modelOrchestrator = new ModelOrchestrator();

  const initialFront = await swiftBridge.getFrontmostApp();
  console.log(`Initial Foreground Focus: [PID ${initialFront.pid}] "${initialFront.name}" (${initialFront.bundleId || 'N/A'})`);

  const requestId = `test_invis_${provider}_${Date.now()}`;
  console.log(`Starting high-frequency turn sampling (15ms polling)...`);
  await monitor.startTurnSampling({
    collaborationId: `collab_invis_${provider}`,
    requestId,
    fromAgent: 'system',
    toAgent: provider
  });

  const startMs = Date.now();
  let modelResult;
  let invisReport;

  try {
    modelResult = await modelOrchestrator.delegateModelTask({
      fromAgent: 'system',
      toAgent: provider,
      message: prompt,
      requestId,
      deadline: Date.now() + 120000
    });
  } finally {
    try {
      invisReport = await monitor.stopTurnSampling();
    } catch (err) {
      console.error(`\n❌ INVISIBILITY VIOLATION DETECTED:`, err.message);
      if (err.report?.alienSamples?.length) {
        console.error(`Alien samples:`, JSON.stringify(err.report.alienSamples.slice(0, 5), null, 2));
      }
      invisReport = err.report;
      throw err;
    }
  }

  const durationMs = Date.now() - startMs;
  console.log(`\nTurn completed in ${(durationMs / 1000).toFixed(1)}s`);
  console.log(`Model Response Success: ${modelResult.success} (Transport: ${modelResult.transport})`);
  console.log(`Response Snippet: "${modelResult.response?.slice(0, 150)}..."`);

  // Assertions
  if (!modelResult.success || !modelResult.response) {
    throw new Error(`Model execution failed for ${provider}: ${modelResult.error || 'NO_RESPONSE'}`);
  }
  if (modelResult.response === 'EXECUTED_BY_AGENT') {
    throw new Error(`Synthetic response detected for ${provider}: EXECUTED_BY_AGENT`);
  }
  if (invisReport.verdict !== 'INVISIBILITY_VERIFIED') {
    throw new Error(`Invisibility verification failed: ${invisReport.verdict}`);
  }
  if (invisReport.alienSamplesCount > 0) {
    throw new Error(`Detected ${invisReport.alienSamplesCount} alien focus samples during turn!`);
  }

  console.log(`\n✅ INVISIBILITY AUDIT TELEMETRY FOR ${provider.toUpperCase()}:`);
  console.log(`   Total High-Frequency Samples: ${invisReport.totalSamples}`);
  console.log(`   Initial Frontmost: [PID ${invisReport.initialFrontmostPID}] ${invisReport.initialFrontmostName}`);
  console.log(`   Final Frontmost:   [PID ${invisReport.finalFrontmostPID}] ${invisReport.finalFrontmostName}`);
  console.log(`   Alien Focus Samples: ${invisReport.alienSamplesCount}`);
  console.log(`   Provider Activation Detected: ${invisReport.providerActivationDetected}`);
  console.log(`   Focus Change Detected: ${invisReport.focusChangeDetected}`);
  console.log(`   Invisibility Verdict: ${invisReport.verdict}`);

  return { provider, invisReport, modelResult };
}

async function main() {
  console.log('================================================================================');
  console.log('AGENT BRIDGE: INDIVIDUAL PROVIDER INVISIBILITY VERIFICATION');
  console.log('================================================================================');
  console.log('Invariant: Zero user interruption, zero Space switching, zero frontmost changes.');
  console.log('Sampling: High-frequency 15ms sampling across BEFORE, DURING, and AFTER phases.');

  const results = [];

  // 1. Gemini
  try {
    results.push(await runIndividualTest(
      'gemini',
      'State in one concise sentence how log compaction prevents unbounded disk growth in Raft.'
    ));
  } catch (err) {
    console.error(`Gemini failed:`, err.message);
    results.push({ provider: 'gemini', error: err.message });
  }

  // 2. Claude
  try {
    results.push(await runIndividualTest(
      'claude',
      'State in one concise sentence why majority quorum prevents split-brain partitioning.'
    ));
  } catch (err) {
    console.error(`Claude failed:`, err.message);
    results.push({ provider: 'claude', error: err.message });
  }

  // 3. ChatGPT
  try {
    results.push(await runIndividualTest(
      'chatgpt',
      'State in one concise sentence the primary advantage of Raft leader leases.'
    ));
  } catch (err) {
    console.error(`ChatGPT failed:`, err.message);
    results.push({ provider: 'chatgpt', error: err.message });
  }

  console.log('\n================================================================================');
  console.log('INDIVIDUAL INVISIBILITY TEST SUMMARY');
  console.log('================================================================================');
  for (const r of results) {
    if (r.invisReport) {
      console.log(`  ${r.provider.toUpperCase().padEnd(10)}: ${r.invisReport.verdict} (${r.invisReport.totalSamples} samples, 0 alien, transport: ${r.modelResult?.transport})`);
    } else {
      console.log(`  ${r.provider.toUpperCase().padEnd(10)}: FAILED (${r.error})`);
    }
  }

  const allPassed = results.length === 3 && results.every(r => r.invisReport && r.invisReport.verdict === 'INVISIBILITY_VERIFIED');
  if (!allPassed) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\n❌ INDIVIDUAL INVISIBILITY SUITE FAILED:', err);
  process.exit(1);
});
