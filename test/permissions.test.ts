import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { config, canCancel } from '../src/config.ts';

// config is a plain mutable object read at call time; restore it when the test ends.
function withLists(t: TestContext, users: string[], channels: string[] = []) {
  const saved = { users: config.authorizedUserIds, channels: config.authorizedChannelIds };
  config.authorizedUserIds = users;
  config.authorizedChannelIds = channels;
  t.after(() => {
    config.authorizedUserIds = saved.users;
    config.authorizedChannelIds = saved.channels;
  });
}

const jobOfB = { channelId: 'D1', userId: 'UB' };

test('without AUTHORIZED_USER_IDS only the creator can cancel a job', (t) => {
  withLists(t, []);
  assert.equal(canCancel('UB', jobOfB), true);
  assert.equal(canCancel('UA', jobOfB), false);
});

test('with AUTHORIZED_USER_IDS, listed users can cancel anyone\'s job and unlisted users cannot', (t) => {
  withLists(t, ['UA', 'UB']);
  assert.equal(canCancel('UA', jobOfB), true); // A cancels B's job
  assert.equal(canCancel('UB', jobOfB), true);
  assert.equal(canCancel('UC', jobOfB), false);
  assert.equal(canCancel('UC', { channelId: 'C1', userId: 'UC' }), false); // not even their own: not listed
});

test('the channel allowlist still applies to cancelling', (t) => {
  withLists(t, ['UA'], ['C9']);
  assert.equal(canCancel('UA', { channelId: 'C1', userId: 'UB' }), false);
  assert.equal(canCancel('UA', { channelId: 'C9', userId: 'UB' }), true);
});
