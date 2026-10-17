import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTicket } from '../src/shared/validators.ts';

test('accepts a valid ticket', () => {
  assert.equal(validateTicket('GCD-123'), 'GCD-123');
});

test('rejects invalid or injectable ticket values', () => {
  for (const ticket of ['', 'gcd-123', 'GCD-abc', 'GCD-123; whoami', 'GCD-123 && whoami', undefined, 123]) {
    assert.throws(() => validateTicket(ticket));
  }
});
