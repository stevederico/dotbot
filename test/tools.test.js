import { test, describe } from 'node:test';
import assert from 'node:assert';
import { coreTools } from '../tools/index.js';

describe('coreTools', () => {
  test('exports an array of tools', () => {
    assert.ok(Array.isArray(coreTools));
    assert.ok(coreTools.length > 0);
  });

  test('all tools have required properties', () => {
    for (const tool of coreTools) {
      assert.ok(tool.name, `Tool missing name`);
      assert.ok(tool.description, `Tool ${tool.name} missing description`);
      assert.ok(tool.parameters, `Tool ${tool.name} missing parameters`);
      assert.strictEqual(tool.parameters.type, 'object', `Tool ${tool.name} parameters.type must be object`);
    }
  });

  test('tool names are unique', () => {
    const names = coreTools.map(t => t.name);
    const unique = new Set(names);
    assert.strictEqual(names.length, unique.size, 'Duplicate tool names found');
  });

  test('tool names are snake_case', () => {
    for (const tool of coreTools) {
      assert.ok(/^[a-z][a-z0-9_]*$/.test(tool.name), `Tool ${tool.name} should be snake_case`);
    }
  });

  test('contains expected core tools', () => {
    const names = coreTools.map(t => t.name);
    assert.ok(names.includes('memory_save'), 'Missing memory_save');
    assert.ok(names.includes('web_search'), 'Missing web_search');
    assert.ok(names.includes('file_read'), 'Missing file_read');
    assert.ok(names.includes('weather_get'), 'Missing weather_get');
  });

  test('has at least 40 tools', () => {
    assert.ok(coreTools.length >= 40, `Expected 40+ tools, got ${coreTools.length}`);
  });
});
