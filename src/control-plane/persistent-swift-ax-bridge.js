import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { SwiftAXBridge } from './swift-ax-bridge.js';
import { getScrubbedEnv } from '../utils/scrubbed-env.js';
import { CONFIG } from '../config.js';

export class PersistentSwiftAXBridge extends SwiftAXBridge {
  constructor(options = {}) {
    super(options);
    this.workerProcess = null;
    this.workerBuffer = '';
    this.workerQueue = Promise.resolve();
    this.pidFilePath = options.pidFilePath || path.join(CONFIG.DATA_DIR, 'bridge-ax-daemon.json');

    this._exitHandler = () => this.close();
    process.once('exit', this._exitHandler);
  }

  reapPreviousDaemon() {
    try {
      if (!fs.existsSync(this.pidFilePath)) return;
      const raw = fs.readFileSync(this.pidFilePath, 'utf8');
      const record = JSON.parse(raw);
      if (!record || !record.pid) return;

      if (record.pid === process.pid) return;

      try {
        process.kill(record.pid, 0);
      } catch {
        try { fs.unlinkSync(this.pidFilePath); } catch {}
        return;
      }

      let cmdLine = '';
      try {
        cmdLine = execFileSync('ps', ['-p', String(record.pid), '-o', 'command='], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore']
        }).trim();
      } catch {
        return;
      }

      const binaryName = path.basename(record.binaryPath || this.binaryPath);
      if (cmdLine.includes(binaryName) || (record.binaryPath && cmdLine.includes(record.binaryPath))) {
        try {
          process.kill(record.pid, 'SIGTERM');
        } catch {}
      }
      try { fs.unlinkSync(this.pidFilePath); } catch {}
    } catch {}
  }

  ensureWorker() {
    if (this.workerProcess && !this.workerProcess.killed) return this.workerProcess;

    this.reapPreviousDaemon();

    const child = spawn(this.binaryPath, ['--daemon'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: getScrubbedEnv()
    });
    if (typeof child.unref === 'function') {
      child.unref();
    }
    // `child.unref()` detaches only the PROCESS handle. The three stdio pipes stay
    // referenced and keep the event loop alive, so any process that starts the
    // daemon cannot exit on its own, and each such process leaks a running helper.
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      if (stream && typeof stream.unref === 'function') {
        try { stream.unref(); } catch  {
          // swallow-ok: intentional non-fatal error suppression
        }
      }
    }
    child.stdout.setEncoding('utf8');
    child.stderr.resume();
    child.on('exit', () => {
      if (this.workerProcess === child) {
        this.workerProcess = null;
        try {
          if (fs.existsSync(this.pidFilePath)) {
            const raw = fs.readFileSync(this.pidFilePath, 'utf8');
            const rec = JSON.parse(raw);
            if (rec && rec.pid === child.pid) {
              fs.unlinkSync(this.pidFilePath);
            }
          }
        } catch {}
      }
    });

    this.workerProcess = child;

    try {
      fs.mkdirSync(path.dirname(this.pidFilePath), { recursive: true });
      fs.writeFileSync(this.pidFilePath, JSON.stringify({
        pid: child.pid,
        binaryPath: this.binaryPath,
        startedAt: Date.now()
      }, null, 2), { mode: 0o600 });
    } catch {}

    return child;
  }

  close() {
    if (this._exitHandler) {
      process.removeListener('exit', this._exitHandler);
      this._exitHandler = null;
    }
    if (this.workerProcess && !this.workerProcess.killed) {
      const pidToKill = this.workerProcess.pid;
      try { this.workerProcess.kill('SIGTERM'); } catch  {
        // swallow-ok: best-effort disposal cleanup
      }
      this.workerProcess = null;
      try {
        if (fs.existsSync(this.pidFilePath)) {
          const raw = fs.readFileSync(this.pidFilePath, 'utf8');
          const rec = JSON.parse(raw);
          if (rec && rec.pid === pidToKill) {
            fs.unlinkSync(this.pidFilePath);
          }
        }
      } catch {}
    }
  }

  executeOp(opObj) {
    const timeoutMs = (opObj.timeoutMs || 4000) + 2000;
    this.workerQueue = this.workerQueue.catch(() => {}).then(() => new Promise((resolve, reject) => {
      const child = this.ensureWorker();
      let settled = false;
      let timer;
      let onExit, onError, onData;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stdout.removeListener('data', onData);
        if (onExit) child.removeListener('exit', onExit);
        if (onError) child.removeListener('error', onError);
        fn(value);
      };
      onExit = () => finish(reject, new Error('SWIFT_WORKER_EXITED'));
      onError = (err) => finish(reject, err);
      child.once('exit', onExit);
      child.once('error', onError);

      onData = chunk => {
        this.workerBuffer += chunk;
        const lines = this.workerBuffer.split('\n');
        this.workerBuffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            finish(resolve, JSON.parse(trimmed));
          } catch {
            finish(resolve, { ok: false, error: 'INVALID_HELPER_RESPONSE' });
          }
          return;
        }
      };
      timer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch  {
      // swallow-ok: safe fallback for plaintext or non-JSON input
    }
        finish(reject, new Error('SWIFT_WORKER_TIMEOUT'));
      }, timeoutMs);
      child.stdout.on('data', onData);
      child.stdin.write(JSON.stringify(opObj) + '\n', error => {
        if (error) finish(reject, error);
      });
    }));
    return this.workerQueue;
  }
}
