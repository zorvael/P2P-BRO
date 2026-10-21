import test from 'node:test';
import assert from 'node:assert/strict';
import { globalValidation } from '../inbox-worker/src/index.js';
import globalChatWorker from '../inbox-worker/src/index.js';

const origin = 'https://zorvael.github.io';

test('Global Chat fails closed when the persistent database is not configured', async () => {
  const response = await globalChatWorker.fetch(new Request('https://worker.example/api/global/status', { headers: { Origin: origin } }), { DB: null, ALLOWED_ORIGINS: origin });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'unavailable');
});

test('Global Chat message feed requires an authenticated session', async () => {
  const response = await globalChatWorker.fetch(new Request('https://worker.example/api/global/messages', { headers: { Origin: origin } }), { DB: {}, ALLOWED_ORIGINS: origin });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, 'unauthorized');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
});

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
