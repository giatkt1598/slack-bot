import { config as loadEnv } from 'dotenv';

loadEnv({ quiet: true });

function csv(value: string | undefined): string[] {
  return (value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

export const config = {
  slackBotToken: process.env.SLACK_BOT_TOKEN,
  slackAppToken: process.env.SLACK_APP_TOKEN,
  databasePath: process.env.DATABASE_PATH || './data/slack-bot.sqlite',
  commandTimeoutMs: Number(process.env.COMMAND_TIMEOUT_MS || 1800000),
  inputTimeoutMs: Number(process.env.INPUT_TIMEOUT_MS || 1800000),
  authorizedChannelIds: csv(process.env.AUTHORIZED_CHANNEL_IDS),
  authorizedUserIds: csv(process.env.AUTHORIZED_USER_IDS),
  logLevel: process.env.LOG_LEVEL || 'info'
};

export function assertBotConfig(): { botToken: string; appToken: string } {
  const { slackBotToken: botToken, slackAppToken: appToken } = config;
  if (!botToken) throw new Error('Missing required environment variable SLACK_BOT_TOKEN');
  if (!appToken) throw new Error('Missing required environment variable SLACK_APP_TOKEN');
  return { botToken, appToken };
}

export function isAuthorized(channelId: string, userId: string): boolean {
  const channelOk = !config.authorizedChannelIds.length || config.authorizedChannelIds.includes(channelId);
  const userOk = !config.authorizedUserIds.length || config.authorizedUserIds.includes(userId);
  return channelOk && userOk;
}
