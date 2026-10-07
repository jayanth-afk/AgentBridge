import { spawn } from 'node:child_process';
import { SwiftAXBridge } from './swift-ax-bridge.js';

export class PersistentSwiftAXBridge extends SwiftAXBridge {
  constructor(options = {}) {
    super(options);
    this.workerProcess = null;
    this.workerBuffer = '';
    this.workerQueue = Promise.resolve();
  }

  ensureWorker() {
    if (this.workerProcess && !this.workerProcess.killed) return this.workerProcess;
    const child = spawn(this.binaryPath, ['--daemon'], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    child.stdout.setEncoding('utf8');
    child.stderr.resume();
    child.on('exit', () => {
      if (this.workerProcess === child) this.workerProcess = null;
    });
    this.workerProcess = child;
    return child;
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
        try { child.kill('SIGTERM'); } catch {}
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
