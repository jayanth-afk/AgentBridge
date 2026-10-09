/**
 * MCP tool-schema measurement + integrity gate.
 *
 * Reports the EXACT serialized size of the tool definitions the bridge serves
 * over `tools/list`, a per-section breakdown, and a clearly-labelled token
 * ESTIMATE (no tokenizer for the serving models is bundled, so this is not an
 * exact provider token count).
 *
 * Also validates every inputSchema with ajv and runs the fixed tool-selection
 * corpus as a determinism gate. If a model's choices are supplied with
 * `--choices <file.json>` it scores them with the same corpus.
 *
 * Usage: node scripts/bench/bench-tool-schema.mjs [--choices choices.json]
 */
import fs from 'node:fs';
import Ajv from 'ajv';
import { ToolRegistry } from '../../src/tool-registry.js';
import { TOOL_SELECTION_CORPUS, REQUIRED_CATEGORIES, scoreSelection } from './tool-selection-corpus.mjs';

const choicesIdx = process.argv.indexOf('--choices');
const choicesFile = choicesIdx >= 0 ? process.argv[choicesIdx + 1] : null;

const registry = new ToolRegistry();
const defs = registry.getToolDefinitions();

const serialized = JSON.stringify(defs);
const names = defs.map(d => d.name);
const nameSet = new Set(names);

let descBytes = 0;
let schemaBytes = 0;
let nameBytes = 0;
for (const d of defs) {
  nameBytes += (d.name || '').length;
  descBytes += (d.description || '').length;
  schemaBytes += JSON.stringify(d.inputSchema || {}).length;
}

// Validate every schema and check required-key sanity.
const ajv = new Ajv({ strict: false, allErrors: true });
const schemaErrors = [];
for (const d of defs) {
  const schema = d.inputSchema || {};
  try {
    ajv.compile(schema);
  } catch (err) {
    schemaErrors.push({ tool: d.name, error: err.message });
  }
  const props = schema.properties || {};
  for (const req of schema.required || []) {
    if (!(req in props)) schemaErrors.push({ tool: d.name, error: `required '${req}' not in properties` });
  }
  if (!d.description || d.description.trim().length < 10) {
    schemaErrors.push({ tool: d.name, error: 'description missing or too short to disambiguate' });
  }
}

// Duplicate descriptions would make tool selection ambiguous.
const descCounts = new Map();
for (const d of defs) descCounts.set(d.description, (descCounts.get(d.description) || 0) + 1);
const duplicateDescriptions = [...descCounts.entries()].filter(([, n]) => n > 1).map(([d]) => d);

// Corpus coverage gate.
const missingExpected = [];
const uncoveredCategories = [];
for (const entry of TOOL_SELECTION_CORPUS) {
  for (const t of entry.expected) {
    if (!nameSet.has(t)) missingExpected.push({ id: entry.id, tool: t });
  }
}
for (const cat of REQUIRED_CATEGORIES) {
  if (!TOOL_SELECTION_CORPUS.some(e => e.category === cat)) uncoveredCategories.push(cat);
}

const nonAscii = serialized.length; // bytes == chars here for JSON we control

const report = {
  toolCount: defs.length,
  serializedBytes: nonAscii,
  breakdown: { nameBytes, descriptionBytes: descBytes, schemaBytes },
  tokenEstimate: {
    note: 'ESTIMATE only — no serving-model tokenizer is bundled. Reported as a range across common chars-per-token ratios.',
    chars_per_token_3_6: Math.ceil(serialized.length / 3.6),
    chars_per_token_4_0: Math.ceil(serialized.length / 4.0),
    chars_per_token_4_5: Math.ceil(serialized.length / 4.5)
  },
  integrity: {
    schemaErrors,
    duplicateDescriptions: duplicateDescriptions.map(d => d.slice(0, 60)),
    missingExpected,
    uncoveredCategories
  }
};

if (choicesFile) {
  const choices = JSON.parse(fs.readFileSync(choicesFile, 'utf8'));
  report.selection = scoreSelection(choices);
} else {
  report.selection = {
    ran: false,
    reason: 'No model choices supplied (--choices). LLM-based tool-selection evaluation requires a live model and was not run.'
  };
}

console.log(JSON.stringify(report, null, 2));
const fatal = schemaErrors.length || duplicateDescriptions.length || missingExpected.length || uncoveredCategories.length;
process.exit(fatal ? 1 : 0);
