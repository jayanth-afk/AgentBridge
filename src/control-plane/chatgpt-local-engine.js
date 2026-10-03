import { spawn } from 'node:child_process';
import fs from 'node:fs';
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
    return {
      name: this.name,
      transport: 'chatgpt-local-engine',
      canWake: true,
      idleModelWake: true, // Authentic idle turn initiation
      streamingSupported: true,
      multiTurnSupported: true,
      concurrencySupported: true,
      cancellationSupported: true,
      nonInteractive: true,
      realModelExecution: true
    };
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

    try {
      if (job.child && !job.child.killed) {
        job.child.kill('SIGTERM');
        // Fallback kill after 500ms if not exited
        setTimeout(() => {
          try {
            if (job.child && !job.child.killed) job.child.kill('SIGKILL');
          } catch {}
        }, 500).unref();
      }
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
    // Terminate any zombie child jobs
    for (const [reqId, job] of this.activeJobs.entries()) {
      try {
        if (job.child && !job.child.killed) job.child.kill('SIGTERM');
      } catch {}
    }
    this.activeJobs.clear();
    return { recovered: true, activeJobs: 0 };
  }

  /**
   * Core execution turn
   */
  async executeTurn({
    prompt,
    requestId = null,
    conversationId = null,
    threadId = null,
    model = null,
    timeoutMs = null,
    onEvent = null,
    ephemeral = false
  }) {
    if (!this.isInstalled()) {
      return { ok: false, error: 'CODEX_CLI_NOT_FOUND' };
    }

    const resolvedReqId = requestId || `req_cg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const resolvedTimeout = timeoutMs || this.defaultTimeoutMs;
    const existingThread = threadId || (conversationId ? this.conversationThreads.get(conversationId) : null);

    let args = [];
    const isEphemeral = ephemeral === true;

    if (existingThread) {
      // Resume existing thread
      args = ['exec', 'resume', existingThread, prompt, '--skip-git-repo-check', '--json'];
    } else {
      // Start fresh thread
      args = ['exec', prompt, '--skip-git-repo-check', '--json'];
      if (isEphemeral) {
        args.push('--ephemeral');
      }
    }

    const targetModel = model || this.defaultModel;
    if (targetModel) {
      args.push('-m', targetModel);
    }

    return new Promise((resolve) => {
      const startMs = Date.now();
      const child = spawn(this.cliPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env
      });

      const jobRecord = {
        requestId: resolvedReqId,
        conversationId,
        child,
        startMs,
        cancelled: false,
        finalResult: null,
        timer: null
      };

      this.activeJobs.set(resolvedReqId, jobRecord);

      let responseText = '';
      let activeThreadId = existingThread;
      let usage = null;
      let errorOutput = '';

      child.stdout.on('data', (chunk) => {
        const lines = chunk.toString().split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const event = JSON.parse(trimmed);
            if (typeof onEvent === 'function') {
              try { onEvent(event); } catch {}
            }

            if (event.type === 'thread.started') {
              activeThreadId = event.thread_id;
              if (conversationId && activeThreadId) {
                this.conversationThreads.set(conversationId, activeThreadId);
              }
            } else if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
              responseText = event.item.text || '';
            } else if (event.type === 'turn.completed') {
              usage = event.usage;
            }
          } catch {
            // Tolerate non-JSON diagnostic lines
          }
        }
      });

      child.stderr.on('data', (chunk) => {
        errorOutput += chunk.toString();
      });

      const timer = setTimeout(() => {
        jobRecord.cancelled = true;
        try { child.kill('SIGTERM'); } catch {}
        const latencyMs = Date.now() - startMs;
        const result = {
          ok: false,
          success: false,
          error: 'TIMEOUT',
          requestId: resolvedReqId,
          latencyMs,
          details: `ChatGPT local engine timed out after ${resolvedTimeout}ms`
        };
        jobRecord.finalResult = result;
        this.activeJobs.delete(resolvedReqId);
        resolve(result);
      }, resolvedTimeout);

      jobRecord.timer = timer;

      child.on('close', (code) => {
        clearTimeout(timer);
        this.activeJobs.delete(resolvedReqId);
        const latencyMs = Date.now() - startMs;

        if (jobRecord.cancelled) {
          const result = {
            ok: false,
            success: false,
            error: 'CANCELLED',
            requestId: resolvedReqId,
            latencyMs
          };
          jobRecord.finalResult = result;
          resolve(result);
          return;
        }

        if (code === 0 && responseText) {
          const result = {
            ok: true,
            success: true,
            transport: 'chatgpt-local-engine',
            requestId: resolvedReqId,
            conversationId,
            threadId: activeThreadId,
            response: responseText,
            usage,
            latencyMs
          };
          jobRecord.finalResult = result;
          resolve(result);
        } else {
          const result = {
            ok: false,
            success: false,
            transport: 'chatgpt-local-engine',
            code,
            requestId: resolvedReqId,
            error: errorOutput.trim() || 'NO_RESPONSE_PRODUCED',
            latencyMs
          };
          jobRecord.finalResult = result;
          resolve(result);
        }
      });
    });
  }
}
