import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { wrapText, paintRows, visibleRows } from '../bin/tui.js';

describe('wrapText', () => {
  it('wraps long words', () => {
    const rows = wrapText('abcdefghij', 4);
    assert.deepEqual(rows, ['abcd', 'efgh', 'ij']);
  });

  it('keeps short lines', () => {
    assert.deepEqual(wrapText('hi there', 20), ['hi there']);
  });

  it('preserves blank lines', () => {
    assert.deepEqual(wrapText('a\n\nb', 10), ['a', '', 'b']);
  });
});

describe('paintRows', () => {
  it('prefixes user lines', () => {
    const rows = paintRows([{ kind: 'user', text: 'hello' }], 40);
    assert.ok(rows[0]?.startsWith('you › '));
    assert.ok(rows[0]?.includes('hello'));
  });
});

describe('visibleRows', () => {
  it('shows the bottom when scrollUp is 0', () => {
    const rows = ['a', 'b', 'c', 'd', 'e'];
    assert.deepEqual(visibleRows(rows, 3, 0), ['c', 'd', 'e']);
  });

  it('scrolls up', () => {
    const rows = ['a', 'b', 'c', 'd', 'e'];
    assert.deepEqual(visibleRows(rows, 3, 2), ['a', 'b', 'c']);
  });
});
