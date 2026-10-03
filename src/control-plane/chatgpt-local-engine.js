import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { DesktopControlAdapter, AdapterHealth } from './desktop-control-adapter.js';

const DEFAULT_CODEX_PATH = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';

/**
 * ChatGptLocalEngineAdapter:
 * Integrates directly with ChatGPT Desktop's bundled local engine (`codex-cli`).
 * Capable of initiating authentic, non-interactive, streaming model turns
 * using the user's existing desktop session authorization without credential extraction.
 */
export class ChatGptLocalEngineAdapter extends DesktopControlAdapter {
  constructor(options = {}) {
    super('chatgpt-local-engine', options);
    this.cliPath = options.cliPath || DEFAULT_CODEX_PATH;
    this.enabled = options.enabled !== false; // Enabled by default if binary exists
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
      idleModelWake: true, // TRUE IDLE WAKE CONFIRMED
      streamingSupported: true,
      nonInteractive: true,
      realModelExecution: true
    };
  }

  async health() {
    if (!this.isInstalled()) {
      return { status: AdapterHealth.UNAVAILABLE, reason: 'CODEX_CLI_NOT_FOUND', path: this.cliPath };
    }
    return { status: AdapterHealth.AVAILABLE, path: this.cliPath };
  }

  /**
   * Execute an authentic model turn via the ChatGPT engine
   */
  async executeTurn({ prompt, requestId = null, model = null, timeoutMs = 45000 }) {
    if (!this.isInstalled()) {
      return { ok: false, error: 'CODEX_CLI_NOT_FOUND' };
    }

    return new Promise((resolve) => {
      const args = [
        'exec',
        prompt,
        '--skip-git-repo-check',
        '--ephemeral',
        '--json'
      ];

      if (model) {
        args.push('-m', model);
      }

      const startMs = Date.now();
      const child = spawn(this.cliPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env
      });

      let responseText = '';
      let threadId = null;
      let usage = null;
      let errorOutput = '';

      child.stdout.on('data', (chunk) => {
        const lines = chunk.toString().split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const event = JSON.parse(trimmed);
            if (event.type === 'thread.started') {
              threadId = event.thread_id;
            } else if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
              responseText = event.item.text || '';
            } else if (event.type === 'turn.completed') {
              usage = event.usage;
            }
          } catch {}
        }
      });

      child.stderr.on('data', (chunk) => {
        errorOutput += chunk.toString();
      });

      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        resolve({
          ok: false,
          error: 'TIMEOUT',
          latencyMs: Date.now() - startMs,
          details: `ChatGPT local engine timed out after ${timeoutMs}ms`
        });
      }, timeoutMs);

      child.on('close', (code) => {
        clearTimeout(timer);
        const latencyMs = Date.now() - startMs;
        if (code === 0 && responseText) {
          resolve({
            ok: true,
            success: true,
            transport: 'chatgpt-local-engine',
            requestId,
            threadId,
            response: responseText,
            usage,
            latencyMs
          });
        } else {
          resolve({
            ok: false,
            success: false,
            transport: 'chatgpt-local-engine',
            code,
            error: errorOutput || 'NO_RESPONSE_PRODUCED',
            latencyMs
          });
        }
      });
    });
  }
}
