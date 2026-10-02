import { BridgeMcpServer } from './mcp-server.js';
import { CONFIG } from './config.js';

console.log('Starting Agent Bridge with config:');
console.log(`- Allowed Roots: ${CONFIG.ALLOWED_ROOTS.join(', ')}`);
console.log(`- Zia Write Locked: ${CONFIG.ZIA_WRITE_LOCKED}`);
console.log(`- Test Workspace: ${CONFIG.TEST_WORKSPACE}`);
console.log(`- Audit DB: ${CONFIG.DB_PATH}`);

const server = new BridgeMcpServer();
server.startStdio().catch(err => {
  console.error('Fatal bridge error:', err);
  process.exit(1);
});
