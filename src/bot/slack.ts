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
