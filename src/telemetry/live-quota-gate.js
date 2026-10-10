import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const HANDOFF_DIR = '/Users/jayanthpranaykonada/agent-bridge-handoff';
const QUOTA_LOG_PATH = path.join(HANDOFF_DIR, 'm4-live-quota-log.jsonl');

export const QUOTA_LIMITS = Object.freeze({
  MAX_MISSION_CALLS: 60,
  MAX_RUN_CALLS: 25,
  MAX_RETRIES: 2,
  PER_CALL_TIMEOUT_MS: 120000
});

export class LiveQuotaGate {
  constructor(options = {}) {
    this.runId = options.runId || `run_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    this.runCallsCount = 0;
    this.maxMissionCalls = options.maxMissionCalls || QUOTA_LIMITS.MAX_MISSION_CALLS;
    this.maxRunCalls = options.maxRunCalls || QUOTA_LIMITS.MAX_RUN_CALLS;
    this.maxRetries = options.maxRetries || QUOTA_LIMITS.MAX_RETRIES;
    this.timeoutMs = options.timeoutMs || QUOTA_LIMITS.PER_CALL_TIMEOUT_MS;
    this.logPath = options.logPath || QUOTA_LOG_PATH;
  }

  getMissionCallsCount() {
    try {
      if (!fs.existsSync(this.logPath)) return 0;
      const lines = fs.readFileSync(this.logPath, 'utf8').trim().split('\n').filter(Boolean);
      return lines.length;
    } catch {
      return 0;
    }
  }

  checkQuota() {
    const isLiveOptIn = process.env.AGENT_BRIDGE_LIVE_MODELS === '1';
    if (!isLiveOptIn) {
      return {
        allowed: false,
        reason: 'OPT_IN_REQUIRED: AGENT_BRIDGE_LIVE_MODELS=1 is not set',
        code: 'LIVE_MODELS_NOT_OPTED_IN'
      };
    }

    const missionCount = this.getMissionCallsCount();
    if (missionCount >= this.maxMissionCalls) {
      return {
        allowed: false,
        reason: `MISSION_QUOTA_EXHAUSTED: ${missionCount}/${this.maxMissionCalls} calls reached`,
        code: 'QUOTA_EXHAUSTED'
      };
    }

    if (this.runCallsCount >= this.maxRunCalls) {
      return {
        allowed: false,
        reason: `RUN_QUOTA_EXHAUSTED: ${this.runCallsCount}/${this.maxRunCalls} calls reached in this run`,
        code: 'RUN_QUOTA_EXHAUSTED'
      };
    }

    return { allowed: true, missionRemaining: this.maxMissionCalls - missionCount, runRemaining: this.maxRunCalls - this.runCallsCount };
  }

  recordCall({
    agent,
    provider,
    nonce,
    latencyMs,
    tokensIn = null,
    tokensOut = null,
    status = 'success',
    error = null,
    metadata = {}
  }) {
    this.runCallsCount++;
    const record = {
      runId: this.runId,
      timestamp: new Date().toISOString(),
      agent,
      provider,
      nonce: nonce || null,
      latencyMs: latencyMs !== undefined ? Number(latencyMs.toFixed(2)) : null,
      tokensIn,
      tokensOut,
      status,
      error: error || null,
      totalMissionCalls: this.getMissionCallsCount() + 1,
      runCallsCount: this.runCallsCount,
      metadata
    };

    try {
      fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
      fs.appendFileSync(this.logPath, JSON.stringify(record) + '\n', 'utf8');
    } catch (err) {
      process.stderr.write(`[LiveQuotaGate] Failed to write log: ${err.message}\n`);
    }

    return record;
  }
}
