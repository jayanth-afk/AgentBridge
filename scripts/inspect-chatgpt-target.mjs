import { SwiftAXBridge } from '../src/control-plane/swift-ax-bridge.js';

const bridge = new SwiftAXBridge();
const app = await bridge.inspectApp('ChatGPT');
const elements = await bridge.inspectElements('ChatGPT');

console.log(JSON.stringify({
  app,
  matches: (elements.elements || []).filter((e) => {
    const s = [e.title, e.description, e.identifier, e.value].filter(Boolean).join(' ');
    return /ZiA Response/i.test(s);
  })
}, null, 2));
