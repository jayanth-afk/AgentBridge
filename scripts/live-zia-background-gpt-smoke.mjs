import { ZiABackgroundGPT } from '../src/control-plane/zia-background-gpt.js';

const bridge = new (await import('../src/control-plane/swift-ax-bridge.js')).SwiftAXBridge();
const before = await bridge.getFrontmostApp();

const worker = new ZiABackgroundGPT({
  timeoutMs: 45000,
  backgroundTransport: 'auto'
});
const primed = await worker.primeBackgroundWindow();
const nonFrontmost = primed.ok
  ? await worker.verifyBackgroundNonFrontmost()
  : primed;
const requestId = `zia_bg_live_${Date.now()}`;
const result = await worker.send({
  requestId,
  text: `Reply with exactly ZIA_BG_LIVE_OK for request ${requestId}`
});

const after = await bridge.getFrontmostApp();
const app = await bridge.inspectApp('ChatGPT');
const finalNonFrontmost = await worker.verifyBackgroundNonFrontmost();

console.log(JSON.stringify({
  before,
  primed,
  nonFrontmost,
  result,
  after,
  app,
  finalNonFrontmost
}, null, 2));
