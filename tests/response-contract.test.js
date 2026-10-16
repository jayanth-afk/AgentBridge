import test from 'node:test';
import assert from 'node:assert/strict';

import {
  enforceResponseContract,
  normalizeContract,
  stripPreambleAndTrailer,
  countWords,
  DEFAULT_MIN_REMAINING_WORDS
} from '../src/protocol/response-contract.js';
import { ToolRegistry } from '../src/tool-registry.js';

// The answer-only response contract (M3) reduces the tokens a requester pays to
// read a delegated answer. It must never damage a genuine answer, so these tests
// weight safety (non-removal) at least as heavily as the reduction itself.

const LONG_BODY =
  'The settlement path writes the durable row before it dispatches the completion ' +
  'event, so a late reader can always re-attach to the terminal state without ' +
  'polling the mailbox repeatedly until the row finally appears.';

test('Response contract: normalizeContract shapes', async (t) => {
  await t.test('1. true is shorthand for answerOnly', () => {
    const c = normalizeContract(true);
    assert.equal(c.answerOnly, true);
    assert.equal(c.forbidPreamble, true);
    assert.equal(c.minRemainingWords, DEFAULT_MIN_REMAINING_WORDS);
  });

  await t.test('2. absent contract means nothing is enforced', () => {
    const c = normalizeContract(undefined);
    assert.equal(c.answerOnly, false);
    assert.equal(c.forbidPreamble, false);
    assert.equal(c.maxWords, null);
  });

  await t.test('3. invalid maxWords/format are ignored, not thrown', () => {
    const c = normalizeContract({ maxWords: -3, format: 42 });
    assert.equal(c.maxWords, null);
    assert.equal(c.format, null);
  });
});

test('Response contract: safety (must never damage a genuine answer)', async (t) => {
  await t.test('1. A leading negation is NOT stripped', () => {
    const text = `Certainly not — ${LONG_BODY}`;
    const r = enforceResponseContract(text, { answerOnly: true });
    assert.equal(r.applied, false);
    assert.equal(r.text, text);
  });

  await t.test('2. A short answer is never reduced to nothing', () => {
    const r = enforceResponseContract('Sure! 42', { answerOnly: true });
    assert.equal(r.applied, false);
    assert.equal(r.text, 'Sure! 42');
  });

  await t.test('3. Fenced code blocks and body indentation are preserved', () => {
    const text = `Here is the answer:\n\n\`\`\`js\nfunction f() {\n    return 42;\n}\n\`\`\`\n${LONG_BODY}`;
    const r = enforceResponseContract(text, { answerOnly: true });
    assert.ok(r.text.includes('function f() {\n    return 42;\n}'), 'code body must be byte-identical');
  });

  await t.test('4. No contract supplied -> text is returned unchanged', () => {
    const r = enforceResponseContract(`Sure! ${LONG_BODY}`);
    assert.equal(r.text, `Sure! ${LONG_BODY}`);
    assert.equal(r.applied, false);
  });

  await t.test('5. countWords ignores bare punctuation', () => {
    assert.equal(countWords('one, two; three!'), 3);
    assert.equal(countWords('   '), 0);
  });
});

test('Response contract: deterministic stripping', async (t) => {
  await t.test('1. Same-line interjection plus clause are both removed', () => {
    const r = enforceResponseContract(`Sure! Here is the answer:\n\n${LONG_BODY}`, { answerOnly: true });
    assert.equal(r.applied, true);
    assert.equal(r.removedLeading.length, 2);
    assert.equal(r.text, LONG_BODY);
    assert.ok(r.charsSaved > 0);
    assert.ok(r.tokensSaved > 0);
    assert.equal(r.isEstimate, true);
  });

  await t.test('2. Stacked trailing offers of help are both removed', () => {
    const text = `${LONG_BODY}\n\nHope this helps! Let me know if you want me to open a PR for it.`;
    const r = enforceResponseContract(text, true);
    assert.equal(r.applied, true);
    assert.equal(r.removedTrailing.length, 2);
    assert.equal(r.text, LONG_BODY);
  });

  await t.test('3. Byte savings are reported truthfully', () => {
    const text = `Sure! ${LONG_BODY}`;
    const r = enforceResponseContract(text, { answerOnly: true });
    assert.equal(r.originalChars, text.length);
    assert.equal(r.finalChars, r.text.length);
    assert.equal(r.charsSaved, text.length - r.text.length);
  });

  await t.test('4. stripPreambleAndTrailer is idempotent', () => {
    const once = stripPreambleAndTrailer(`Sure! ${LONG_BODY}`);
    const twice = stripPreambleAndTrailer(once.text);
    assert.equal(twice.text, once.text);
    assert.equal(twice.removedLeading.length, 0);
  });
});

test('Response contract: violations are reported, not enforced destructively', async (t) => {
  await t.test('1. maxWords overrun is reported and the text is untouched', () => {
    const r = enforceResponseContract('one two three', { maxWords: 2 });
    assert.equal(r.text, 'one two three');
    assert.ok(r.violations.some(v => v.startsWith('MAX_WORDS_EXCEEDED')));
  });

  await t.test('2. Invalid JSON for a json contract is reported', () => {
    const r = enforceResponseContract('not json', { format: 'json' });
    assert.ok(r.violations.includes('FORMAT_JSON_INVALID'));
  });

  await t.test('3. Valid JSON for a json contract reports no violation', () => {
    const r = enforceResponseContract('{"ok":true}', { format: 'json' });
    assert.equal(r.violations.length, 0);
  });
});

test('Response contract: tool wiring', async (t) => {
  const registry = new ToolRegistry();

  await t.test('1. bridge_submit_task_result strips and reports before settlement', async () => {
    let captured = null;
    const args = {
      taskId: 'task_1',
      agentId: 'claude-desktop',
      status: 'completed',
      result: `Sure! Here is the answer:\n\n${LONG_BODY}`,
      contract: { answerOnly: true }
    };
    const handler = registry.tools.get('bridge_submit_task_result').handler;
    const outcome = await handler(args, {
      mailbox: { submitTaskResult: async (a) => { captured = a; return { ok: true, taskId: a.taskId }; } },
      logger: { log() {} }
    });

    assert.equal(captured.result, LONG_BODY, 'durable layer must receive the stripped answer');
    assert.ok(outcome.contractReport, 'contract report must be surfaced');
    assert.equal(outcome.contractReport.applied, true);
    assert.ok(outcome.contractReport.tokensSaved > 0);
  });

  await t.test('2. No contract -> durable payload is byte-identical to the input', async () => {
    let captured = null;
    const raw = `Sure! Here is the answer:\n\n${LONG_BODY}`;
    const handler = registry.tools.get('bridge_submit_task_result').handler;
    const outcome = await handler(
      { taskId: 'task_2', agentId: 'claude-desktop', status: 'completed', result: raw },
      { mailbox: { submitTaskResult: async (a) => { captured = a; return { ok: true }; } }, logger: { log() {} } }
    );

    assert.equal(captured.result, raw);
    assert.equal(outcome.contractReport, undefined);
  });

  await t.test('3. bridge_answer_request honours the contract on the response field', async () => {
    let captured = null;
    const handler = registry.tools.get('bridge_answer_request').handler;
    const outcome = await handler(
      {
        requestId: 'req_1',
        agentId: 'claude-desktop',
        response: `Sure! ${LONG_BODY}`,
        contract: true
      },
      { mailbox: { answerRequest: async (a) => { captured = a; return { ok: true }; } }, logger: { log() {} } }
    );

    assert.equal(captured.response, LONG_BODY);
    assert.equal(outcome.contractReport.applied, true);
  });

  await t.test('4. Both tools advertise the contract schema', () => {
    for (const name of ['bridge_submit_task_result', 'bridge_answer_request']) {
      const schema = registry.tools.get(name).inputSchema;
      assert.ok(schema.properties.contract, `${name} must expose a contract property`);
      assert.ok(schema.properties.contract.properties.answerOnly);
    }
  });
});
