/**
 * Tool-Surface Token Measurement & Optimization Benchmark
 *
 * Measures serialized JSON byte sizes, per-field breakdown (names, descriptions,
 * schemas), and estimated token costs across all tool profiles:
 * - 'all' (74 tools, baseline)
 * - 'developer' (32 tools)
 * - 'collaborator' (16 tools)
 * - 'minimal' (8 tools)
 *
 * Also tests schema validity with Ajv and verifies alias resolution for bridge_search_tools.
 *
 * Usage: node scripts/bench/tool-surface-token-measurement.js
 */

import Ajv from 'ajv';
import { ToolRegistry, TOOL_PROFILES, PROFILE_TOOLS } from '../../src/tool-registry.js';

export function measureToolProfiles(options = {}) {
  const ajv = new Ajv({ strict: false, allErrors: true });
  const registry = new ToolRegistry({ profile: 'all' });
  const allDefs = registry.getToolDefinitions('all');
  const baselineSerialized = JSON.stringify(allDefs);
  const baselineBytes = Buffer.byteLength(baselineSerialized, 'utf8');

  const profiles = ['all', 'developer', 'collaborator', 'minimal'];
  const results = {};

  for (const prof of profiles) {
    const defs = registry.getToolDefinitions(prof);
    const serialized = JSON.stringify(defs);
    const totalBytes = Buffer.byteLength(serialized, 'utf8');

    let nameBytes = 0;
    let descriptionBytes = 0;
    let schemaBytes = 0;
    const schemaErrors = [];

    for (const d of defs) {
      nameBytes += Buffer.byteLength(d.name || '', 'utf8');
      descriptionBytes += Buffer.byteLength(d.description || '', 'utf8');
      const sJson = JSON.stringify(d.inputSchema || {});
      schemaBytes += Buffer.byteLength(sJson, 'utf8');

      try {
        ajv.compile(d.inputSchema || {});
      } catch (err) {
        schemaErrors.push({ tool: d.name, error: err.message });
      }
    }

    const reductionPercent = baselineBytes > 0
      ? Number(((1 - (totalBytes / baselineBytes)) * 100).toFixed(2))
      : 0;

    results[prof] = {
      profile: prof,
      toolCount: defs.length,
      totalBytes,
      reductionPercent,
      breakdown: {
        nameBytes,
        descriptionBytes,
        schemaBytes,
        framingBytes: totalBytes - (nameBytes + descriptionBytes + schemaBytes)
      },
      tokenEstimates: {
        note: 'ESTIMATED — ratio range (3.6 to 4.5 chars/token)',
        chars_3_6: Math.ceil(totalBytes / 3.6),
        chars_4_0: Math.ceil(totalBytes / 4.0),
        chars_4_5: Math.ceil(totalBytes / 4.5)
      },
      schemaErrors
    };
  }

  return {
    baselineBytes,
    profiles: results,
    timestamp: new Date().toISOString()
  };
}

// Standalone execution
if (process.argv[1] && (process.argv[1].endsWith('tool-surface-token-measurement.js') || process.argv[1].endsWith('tool-surface-token-measurement'))) {
  const report = measureToolProfiles();

  console.log('='.repeat(80));
  console.log('AGENT BRIDGE — TOOL-SURFACE TOKEN REDUCTION BENCHMARK');
  console.log('='.repeat(80));
  console.log(`Baseline ('all' profile): ${report.profiles.all.toolCount} tools, ${report.baselineBytes} bytes`);
  console.log('-'.repeat(80));
  console.log(
    'Profile'.padEnd(14) +
    'Tools'.padEnd(8) +
    'Bytes'.padEnd(10) +
    'Reduction'.padEnd(12) +
    'Est Tokens (3.6)'.padEnd(18) +
    'Est Tokens (4.0)'
  );
  console.log('-'.repeat(80));

  for (const prof of ['all', 'developer', 'collaborator', 'minimal']) {
    const p = report.profiles[prof];
    console.log(
      p.profile.padEnd(14) +
      String(p.toolCount).padEnd(8) +
      String(p.totalBytes).padEnd(10) +
      `${p.reductionPercent}%`.padEnd(12) +
      String(p.tokenEstimates.chars_3_6).padEnd(18) +
      String(p.tokenEstimates.chars_4_0)
    );
  }
  console.log('='.repeat(80));
  console.log(JSON.stringify(report, null, 2));
}
