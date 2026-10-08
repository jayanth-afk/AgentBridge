import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import EventEmitter from 'node:events';
import { CONFIG } from '../config.js';

export class WorkerSupervisor extends EventEmitter {
  constructor(options = {}) {
    super();
    this.bridgeRoot = options.bridgeRoot || CONFIG.BRIDGE_ROOT;
    this.dataDir = options.dataDir || CONFIG.DATA_DIR;
    this.pidsDir = path.join(this.dataDir, 'pids');
    this.logsDir = path.join(this.dataDir, 'logs');
    this.dbPath = options.dbPath || CONFIG.DB_PATH;
    this.maxRestarts = options.maxRestarts || 5;

    this.workerScripts = {
      'antigravity-ide': path.join(this.bridgeRoot, 'bin', 'antigravity-agent-worker.js'),
      'claude-desktop': path.join(this.bridgeRoot, 'bin', 'claude-agent-worker.js'),
      'chatgpt-desktop': path.join(this.bridgeRoot, 'bin', 'chatgpt-agent-worker.js'),
      'gemini': path.join(this.bridgeRoot, 'bin', 'gemini-agent-worker.js')
    };

    // In-memory process registry: agentId -> workerState
    this.workers = new Map();
    this.stopping = new Set();

    this.ensureDirs();
  }

  ensureDirs() {
    if (!fs.existsSync(this.pidsDir)) {
      fs.mkdirSync(this.pidsDir, { recursive: true });
    }
    if (!fs.existsSync(this.logsDir)) {
      fs.mkdirSync(this.logsDir, { recursive: true });
    }
  }

  getPidFilePath(agentId) {
    return path.join(this.pidsDir, `${agentId}.pid`);
  }

  getLogFilePath(agentId) {
    return path.join(this.logsDir, `${agentId}-worker.log`);
  }

  isProcessAlive(pid) {
    if (!pid || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  isWorkerRunning(agentId) {
    // 1. Check in-memory child
    const inMem = this.workers.get(agentId);
    if (inMem?.child && !inMem.child.killed && this.isProcessAlive(inMem.child.pid)) {
      return { running: true, pid: inMem.child.pid, managed: true };
    }

    // 2. Check pid file on disk
    const pidFile = this.getPidFilePath(agentId);
    if (fs.existsSync(pidFile)) {
      try {
        const raw = fs.readFileSync(pidFile, 'utf8').trim();
        const pid = parseInt(raw, 10);
        if (pid > 0 && this.isProcessAlive(pid)) {
          return { running: true, pid, managed: false };
        } else {
          // Stale PID file
          try { fs.unlinkSync(pidFile); } catch {}
        }
      } catch {}
    }

    return { running: false, pid: null, managed: false };
  }

  async startWorker(agentId, options = {}) {
    const scriptPath = this.workerScripts[agentId];
    if (!scriptPath || !fs.existsSync(scriptPath)) {
      throw new Error(`No worker script found for agent '${agentId}' at: ${scriptPath}`);
    }

    // Duplicate worker prevention
    const current = this.isWorkerRunning(agentId);
    if (current.running) {
      return {
        started: false,
        alreadyRunning: true,
        agentId,
        pid: current.pid
      };
    }

    this.stopping.delete(agentId);
    const logFile = this.getLogFilePath(agentId);
    const logFd = fs.openSync(logFile, 'a');

    const spawnArgs = [scriptPath];
    if (options.db || this.dbPath) {
      spawnArgs.push('--db', options.db || this.dbPath);
    }
    if (options.once) {
      spawnArgs.push('--once');
    }

    const env = {
      ...process.env,
      AGENT_ID: agentId,
      NODE_NO_WARNINGS: '1'
    };

    const detached = Boolean(options.detached);
    const child = spawn(process.execPath, spawnArgs, {
      cwd: this.bridgeRoot,
      env,
      stdio: ['ignore', logFd, logFd],
      detached
    });
    if (detached) {
      child.unref();
    }

    const pid = child.pid;
    fs.writeFileSync(this.getPidFilePath(agentId), String(pid));

    const workerState = {
      agentId,
      child,
      pid,
      logFile,
      startedAt: Date.now(),
      restarts: (this.workers.get(agentId)?.restarts || 0)
    };

    this.workers.set(agentId, workerState);

    child.on('exit', (code, signal) => {
      try { fs.closeSync(logFd); } catch {}
      this.handleWorkerExit(agentId, pid, code, signal, options);
    });

    this.emit('workerStarted', { agentId, pid });

    return {
      started: true,
      alreadyRunning: false,
      agentId,
      pid
    };
  }

  handleWorkerExit(agentId, pid, code, signal, options = {}) {
    // Clean up pid file if it matches
    const pidFile = this.getPidFilePath(agentId);
    try {
      if (fs.existsSync(pidFile)) {
        const recorded = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
        if (recorded === pid) {
          fs.unlinkSync(pidFile);
        }
      }
    } catch {}

    const workerState = this.workers.get(agentId);
    if (this.stopping.has(agentId) || options.once) {
      // Intentional stop or one-shot execution
      this.workers.delete(agentId);
      this.stopping.delete(agentId);
      this.emit('workerStopped', { agentId, pid, code, signal });
      return;
    }

    // Unintentional crash: auto-restart with backoff
    const restarts = (workerState?.restarts || 0) + 1;
    this.emit('workerCrashed', { agentId, pid, code, signal, restarts });

    if (restarts <= this.maxRestarts) {
      const backoffMs = Math.min(restarts * 500, 5000);
      setTimeout(() => {
        if (!this.stopping.has(agentId)) {
          this.startWorker(agentId, options)
            .then(res => {
              if (this.workers.has(agentId)) {
                this.workers.get(agentId).restarts = restarts;
              }
            })
            .catch(err => {
              this.emit('error', new Error(`Failed to restart worker [${agentId}]: ${err.message}`));
            });
        }
      }, backoffMs).unref?.();
    } else {
      const err = new Error(`Worker [${agentId}] exceeded maximum restarts (${this.maxRestarts}).`);
      if (this.listenerCount('error') > 0) {
        this.emit('error', err);
      } else {
        console.error(`[WorkerSupervisor] ${err.message}`);
      }
    }
  }

  async stopWorker(agentId, timeoutMs = 3000) {
    this.stopping.add(agentId);
    const inMem = this.workers.get(agentId);
    let targetPid = inMem?.child?.pid;

    if (!targetPid) {
      const status = this.isWorkerRunning(agentId);
      if (status.running) targetPid = status.pid;
    }

    if (!targetPid) {
      this.stopping.delete(agentId);
      return { stopped: false, notRunning: true, agentId };
    }

    try {
      process.kill(targetPid, 'SIGTERM');
    } catch {}

    // Wait for exit
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (!this.isProcessAlive(targetPid)) break;
      await new Promise(r => setTimeout(r, 100));
    }

    // Force kill if still alive
    if (this.isProcessAlive(targetPid)) {
      try { process.kill(targetPid, 'SIGKILL'); } catch {}
      await new Promise(r => setTimeout(r, 100));
    }

    // Clean up pid file
    try {
      const pidFile = this.getPidFilePath(agentId);
      if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
    } catch {}

    this.workers.delete(agentId);
    this.stopping.delete(agentId);
    this.emit('workerStopped', { agentId, pid: targetPid });

    return { stopped: true, agentId, pid: targetPid };
  }

  async restartWorker(agentId, options = {}) {
    await this.stopWorker(agentId);
    return await this.startWorker(agentId, options);
  }

  async startAll(options = {}) {
    const agents = Object.keys(this.workerScripts);
    const results = {};
    for (const agentId of agents) {
      results[agentId] = await this.startWorker(agentId, options);
    }
    return results;
  }

  async stopAll(timeoutMs = 3000) {
    const agents = Object.keys(this.workerScripts);
    const results = {};
    for (const agentId of agents) {
      results[agentId] = await this.stopWorker(agentId, timeoutMs);
    }
    return results;
  }

  status() {
    const agents = Object.keys(this.workerScripts);
    const result = {};
    for (const agentId of agents) {
      const state = this.isWorkerRunning(agentId);
      result[agentId] = {
        agentId,
        running: state.running,
        pid: state.pid,
        logFile: this.getLogFilePath(agentId)
      };
    }
    return result;
  }
}
