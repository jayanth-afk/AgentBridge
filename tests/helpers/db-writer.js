// Child-process helper: simulates ONE agent's own bridge process writing to the
// shared SQLite file. ChatGPT, Claude and Antigravity each spawn their own
// mcp-server.js, so real multi-agent use is multi-process on one DB file.
import { AuditLogger } from '../../src/audit-logger.js';
import { CollaborationManager } from '../../src/collaboration-manager.js';
import { FileActivityManager } from '../../src/file-activity-manager.js';
import { MailboxHub } from '../../src/mailbox-hub.js';

const [dbPath, agentId, collaborationId, filePath, countStr] = process.argv.slice(2);
const count = Number(countStr);

const logger = new AuditLogger(dbPath);
const collab = new CollaborationManager(logger);
const activity = new FileActivityManager(logger, { ttlMs: 120000 });
const mailbox = new MailboxHub(logger);

collab.join({ collaborationId, agentId, role: 'participant' });
activity.start({ filePath, agentId, activityType: 'editing', collaborationId });

for (let i = 0; i < count; i++) {
  collab.event({ collaborationId, agentId, eventType: 'finding', payload: { i } });
  collab.heartbeat({ collaborationId, agentId });
  activity.heartbeat({ filePath, agentId, activityType: 'editing' });
  mailbox.sendMessage({ fromAgent: agentId, toAgent: 'system', subject: 'load', content: String(i) });
}

// Intentionally NOT stopping file activity: the parent asserts that all agents'
// activity on the same file is visible simultaneously.
logger.close();
