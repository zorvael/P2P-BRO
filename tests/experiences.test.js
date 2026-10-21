import test from 'node:test';
import assert from 'node:assert/strict';
import { capsuleStatus, createCapsule, createTrustGate, isValidExperiencePacket, TRUST_QUESTIONS } from '../src/experiences.js';

test('time capsules validate a future local date and retain an explicit UTC instant', () => {
  const now = Date.parse('2030-02-01T12:00:00Z');
  const capsule = createCapsule({ title: 'Dear future me', content: 'Keep going.', unlockAt: '2030-02-02T08:30' }, now);
  assert.equal(capsule.title, 'Dear future me');
  assert.equal(capsule.unlockAt, new Date('2030-02-02T08:30').toISOString());
  assert.equal(capsuleStatus(capsule, now), 'waiting');
  assert.equal(capsuleStatus(capsule, Date.parse(capsule.unlockAt)), 'ready to unlock');
  capsule.openedAt = new Date().toISOString();
  assert.equal(capsuleStatus(capsule, now), 'opened');
});

test('time capsules reject invalid, past, blank, and oversized content', () => {
  const now = 1_800_000_000_000;
  assert.throws(() => createCapsule({ title: '', content: 'x', unlockAt: new Date(now + 1000).toISOString() }, now));
  assert.throws(() => createCapsule({ title: 'x', content: 'x', unlockAt: 'not-a-date' }, now));
  assert.throws(() => createCapsule({ title: 'x', content: 'x', unlockAt: new Date(now - 1000).toISOString() }, now));
  assert.throws(() => createCapsule({ title: 'x', content: 'x'.repeat(5001), unlockAt: new Date(now + 1000).toISOString() }, now));
  assert.throws(() => createCapsule({ title: 'x', content: 'photo', unlockAt: new Date(now + 1000).toISOString(), photoData: 'https://example.com/picture.png' }, now));
  assert.equal(createCapsule({ title: 'photo', content: '', unlockAt: new Date(now + 1000).toISOString(), kind: 'photo', photoData: `data:image/png;base64,${'A'.repeat(100)}` }, now).kind, 'photo');
});

test('room experience packets are scoped by a type and bounded to 24 KB', () => {
  assert.equal(isValidExperiencePacket({ type: 'experience', feature: 'moment', action: 'add', eventId: 'one' }), true);
  assert.equal(isValidExperiencePacket({ type: 'message', feature: 'moment', action: 'add' }), false);
  assert.equal(isValidExperiencePacket({ type: 'experience', feature: 'moment', action: 'add', text: 'x'.repeat(25_000) }), false);
  assert.equal(TRUST_QUESTIONS.friendship.length, 2);
});

test('Trust Mirror waits for every active participant, rejects duplicates, and completes after a departure', () => {
  const participants = ['host', 'a', 'b'];
  const gate = createTrustGate(() => participants);
  assert.equal(gate.setCategory('light'), true);
  const first = { participant: 'host', category: 'light', answers: ['one', ''] };
  assert.deepEqual(gate.submit(first), { accepted: true, reveal: null });
  assert.equal(gate.submit(first).accepted, false);
  assert.deepEqual(gate.submit({ participant: 'a', category: 'light', answers: ['two', 'three'] }), { accepted: true, reveal: null });
  participants.splice(participants.indexOf('b'), 1);
  assert.deepEqual(gate.leave('b'), { category: 'light', answers: { host: ['one', ''], a: ['two', 'three'] } });
  assert.equal(gate.submit({ participant: 'a', category: 'light', answers: ['again', ''] }).accepted, false);
  assert.equal(gate.setCategory('friendship'), false);
});
