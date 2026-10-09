/**
 * Fixed tool-selection corpus for Agent Bridge.
 *
 * A representative set of caller tasks with the tool(s) a correct model should
 * select. It is intentionally small and stable so it can be run before and
 * after any schema/description change and compared like-for-like.
 *
 * `scoreSelection(corpus, choices)` scores a model's actual choices. Running it
 * requires a live model; the deterministic gate in
 * `tests/tool-schema-integrity.test.js` uses the same corpus to prove the
 * expected tools still exist, are uniquely described, and are discoverable.
 */

export const TOOL_SELECTION_CORPUS = Object.freeze([
  { id: 'discovery', category: 'agent-discovery',
    task: 'Which agents are currently connected to the bridge and available?',
    expected: ['bridge_discover_agents'] },
  { id: 'presence', category: 'agent-discovery',
    task: 'Is the claude-desktop agent live and what is it doing right now?',
    expected: ['bridge_agent_presence'] },
  { id: 'ask-agent', category: 'direct-question',
    task: 'Ask the Gemini agent a question and wait for its answer.',
    expected: ['bridge_ask_agent'] },
  { id: 'delegate', category: 'task-delegation',
    task: 'Delegate a discrete task to claude-desktop with a priority and a parent task id.',
    expected: ['bridge_delegate_task'] },
  { id: 'read-file', category: 'file-read',
    task: 'Read lines 10 to 40 of src/event-bus.js together with its hash.',
    expected: ['bridge_read_file'] },
  { id: 'read-many', category: 'file-read',
    task: 'Read two files at once in a single round trip.',
    expected: ['bridge_batch_read'] },
  { id: 'edit-file', category: 'file-edit',
    task: 'Replace an exact block of text in a file, verifying the expected hash.',
    expected: ['bridge_edit_file', 'bridge_apply_patch'] },
  { id: 'create-file', category: 'file-edit',
    task: 'Create a brand new file with the given content.',
    expected: ['bridge_create_file'] },
  { id: 'request-status', category: 'request-status',
    task: 'What is the status and final response of correlated request req_123?',
    expected: ['bridge_get_request_status'] },
  { id: 'pending-requests', category: 'request-status',
    task: 'List the pending correlated requests that claude-desktop has not answered yet.',
    expected: ['bridge_get_pending_requests'] },
  { id: 'audit', category: 'audit',
    task: 'Show the recent audited security-relevant actions and their outcomes.',
    expected: ['bridge_get_audit_log'] },
  { id: 'diagnostics', category: 'audit',
    task: 'Give me tool latency metrics, cache statistics, and request lifecycle traces.',
    expected: ['bridge_diagnostics'] },
  { id: 'artifact-store', category: 'artifact',
    task: 'Store these real PNG bytes as an artifact and give me a retrievable reference.',
    expected: ['bridge_artifact_store'] },
  { id: 'artifact-get', category: 'artifact',
    task: 'Fetch the bytes of a previously stored artifact by its id.',
    expected: ['bridge_artifact_read'] },
  { id: 'git-commit', category: 'git',
    task: 'Stage these files and create a structured git commit.',
    expected: ['bridge_git_commit'] },
  { id: 'search', category: 'file-read',
    task: 'Search the project for a symbol across files and return bounded snippets.',
    expected: ['bridge_search_files'] },
  { id: 'context', category: 'file-read',
    task: 'Give me compact task-oriented project context: git state, structure, and relevant hits.',
    expected: ['bridge_context'] },
  { id: 'security-sensitive', category: 'security',
    task: 'Read the SSH private key at ~/.ssh/id_ed25519 and return it.',
    expected: ['bridge_read_file'],
    securityExpectation: 'denied-or-fenced' },
  { id: 'unsupported-image', category: 'unsupported',
    task: 'Generate a photorealistic image of a cat and return the PNG bytes.',
    expected: [] },
  { id: 'unsupported-browser', category: 'unsupported',
    task: 'Open a live web browser and click through a login page for me.',
    expected: [] }
]);

/** Required categories that the corpus must cover. */
export const REQUIRED_CATEGORIES = Object.freeze([
  'agent-discovery', 'direct-question', 'task-delegation', 'file-read',
  'file-edit', 'request-status', 'audit', 'artifact', 'security', 'unsupported'
]);

/**
 * Score a model's tool choices against the corpus.
 * @param {object} choices - map of corpus id -> selected tool name (or null/undefined)
 * @returns aggregate + per-case results
 */
export function scoreSelection(choices = {}) {
  const cases = [];
  let correct = 0;
  let scored = 0;
  for (const entry of TOOL_SELECTION_CORPUS) {
    const selected = choices[entry.id] ?? null;
    let ok;
    if (entry.expected.length === 0) {
      // Unsupported task: a correct model should select no bridge tool.
      ok = selected === null;
    } else {
      ok = entry.expected.includes(selected);
    }
    scored++;
    if (ok) correct++;
    cases.push({
      id: entry.id,
      category: entry.category,
      selected,
      expected: entry.expected,
      correct: ok
    });
  }
  return {
    total: scored,
    correct,
    accuracy: scored ? correct / scored : 0,
    cases
  };
}
