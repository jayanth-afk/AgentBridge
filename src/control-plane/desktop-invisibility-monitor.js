import { SwiftAXBridge } from './swift-ax-bridge.js';

/**
 * DesktopInvisibilityMonitor:
 * High-frequency telemetry and violation detector for autonomous agent execution.
 * 
 * Verifies the core invariant:
 * The user's active foreground application and Space must remain 100% undisturbed
 * during every autonomous model turn. Transient activation (even for a few milliseconds)
 * is strictly detected and classified as a HARD FAILURE.
 */
export class DesktopInvisibilityMonitor {
  constructor(options = {}) {
    this.swiftBridge = options.swiftBridge || new SwiftAXBridge(options);
    this.sampleIntervalMs = options.sampleIntervalMs || 15;
    this.activeSession = null;
    this.history = [];
  }

  /**
   * Start high-frequency sampling for an autonomous turn.
   */
  async startTurnSampling({
    collaborationId = 'standalone',
    requestId,
    fromAgent,
    toAgent,
    providerPID = null,
    providerBundle = null
  }) {
    if (this.activeSession) {
      this.stopTurnSampling();
    }

    const initialFront = await this.swiftBridge.getFrontmostApp().catch(() => null);
    const startTimestamp = new Date().toISOString();

    const session = {
      collaborationId,
      requestId,
      fromAgent,
      toAgent,
      providerPID,
      providerBundle: providerBundle ? providerBundle.toLowerCase() : null,
      initialFrontmostPID: initialFront?.pid || null,
      initialFrontmostName: initialFront?.name || null,
      initialFrontmostBundle: initialFront?.bundleId || null,
      samples: [],
      alienSamples: [],
      providerActivationDetected: false,
      focusChangeDetected: false,
      startedAt: Date.now(),
      startTimestamp,
      intervalHandle: null,
      stopped: false
    };

    // Record BEFORE sample
    session.samples.push({
      phase: 'BEFORE',
      timestamp: Date.now(),
      pid: initialFront?.pid,
      name: initialFront?.name,
      bundleId: initialFront?.bundleId
    });

    // High-frequency polling loop during execution
    session.intervalHandle = setInterval(async () => {
      if (session.stopped) return;
      try {
        const cur = await this.swiftBridge.getFrontmostApp();
        if (!cur || !cur.ok) return;

        const sample = {
          phase: 'DURING',
          timestamp: Date.now(),
          pid: cur.pid,
          name: cur.name,
          bundleId: cur.bundleId
        };
        session.samples.push(sample);

        // Check violation 1: Provider became frontmost
        const curBundle = (cur.bundleId || '').toLowerCase();
        const curName = (cur.name || '').toLowerCase();
        const isProvider = (session.providerPID && cur.pid === session.providerPID) ||
                           (session.providerBundle && curBundle.includes(session.providerBundle)) ||
                           (toAgent && curName.includes(toAgent.toLowerCase()));

        if (isProvider) {
          session.providerActivationDetected = true;
          session.alienSamples.push(sample);
        } else if (session.initialFrontmostPID && cur.pid !== session.initialFrontmostPID) {
          session.focusChangeDetected = true;
          session.alienSamples.push(sample);
        }
      } catch {}
    }, this.sampleIntervalMs);

    this.activeSession = session;
    return session;
  }

  /**
   * Stop sampling, take AFTER sample, and assert strict invisibility.
   */
  async stopTurnSampling() {
    const session = this.activeSession;
    if (!session || session.stopped) return null;

    session.stopped = true;
    if (session.intervalHandle) {
      clearInterval(session.intervalHandle);
      session.intervalHandle = null;
    }

    const durationMs = Date.now() - session.startedAt;
    const finalFront = await this.swiftBridge.getFrontmostApp().catch(() => null);

    // Record AFTER sample
    session.samples.push({
      phase: 'AFTER',
      timestamp: Date.now(),
      pid: finalFront?.pid,
      name: finalFront?.name,
      bundleId: finalFront?.bundleId
    });

    const isFinalProvider = (session.providerPID && finalFront?.pid === session.providerPID) ||
                            (toAgentName(session.toAgent) && (finalFront?.name || '').toLowerCase().includes(toAgentName(session.toAgent)));

    if (isFinalProvider) {
      session.providerActivationDetected = true;
      session.alienSamples.push(session.samples[session.samples.length - 1]);
    } else if (session.initialFrontmostPID && finalFront?.pid !== session.initialFrontmostPID) {
      session.focusChangeDetected = true;
      session.alienSamples.push(session.samples[session.samples.length - 1]);
    }

    const report = {
      timestamp: session.startTimestamp,
      requestId: session.requestId,
      collaborationId: session.collaborationId,
      fromAgent: session.fromAgent,
      toAgent: session.toAgent,
      durationMs,
      totalSamples: session.samples.length,
      initialFrontmostPID: session.initialFrontmostPID,
      initialFrontmostName: session.initialFrontmostName,
      initialFrontmostBundle: session.initialFrontmostBundle,
      finalFrontmostPID: finalFront?.pid || null,
      finalFrontmostName: finalFront?.name || null,
      finalFrontmostBundle: finalFront?.bundleId || null,
      providerActivationDetected: session.providerActivationDetected,
      focusChangeDetected: session.focusChangeDetected,
      alienSamplesCount: session.alienSamples.length,
      alienSamples: session.alienSamples,
      verdict: !session.providerActivationDetected && !session.focusChangeDetected ? 'INVISIBILITY_VERIFIED' : 'FAILED'
    };

    this.history.push(report);
    this.activeSession = null;

    // HARD FAILURE ENFORCEMENT
    if (report.providerActivationDetected) {
      const err = new Error(`VISIBLE_PROVIDER_ACTIVATION: Provider '${session.toAgent}' visibly took over desktop focus during turn`);
      err.code = 'VISIBLE_PROVIDER_ACTIVATION';
      err.report = report;
      throw err;
    }

    if (report.focusChangeDetected) {
      const err = new Error(`FOCUS_STOLEN_DURING_EXECUTION: Focus moved from [${session.initialFrontmostPID}] ${session.initialFrontmostName} during turn`);
      err.code = 'FOCUS_STOLEN';
      err.report = report;
      throw err;
    }

    return report;
  }
}

function toAgentName(toAgent) {
  if (!toAgent) return '';
  const lower = toAgent.toLowerCase();
  if (lower.includes('chatgpt')) return 'chatgpt';
  if (lower.includes('claude')) return 'claude';
  if (lower.includes('gemini')) return 'gemini';
  return lower;
}
