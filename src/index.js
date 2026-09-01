// ============================================================
// src/index.js — The main file. This is where the bot starts.
// ============================================================

require('dotenv').config();

const { Client, GatewayIntentBits, Collection } = require('discord.js');
const { loadCommands } = require('./utils/commandLoader');
const { loadEvents } = require('./utils/eventLoader');
const { connectDatabase, saveDatabase } = require('./utils/database');
const logger = require('./utils/logger');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.commands = new Collection();

async function main() {
  try {
    logger.info('Starting PW Defense Bot...');

    // Give Railway's volume mount a moment to fully attach before we touch
    // the database path. Without this, there's a race where the app can
    // start and create/write its database file on the container's ephemeral
    // local disk a moment BEFORE the persistent volume finishes mounting
    // over that same path — meaning every restart looks like a fresh
    // install ("Created new database") even with a volume correctly
    // attached, because the existence check ran too early to see it.
    if (process.env.RAILWAY_ENVIRONMENT_NAME) {
      logger.info('Waiting for volume mount to settle...');
      await new Promise(r => setTimeout(r, 3000));
    }

    // Step 1: Connect to database (sql.js needs await)
    await connectDatabase();
    logger.info('✅ Database ready');

    // Step 2: Load all commands
    await loadCommands(client);
    logger.info('✅ Commands loaded');

    // Step 3: Load all event handlers
    await loadEvents(client);
    logger.info('✅ Events loaded');

    // Step 4: Log into Discord
    await client.login(process.env.DISCORD_TOKEN);

  } catch (error) {
    logger.error('❌ Failed to start bot:', error);
    process.exit(1);
  }
}

// Save database safely if the bot is shut down with Ctrl+C
process.on('SIGINT', () => {
  saveDatabase();
  logger.info('Bot shut down. Database saved.');
  process.exit(0);
});

main();
