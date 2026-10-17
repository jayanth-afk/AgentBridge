import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConformanceSuite } from '../interop/conformance-suite.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const bridgeMainPath = path.resolve(__dirname, '../../main.js');

export class AgentAddFlow {
  constructor(options = {}) {
    this.identityManager = options.identityManager;
    this.registry = options.registry || new Map();
    this.conformanceSuite = options.conformanceSuite || new ConformanceSuite();
  }

  /**
   * Initiate agent onboarding flow.
   * Generates token, creates disabled registration, and runs conformance suite.
   */
  async startOnboarding(agentId, options = {}) {
    if (!agentId || typeof agentId !== 'string') {
      throw new Error('agentId is required and must be a string');
    }

    const cleanId = agentId.trim().toLowerCase();
    const routeType = options.routeType || 'mcp';
    const isMock = Boolean(options.isMock ?? true);

    // 1. Generate cryptographically strong scoped token (shown once)
    const rawToken = `ab_tok_${crypto.randomBytes(24).toString('hex')}`;
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    // 2. Prepare MCP configuration snippet
    const mcpConfigSnippet = {
      mcpServers: {
        'agent-bridge': {
          command: 'node',
          args: [bridgeMainPath],
          env: {
            BRIDGE_AGENT_ID: cleanId,
            BRIDGE_AUTH_TOKEN: rawToken
          }
        }
      }
    };

    // 3. Stable protocol instructions
    const protocolInstructions = `
[AGENT BRIDGE CONNECTION PROTOCOL]
You are connected to Agent Bridge as '${cleanId}'.
To converse with other agents, use:
- bridge_ask_agent({ targetAgent, prompt })
- bridge_get_response({ requestId })
- bridge_answer_request({ requestId, answer })
All requests carry V2 correlation headers and strict default-deny permission guards.
`;

    // 4. Register agent as DISABLED initially
    const registrationRecord = {
      id: cleanId,
      status: 'disabled',
      routeType,
      isMock,
      tokenHash,
      createdAt: new Date().toISOString(),
      userApproved: false
    };
    this.registry.set(cleanId, registrationRecord);

    // 5. Run Conformance Suite
    const scorecard = await this.conformanceSuite.runSuite(registrationRecord);

    return {
      agentId: cleanId,
      status: 'disabled',
      rawToken,
      mcpConfigSnippet,
      protocolInstructions: protocolInstructions.trim(),
      scorecard,
      readyForApproval: scorecard.passed,
      approvalInstructions: `To activate '${cleanId}', review the scorecard and invoke approveRegistration('${cleanId}', { userApproved: true })`
    };
  }

  /**
   * Complete registration ONLY upon explicit human confirmation.
   */
  approveRegistration(agentId, options = {}) {
    const { userApproved = false, approver = 'user' } = options;
    if (!userApproved) {
      throw new Error('Registration activation rejected: explicit user approval is required.');
    }

    const normApprover = String(approver || '').trim().toLowerCase();
    if (
      !normApprover ||
      normApprover.startsWith('agent:') ||
      normApprover.includes('agent') ||
      normApprover.includes('gemini') ||
      normApprover.includes('chatgpt') ||
      normApprover.includes('claude') ||
      normApprover.includes('antigravity') ||
      normApprover.includes('freebuff')
    ) {
      throw new Error('Agents cannot self-enable or promote their registration.');
    }

    const record = this.registry.get(agentId);
    if (!record) {
      throw new Error(`Agent '${agentId}' not found in registry.`);
    }

    record.status = 'enabled';
    record.userApproved = true;
    record.approvedAt = new Date().toISOString();
    record.approvedBy = approver;

    return {
      agentId,
      status: 'enabled',
      approvedBy: approver,
      activatedAt: record.approvedAt
    };
  }
}
