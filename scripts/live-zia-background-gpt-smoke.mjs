import { ZiABackgroundGPT } from '../src/control-plane/zia-background-gpt.js';

const bridge = new (await import('../src/control-plane/swift-ax-bridge.js')).SwiftAXBridge();
const before = await bridge.getFrontmostApp();
const minimized = await bridge.setChatGPTMinimized(true);
await new Promise((r) => setTimeout(r, 700));

const worker = new ZiABackgroundGPT({
  timeoutMs: 45000,
  backgroundTransport: 'auto'
});
const requestId = `zia_bg_live_${Date.now()}`;
const result = await worker.send({
  requestId,
  text: `Reply with exactly ZIA_BG_LIVE_OK for request ${requestId}`
});

const after = await bridge.getFrontmostApp();
const app = await bridge.inspectApp('ChatGPT');
const finalMinimized = await bridge.setChatGPTMinimized(true);

console.log(JSON.stringify({
  before,
  minimized,
  result,
  after,
  app
}, null, 2));
