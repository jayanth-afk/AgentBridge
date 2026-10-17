import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { CompletionEvidenceTier } from '../src/control-plane/route-interface.js';

test('B3 Evidence Tier Producers: every declared tier must have at least one active producer in src/', () => {
  const srcDir = path.resolve('src');

  // Recursively collect all JS files in src/
  function getJsFiles(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    let files = [];
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files = files.concat(getJsFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        files.push(fullPath);
      }
    }
    return files;
  }

  const allFiles = getJsFiles(srcDir);
  const fileContents = allFiles.map(filePath => ({
    filePath,
    content: fs.readFileSync(filePath, 'utf8')
  }));

  // Canonical tiers defined in CompletionEvidenceTier (excluding aliases)
  const canonicalTiers = [
    CompletionEvidenceTier.AUTHENTICATED_SUBMIT,
    CompletionEvidenceTier.NETWORK_END_OF_STREAM,
    CompletionEvidenceTier.PROCESS_EXIT,
    CompletionEvidenceTier.A2A_COMPLETION,
    CompletionEvidenceTier.UI_STOP_IDLE,
    CompletionEvidenceTier.STABILITY_HEURISTIC
  ];

  const definitionFile = path.resolve('src/control-plane/route-interface.js');

  for (const tier of canonicalTiers) {
    // Find all occurrences where tier is assigned, emitted, or produced
    // Exclude the definition file itself
    const producers = [];

    for (const { filePath, content } of fileContents) {
      if (filePath === definitionFile) continue;

      // Regex pattern to check if the file references this tier as a value
      const hasTierRef = content.includes(`CompletionEvidenceTier.${tier}`) ||
        content.includes(`'${tier}'`) ||
        content.includes(`"${tier}"`);

      if (hasTierRef) {
        // Exclude test mocks or comment-only matches by checking for code context
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (
            (line.includes(`CompletionEvidenceTier.${tier}`) || line.includes(`'${tier}'`) || line.includes(`"${tier}"`)) &&
            !line.trim().startsWith('//') &&
            !line.trim().startsWith('*') &&
            !line.includes('CONFIDENCE_RANK')
          ) {
            producers.push({ file: path.relative(srcDir, filePath), line: i + 1, snippet: line.trim() });
          }
        }
      }
    }

    assert.ok(
      producers.length > 0,
      `Evidence tier '${tier}' has zero producers in src/! A declared tier must have production code behind it.`
    );
  }
});
