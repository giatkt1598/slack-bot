import type { SlackUsersClient } from './slack.ts';

// Resolves user IDs to plain-text names for the `queue` listing (never @mentions, so nobody is notified).
// Many users leave their Slack display name empty, so it falls back to the real name, then the username.
// Successful lookups are cached; failures are not (so they recover once the scope is granted) and fall back
// to the user ID, logging the Slack error once per user so the cause (usually `missing_scope`) is visible.
export function createUserNameResolver(client: SlackUsersClient, warn: (message: string) => void = console.warn) {
  const names = new Map<string, string>();
  const warned = new Set<string>();

  return async function resolveUserName(userId: string): Promise<string> {
    const cached = names.get(userId);
    if (cached) return cached;
    try {
      const { user } = await client.users.info({ user: userId });
      const name = user?.profile?.display_name || user?.profile?.real_name || user?.real_name || user?.name;
      if (!name) throw new Error('user has no name');
      names.set(userId, name);
      return name;
    } catch (error) {
      if (!warned.has(userId)) {
        warned.add(userId);
        const code = (error as { data?: { error?: string } }).data?.error ?? (error as Error).message;
        warn(`[queue] could not look up the name of ${userId} (${code}); showing the user ID. Does the app have the users:read scope (reinstalled after adding it)?`);
      }
      return userId;
    }
  };
}
