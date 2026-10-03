import { CONFIG } from './config.js';
import { createSessionAdapter } from './session-adapters/index.js';

/**
 * Unified Tool Registry: Single Source of Truth for all Bridge tools across
 * stdio MCP, HTTP MCP, SSE, and plugins.
 */
export class ToolRegistry {
  constructor() {
    this.tools = new Map();
    this.registerCoreTools();
  }

  registerTool(definition) {
    if (!definition.name || !definition.handler) {
      throw new Error('Tool definition must have name and handler');
    }
    this.tools.set(definition.name, definition);
  }

  getToolDefinitions() {
    return Array.from(this.tools.values()).map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema
    }));
  }

  async executeTool(name, rawArgs = {}, context = {}) {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Unknown tool: '${name}'`);
    }

    const t0 = Date.now();
    let success = true;

    // Resolve caller identity through AgentIdentityManager
    let callerAgentId = rawArgs.agentId || rawArgs.fromAgent || null;
    if (context.identity) {
      const resolved = context.identity.resolveIdentity(callerAgentId, { token: rawArgs.token });
      callerAgentId = resolved.agentId;
    } else if (!callerAgentId) {
      callerAgentId = 'system';
    }

    // Attach resolved agentId to arguments
    const args = { ...rawArgs, agentId: callerAgentId };
    if (rawArgs.fromAgent) args.fromAgent = callerAgentId;

    try {
      const result = await tool.handler(args, context);
      const durationMs = Date.now() - t0;
      context.diagnostics?.recordToolExecution(name, durationMs, true);
      return result;
    } catch (err) {
      success = false;
      const durationMs = Date.now() - t0;
      context.diagnostics?.recordToolExecution(name, durationMs, false);
      throw err;
    }
  }

  registerCoreTools() {
    // 1. Diagnostics & Health
    this.registerTool({
      name: 'bridge_ping',
      description: 'Harmless health check tool verifying Agent Bridge connectivity.',
      inputSchema: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'Caller agent identity' }
        }
      },
      handler: async (args, ctx) => {
        const caller = args.agentId || 'unknown';
        const timestamp = new Date().toISOString();
        ctx.logger?.log({
          agentId: caller,
          action: 'bridge_ping',
          status: 'success',
          details: { responseToken: 'CHATGPT_BRIDGE_REAL_TEST_7F31' }
        });
        return {
          status: 'OK',
          token: 'CHATGPT_BRIDGE_REAL_TEST_7F31',
          timestamp,
          caller,
          environment: 'Jayanth\'s Mac (Apple Silicon arm64)',
          bridgePath: CONFIG.BRIDGE_ROOT,
          message: 'CHATGPT_BRIDGE_REAL_TEST_7F31: Agent Bridge is operational on Jayanth\'s Mac.'
        };
      }
    });

    this.registerTool({
      name: 'bridge_discover_agents',
      description: 'Discover active agents registered with the bridge, lock states, and allowed project roots.',
      inputSchema: {
        type: 'object',
        properties: {
          agentId: { type: 'string' }
        }
      },
      handler: async (args, ctx) => ({
        registeredAgents: CONFIG.AGENT_IDENTITIES,
        liveAgents: ctx.presence ? ctx.presence.listAgents() : [],
        ziaWriteLocked: CONFIG.ZIA_WRITE_LOCKED,
        allowedRoots: CONFIG.ALLOWED_ROOTS
      })
    });

    this.registerTool({
      name: 'bridge_agent_presence',
      description: 'Query live agent presence, connection states, and current active tasks.',
      inputSchema: {
        type: 'object',
        properties: {
          agentId: { type: 'string' }
        }
      },
      handler: async (args, ctx) => {
        return {
          agents: ctx.presence ? ctx.presence.listAgents() : [],
          timestamp: new Date().toISOString()
        };
      }
    });

    this.registerTool({
      name: 'bridge_diagnostics',
      description: 'Get compact performance metrics, tool latencies, and cache statistics.',
      inputSchema: {
        type: 'object',
        properties: {}
      },
      handler: async (args, ctx) => {
        return ctx.diagnostics ? ctx.diagnostics.getSnapshot(ctx.cache) : { status: 'no_diagnostics' };
      }
    });

    // 2. Project & Filesystem
    this.registerTool({
      name: 'bridge_context',
      description: 'Return compact task-oriented project context: git state, structure, and optional relevant search hits.',
      inputSchema: {
        type: 'object',
        properties: {
          rootPath: { type: 'string' },
          query: { type: 'string' },
          maxResults: { type: 'number' },
          agentId: { type: 'string' }
        },
        required: ['agentId']
      },
      handler: async (args, ctx) => {
        const context = await ctx.controller.buildContext(args.rootPath, args.agentId, args.query, args.maxResults);
        context.tasks = ctx.taskManager ? ctx.taskManager.listTasks({ agentId: args.agentId, limit: 6, compact: true }) : [];
        context.agents = ctx.presence ? ctx.presence.listAgents() : [];
        return context;
      }
    });

    this.registerTool({
      name: 'bridge_find_symbol',
      description: 'Find code symbol definitions with compact file and line references.',
      inputSchema: {
        type: 'object',
        properties: {
          rootPath: { type: 'string' },
          symbol: { type: 'string' },
          maxResults: { type: 'number' },
          agentId: { type: 'string' }
        },
        required: ['rootPath', 'symbol', 'agentId']
      },
      handler: async (args, ctx) => ctx.controller.findSymbol(args.rootPath, args.agentId, args.symbol, args.maxResults)
    });

    this.registerTool({
      name: 'bridge_read_symbol',
      description: 'Read a bounded source window around a symbol definition instead of an entire file.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          symbol: { type: 'string' },
          contextLines: { type: 'number' },
          maxLines: { type: 'number' },
          agentId: { type: 'string' }
        },
        required: ['filePath', 'symbol', 'agentId']
      },
      handler: async (args, ctx) => ctx.controller.readSymbol(args.filePath, args.agentId, args.symbol, args.contextLines, args.maxLines)
    });

    this.registerTool({
      name: 'bridge_test_plan',
      description: 'Build a compact test plan from changed files and available test files, with a full-suite fallback.',
      inputSchema: {
        type: 'object',
        properties: { rootPath: { type: 'string' }, agentId: { type: 'string' } },
        required: ['agentId']
      },
      handler: async (args, ctx) => ctx.controller.testPlan(args.rootPath, args.agentId)
    });

    this.registerTool({
      name: 'bridge_inspect_project',
      description: 'Inspect a project root directory, returning files and directories.',
      inputSchema: {
        type: 'object',
        properties: {
          rootPath: { type: 'string', description: 'Directory path' },
          agentId: { type: 'string' }
        },
        required: ['rootPath', 'agentId']
      },
      handler: async (args, ctx) => ctx.controller.inspectProject(args.rootPath, args.agentId)
    });

    this.registerTool({
      name: 'bridge_project_snapshot',
      description: 'Compact project snapshot with git branch, status, structure, and active tasks.',
      inputSchema: {
        type: 'object',
        properties: {
          rootPath: { type: 'string', description: 'Directory path (defaults to bridge root)' },
          agentId: { type: 'string' }
        }
      },
      handler: async (args, ctx) => ctx.controller.projectSnapshot(args.rootPath, args.agentId)
    });

    this.registerTool({
      name: 'bridge_read_file',
      description: 'Read file with line numbers and SHA-256 hash. Defaults to compact output.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Absolute file path' },
          agentId: { type: 'string' },
          startLine: { type: 'number', description: 'Starting line (default 1)' },
          endLine: { type: 'number', description: 'Ending line (default 100)' },
          compact: { type: 'boolean', description: 'Omit extra metadata for low token burn' },
          knownHash: { type: 'string', description: 'If unchanged, return only unchanged=true and the current hash' }
        },
        required: ['filePath', 'agentId']
      },
      handler: async (args, ctx) => ctx.controller.readFile(args.filePath, args.agentId, args.startLine, args.endLine, args.compact)
    });

    this.registerTool({
      name: 'bridge_create_file',
      description: 'Create a new file in an authorized workspace.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          content: { type: 'string' },
          overwrite: { type: 'boolean' },
          agentId: { type: 'string' }
        },
        required: ['filePath', 'content', 'agentId']
      },
      handler: async (args, ctx) => ctx.controller.createFile(args.filePath, args.agentId, args.content, args.overwrite)
    });

    this.registerTool({
      name: 'bridge_edit_file',
      description: 'Replace an exact target content string with optimistic hash verification.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          targetContent: { type: 'string' },
          replacementContent: { type: 'string' },
          expectedHash: { type: 'string' },
          agentId: { type: 'string' }
        },
        required: ['filePath', 'targetContent', 'replacementContent', 'agentId']
      },
      handler: async (args, ctx) => ctx.controller.editFile(args.filePath, args.agentId, args.targetContent, args.replacementContent, args.expectedHash)
    });

    this.registerTool({
      name: 'bridge_apply_patch',
      description: 'Atomic compare-and-swap patch operation with expectedHash, conflict detection, and minimal response tokens.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          patch: {
            type: 'object',
            description: 'Patch object with targetContent/replacementContent or newContent'
          },
          expectedHash: { type: 'string', description: 'Expected current file SHA-256 hash' },
          agentId: { type: 'string' }
        },
        required: ['filePath', 'patch', 'agentId']
      },
      handler: async (args, ctx) => ctx.controller.applyPatch(args.filePath, args.agentId, args.patch, args.expectedHash)
    });

    this.registerTool({
      name: 'bridge_delete_file',
      description: 'Safely delete a file in an authorized workspace.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          agentId: { type: 'string' }
        },
        required: ['filePath', 'agentId']
      },
      handler: async (args, ctx) => ctx.controller.deleteFile(args.filePath, args.agentId)
    });

    this.registerTool({
      name: 'bridge_search_files',
      description: 'Fast search across project files with snippet bounds, filters, and noise directory skipping.',
      inputSchema: {
        type: 'object',
        properties: {
          rootPath: { type: 'string' },
          query: { type: 'string' },
          isRegex: { type: 'boolean' },
          maxResults: { type: 'number', description: 'Max results (default 20, max 100)' },
          extensions: { type: 'array', items: { type: 'string' }, description: 'e.g. [".js", ".swift"]' },
          agentId: { type: 'string' }
        },
        required: ['rootPath', 'query', 'agentId']
      },
      handler: async (args, ctx) => ctx.controller.searchFiles(args.rootPath, args.agentId, args.query, args.isRegex, args.maxResults, args.extensions)
    });

    this.registerTool({
      name: 'bridge_batch_read',
      description: 'Read multiple files in a single round-trip with line bounds and hashes.',
      inputSchema: {
        type: 'object',
        properties: {
          files: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                filePath: { type: 'string' },
                startLine: { type: 'number' },
                endLine: { type: 'number' }
              },
              required: ['filePath']
            }
          },
          compact: { type: 'boolean' },
          agentId: { type: 'string' }
        },
        required: ['files', 'agentId']
      },
      handler: async (args, ctx) => ctx.controller.batchRead(args.files, args.agentId, args.compact)
    });

    this.registerTool({
      name: 'bridge_batch_write',
      description: 'Batch write multiple files in a single call with optional optimistic expectedHash.',
      inputSchema: {
        type: 'object',
        properties: {
          files: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                filePath: { type: 'string' },
                content: { type: 'string' },
                expectedHash: { type: 'string' },
                overwrite: { type: 'boolean' }
              },
              required: ['filePath', 'content']
            }
          },
          agentId: { type: 'string' }
        },
        required: ['files', 'agentId']
      },
      handler: async (args, ctx) => ctx.controller.batchWrite(args.files, args.agentId)
    });

    this.registerTool({
      name: 'bridge_batch_stat',
      description: 'Stat multiple paths in a single round trip.',
      inputSchema: {
        type: 'object',
        properties: {
          paths: { type: 'array', items: { type: 'string' } },
          agentId: { type: 'string' }
        },
        required: ['paths', 'agentId']
      },
      handler: async (args, ctx) => ctx.controller.batchStat(args.paths, args.agentId)
    });

    this.registerTool({
      name: 'bridge_execute_command',
      description: 'Execute a whitelisted command within an authorized workspace.',
      inputSchema: {
        type: 'object',
        properties: {
          commandLine: { type: 'string' },
          cwd: { type: 'string' },
          agentId: { type: 'string' }
        },
        required: ['commandLine', 'agentId']
      },
      handler: async (args, ctx) => ctx.controller.executeCommand(args.commandLine, args.cwd, args.agentId)
    });

    // 3. Structured Git Tools
    this.registerTool({
      name: 'bridge_git_status',
      description: 'Get structured Git status with branch, tracking, staged, and unstaged change summaries.',
      inputSchema: {
        type: 'object',
        properties: {
          repoPath: { type: 'string' },
          agentId: { type: 'string' }
        },
        required: ['repoPath', 'agentId']
      },
      handler: async (args, ctx) => ctx.git.getStatus(args.repoPath, args.agentId)
    });

    this.registerTool({
      name: 'bridge_git_branches',
      description: 'List local and remote branches and indicate the current branch.',
      inputSchema: {
        type: 'object',
        properties: {
          repoPath: { type: 'string' },
          agentId: { type: 'string' }
        },
        required: ['repoPath', 'agentId']
      },
      handler: async (args, ctx) => ctx.git.getBranches(args.repoPath, args.agentId)
    });

    this.registerTool({
      name: 'bridge_git_create_branch',
      description: 'Create a new Git branch with name validation.',
      inputSchema: {
        type: 'object',
        properties: {
          repoPath: { type: 'string' },
          branchName: { type: 'string' },
          startPoint: { type: 'string' },
          agentId: { type: 'string' }
        },
        required: ['repoPath', 'branchName', 'agentId']
      },
      handler: async (args, ctx) => ctx.git.createBranch(args.repoPath, args.agentId, args.branchName, args.startPoint)
    });

    this.registerTool({
      name: 'bridge_git_switch_branch',
      description: 'Switch or checkout a branch.',
      inputSchema: {
        type: 'object',
        properties: {
          repoPath: { type: 'string' },
          branchName: { type: 'string' },
          createIfMissing: { type: 'boolean' },
          agentId: { type: 'string' }
        },
        required: ['repoPath', 'branchName', 'agentId']
      },
      handler: async (args, ctx) => ctx.git.switchBranch(args.repoPath, args.agentId, args.branchName, args.createIfMissing)
    });

    this.registerTool({
      name: 'bridge_git_delete_branch',
      description: 'Delete a local Git branch.',
      inputSchema: {
        type: 'object',
        properties: {
          repoPath: { type: 'string' },
          branchName: { type: 'string' },
          force: { type: 'boolean' },
          agentId: { type: 'string' }
        },
        required: ['repoPath', 'branchName', 'agentId']
      },
      handler: async (args, ctx) => ctx.git.deleteBranch(args.repoPath, args.agentId, args.branchName, args.force)
    });

    this.registerTool({
      name: 'bridge_git_stage',
      description: 'Stage files for Git commit.',
      inputSchema: {
        type: 'object',
        properties: {
          repoPath: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          stageAll: { type: 'boolean' },
          agentId: { type: 'string' }
        },
        required: ['repoPath', 'agentId']
      },
      handler: async (args, ctx) => ctx.git.stage(args.repoPath, args.agentId, args.files, args.stageAll)
    });

    this.registerTool({
      name: 'bridge_git_commit',
      description: 'Stage files and create a structured Git commit with author metadata.',
      inputSchema: {
        type: 'object',
        properties: {
          repoPath: { type: 'string' },
          message: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          stageAll: { type: 'boolean' },
          agentId: { type: 'string' }
        },
        required: ['repoPath', 'message', 'agentId']
      },
      handler: async (args, ctx) => ctx.git.commit(args.repoPath, args.agentId, args.message, args.files, args.stageAll)
    });

    this.registerTool({
      name: 'bridge_git_log',
      description: 'View compact Git commit history.',
      inputSchema: {
        type: 'object',
        properties: {
          repoPath: { type: 'string' },
          maxCommits: { type: 'number' },
          agentId: { type: 'string' }
        },
        required: ['repoPath', 'agentId']
      },
      handler: async (args, ctx) => ctx.git.getLog(args.repoPath, args.agentId, args.maxCommits)
    });

    this.registerTool({
      name: 'bridge_git_diff',
      description: 'View concise Git diff summary.',
      inputSchema: {
        type: 'object',
        properties: {
          repoPath: { type: 'string' },
          staged: { type: 'boolean' },
          maxLines: { type: 'number' },
          agentId: { type: 'string' }
        },
        required: ['repoPath', 'agentId']
      },
      handler: async (args, ctx) => ctx.git.getDiff(args.repoPath, args.agentId, args.staged, args.maxLines)
    });

    this.registerTool({
      name: 'bridge_git_push',
      description: 'Autonomous Git push to remote with repo, remote, branch, and commit validation. Does NOT require human confirmation.',
      inputSchema: {
        type: 'object',
        properties: {
          repoPath: { type: 'string' },
          remote: { type: 'string', description: 'Remote name (default origin)' },
          branch: { type: 'string', description: 'Target branch (defaults to current)' },
          allowProtected: { type: 'boolean', description: 'Allow pushing to main/master/production if policy requires' },
          dryRun: { type: 'boolean' },
          verbose: { type: 'boolean', description: 'Return full git command output' },
          agentId: { type: 'string' }
        },
        required: ['repoPath', 'agentId']
      },
      handler: async (args, ctx) => ctx.git.push(args.repoPath, args.agentId, {
        remote: args.remote,
        branch: args.branch,
        allowProtected: args.allowProtected,
        dryRun: args.dryRun,
        verbose: args.verbose
      })
    });

    this.registerTool({
      name: 'bridge_git_pull',
      description: 'Pull latest changes from remote.',
      inputSchema: {
        type: 'object',
        properties: {
          repoPath: { type: 'string' },
          remote: { type: 'string' },
          branch: { type: 'string' },
          agentId: { type: 'string' }
        },
        required: ['repoPath', 'agentId']
      },
      handler: async (args, ctx) => ctx.git.pull(args.repoPath, args.agentId, {
        remote: args.remote,
        branch: args.branch
      })
    });

    this.registerTool({
      name: 'bridge_git_fetch',
      description: 'Fetch latest references from remote.',
      inputSchema: {
        type: 'object',
        properties: {
          repoPath: { type: 'string' },
          remote: { type: 'string' },
          agentId: { type: 'string' }
        },
        required: ['repoPath', 'agentId']
      },
      handler: async (args, ctx) => ctx.git.fetch(args.repoPath, args.agentId, {
        remote: args.remote
      })
    });

    // 4. Messaging & Tasks
    this.registerTool({
      name: 'bridge_send_message',
      description: 'Send an asynchronous message to another connected agent.',
      inputSchema: {
        type: 'object',
        properties: {
          fromAgent: { type: 'string' },
          toAgent: { type: 'string' },
          subject: { type: 'string' },
          content: { type: 'string' },
          replyToId: { type: 'string' }
        },
        required: ['fromAgent', 'toAgent', 'subject', 'content']
      },
      handler: async (args, ctx) => ctx.mailbox.sendMessage(args)
    });

    this.registerTool({
      name: 'bridge_broadcast_message',
      description: 'Fan out the same message to multiple agents concurrently.',
      inputSchema: {
        type: 'object',
        properties: {
          fromAgent: { type: 'string' },
          toAgents: { type: 'array', items: { type: 'string' } },
          subject: { type: 'string' },
          content: { type: 'string' },
          replyToId: { type: 'string' }
        },
        required: ['fromAgent', 'toAgents', 'subject', 'content']
      },
      handler: async (args, ctx) => ctx.mailbox.broadcastMessage(args)
    });

    this.registerTool({
      name: 'bridge_check_inbox',
      description: 'Check inbox messages addressed to this agent. Supports compact summary.',
      inputSchema: {
        type: 'object',
        properties: {
          agentId: { type: 'string' },
          unreadOnly: { type: 'boolean' },
          compact: { type: 'boolean', description: 'Omit full bodies for low token burn' },
          limit: { type: 'number' }
        },
        required: ['agentId']
      },
      handler: async (args, ctx) => ctx.mailbox.getInbox(args)
    });

    this.registerTool({
      name: 'bridge_delegate_task',
      description: 'Delegate a discrete first-class task with priorities, parent taskId, and dependencies.',
      inputSchema: {
        type: 'object',
        properties: {
          fromAgent: { type: 'string' },
          toAgent: { type: 'string' },
          title: { type: 'string' },
          instructions: { type: 'string' },
          context: { type: 'string' },
          parentTaskId: { type: 'string' },
          priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
          dependencies: { type: 'array', items: { type: 'string' } }
        },
        required: ['fromAgent', 'toAgent', 'title', 'instructions']
      },
      handler: async (args, ctx) => ctx.mailbox.delegateTask(args)
    });

    this.registerTool({
      name: 'bridge_claim_task',
      description: 'Claim the next available pending task for an agent, transitioning it to claimed/in_progress.',
      inputSchema: {
        type: 'object',
        properties: {
          agentId: { type: 'string' }
        },
        required: ['agentId']
      },
      handler: async (args, ctx) => {
        const claimed = ctx.mailbox.claimNextTask(args.agentId);
        return claimed || { status: 'no_tasks_available', agentId: args.agentId };
      }
    });

    this.registerTool({
      name: 'bridge_get_task_status',
      description: 'Retrieve details, status, and compact outcome of a delegated task.',
      inputSchema: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          compact: { type: 'boolean', description: 'Return concise state by default' }
        },
        required: ['taskId']
      },
      handler: async (args, ctx) => {
        const compact = args.compact !== false; // default true
        return ctx.mailbox.getTask(args.taskId, compact);
      }
    });

    this.registerTool({
      name: 'bridge_submit_task_result',
      description: 'Submit completion or failure outcome for an assigned task, delivering result to creator.',
      inputSchema: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          agentId: { type: 'string' },
          status: { type: 'string', enum: ['completed', 'failed', 'in_progress'] },
          result: { type: 'string' },
          error: { type: 'string' }
        },
        required: ['taskId', 'agentId', 'status']
      },
      handler: async (args, ctx) => ctx.mailbox.submitTaskResult(args)
    });

    this.registerTool({
      name: 'bridge_ask_agent',
      description: 'Directly query another connected agent and await correlated response over cross-process event bus.',
      inputSchema: {
        type: 'object',
        properties: {
          fromAgent: { type: 'string' },
          toAgent: { type: 'string' },
          question: { type: 'string' },
          context: { type: 'string' },
          conversationId: { type: 'string' },
          requestId: { type: 'string' },
          timeoutMs: { type: 'number' },
          asyncMode: { type: 'boolean' }
        },
        required: ['fromAgent', 'toAgent', 'question']
      },
      handler: async (args, ctx) => ctx.mailbox.askAgent(args)
    });

    this.registerTool({
      name: 'bridge_get_request_status',
      description: 'Get status and response details for a correlated request.',
      inputSchema: {
        type: 'object',
        properties: {
          requestId: { type: 'string' }
        },
        required: ['requestId']
      },
      handler: async (args, ctx) => ctx.mailbox.getRequest(args.requestId)
    });

    this.registerTool({
      name: 'bridge_get_events',
      description: 'Get compact events from the cross-process event bus with cursor support.',
      inputSchema: {
        type: 'object',
        properties: {
          agentId: { type: 'string' },
          afterEventId: { type: 'number' },
          limit: { type: 'number' },
          compact: { type: 'boolean' }
        }
      },
      handler: async (args, ctx) => ctx.eventBus ? ctx.eventBus.getEvents(args) : []
    });

    this.registerTool({
      name: 'bridge_get_adapter_capabilities',
      description: 'Inspect session adapter capabilities and execution boundaries for connected agents.',
      inputSchema: {
        type: 'object',
        properties: {
          agentId: { type: 'string' }
        },
        required: ['agentId']
      },
      handler: async (args, ctx) => {
        const adapter = createSessionAdapter(args.agentId, { mailboxHub: ctx.mailbox, eventBus: ctx.eventBus });
        return adapter.capabilities();
      }
    });

    this.registerTool({
      name: 'bridge_request_review',
      description: 'Request a peer code review for a file or change.',
      inputSchema: {
        type: 'object',
        properties: {
          fromAgent: { type: 'string' },
          toAgent: { type: 'string' },
          filePath: { type: 'string' },
          description: { type: 'string' }
        },
        required: ['fromAgent', 'toAgent', 'filePath', 'description']
      },
      handler: async (args, ctx) => ctx.mailbox.requestReview(args)
    });

    // 5. Collaboration Boards
    this.registerTool({
      name: 'bridge_create_collaboration',
      description: 'Create a persistent multi-agent collaboration board/session.',
      inputSchema: {
        type: 'object',
        properties: {
          ownerAgent: { type: 'string' },
          title: { type: 'string' },
          objective: { type: 'string' },
          metadata: { type: 'object' }
        },
        required: ['ownerAgent', 'title', 'objective']
      },
      handler: async (args, ctx) => ctx.collaboration.create(args)
    });

    this.registerTool({
      name: 'bridge_join_collaboration',
      description: 'Join or refresh presence in a collaboration.',
      inputSchema: {
        type: 'object',
        properties: {
          collaborationId: { type: 'string' },
          agentId: { type: 'string' },
          role: { type: 'string' },
          capabilities: { type: 'array' }
        },
        required: ['collaborationId', 'agentId']
      },
      handler: async (args, ctx) => ctx.collaboration.join(args)
    });

    this.registerTool({
      name: 'bridge_leave_collaboration',
      description: 'Leave a collaboration.',
      inputSchema: {
        type: 'object',
        properties: {
          collaborationId: { type: 'string' },
          agentId: { type: 'string' }
        },
        required: ['collaborationId', 'agentId']
      },
      handler: async (args, ctx) => ctx.collaboration.leave(args)
    });

    this.registerTool({
      name: 'bridge_heartbeat_collaboration',
      description: 'Refresh heartbeat in collaboration.',
      inputSchema: {
        type: 'object',
        properties: {
          collaborationId: { type: 'string' },
          agentId: { type: 'string' },
          status: { type: 'string' }
        },
        required: ['collaborationId', 'agentId']
      },
      handler: async (args, ctx) => ctx.collaboration.heartbeat(args)
    });

    this.registerTool({
      name: 'bridge_get_collaboration',
      description: 'Read the shared collaboration board, participants, and events.',
      inputSchema: {
        type: 'object',
        properties: {
          collaborationId: { type: 'string' }
        },
        required: ['collaborationId']
      },
      handler: async (args, ctx) => ctx.collaboration.get(args.collaborationId)
    });

    this.registerTool({
      name: 'bridge_list_collaborations',
      description: 'List collaboration boards visible to an agent.',
      inputSchema: {
        type: 'object',
        properties: {
          agentId: { type: 'string' },
          status: { type: 'string' }
        }
      },
      handler: async (args, ctx) => ctx.collaboration.list(args)
    });

    this.registerTool({
      name: 'bridge_post_collaboration_event',
      description: 'Post an event to a collaboration board.',
      inputSchema: {
        type: 'object',
        properties: {
          collaborationId: { type: 'string' },
          agentId: { type: 'string' },
          eventType: { type: 'string' },
          payload: { type: 'object' }
        },
        required: ['collaborationId', 'agentId', 'eventType']
      },
      handler: async (args, ctx) => ctx.collaboration.event(args)
    });

    this.registerTool({
      name: 'bridge_close_collaboration',
      description: 'Close a collaboration owned by the requesting agent.',
      inputSchema: {
        type: 'object',
        properties: {
          collaborationId: { type: 'string' },
          agentId: { type: 'string' },
          reason: { type: 'string' }
        },
        required: ['collaborationId', 'agentId']
      },
      handler: async (args, ctx) => ctx.collaboration.close(args)
    });

    // 6. File Activity
    this.registerTool({
      name: 'bridge_file_activity_start',
      description: 'Announce file activity for non-blocking awareness.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          agentId: { type: 'string' },
          activityType: { type: 'string' },
          collaborationId: { type: 'string' },
          taskId: { type: 'string' },
          description: { type: 'string' }
        },
        required: ['filePath', 'agentId']
      },
      handler: async (args, ctx) => ctx.fileActivity.start(args)
    });

    this.registerTool({
      name: 'bridge_file_activity_heartbeat',
      description: 'Refresh file activity presence.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          agentId: { type: 'string' },
          activityType: { type: 'string' }
        },
        required: ['filePath', 'agentId']
      },
      handler: async (args, ctx) => ctx.fileActivity.heartbeat(args)
    });

    this.registerTool({
      name: 'bridge_file_activity_stop',
      description: 'Clear file activity.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          agentId: { type: 'string' },
          activityType: { type: 'string' }
        },
        required: ['filePath', 'agentId']
      },
      handler: async (args, ctx) => ctx.fileActivity.stop(args)
    });

    this.registerTool({
      name: 'bridge_get_file_activity',
      description: 'See who is currently working on a file.',
      inputSchema: {
        type: 'object',
        properties: { filePath: { type: 'string' } },
        required: ['filePath']
      },
      handler: async (args, ctx) => ctx.fileActivity.get(args.filePath)
    });

    this.registerTool({
      name: 'bridge_get_all_file_activity',
      description: 'See all active file activity.',
      inputSchema: { type: 'object', properties: {} },
      handler: async (args, ctx) => ctx.fileActivity.getAll()
    });

    // 7. Audit Log
    this.registerTool({
      name: 'bridge_get_audit_log',
      description: 'View recent security audit log records with compact summaries.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Number of recent records (default 20)' },
          compact: { type: 'boolean' }
        }
      },
      handler: async (args, ctx) => {
        const limit = args.limit || 20;
        const logs = ctx.logger.getRecentLogs(limit);
        if (args.compact !== false) {
          return logs.map(l => ({
            id: l.id,
            timestamp: l.timestamp,
            agent: l.agent_id,
            action: l.action,
            status: l.status,
            target: l.target_path ? l.target_path.slice(-40) : null
          }));
        }
        return logs;
      }
    });
  }
}
