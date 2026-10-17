import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import {
  BaseRouteAdapter,
  DeliveryStage,
  CompletionEvidenceTier
} from './route-interface.js';
import { RouteEvidence } from '../capabilities/agent-manifest.js';
import { getScrubbedEnv } from '../utils/scrubbed-env.js';

const execFileAsync = promisify(execFile);

export const ALLOWED_CLI_COMMANDS = Object.freeze([
  'echo',
  'cat',
  'node',
  'python3',
  'swift',
  'git',
  'sh',
  'bash',
  'zsh',
  'claude',
  'codex',
  'gemini'
]);

/**
 * Headless CLI process adapter for non-interactive agents (Claude CLI, Codex exec, Gemini CLI).
 * Spawns headless process, streams stdout, takes process exit / EOF as exact completion.
 * No UI or accessibility permissions involved.
 */
export class CliProcessAdapter extends BaseRouteAdapter {
  constructor(routeIdOrOptions = 'cli-process', maybeOptions = {}) {
    const isOptionsFirst = typeof routeIdOrOptions === 'object' && routeIdOrOptions !== null;
    const routeId = isOptionsFirst ? (routeIdOrOptions.routeId || 'cli-process') : routeIdOrOptions;
    const options = isOptionsFirst ? routeIdOrOptions : maybeOptions;

    super(routeId, options);
    this.allowedCommands = Array.isArray(options.allowedCommands)
      ? options.allowedCommands
      : ALLOWED_CLI_COMMANDS;
    this.command = options.command || 'echo';
    this.baseArgs = options.args || options.defaultArgs || [];
    this.inputMode = options.inputMode || (options.passPromptViaStdin ? 'stdin' : 'arg');
    this.agentId = options.agentId || 'cli-agent';
    this.activeProcesses = new Map(); // requestId -> record
    this.usageRecords = new Map();    // requestId -> usage
  }

  isCommandAllowed(cmd) {
    if (!cmd || typeof cmd !== 'string') return false;
    const base = path.basename(cmd).toLowerCase();
    return this.allowedCommands.some(allowed => {
      const allowedBase = path.basename(allowed).toLowerCase();
      return base === allowedBase || cmd === allowed;
    });
  }

  /**
   * Probe CLI availability via binary check without assuming presence.
   */
  async probe() {
    if (!this.isCommandAllowed(this.command)) {
      return {
        ready: false,
        stage: DeliveryStage.FAILED,
        evidence: RouteEvidence.PROBED,
        backgroundCapable: false,
        reason: `Command '${this.command}' is not in the CLI process adapter allowlist`
      };
    }
    try {
      let binPath = null;
      if (this.command.includes('/') || path.isAbsolute(this.command)) {
        if (fs.existsSync(this.command)) {
          binPath = path.resolve(this.command);
        }
      } else {
        const { stdout } = await execFileAsync('which', [this.command], { env: getScrubbedEnv() });
        binPath = stdout.trim();
      }

      if (!binPath) {
        return {
          ready: false,
          stage: DeliveryStage.DISCONNECTED,
          evidence: RouteEvidence.PROBED,
          backgroundCapable: true,
          reason: `CLI binary '${this.command}' not found on PATH`
        };
      }

      // Try reading version non-destructively
      let version = 'unknown';
      try {
        const vRun = await execFileAsync(binPath, ['--version'], { timeout: 1000, env: getScrubbedEnv() });
        version = (vRun.stdout || vRun.stderr || '').trim().split('\n')[0];
      } catch {
        version = `${this.command} (detected at ${binPath})`;
      }

      return {
        ready: true,
        stage: DeliveryStage.READY,
        binPath,
        command: this.command,
        version,
        evidence: RouteEvidence.MOCK_TESTED,
        backgroundCapable: true
      };
    } catch (err) {
      return {
        ready: false,
        stage: DeliveryStage.DISCONNECTED,
        evidence: RouteEvidence.PROBED,
        backgroundCapable: true,
        reason: `CLI binary '${this.command}' is not installed or unreachable`,
        error: err.message
      };
    }
  }

  /**
   * Dispatch request to CLI process and wait for completion.
   */
  /**
   * Dispatch request to CLI process and wait for completion.
   */
  async send(request) {
    if (!this.isCommandAllowed(this.command)) {
      throw new Error(`Command '${this.command}' is not in the CLI process adapter allowlist`);
    }

    const {
      requestId,
      prompt = request.message || '',
      args = [],
      timeoutMs = 60000,
      observer = null
    } = request;

    if (!requestId) throw new Error('requestId is required for CLI dispatch');

    const spawnArgs = [...this.baseArgs, ...(args.length > 0 ? args : (this.inputMode === 'arg' ? [prompt] : []))];
    const startTime = Date.now();
    const tokensIn = Math.ceil(Buffer.byteLength(prompt, 'utf8') / 4);

    // Register active process record SYNCHRONOUSLY before any await to eliminate spawn races
    const record = {
      child: null,
      pid: null,
      requestId,
      startTime,
      tokensIn,
      tokensOut: 0,
      accumulatedText: '',
      timer: null,
      cancelled: false,
      resolve: null
    };

    if (timeoutMs > 0) {
      record.timer = setTimeout(() => {
        this.cancel(requestId);
      }, timeoutMs);
    }

    this.activeProcesses.set(requestId, record);

    const probeRes = await this.probe();
    if (record.cancelled) {
      this.activeProcesses.delete(requestId);
      return {
        outcome: 'CANCELLED',
        requestId,
        exitCode: null,
        signal: 'SIGTERM'
      };
    }

    if (!probeRes.ready) {
      this.activeProcesses.delete(requestId);
      return {
        outcome: 'FAILED',
        accepted: false,
        routeId: this.routeId,
        stage: DeliveryStage.FAILED,
        reason: probeRes.reason
      };
    }

    return new Promise((resolve) => {
      record.resolve = resolve;
      if (record.cancelled) {
        this.activeProcesses.delete(requestId);
        return resolve({
          outcome: 'CANCELLED',
          requestId,
          exitCode: null,
          signal: 'SIGTERM'
        });
      }

      let child;
      try {
        const scrubbedEnv = getScrubbedEnv(this.options.env);

        child = spawn(this.command, spawnArgs, {
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
          env: scrubbedEnv
        });
      } catch (spawnErr) {
        this.activeProcesses.delete(requestId);
        return resolve({
          outcome: 'FAILED',
          error: spawnErr.message,
          requestId
        });
      }

      record.child = child;
      record.pid = child.pid;

      let stdoutBuffer = '';
      let stderrBuffer = '';

      child.stdout.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        stdoutBuffer += text;
        record.accumulatedText = stdoutBuffer;
        record.tokensOut = Math.ceil(Buffer.byteLength(stdoutBuffer, 'utf8') / 4);

        if (observer && typeof observer.onPartialText === 'function') {
          observer.onPartialText(text);
        }
        this.emit('delta', { requestId, delta: text, accumulatedLength: stdoutBuffer.length });
      });

      child.stderr.on('data', (chunk) => {
        stderrBuffer += chunk.toString('utf8');
      });

      child.on('error', (err) => {
        if (record.timer) clearTimeout(record.timer);
        this.activeProcesses.delete(requestId);
        resolve({
          outcome: 'FAILED',
          error: err.message,
          requestId
        });
      });

      child.on('close', (code, signal) => {
        if (record.timer) clearTimeout(record.timer);
        this.activeProcesses.delete(requestId);

        if (record.cancelled) {
          return resolve({
            outcome: 'CANCELLED',
            requestId,
            exitCode: null,
            signal
          });
        }

        const durationMs = Date.now() - startTime;
        
        // Extract reported usage tokens if emitted as JSON
        let reportedTokensIn = tokensIn;
        let reportedTokensOut = record.tokensOut;
        try {
          const match = stdoutBuffer.match(/\{.*"usage".*\}/);
          if (match) {
            const parsed = JSON.parse(match[0]);
            if (parsed.usage) {
              reportedTokensIn = parsed.usage.prompt_tokens || parsed.usage.input_tokens || tokensIn;
              reportedTokensOut = parsed.usage.completion_tokens || parsed.usage.output_tokens || record.tokensOut;
            }
          }
        } catch  {
      // swallow-ok: intentional non-fatal error suppression
    }

        const usage = {
          tokensIn: reportedTokensIn,
          tokensOut: reportedTokensOut,
          durationMs,
          exitCode: code
        };
        this.usageRecords.set(requestId, usage);

        if (code === 0) {
          resolve({
            outcome: 'DELIVERED_CONFIRMED',
            requestId,
            response: stdoutBuffer.trim(),
            completionConfidence: 'EXPLICIT_END_OF_TURN',
            evidence: CompletionEvidenceTier.PROCESS_EXIT,
            durationMs,
            usage
          });
        } else {
          resolve({
            outcome: 'FAILED',
            requestId,
            exitCode: code,
            error: stderrBuffer.trim() || `CLI exited with code ${code}`,
            usage
          });
        }
      });

      if (this.inputMode === 'stdin' && prompt) {
        child.stdin.write(prompt);
        child.stdin.end();
      }
    });
  }

  /**
   * Observe stream events.
   */
  observe(callbacks = {}) {
    return callbacks;
  }

  /**
   * Cancel in-flight CLI task by terminating process tree.
   * Deterministic synchronous resolution, no retry loops.
   */
  async cancel(requestId) {
    const record = this.activeProcesses.get(requestId);
    if (!record) return { cancelled: false, reason: 'Request not found or already completed' };

    record.cancelled = true;
    if (record.timer) clearTimeout(record.timer);

    const pid = record.pid;
    if (pid) {
      const killGroup = (sig) => {
        try {
          if (process.platform !== 'win32') {
            process.kill(-pid, sig);
          } else {
            process.kill(pid, sig);
          }
        } catch {
          try {
            if (record.child && !record.child.killed) record.child.kill(sig);
          } catch  {
      // swallow-ok: process or file cleanup
    }
        }
      };

      killGroup('SIGTERM');
      setTimeout(() => {
        killGroup('SIGKILL');
      }, 200).unref();
    } else if (record.child) {
      try { record.child.kill('SIGTERM'); } catch  {
      // swallow-ok: process or file cleanup
    }
    }

    if (record.resolve) {
      record.resolve({
        outcome: 'CANCELLED',
        requestId,
        exitCode: null,
        signal: 'SIGTERM'
      });
      this.activeProcesses.delete(requestId);
    }

    return {
      cancelled: true,
      requestId,
      pid: record.pid
    };
  }

  /**
   * Retrieve captured usage stats for a request.
   */
  usage(requestId) {
    return this.usageRecords.get(requestId) || null;
  }
}
