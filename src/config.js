require('dotenv').config({ quiet: true });

function csv(value) {
  return (value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

const config = {
  slackBotToken: process.env.SLACK_BOT_TOKEN,
  slackAppToken: process.env.SLACK_APP_TOKEN,
  redis: {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT || 6379)
  },
  queuePrefix: process.env.QUEUE_PREFIX || 'command-jobs',
  databasePath: process.env.DATABASE_PATH || './data/slack-bot.sqlite',
  commandTimeoutMs: Number(process.env.COMMAND_TIMEOUT_MS || 1800000),
  inputTimeoutMs: Number(process.env.INPUT_TIMEOUT_MS || 1800000),
  gcmdBin: process.env.GCMD_BIN || 'gcmd',
  authorizedChannelIds: csv(process.env.AUTHORIZED_CHANNEL_IDS),
  authorizedUserIds: csv(process.env.AUTHORIZED_USER_IDS),
  logLevel: process.env.LOG_LEVEL || 'info'
};

function assertBotConfig() {
  for (const key of ['slackBotToken', 'slackAppToken']) {
    if (!config[key]) throw new Error(`Missing required environment variable for ${key}`);
  }
}

function isAuthorized(channelId, userId) {
  const channelOk = !config.authorizedChannelIds.length || config.authorizedChannelIds.includes(channelId);
  const userOk = !config.authorizedUserIds.length || config.authorizedUserIds.includes(userId);
  return channelOk && userOk;
}

module.exports = { config, assertBotConfig, isAuthorized };
