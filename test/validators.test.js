const test = require('node:test');
const assert = require('node:assert/strict');
const { validateTicket } = require('../src/shared/validators');

test('accepts a valid ticket', () => {
  assert.equal(validateTicket('GCD-123'), 'GCD-123');
});

test('rejects invalid or injectable ticket values', () => {
  for (const ticket of ['', 'gcd-123', 'GCD-abc', 'GCD-123; whoami', 'GCD-123 && whoami']) {
    assert.throws(() => validateTicket(ticket));
  }
});
