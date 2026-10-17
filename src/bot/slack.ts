// The slice of Slack's WebClient this bot uses. Keeps modules testable with small fakes.
export interface SlackMessage {
  channel: string;
  text: string;
  thread_ts?: string;
}

export interface SlackClient {
  chat: {
    postMessage(message: SlackMessage): Promise<{ ts?: string }>;
    update(message: SlackMessage & { ts: string }): Promise<unknown>;
  };
}

// users.info (needs the `users:read` scope), used to show creators by name in `queue`.
export interface SlackUsersClient {
  users: {
    info(args: { user: string }): Promise<{
      user?: { name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string } };
    }>;
  };
}
