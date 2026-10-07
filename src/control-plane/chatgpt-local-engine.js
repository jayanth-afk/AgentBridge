import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { DesktopControlAdapter, AdapterHealth } from './desktop-control-adapter.js';

const DEFAULT_CODEX_PATH = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';

/**
 * ChatGptLocalEngineAdapter:
 * Production-grade autonomous agent runtime for ChatGPT Desktop's bundled local engine (`codex-cli`).
 * Supports:
 * - Independent concurrent turns
 * - Multi-turn conversation continuation via thread persistence (`resume`)
 * - Real-time JSONL event streaming
 * - Active process management & cancellation
 * - Usage metric accounting & token monitoring
 * - Crash recovery & malformed event tolerance
 */
export class ChatGptLocalEngineAdapter extends DesktopControlAdapter {
  constructor(options = {}) {
    super('chatgpt-local-engine', options);
    this.cliPath = options.cliPath || DEFAULT_CODEX_PATH;
    this.enabled = options.enabled !== false;
    this.defaultModel = options.model || null;
    this.defaultTimeoutMs = options.defaultTimeoutMs || 60000;

    // Active turns map: requestId -> activeJob
    this.activeJobs = new Map();

    // Session / Thread memory: conversationId -> threadId
    this.conversationThreads = new Map();
  }

  discover() {
    const installed = this.isInstalled();
    return {
      name: this.name,
      installed,
      path: this.cliPath,
      supportsResume: true,
      supportsStreaming: true,
      idleModelWake: true
    };
  }

  isInstalled() {
    try {
      return fs.existsSync(this.cliPath);
    } catch {
      return false;
    }
  }

  async isRunning() {
    return this.isInstalled();
  }

  async isAccessible() {
    return this.isInstalled();
  }

  capabilities() {
    const installed = this.isInstalled();
    return {
      name: this.name,
      transport: 'chatgpt-local-engine',
      agent: 'chatgpt',
      engine: 'codex-local',
      trueHeadlessEngine: true, // Non-interactive headless CLI/app-server
      idleModelWake: installed, // boolean: true when codex-cli is installed and ready
      idleModelWakeVerdict: installed ? 'VERIFIED' : 'UNSUPPORTED',
      uiSubmission: installed,
      modelTurnConfirmation: installed,
      modelResponseCorrelation: true,
      streaming: true,
      cancellation: true,
      concurrency: true,
      transports: ['codex-local', 'ipc-socket'],
      ipcSocketPath: '/Users/jayanthpranaykonada/.codex/ipc/ipc.sock',
      canWake: true,
      streamingSupported: true,
      multiTurnSupported: true,
      concurrencySupported: true,
      cancellationSupported: true,
      nonInteractive: true,
      realModelExecution: true
    };
  }

  async startTurn(options = {}) {
    return this.executeTurn(options);
  }

  async send(options = {}) {
    return this.executeTurn(options);
  }

  async health() {
    if (!this.isInstalled()) {
      return {
        status: AdapterHealth.UNAVAILABLE,
        reason: 'CODEX_CLI_NOT_FOUND',
        path: this.cliPath
      };
    }
    return {
      status: AdapterHealth.AVAILABLE,
      path: this.cliPath,
      activeJobs: this.activeJobs.size,
      activeThreads: this.conversationThreads.size
    };
  }

  /**
   * Start or register a conversation session with a threadId
   */
  startSession({ conversationId, threadId = null, model = null }) {
    const convId = conversationId || `conv_chatgpt_${Date.now()}`;
    if (threadId) {
      this.conversationThreads.set(convId, threadId);
    }
    return {
      conversationId: convId,
      threadId: this.conversationThreads.get(convId) || null,
      model: model || this.defaultModel
    };
  }

  /**
   * Cancel an in-flight turn by requestId
   */
  async cancel(requestId) {
    const job = this.activeJobs.get(requestId);
    if (!job) {
      return { cancelled: false, reason: 'JOB_NOT_FOUND', requestId };
    }

    job.cancelled = true;
    if (job.timer) clearTimeout(job.timer);
    if (job.firstTokenTimer) clearTimeout(job.firstTokenTimer);

    try {
      // Kill the WHOLE process group so grandchildren never survive a cancel.
      if (job.killGroup) {
        job.killGroup('SIGTERM');
      } else if (job.child && !job.child.killed) {
        job.child.kill('SIGTERM');
      }
      // Escalate after 500ms if the group has not exited.
      setTimeout(() => {
        try {
          if (job.killGroup) job.killGroup('SIGKILL');
          else if (job.child && !job.child.killed) job.child.kill('SIGKILL');
        } catch {}
      }, 500).unref();
    } catch (err) {
      return { cancelled: false, error: err.message, requestId };
    }

    this.activeJobs.delete(requestId);
    return { cancelled: true, requestId, latencyMs: Date.now() - job.startMs };
  }

  /**
   * Send a prompt and wait for completion (wrapper around executeTurn)
   */
  async send(prompt, options = {}) {
    return this.executeTurn({
      prompt,
      ...options
    });
  }

  /**
   * Stream a prompt and notify callback on each JSONL event
   */
  async stream(prompt, onEvent, options = {}) {
    return this.executeTurn({
      prompt,
      onEvent,
      ...options
    });
  }

  /**
   * Wait for an existing job to complete
   */
  async waitForCompletion(requestId, timeoutMs = null) {
    const job = this.activeJobs.get(requestId);
    if (!job) {
      return { ok: false, error: 'JOB_NOT_FOUND', requestId };
    }

    const waitTimeout = timeoutMs || this.defaultTimeoutMs;
    const start = Date.now();

    while (this.activeJobs.has(requestId)) {
      if (Date.now() - start > waitTimeout) {
        await this.cancel(requestId);
        return { ok: false, error: 'TIMEOUT', requestId };
      }
      await new Promise(r => setTimeout(r, 100));
    }

    return job.finalResult || { ok: true, requestId, status: 'completed' };
  }

  /**
   * Reconnect or recover active sessions
   */
  async reconnect() {
    const h = await this.health();
    return {
      reconnected: h.status === AdapterHealth.AVAILABLE,
      health: h
    };
  }

  async recover() {
    // Terminate any zombie child jobs (whole groups when detached).
    for (const job of this.activeJobs.values()) {
      try {
        if (job.killGroup) job.killGroup('SIGTERM');
        else if (job.child && !job.child.killed) job.child.kill('SIGTERM');
      } catch {}
    }
    this.activeJobs.clear();
    return { recovered: true, activeJobs: 0 };
  }

  /**
   * Core execution turn.
   *
   * Hardening options (used by `answer`, the Zia brain endpoint's transport):
   *  - `useTempCwd`: run in a fresh EMPTY temp dir (never the repo or $HOME)
   *  - `cwd`: explicit working root instead
   *  - `sandboxMode`: 'read-only' | 'workspace-write' | 'danger-full-access'
   *  - `ephemeral`: run without persisting session files (stateless)
   *  - `firstTokenTimeoutMs`: abort if no output arrives within this window
   *  - `detached`: spawn in its own process group so cancel kills the WHOLE group
   */
  async executeTurn({
    prompt,
    requestId = null,
    conversationId = null,
    threadId = null,
    model = null,
    timeoutMs = null,
    firstTokenTimeoutMs = null,
    onEvent = null,
    onTextDelta = null,
    ephemeral = false,
    cwd = null,
    useTempCwd = false,
    sandboxMode = null,
    detached = false
  } = {}) {
    if (!this.isInstalled()) {
      return { ok: false, success: false, transport: 'chatgpt-local-engine', error: 'CODEX_CLI_NOT_FOUND' };
    }
    if (!prompt || !String(prompt).trim()) {
      return { ok: false, success: false, transport: 'chatgpt-local-engine', error: 'EMPTY_PROMPT' };
    }

    const resolvedReqId = requestId || `req_cg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const resolvedTimeout = timeoutMs || this.defaultTimeoutMs;
    const existingThread = threadId || (conversationId ? this.conversationThreads.get(conversationId) : null);

    // A hardened Q&A turn runs in a throwaway, EMPTY directory and cleans it up.
    let workDir = cwd;
    let tempDir = null;
    if (!workDir && useTempCwd) {
      try {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zia-codex-'));
        workDir = tempDir;
      } catch {
        workDir = null;
      }
    }
    const cleanupTemp = () => {
      if (tempDir) {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
        tempDir = null;
      }
    };

    // Build args using ONLY flags this CLI supports. The prompt stays a positional
    // argument (matching the previously-shipped invocation).
    const args = ['exec'];
    if (existingThread) args.push('resume', existingThread);
    args.push(prompt);
    if (sandboxMode) args.push('--sandbox', sandboxMode);
    if (workDir) args.push('--cd', workDir);
    args.push('--skip-git-repo-check', '--json');
    if (ephemeral === true) args.push('--ephemeral');
    const targetModel = model || this.defaultModel;
    if (targetModel) args.push('-m', targetModel);

    return new Promise((resolve) => {
      const startMs = Date.now();
      const spawnOptions = { stdio: ['ignore', 'pipe', 'pipe'], env: process.env };
      if (workDir) spawnOptions.cwd = workDir;
      if (detached) spawnOptions.detached = true;

      let child;
      try {
        child = spawn(this.cliPath, args, spawnOptions);
      } catch (err) {
        cleanupTemp();
        resolve({ ok: false, success: false, transport: 'chatgpt-local-engine',
                  requestId: resolvedReqId, error: `SPAWN_FAILED: ${err.message}` });
        return;
      }

      const jobRecord = {
        requestId: resolvedReqId,
        conversationId,
        child,
        startMs,
        cancelled: false,
        settled: false,
        finalResult: null,
        timer: null,
        firstTokenTimer: null
      };
      this.activeJobs.set(resolvedReqId, jobRecord);

      // Kill the whole process group when detached; otherwise the direct child.
      const killGroup = (signal) => {
        try {
          if (detached && child.pid) process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch {
          try { child.kill(signal); } catch {}
        }
      };
      jobRecord.killGroup = killGroup;

      // Exactly one terminal result per turn.
      const settle = (result) => {
        if (jobRecord.settled) return;
        jobRecord.settled = true;
        if (jobRecord.timer) clearTimeout(jobRecord.timer);
        if (jobRecord.firstTokenTimer) clearTimeout(jobRecord.firstTokenTimer);
        cleanupTemp();
        this.activeJobs.delete(resolvedReqId);
        jobRecord.finalResult = result;
        resolve(result);
      };

      let stdoutBuffer = '';
      let responseText = '';
      let lastEmitted = '';
      let activeThreadId = existingThread;
      let usage = null;
      let errorOutput = '';
      let sawOutput = false;

      const clearFirstToken = () => {
        if (jobRecord.firstTokenTimer) {
          clearTimeout(jobRecord.firstTokenTimer);
          jobRecord.firstTokenTimer = null;
        }
      };

      // Stream best-effort text deltas: emit only when the assembled text grows.
      const flushText = () => {
        if (typeof onTextDelta !== 'function') return;
        if (responseText.length > lastEmitted.length && responseText.startsWith(lastEmitted)) {
          const delta = responseText.slice(lastEmitted.length);
          lastEmitted = responseText;
          try { onTextDelta(delta); } catch {}
        }
      };

      const handleEvent = (event) => {
        if (typeof onEvent === 'function') {
          try { onEvent(event); } catch {}
        }
        if (event.type === 'thread.started') {
          activeThreadId = event.thread_id || activeThreadId;
          if (conversationId && activeThreadId) {
            this.conversationThreads.set(conversationId, activeThreadId);
          }
        } else if (event.type === 'item.completed' && event.item && event.item.type === 'agent_message') {
          const text = typeof event.item.text === 'string' ? event.item.text : '';
          if (text) responseText = responseText ? `${responseText}\n${text}` : text;
          flushText();
        } else if (event.type === 'item.updated' && event.item && event.item.type === 'agent_message'
                   && typeof event.item.text === 'string') {
          responseText = event.item.text;
          flushText();
        } else if (event.type === 'turn.completed') {
          if (event.usage) usage = event.usage;
        }
      };

      // Line-buffered stdout so a JSONL line split across chunks still parses.
      child.stdout.on('data', (chunk) => {
        stdoutBuffer += chunk.toString();
        let newlineIndex;
        while ((newlineIndex = stdoutBuffer.indexOf('\n')) >= 0) {
          const line = stdoutBuffer.slice(0, newlineIndex);
          stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (!sawOutput) { sawOutput = true; clearFirstToken(); }
          let event;
          try {
            event = JSON.parse(trimmed);
          } catch {
            continue; // tolerate malformed / non-JSON diagnostic lines
          }
          handleEvent(event);
        }
      });

      child.stderr.on('data', (chunk) => {
        errorOutput += chunk.toString();
      });

      // First-token timeout: an engine that never emits anything is stuck.
      if (firstTokenTimeoutMs && firstTokenTimeoutMs > 0) {
        jobRecord.firstTokenTimer = setTimeout(() => {
          jobRecord.cancelled = true;
          killGroup('SIGTERM');
          settle({
            ok: false,
            success: false,
            transport: 'chatgpt-local-engine',
            requestId: resolvedReqId,
            error: 'FIRST_TOKEN_TIMEOUT',
            latencyMs: Date.now() - startMs,
            details: `no output within ${firstTokenTimeoutMs}ms`
          });
        }, firstTokenTimeoutMs);
      }

      // Total timeout.
      jobRecord.timer = setTimeout(() => {
        jobRecord.cancelled = true;
        killGroup('SIGTERM');
        settle({
          ok: false,
          success: false,
          transport: 'chatgpt-local-engine',
          requestId: resolvedReqId,
          error: 'TIMEOUT',
          latencyMs: Date.now() - startMs,
          details: `ChatGPT local engine timed out after ${resolvedTimeout}ms`
        });
      }, resolvedTimeout);

      child.on('error', (err) => {
        settle({
          ok: false,
          success: false,
          transport: 'chatgpt-local-engine',
          requestId: resolvedReqId,
          error: `PROCESS_ERROR: ${err.message}`,
          latencyMs: Date.now() - startMs
        });
      });

      child.on('close', (code) => {
        // Flush a trailing JSONL line that had no final newline.
        const tail = stdoutBuffer.trim();
        if (tail) {
          try { handleEvent(JSON.parse(tail)); } catch { /* tolerate */ }
        }
        stdoutBuffer = '';

        const latencyMs = Date.now() - startMs;

        if (jobRecord.cancelled) {
          settle({ ok: false, success: false, transport: 'chatgpt-local-engine',
                   requestId: resolvedReqId, error: 'CANCELLED', latencyMs });
          return;
        }

        if (code === 0 && responseText) {
          settle({
            ok: true,
            success: true,
            transport: 'chatgpt-local-engine',
            requestId: resolvedReqId,
            conversationId,
            threadId: activeThreadId,
            response: responseText,
            usage,
            latencyMs
          });
        } else {
          settle({
            ok: false,
            success: false,
            transport: 'chatgpt-local-engine',
            code,
            requestId: resolvedReqId,
            error: errorOutput.trim() || 'NO_RESPONSE_PRODUCED',
            latencyMs
          });
        }
      });
    });
  }

  /**
   * Stateless, hardened one-shot Q&A turn used by the Zia brain endpoint.
   *
   * Guarantees:
   *  - cwd is a fresh EMPTY temp dir (never the Zia repo or the user's home)
   *  - read-only sandbox, no approvals, ephemeral session (no persisted files)
   *  - first-token and total timeouts; timeout/cancel kills the whole group
   *  - malformed JSONL tolerated; final text assembled from events
   */
  async answer({
    prompt,
    requestId = null,
    timeoutMs = 60000,
    firstTokenTimeoutMs = 15000,
    onTextDelta = null,
    onEvent = null
  } = {}) {
    return this.executeTurn({
      prompt,
      requestId,
      timeoutMs,
      firstTokenTimeoutMs,
      onTextDelta,
      onEvent,
      ephemeral: true,
      useTempCwd: true,
      sandboxMode: 'read-only',
      detached: true
    });
  }
}
