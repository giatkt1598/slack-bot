import test from 'node:test';
import assert from 'node:assert/strict';
import { createUserNameResolver } from '../src/bot/userNames.ts';
import type { SlackUsersClient } from '../src/bot/slack.ts';

type User = NonNullable<Awaited<ReturnType<SlackUsersClient['users']['info']>>['user']>;

// A fake users.info: a user object, or an error shaped like the Slack SDK's (data.error = Slack error code).
function fakeClient(answers: Record<string, User | string>) {
  const calls: string[] = [];
  const client: SlackUsersClient = {
    users: {
      info: async ({ user }) => {
        calls.push(user);
        const answer = answers[user];
        if (typeof answer === 'string') throw Object.assign(new Error('An API error occurred'), { data: { error: answer } });
        return { user: answer };
      }
    }
  };
  return { client, calls };
}

test('prefers the display name, then the real name, then the username', async () => {
  const { client } = fakeClient({
    U1: { name: 'gia.k', real_name: 'Gia K', profile: { display_name: 'Gia', real_name: 'Gia K' } },
    U2: { name: 'gia.k', real_name: 'Gia', profile: { display_name: '', real_name: 'Gia' } }, // empty display name (common)
    U3: { name: 'linh', profile: {} }
  });
  const resolve = createUserNameResolver(client, () => {});
  assert.equal(await resolve('U1'), 'Gia');
  assert.equal(await resolve('U2'), 'Gia');
  assert.equal(await resolve('U3'), 'linh');
});

test('caches successful lookups', async () => {
  const { client, calls } = fakeClient({ U1: { profile: { display_name: 'Gia' } } });
  const resolve = createUserNameResolver(client, () => {});
  await resolve('U1');
  await resolve('U1');
  assert.deepEqual(calls, ['U1']);
});

test('falls back to the user ID on errors, warns once per user and retries later', async () => {
  const answers: Record<string, User | string> = { U1: 'missing_scope' };
  const { client, calls } = fakeClient(answers);
  const warnings: string[] = [];
  const resolve = createUserNameResolver(client, (message) => warnings.push(message));

  assert.equal(await resolve('U1'), 'U1');
  assert.equal(await resolve('U1'), 'U1');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /missing_scope/);
  assert.match(warnings[0], /users:read/);

  // Once the scope is granted the next lookup succeeds: failures are not cached.
  answers.U1 = { profile: { display_name: 'Gia' } };
  assert.equal(await resolve('U1'), 'Gia');
  assert.equal(calls.length, 3);
});
