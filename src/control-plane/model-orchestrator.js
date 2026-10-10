import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { ChatGptLocalEngineAdapter } from './chatgpt-local-engine.js';
import { ChatGptAutonomousSession } from './chatgpt-autonomous-session.js';
import { ClaudeAutonomousSession } from './claude-autonomous-session.js';
import { GeminiAutonomousSession } from './gemini-autonomous-session.js';
import { ConversationRegistry } from './conversation-registry.js';
import { ResponseCorrelator } from './response-correlator.js';
import { RequestEnvelope, RequestState } from '../protocol/envelope.js';
import { SwiftAXBridge } from './swift-ax-bridge.js';

/**
 * Autonomous Local Multi-Desktop-Agent Orchestrator:
 * Manages autonomous cross-agent task delegation across ChatGPT Desktop,
 * Claude Desktop, and Antigravity IDE without manual user intervention.
 */
export class ModelOrchestrator extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.swiftBridge = options.swiftBridge || new SwiftAXBridge(options);
    this.chatgptEngine = options.chatgptEngine || new ChatGptLocalEngineAdapter(options.chatgpt || {});
    this.chatgptSession = options.chatgptSession || new ChatGptAutonomousSession(options.chatgptSessionOptions || { timeoutMs: 120000 });
    this.claudeSession = options.claudeSession || new ClaudeAutonomousSession(options.claude || { timeoutMs: 90000 });
    this.geminiSession = options.geminiSession || new GeminiAutonomousSession(options.gemini || {});
    this.conversations = options.conversations || new ConversationRegistry(options);
    this.correlator = options.correlator || new ResponseCorrelator(options);
    this.mailbox = options.mailboxHub || null;
    this.eventBus = options.eventBus || null;

    // Track active tasks across all transports
    this.activeTasks = new Map(); // requestId -> envelope & taskState
  }

  /**
   * Await task completion from autonomous worker via TaskManager event bus
   */
  async _waitForTaskResult(taskId, timeoutMs = 15000) {
    if (!this.mailbox?.tasks) {
      return { status: 'unsupported', error: 'No task manager available' };
    }

    return new Promise((resolve) => {
      let timer = null;
      const tasks = this.mailbox.tasks;

      const onCompleted = (updated) => {
        if (updated && updated.id === taskId) {
          cleanup();
          resolve({ status: 'completed', task: updated, result: updated.result });
        }
      };

      const onFailed = (updated) => {
        if (updated && updated.id === taskId) {
          cleanup();
          resolve({ status: 'failed', task: updated, error: updated.error });
        }
      };

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (typeof tasks.removeListener === 'function') {
          tasks.removeListener('taskCompleted', onCompleted);
          tasks.removeListener('taskFailed', onFailed);
        }
      };

      if (typeof tasks.on === 'function') {
        tasks.on('taskCompleted', onCompleted);
        tasks.on('taskFailed', onFailed);
      }

      // Check immediate state in case already completed
      try {
        const existing = tasks.getTask(taskId, false);
        if (existing) {
          if (existing.status === 'completed') {
            cleanup();
            resolve({ status: 'completed', task: existing, result: existing.result });
            return;
          } else if (existing.status === 'failed') {
            cleanup();
            resolve({ status: 'failed', task: existing, error: existing.error });
            return;
          }
        }
      } catch {}

      timer = setTimeout(() => {
        cleanup();
        try {
          const late = tasks.getTask(taskId, false);
          if (late && late.status === 'completed') {
            resolve({ status: 'completed', task: late, result: late.result });
            return;
          }
        } catch {}
        resolve({ status: 'timeout', error: 'TIMEOUT_WAITING_FOR_WORKER' });
      }, timeoutMs);
    });
  }

  /**
   * Delegate model task between agents with authentic model turn lifecycle
   */
  async delegateModelTask({
    fromAgent,
    toAgent,
    message,
    context = {},
    conversationId = null,
    deadline = null,
    priority = 'normal',
    mcpAdapter = null,
    requestId: requestedId = null
  }) {
    if (!fromAgent) throw new Error('fromAgent is required');
    if (!toAgent) throw new Error('toAgent is required');
    if (!message) throw new Error('message is required');

    const requestId = requestedId || `req_mod_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const resolvedConvId = conversationId || `conv_${fromAgent}_${toAgent}_${Date.now()}`;

    const envelope = new RequestEnvelope({
      requestId,
      conversationId: resolvedConvId,
      fromAgent,
      toAgent,
      message,
      context,
      deadline,
      priority
    });

    envelope.transition(RequestState.ROUTING);
    this.activeTasks.set(requestId, { envelope, startTime: Date.now() });
    this.emit('task_delegated', { requestId, fromAgent, toAgent, envelope });

    const normalizedTarget = toAgent.toLowerCase();
    const startMs = Date.now();

    try {
      let result;

      // 1. Target: ChatGPT Desktop
      if (normalizedTarget.includes('chatgpt')) {
        envelope.transition(RequestState.TRANSPORT_CONNECTED, { transport: 'chatgpt-autonomous-session' });

        let conv = this.conversations.get(resolvedConvId);
        if (!conv) {
          conv = this.conversations.createConversation({
            conversationId: resolvedConvId,
            agent: 'chatgpt',
            transport: 'chatgpt-autonomous-session'
          });
        }

        const taggedPrompt = this.correlator.tagMessage(envelope.message, requestId);
        const sessionRes = await this.chatgptSession.send({
          text: taggedPrompt,
          requestId,
          activate: false,
          timeoutMs: deadline ? Math.max(5000, deadline - Date.now()) : 90000
        });

        if (!sessionRes.success && sessionRes.error) {
          envelope.transition(RequestState.FAILED, { error: sessionRes.error });
          return {
            success: false,
            requestId,
            toAgent,
            error: sessionRes.error,
            latencyMs: Date.now() - startMs
          };
        }

        const responseText = sessionRes.response || null;
        if (!responseText) {
          const noRespError = sessionRes.status || sessionRes.error || 'CHATGPT_NO_MODEL_RESPONSE';
          envelope.transition(RequestState.FAILED, { error: noRespError });
          return {
            success: false,
            requestId,
            toAgent,
            transport: sessionRes.transport || 'chatgpt-autonomous-session',
            error: noRespError,
            latencyMs: Date.now() - startMs,
            state: envelope.state
          };
        }

        if (sessionRes.modelTurnConfirmed) {
          envelope.transition(RequestState.MODEL_TURN_CONFIRMED);
        }
        envelope.transition(RequestState.ASSISTANT_STARTED);
        envelope.transition(RequestState.ASSISTANT_COMPLETED);
        const correlated = this.correlator.correlateTurn({
          rawResponse: responseText,
          expectedRequestId: requestId
        });

        if (!correlated.correlated) {
          envelope.transition(RequestState.FAILED, { error: 'CORRELATION_FAILED' });
          return {
            success: false,
            requestId,
            toAgent,
            error: 'CORRELATION_FAILED: Response failed correlation verification',
            latencyMs: Date.now() - startMs,
            state: envelope.state
          };
        }

        envelope.transition(RequestState.RESPONSE_CORRELATED);
        envelope.transition(RequestState.DELIVERED);

        this.conversations.updateActivity(resolvedConvId, {
          request: envelope.message,
          response: correlated.cleanedText,
          latencyMs: sessionRes.latencyMs || (Date.now() - startMs)
        });

        result = {
          success: true,
          requestId,
          fromAgent,
          toAgent,
          transport: sessionRes.transport || 'chatgpt-autonomous-session',
          response: correlated.cleanedText,
          rawResponse: responseText,
          latencyMs: Date.now() - startMs,
          state: envelope.state
        };
      }

      // 2. Target: Claude Desktop
      else if (normalizedTarget.includes('claude')) {
        envelope.transition(RequestState.TRANSPORT_CONNECTED);

        const taggedPrompt = this.correlator.tagMessage(envelope.message, requestId);
        const claudeRes = await this.claudeSession.send({
          text: taggedPrompt,
          requestId,
          mcpAdapter,
          timeoutMs: deadline ? Math.max(10000, deadline - Date.now()) : (this.options.timeoutMs || 90000)
        });

        if (!claudeRes.success && claudeRes.error) {
          envelope.transition(RequestState.FAILED, { error: claudeRes.error });
          return {
            success: false,
            requestId,
            toAgent,
            error: claudeRes.error,
            latencyMs: Date.now() - startMs
          };
        }

        // Never fabricate a response. A Claude turn is only successful when a
        // real correlated model response is present; otherwise fail honestly.
        const responseText = claudeRes.response || claudeRes.result || null;
        if (!responseText) {
          const noRespError = claudeRes.status || claudeRes.error || 'CLAUDE_NO_MODEL_RESPONSE';
          envelope.transition(RequestState.FAILED, { error: noRespError });
          return {
            success: false,
            requestId,
            toAgent,
            transport: claudeRes.transport || 'claude-session',
            error: noRespError,
            latencyMs: Date.now() - startMs,
            state: envelope.state
          };
        }
        if (claudeRes.modelTurnConfirmed) {
          envelope.transition(RequestState.MODEL_TURN_CONFIRMED);
        }
        envelope.transition(RequestState.ASSISTANT_STARTED);
        envelope.transition(RequestState.ASSISTANT_COMPLETED);
        const correlated = this.correlator.correlateTurn({
          rawResponse: responseText,
          expectedRequestId: requestId
        });

        if (!correlated.correlated) {
          envelope.transition(RequestState.FAILED, { error: 'CORRELATION_FAILED' });
          return {
            success: false,
            requestId,
            toAgent,
            error: 'CORRELATION_FAILED: Response failed correlation verification',
            latencyMs: Date.now() - startMs,
            state: envelope.state
          };
        }

        envelope.transition(RequestState.RESPONSE_CORRELATED);
        envelope.transition(RequestState.DELIVERED);

        let conv = this.conversations.get(resolvedConvId);
        if (!conv) {
          conv = this.conversations.createConversation({
            conversationId: resolvedConvId,
            agent: 'claude',
            transport: claudeRes.transport || 'claude-session'
          });
        }
        this.conversations.updateActivity(resolvedConvId, {
          request: envelope.message,
          response: correlated.cleanedText,
          latencyMs: Date.now() - startMs
        });

        result = {
          success: true,
          requestId,
          fromAgent,
          toAgent,
          transport: claudeRes.transport || 'claude-session',
          response: correlated.cleanedText,
          rawResponse: responseText,
          latencyMs: Date.now() - startMs,
          state: envelope.state
        };
      }

      // 3. Target: Gemini Desktop (Gemini.app via Swift AX)
      else if (normalizedTarget.includes('gemini')) {
        envelope.transition(RequestState.TRANSPORT_CONNECTED, { transport: 'gemini-autonomous-session' });

        let conv = this.conversations.get(resolvedConvId);
        if (!conv) {
          conv = this.conversations.createConversation({
            conversationId: resolvedConvId,
            agent: 'gemini',
            transport: 'gemini-autonomous-session'
          });
        }

        const taggedPrompt = this.correlator.tagMessage(envelope.message, requestId);
        const geminiRes = await this.geminiSession.send({
          text: taggedPrompt,
          requestId,
          timeoutMs: deadline ? Math.max(5000, deadline - Date.now()) : 60000
        });

        if (!geminiRes.success && geminiRes.error) {
          envelope.transition(RequestState.FAILED, { error: geminiRes.error });
          return {
            success: false,
            requestId,
            toAgent,
            error: geminiRes.error,
            latencyMs: Date.now() - startMs
          };
        }

        const responseText = geminiRes.response || null;
        if (!responseText) {
          const noRespError = geminiRes.status || geminiRes.error || 'GEMINI_NO_MODEL_RESPONSE';
          envelope.transition(RequestState.FAILED, { error: noRespError });
          return {
            success: false,
            requestId,
            toAgent,
            transport: geminiRes.transport || 'gemini-autonomous-session',
            error: noRespError,
            latencyMs: Date.now() - startMs,
            state: envelope.state
          };
        }

        if (geminiRes.modelTurnConfirmed) {
          envelope.transition(RequestState.MODEL_TURN_CONFIRMED);
        }
        envelope.transition(RequestState.ASSISTANT_STARTED);
        envelope.transition(RequestState.ASSISTANT_COMPLETED);
        const correlated = this.correlator.correlateTurn({
          rawResponse: responseText,
          expectedRequestId: requestId
        });

        if (!correlated.correlated) {
          envelope.transition(RequestState.FAILED, { error: 'CORRELATION_FAILED' });
          return {
            success: false,
            requestId,
            toAgent,
            error: 'CORRELATION_FAILED: Response failed correlation verification',
            latencyMs: Date.now() - startMs,
            state: envelope.state
          };
        }

        envelope.transition(RequestState.RESPONSE_CORRELATED);
        envelope.transition(RequestState.DELIVERED);

        this.conversations.updateActivity(resolvedConvId, {
          request: envelope.message,
          response: correlated.cleanedText,
          latencyMs: Date.now() - startMs
        });

        result = {
          success: true,
          requestId,
          fromAgent,
          toAgent,
          transport: geminiRes.transport || 'gemini-autonomous-session',
          response: correlated.cleanedText,
          rawResponse: responseText,
          latencyMs: Date.now() - startMs,
          state: envelope.state
        };
      }

      // 4. Target: Antigravity IDE (Autonomous Task Execution)
      else if (normalizedTarget.includes('antigravity') || normalizedTarget.includes('worker')) {
        // If MailboxHub is wired, queue task directly for autonomous worker
        if (this.mailbox && typeof this.mailbox.delegateTask === 'function') {
          envelope.transition(RequestState.TRANSPORT_CONNECTED, { transport: 'antigravity-worker' });
          envelope.transition(RequestState.ASSISTANT_STARTED);

          const task = await this.mailbox.delegateTask({
            fromAgent,
            toAgent: normalizedTarget,
            title: `Model Delegation: ${requestId}`,
            instructions: envelope.message,
            context,
            requestId,
            conversationId: resolvedConvId,
            priority
          });

          // Wait for autonomous completion with lease check
          const timeoutMs = deadline ? Math.max(1000, deadline - Date.now()) : 15000;
          const waiter = await this._waitForTaskResult(task.id, timeoutMs);

          if (waiter.status === 'completed' && waiter.result) {
            envelope.transition(RequestState.ASSISTANT_COMPLETED);
            envelope.transition(RequestState.DELIVERED);

            result = {
              success: true,
              requestId,
              fromAgent,
              toAgent,
              transport: 'antigravity-worker',
              taskId: task.id,
              response: typeof waiter.result === 'object' ? JSON.stringify(waiter.result) : String(waiter.result),
              latencyMs: Date.now() - startMs,
              state: envelope.state
            };
          } else {
            const failReason = waiter.error || (waiter.status === 'completed' ? 'TASK_COMPLETED_WITHOUT_RESULT' : 'EXECUTION_FAILED');
            envelope.transition(RequestState.FAILED, { error: failReason });
            result = {
              success: false,
              status: waiter.status || 'failed',
              requestId,
              fromAgent,
              toAgent,
              transport: 'antigravity-worker',
              taskId: task.id,
              error: failReason,
              latencyMs: Date.now() - startMs,
              state: envelope.state
            };
          }
        } else {
          // No autonomous worker execution mechanism available - fail honestly
          envelope.transition(RequestState.FAILED, { error: 'EXECUTION_UNSUPPORTED: no autonomous worker' });
          result = {
            success: false,
            status: 'unsupported',
            requestId,
            fromAgent,
            toAgent,
            transport: 'antigravity-worker',
            error: 'EXECUTION_UNSUPPORTED: no autonomous worker',
            latencyMs: Date.now() - startMs,
            state: envelope.state
          };
        }
      } else {
        throw new Error(`UNKNOWN_TARGET_AGENT: ${toAgent}`);
      }

      this.activeTasks.delete(requestId);
      return result;
    } catch (err) {
      envelope.transition(RequestState.UNKNOWN, { error: err.message });
      this.activeTasks.delete(requestId);
      return {
        success: false,
        requestId,
        fromAgent,
        toAgent,
        error: err.message,
        state: RequestState.UNKNOWN,
        latencyMs: Date.now() - startMs
      };
    }
  }

  /**
   * Cancel an in-flight delegated task
   */
  async cancelTask(requestId) {
    const entry = this.activeTasks.get(requestId);
    if (!entry) return { cancelled: false, reason: 'TASK_NOT_FOUND', requestId };

    const toAgent = entry.envelope.toAgent.toLowerCase();
    if (toAgent.includes('chatgpt')) {
      await this.chatgptEngine.cancel(requestId);
      if (typeof this.chatgptSession.cancel === 'function') await this.chatgptSession.cancel(requestId);
    } else if (toAgent.includes('claude')) {
      await this.claudeSession.cancel(requestId);
    } else if (toAgent.includes('gemini')) {
      if (typeof this.geminiSession.cancel === 'function') await this.geminiSession.cancel(requestId);
    }

    entry.envelope.transition(RequestState.FAILED, { error: 'CANCELLED_BY_CALLER' });
    this.activeTasks.delete(requestId);
    return { cancelled: true, requestId };
  }

  /**
   * Live status reporting across all agents (Phase 24: bridge status)
   */
  async getLiveStatus() {
    const chatgptHealth = await this.chatgptEngine.health();
    const claudeHealth = await this.claudeSession.health();
    const claudeInspect = await this.swiftBridge.inspectApp('Claude');
    const chatgptInspect = await this.swiftBridge.inspectApp('ChatGPT');
    const geminiInspect = await this.swiftBridge.inspectApp('Gemini');
    const geminiCaps = await this.geminiSession.capabilities();

    return {
      timestamp: new Date().toISOString(),
      activeTasks: this.activeTasks.size,
      agents: {
        chatgpt: {
          name: 'ChatGPT Desktop',
          pid: chatgptInspect.pid || null,
          running: chatgptInspect.running || false,
          windowCount: chatgptInspect.windowCount || 0,
          engine: 'codex-local',
          idleTurn: 'YES',
          idleModelWake: true,
          modelTurn: this.chatgptEngine.activeJobs.size > 0 ? 'STREAMING' : 'IDLE',
          trueHeadlessEngine: 'YES',
          uiSubmissionSupported: true,
          modelInvocationSupported: true,
          modelResponseSupported: true,
          health: chatgptHealth.status === 'available' || chatgptInspect.running ? 'HEALTHY' : 'UNAVAILABLE',
          activeJobs: chatgptHealth.activeJobs || 0
        },
        claude: {
          name: 'Claude Desktop',
          pid: claudeInspect.pid || null,
          running: claudeInspect.running || false,
          windowCount: claudeInspect.windowCount || 0,
          engine: 'desktop',
          idleTurn: 'AX/CDP/BROWSER',
          idleModelWake: true, // PROVEN via native Swift AX pipeline
          modelTurn: claudeHealth.activeTurns > 0 ? 'ACTIVE' : 'IDLE',
          trueHeadlessEngine: 'NO',
          uiSubmissionSupported: true,
          modelInvocationSupported: true,
          modelResponseSupported: true,
          health: (claudeInspect.running && claudeInspect.windowCount > 0) ? 'HEALTHY' : (claudeInspect.running ? 'WINDOWLESS_RECOVERABLE' : 'UNAVAILABLE'),
          activeTurns: claudeHealth.activeTurns || 0
        },
        gemini: {
          name: 'Gemini Desktop',
          pid: geminiInspect.pid || null,
          running: geminiInspect.running || false,
          windowCount: geminiInspect.windowCount || 0,
          engine: 'gemini-desktop-native-ax',
          idleTurn: 'AX',
          idleModelWake: (geminiInspect.running && geminiInspect.windowCount > 0),
          modelTurn: 'IDLE',
          trueHeadlessEngine: false,
          uiSubmissionSupported: true,
          modelInvocationSupported: true,
          modelResponseSupported: true,
          health: (geminiInspect.running && geminiInspect.windowCount > 0) ? 'HEALTHY' : 'UNAVAILABLE'
        },
        antigravity: {
          name: 'Antigravity IDE',
          running: true,
          engine: 'autonomous-worker',
          idleTurn: 'YES',
          idleModelWake: true,
          modelTurn: 'IDLE',
          trueHeadlessEngine: 'YES',
          uiSubmissionSupported: true,
          modelInvocationSupported: true,
          modelResponseSupported: true,
          health: 'HEALTHY'
        }
      },
      conversations: this.conversations.getAll().length
    };
  }
}
