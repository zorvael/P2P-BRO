import test from 'node:test';
import assert from 'node:assert/strict';
import { globalValidation } from '../inbox-worker/src/index.js';

test('Global Chat requires a valid adult birth date without retaining it', () => {
  const now = Date.parse('2026-10-21T12:00:00Z');
  assert.equal(globalValidation.ageIsAdult('2008-10-21', now), true);
  assert.equal(globalValidation.ageIsAdult('2008-10-22', now), false);
  assert.equal(globalValidation.ageIsAdult('2027-01-01', now), false);
  assert.equal(globalValidation.ageIsAdult('2000-02-30', now), false);
  assert.equal(globalValidation.ageIsAdult('', now), false);
});

test('Global Chat validates nicknames and password bounds on the server', () => {
  assert.equal(globalValidation.validNickname('Tanmay 22'), true);
  assert.equal(globalValidation.validNickname('नमस्ते'), true);
  assert.equal(globalValidation.validNickname('x'), false);
  assert.equal(globalValidation.validNickname('name<script>'), false);
  assert.equal(globalValidation.validPassword('1234567890'), true);
  assert.equal(globalValidation.validPassword('short'), false);
  assert.equal(globalValidation.validPassword('x'.repeat(129)), false);
});
