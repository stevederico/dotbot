import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  extractErrorHint,
  formatFailoverAttempt,
  formatFailoverMessage,
} from '../core/failover.js';

describe('failover error message hints', () => {
  test('extractErrorHint reads Pro free-credit JSON', () => {
    assert.equal(
      extractErrorHint(JSON.stringify({ error: 'free credit used', paid_required: true })),
      'free credit used',
    );
  });

  test('extractErrorHint reads nested error.message', () => {
    assert.equal(
      extractErrorHint(JSON.stringify({ error: { message: 'model not found' } })),
      'model not found',
    );
  });

  test('extractErrorHint empty body', () => {
    assert.equal(extractErrorHint(''), '');
    assert.equal(extractErrorHint('   '), '');
  });

  test('formatFailoverAttempt includes body hint', () => {
    assert.equal(
      formatFailoverAttempt({
        provider: 'dottiepro',
        status: 429,
        body: JSON.stringify({ error: 'free credit used' }),
      }),
      'dottiepro(429): free credit used',
    );
  });

  test('formatFailoverAttempt status-only when body empty', () => {
    assert.equal(
      formatFailoverAttempt({ provider: 'xai', status: 502, body: '' }),
      'xai(502)',
    );
  });

  test('formatFailoverMessage free credit path', () => {
    const msg = formatFailoverMessage([
      {
        provider: 'dottiepro',
        status: 429,
        body: JSON.stringify({ error: 'free credit used', paid_required: true }),
      },
    ]);
    assert.equal(msg, 'All providers failed: dottiepro(429): free credit used');
    assert.match(msg, /free credit used/);
  });
});
