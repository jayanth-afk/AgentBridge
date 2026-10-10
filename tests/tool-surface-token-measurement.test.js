import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import { ToolRegistry, TOOL_PROFILES, PROFILE_TOOLS } from '../src/tool-registry.js';
import { measureToolProfiles } from '../scripts/bench/tool-surface-token-measurement.js';

test('Tool-Surface Token Reduction & Profile Measurement Suite', async (t) => {
  const ajv = new Ajv({ strict: false, allErrors: true });

  await t.test('1. Default profile is "all" and serves exactly 74 tools (backward compatibility)', () => {
    const registry = new ToolRegistry();
    assert.strictEqual(registry.profile, 'all');
    const defs = registry.getToolDefinitions();
    assert.strictEqual(defs.length, 74, `Expected 74 tools, got ${defs.length}`);
  });

  await t.test('2. Profile filtering yields exact tool counts (minimal: 8, collaborator: 16, developer: 32)', () => {
    const registry = new ToolRegistry();

    const minimal = registry.getToolDefinitions('minimal');
    assert.strictEqual(minimal.length, 8);
    const minNames = minimal.map(t => t.name);
    assert.ok(minNames.includes('bridge_ping'));
    assert.ok(minNames.includes('bridge_discover_tools'));
    assert.ok(minNames.includes('bridge_tool_info'));
    assert.ok(minNames.includes('bridge_ask_agent'));
    assert.ok(minNames.includes('bridge_get_response'));

    const collaborator = registry.getToolDefinitions('collaborator');
    assert.strictEqual(collaborator.length, 16);
    const colNames = collaborator.map(t => t.name);
    assert.ok(colNames.includes('bridge_send_message'));
    assert.ok(colNames.includes('bridge_claim_task'));

    const developer = registry.getToolDefinitions('developer');
    assert.strictEqual(developer.length, 32);
    const devNames = developer.map(t => t.name);
    assert.ok(devNames.includes('bridge_read_file'));
    assert.ok(devNames.includes('bridge_git_status'));
    assert.ok(devNames.includes('bridge_execute_command'));
  });

  await t.test('3. Constructor honors options.profile and environment variable AGENT_BRIDGE_TOOL_PROFILE', () => {
    const regOpt = new ToolRegistry({ profile: 'minimal' });
    assert.strictEqual(regOpt.profile, 'minimal');
    assert.strictEqual(regOpt.getToolDefinitions().length, 8);

    const origEnv = process.env.AGENT_BRIDGE_TOOL_PROFILE;
    try {
      process.env.AGENT_BRIDGE_TOOL_PROFILE = 'collaborator';
      const regEnv = new ToolRegistry();
      assert.strictEqual(regEnv.profile, 'collaborator');
      assert.strictEqual(regEnv.getToolDefinitions().length, 16);
    } finally {
      if (origEnv !== undefined) {
        process.env.AGENT_BRIDGE_TOOL_PROFILE = origEnv;
      } else {
        delete process.env.AGENT_BRIDGE_TOOL_PROFILE;
      }
    }
  });

  await t.test('4. Benchmark confirms token reductions meet targets (>85% minimal, >70% collaborator, >50% developer)', () => {
    const metrics = measureToolProfiles();

    assert.ok(metrics.profiles.minimal.reductionPercent > 85, `Minimal reduction was ${metrics.profiles.minimal.reductionPercent}%`);
    assert.ok(metrics.profiles.collaborator.reductionPercent > 70, `Collaborator reduction was ${metrics.profiles.collaborator.reductionPercent}%`);
    assert.ok(metrics.profiles.developer.reductionPercent > 50, `Developer reduction was ${metrics.profiles.developer.reductionPercent}%`);

    assert.strictEqual(metrics.profiles.minimal.schemaErrors.length, 0);
    assert.strictEqual(metrics.profiles.collaborator.schemaErrors.length, 0);
    assert.strictEqual(metrics.profiles.developer.schemaErrors.length, 0);
    assert.strictEqual(metrics.profiles.all.schemaErrors.length, 0);
  });

  await t.test('5. bridge_search_tools alias executes identically to bridge_discover_tools via executeTool', async () => {
    const registry = new ToolRegistry({ profile: 'minimal' });

    const discoverResult = await registry.executeTool('bridge_discover_tools', { query: 'agent' });
    const searchResult = await registry.executeTool('bridge_search_tools', { query: 'agent' });

    assert.strictEqual(discoverResult.matchedCount, searchResult.matchedCount);
    assert.deepStrictEqual(
      discoverResult.tools.map(t => t.name),
      searchResult.tools.map(t => t.name)
    );
  });

  await t.test('6. bridge_tool_info resolves bridge_search_tools alias correctly', async () => {
    const registry = new ToolRegistry();

    const info = await registry.executeTool('bridge_tool_info', { toolName: 'bridge_search_tools' });
    assert.strictEqual(info.name, 'bridge_discover_tools');
    assert.strictEqual(info.category, 'discovery');
    assert.ok(info.inputSchema);
  });

  await t.test('7. bridge_discover_tools discovers across all 74 tools even when active profile is "minimal"', async () => {
    const registry = new ToolRegistry({ profile: 'minimal' });
    assert.strictEqual(registry.getToolDefinitions().length, 8);

    const res = await registry.executeTool('bridge_discover_tools', {});
    assert.strictEqual(res.totalAvailable, 74, 'Discovers all 74 tools across bridge');
    assert.strictEqual(res.matchedCount, 74);
  });

  await t.test('8. Tools unadvertised in minimal profile remain executable directly via executeTool', async () => {
    const registry = new ToolRegistry({ profile: 'minimal' });

    // bridge_diagnostics is in developer and all, but omitted from minimal
    const minimalNames = registry.getToolDefinitions().map(t => t.name);
    assert.ok(!minimalNames.includes('bridge_diagnostics'));

    const { DiagnosticsManager } = await import('../src/diagnostics-manager.js');
    const diagnostics = new DiagnosticsManager();

    // Yet calling it directly succeeds without throwing 'Unknown tool'
    const result = await registry.executeTool('bridge_diagnostics', {}, { diagnostics });
    assert.ok(result);
    assert.strictEqual(result.agent, 'freebuff');
    assert.strictEqual(result.state, 'OFFLINE');
  });

  await t.test('9. All tool schemas across all profiles pass Ajv compilation without errors', () => {
    const registry = new ToolRegistry();
    const all = registry.getToolDefinitions('all');

    for (const tool of all) {
      assert.doesNotThrow(() => {
        const validate = ajv.compile(tool.inputSchema || {});
        assert.strictEqual(typeof validate, 'function');
      }, `Schema for ${tool.name} failed compilation`);
    }
  });

  await t.test('10. BridgeHttpServer honors toolProfile option in its registry initialization', async () => {
    const { BridgeHttpServer } = await import('../src/http-server.js');
    const srv = new BridgeHttpServer({ toolProfile: 'minimal', port: 0 });
    assert.strictEqual(srv.registry.profile, 'minimal');
    assert.strictEqual(srv.registry.getToolDefinitions().length, 8);
  });
});
