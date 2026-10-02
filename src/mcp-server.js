import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';

import { CONFIG } from './config.js';
import { AuditLogger } from './audit-logger.js';
import { PermissionGuard } from './permission-guard.js';
import { MailboxHub } from './mailbox-hub.js';
import { ProjectController } from './project-controller.js';
import { ConcurrencyManager } from './concurrency-manager.js';
import { CollaborationManager } from './collaboration-manager.js';
import { FileActivityManager } from './file-activity-manager.js';

export class BridgeMcpServer {
  constructor(options = {}) {
    this.agentId = options.agentId || 'system';
    this.startedAt = new Date().toISOString();
    this.instanceId = `bridge_${process.pid}_${Date.now()}`;
    this.logger = options.auditLogger || new AuditLogger();
    this.guard = options.permissionGuard || new PermissionGuard();
    this.concurrency = options.concurrencyManager || new ConcurrencyManager();
    this.mailbox = options.mailboxHub || new MailboxHub(this.logger);
    this.collaboration = options.collaborationManager || new CollaborationManager(this.logger);
    this.fileActivity = options.fileActivityManager || new FileActivityManager(this.logger);
    this.controller = options.projectController || new ProjectController(this.guard, this.logger, this.concurrency, this.fileActivity);

    this.server = new Server(
      {
        name: 'agent-bridge',
        version: '1.1.0'
      },
      {
        capabilities: {
          tools: {}
        }
      }
    );

    this.setupHandlers();
  }

  setupHandlers() {
    // Single source of truth for the tool list: used by tools/list AND by the
    // bridge_ping/bridge_discover_agents diagnostics (toolCount).
    this.toolList = () => [
          {
            name: 'bridge_ping',
            description: 'Harmless health check tool that verifies connectivity to the local Agent Bridge.',
            inputSchema: {
              type: 'object',
              properties: {
                agentId: { type: 'string', description: 'Caller agent identity (e.g. chatgpt-desktop, claude-desktop, antigravity-ide)' }
              }
            }
          },
          {
            name: 'bridge_discover_agents',
            description: 'Discover active agents registered with the bridge, lock states, and allowed project roots.',
            inputSchema: {
              type: 'object',
              properties: {
                agentId: { type: 'string', description: 'Caller agent identity (e.g. claude-desktop, chatgpt-desktop, antigravity-ide)' }
              }
            }
          },
          {
            name: 'bridge_inspect_project',
            description: 'Inspect a project root directory, returning files, directories and entries.',
            inputSchema: {
              type: 'object',
              properties: {
                rootPath: { type: 'string', description: 'Path to directory' },
                agentId: { type: 'string', description: 'Caller agent identity' }
              },
              required: ['rootPath', 'agentId']
            }
          },
          {
            name: 'bridge_read_file',
            description: 'Read contents of a file with line numbers and SHA-256 hash for optimistic concurrency.',
            inputSchema: {
              type: 'object',
              properties: {
                filePath: { type: 'string', description: 'Absolute path to file' },
                agentId: { type: 'string', description: 'Caller agent identity' },
                startLine: { type: 'number', description: 'Starting line number (1-based)' },
                endLine: { type: 'number', description: 'Ending line number' }
              },
              required: ['filePath', 'agentId']
            }
          },
          {
            name: 'bridge_search_files',
            description: 'Search for text or regex pattern across files within safe project roots.',
            inputSchema: {
              type: 'object',
              properties: {
                rootPath: { type: 'string', description: 'Directory to search within' },
                query: { type: 'string', description: 'Search term or regex' },
                isRegex: { type: 'boolean', description: 'Whether query is a regex' },
                agentId: { type: 'string', description: 'Caller agent identity' }
              },
              required: ['rootPath', 'query', 'agentId']
            }
          },
          {
            name: 'bridge_create_file',
            description: 'Create a new file in an authorized workspace.',
            inputSchema: {
              type: 'object',
              properties: {
                filePath: { type: 'string', description: 'Absolute file path' },
                content: { type: 'string', description: 'File content' },
                overwrite: { type: 'boolean', description: 'Allow overwrite of existing file' },
                agentId: { type: 'string', description: 'Caller agent identity' }
              },
              required: ['filePath', 'content', 'agentId']
            }
          },
          {
            name: 'bridge_edit_file',
            description: 'Perform an exact target string replacement with optimistic concurrency lock verification.',
            inputSchema: {
              type: 'object',
              properties: {
                filePath: { type: 'string', description: 'Absolute file path' },
                targetContent: { type: 'string', description: 'Exact string block to replace' },
                replacementContent: { type: 'string', description: 'New string block' },
                expectedHash: { type: 'string', description: 'Optional expected file SHA-256 hash to prevent race conditions' },
                agentId: { type: 'string', description: 'Caller agent identity' }
              },
              required: ['filePath', 'targetContent', 'replacementContent', 'agentId']
            }
          },
          {
            name: 'bridge_delete_file',
            description: 'Safely delete a file in an authorized workspace.',
            inputSchema: {
              type: 'object',
              properties: {
                filePath: { type: 'string', description: 'Absolute file path' },
                agentId: { type: 'string', description: 'Caller agent identity' }
              },
              required: ['filePath', 'agentId']
            }
          },
          {
            name: 'bridge_execute_command',
            description: 'Execute a whitelisted command within an authorized workspace.',
            inputSchema: {
              type: 'object',
              properties: {
                commandLine: { type: 'string', description: 'Command to run (e.g. swift test, git status)' },
                cwd: { type: 'string', description: 'Working directory' },
                agentId: { type: 'string', description: 'Caller agent identity' }
              },
              required: ['commandLine', 'agentId']
            }
          },
          {
            name: 'bridge_send_message',
            description: 'Send an asynchronous message to another connected agent.',
            inputSchema: {
              type: 'object',
              properties: {
                fromAgent: { type: 'string', description: 'Sender agent identity' },
                toAgent: { type: 'string', description: 'Recipient agent identity' },
                subject: { type: 'string', description: 'Message subject' },
                content: { type: 'string', description: 'Message body' },
                replyToId: { type: 'string', description: 'Optional ID of message being replied to' }
              },
              required: ['fromAgent', 'toAgent', 'subject', 'content']
            }
          },
          {
            name: 'bridge_broadcast_message',
            description: 'Send the same message to multiple agents concurrently.',
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
            }
          },
          {
            name: 'bridge_check_inbox',
            description: 'Check inbox for messages addressed to this agent.',
            inputSchema: {
              type: 'object',
              properties: {
                agentId: { type: 'string', description: 'Recipient agent identity' },
                unreadOnly: { type: 'boolean', description: 'Filter only unread messages' }
              },
              required: ['agentId']
            }
          },
          {
            name: 'bridge_delegate_task',
            description: 'Delegate a discrete task to another agent and track its lifecycle.',
            inputSchema: {
              type: 'object',
              properties: {
                fromAgent: { type: 'string', description: 'Delegator agent identity' },
                toAgent: { type: 'string', description: 'Assignee agent identity' },
                title: { type: 'string', description: 'Task title' },
                instructions: { type: 'string', description: 'Task instructions' },
                context: { type: 'string', description: 'Context or background notes' }
              },
              required: ['fromAgent', 'toAgent', 'title', 'instructions']
            }
          },
          {
            name: 'bridge_ask_agent',
            description: 'Ask a question directly to another connected agent and await response.',
            inputSchema: {
              type: 'object',
              properties: {
                fromAgent: { type: 'string', description: 'Sender agent identity' },
                toAgent: { type: 'string', description: 'Recipient agent identity' },
                question: { type: 'string', description: 'Question or query' },
                context: { type: 'string', description: 'Optional context' }
              },
              required: ['fromAgent', 'toAgent', 'question']
            }
          },
          {
            name: 'bridge_request_review',
            description: 'Request a peer code review for a file or change.',
            inputSchema: {
              type: 'object',
              properties: {
                fromAgent: { type: 'string', description: 'Requesting agent identity' },
                toAgent: { type: 'string', description: 'Reviewing agent identity' },
                filePath: { type: 'string', description: 'Path to reviewed file' },
                description: { type: 'string', description: 'Summary of changes' }
              },
              required: ['fromAgent', 'toAgent', 'filePath', 'description']
            }
          },
          {
            name: 'bridge_get_task_status',
            description: 'Retrieve details and outcome of a delegated task.',
            inputSchema: {
              type: 'object',
              properties: {
                taskId: { type: 'string', description: 'Task ID' }
              },
              required: ['taskId']
            }
          },
          {
            name: 'bridge_submit_task_result',
            description: 'Submit completion or failure outcome for an assigned task.',
            inputSchema: {
              type: 'object',
              properties: {
                taskId: { type: 'string', description: 'Task ID' },
                agentId: { type: 'string', description: 'Agent identity' },
                status: { type: 'string', enum: ['completed', 'failed', 'in_progress'] },
                result: { type: 'string', description: 'Detailed result, diff, or findings' }
              },
              required: ['taskId', 'agentId', 'status']
            }
          },
          {
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
            }
          },
          {
            name: 'bridge_join_collaboration',
            description: 'Join or refresh presence in a collaboration without locking anything.',
            inputSchema: {
              type: 'object',
              properties: {
                collaborationId: { type: 'string' },
                agentId: { type: 'string' },
                role: { type: 'string' },
                capabilities: { type: 'array' }
              },
              required: ['collaborationId', 'agentId']
            }
          },
          {
            name: 'bridge_leave_collaboration',
            description: 'Leave a collaboration by marking the agent offline. This never locks or blocks other agents.',
            inputSchema: {
              type: 'object',
              properties: {
                collaborationId: { type: 'string' },
                agentId: { type: 'string' }
              },
              required: ['collaborationId', 'agentId']
            }
          },
          {
            name: 'bridge_heartbeat_collaboration',
            description: 'Keep an agent present in a collaboration.',
            inputSchema: {
              type: 'object',
              properties: {
                collaborationId: { type: 'string' },
                agentId: { type: 'string' },
                status: { type: 'string' }
              },
              required: ['collaborationId', 'agentId']
            }
          },
          {
            name: 'bridge_get_collaboration',
            description: 'Read the shared collaboration board, participants and events.',
            inputSchema: {
              type: 'object',
              properties: { collaborationId: { type: 'string' } },
              required: ['collaborationId']
            }
          },
          {
            name: 'bridge_list_collaborations',
            description: 'List collaboration boards visible to an agent.',
            inputSchema: {
              type: 'object',
              properties: {
                agentId: { type: 'string' },
                status: { type: 'string' }
              }
            }
          },
          {
            name: 'bridge_post_collaboration_event',
            description: 'Post a message, finding, decision or status event to a collaboration board.',
            inputSchema: {
              type: 'object',
              properties: {
                collaborationId: { type: 'string' },
                agentId: { type: 'string' },
                eventType: { type: 'string' },
                payload: { type: 'object' }
              },
              required: ['collaborationId', 'agentId', 'eventType']
            }
          },
          {
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
            }
          },
          {
            name: 'bridge_file_activity_start',
            description: 'Announce that an agent is reading, editing or reviewing a file. Informational only; never locks the file.',
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
            }
          },
          {
            name: 'bridge_file_activity_heartbeat',
            description: 'Refresh non-blocking file activity presence.',
            inputSchema: {
              type: 'object',
              properties: {
                filePath: { type: 'string' },
                agentId: { type: 'string' },
                activityType: { type: 'string' }
              },
              required: ['filePath', 'agentId']
            }
          },
          {
            name: 'bridge_file_activity_stop',
            description: 'Clear an agent\'s non-blocking activity on a file.',
            inputSchema: {
              type: 'object',
              properties: {
                filePath: { type: 'string' },
                agentId: { type: 'string' },
                activityType: { type: 'string' }
              },
              required: ['filePath', 'agentId']
            }
          },
          {
            name: 'bridge_get_file_activity',
            description: 'See who is currently using a file. This is awareness only and never blocks access.',
            inputSchema: {
              type: 'object',
              properties: { filePath: { type: 'string' } },
              required: ['filePath']
            }
          },
          {
            name: 'bridge_get_all_file_activity',
            description: 'See active file activity across the workspace. Informational only.',
            inputSchema: { type: 'object', properties: {} }
          },
          {
            name: 'bridge_get_audit_log',
            description: 'View recent security audit log records.',
            inputSchema: {
              type: 'object',
              properties: {
                limit: { type: 'number', description: 'Number of recent records to fetch' }
              }
            }
          }
        ];
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.toolList()
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args = {} } = request.params;

      try {
        let result;

        switch (name) {
          case 'bridge_ping': {
            const caller = args.agentId || 'unknown';
            const timestamp = new Date().toISOString();
            this.logger.log({
              agentId: caller,
              action: 'bridge_ping',
              targetPath: null,
              command: null,
              status: 'success',
              details: { responseToken: 'CHATGPT_BRIDGE_REAL_TEST_7F31' }
            });
            result = {
              status: 'OK',
              token: 'CHATGPT_BRIDGE_REAL_TEST_7F31',
              timestamp,
              caller,
              environment: 'Jayanth\'s Mac (Apple Silicon arm64, Node v24.12.0)',
              bridgePath: '/Users/jayanthpranaykonada/agent-bridge',
              message: 'CHATGPT_BRIDGE_REAL_TEST_7F31: Agent Bridge is operational on Jayanth\'s Mac.'
            };
            break;
          }

          case 'bridge_discover_agents': {
            result = {
              registeredAgents: CONFIG.AGENT_IDENTITIES,
              ziaWriteLocked: CONFIG.ZIA_WRITE_LOCKED,
              allowedRoots: CONFIG.ALLOWED_ROOTS
            };
            break;
          }

          case 'bridge_inspect_project': {
            result = await this.controller.inspectProject(args.rootPath, args.agentId);
            break;
          }

          case 'bridge_read_file': {
            result = await this.controller.readFile(args.filePath, args.agentId, args.startLine, args.endLine);
            break;
          }

          case 'bridge_search_files': {
            result = await this.controller.searchFiles(args.rootPath, args.agentId, args.query, args.isRegex);
            break;
          }

          case 'bridge_create_file': {
            result = await this.controller.createFile(args.filePath, args.agentId, args.content, args.overwrite);
            break;
          }

          case 'bridge_edit_file': {
            result = await this.controller.editFile(args.filePath, args.agentId, args.targetContent, args.replacementContent, args.expectedHash);
            break;
          }

          case 'bridge_delete_file': {
            result = await this.controller.deleteFile(args.filePath, args.agentId);
            break;
          }

          case 'bridge_execute_command': {
            result = await this.controller.executeCommand(args.commandLine, args.cwd, args.agentId);
            break;
          }

          case 'bridge_send_message': {
            result = this.mailbox.sendMessage({
              fromAgent: args.fromAgent,
              toAgent: args.toAgent,
              subject: args.subject,
              content: args.content,
              replyToId: args.replyToId
            });
            break;
          }

          case 'bridge_broadcast_message': {
            const recipients = Array.isArray(args.toAgents) ? args.toAgents : [];
            result = await Promise.all(recipients.map(toAgent => this.mailbox.sendMessage({
              fromAgent: args.fromAgent,
              toAgent,
              subject: args.subject,
              content: args.content,
              replyToId: args.replyToId
            })));
            break;
          }
          case 'bridge_check_inbox': {
            result = this.mailbox.getInbox({
              agentId: args.agentId,
              unreadOnly: args.unreadOnly
            });
            break;
          }

          case 'bridge_delegate_task': {
            result = this.mailbox.delegateTask({
              fromAgent: args.fromAgent,
              toAgent: args.toAgent,
              title: args.title,
              instructions: args.instructions,
              context: args.context
            });
            break;
          }

          case 'bridge_ask_agent': {
            result = await this.mailbox.askAgent({
              fromAgent: args.fromAgent,
              toAgent: args.toAgent,
              question: args.question,
              context: args.context
            });
            break;
          }

          case 'bridge_request_review': {
            result = this.mailbox.requestReview({
              fromAgent: args.fromAgent,
              toAgent: args.toAgent,
              filePath: args.filePath,
              description: args.description
            });
            break;
          }

          case 'bridge_get_task_status': {
            result = this.mailbox.getTask(args.taskId);
            break;
          }

          case 'bridge_submit_task_result': {
            result = this.mailbox.updateTaskStatus({
              taskId: args.taskId,
              agentId: args.agentId,
              status: args.status,
              result: args.result
            });
            break;
          }

          case 'bridge_create_collaboration': {
            result = this.collaboration.create(args);
            break;
          }
          case 'bridge_join_collaboration': {
            result = this.collaboration.join(args);
            break;
          }
          case 'bridge_leave_collaboration': {
            result = this.collaboration.leave(args);
            break;
          }
          case 'bridge_heartbeat_collaboration': {
            result = this.collaboration.heartbeat(args);
            break;
          }
          case 'bridge_get_collaboration': {
            result = this.collaboration.get(args.collaborationId);
            break;
          }
          case 'bridge_list_collaborations': {
            result = this.collaboration.list(args);
            break;
          }
          case 'bridge_post_collaboration_event': {
            result = this.collaboration.event(args);
            break;
          }
          case 'bridge_close_collaboration': {
            result = this.collaboration.close(args);
            break;
          }
          case 'bridge_file_activity_start': {
            result = this.fileActivity.start(args);
            break;
          }
          case 'bridge_file_activity_heartbeat': {
            result = this.fileActivity.heartbeat(args);
            break;
          }
          case 'bridge_file_activity_stop': {
            result = this.fileActivity.stop(args);
            break;
          }
          case 'bridge_get_file_activity': {
            result = this.fileActivity.get(args.filePath);
            break;
          }
          case 'bridge_get_all_file_activity': {
            result = this.fileActivity.getAll();
            break;
          }
          case 'bridge_get_audit_log': {
            result = this.logger.getRecentLogs(args.limit || 50);
            break;
          }

          default:
            throw new Error(`Unknown tool name: ${name}`);
        }

        return {
          content: [
            {
              type: 'text',
              text: typeof result === 'string' ? result : JSON.stringify(result, null, 2)
            }
          ]
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Error executing ${name}: ${err.message}`
            }
          ]
        };
      }
    });
  }

  async startStdio() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }
}

if (process.argv[1] && process.argv[1].endsWith('mcp-server.js')) {
  const bridge = new BridgeMcpServer();
  bridge.startStdio().catch(err => {
    console.error('Bridge MCP server error:', err);
    process.exit(1);
  });
}
