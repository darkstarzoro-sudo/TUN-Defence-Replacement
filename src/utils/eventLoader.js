// ============================================================
// src/utils/eventLoader.js
// Automatically finds and loads all Discord event handlers
// ============================================================

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

async function loadEvents(client) {
  const eventsPath = path.join(__dirname, '../events');
  const eventFiles = fs.readdirSync(eventsPath).filter(f => f.endsWith('.js'));

  for (const file of eventFiles) {
    const filePath = path.join(eventsPath, file);
    const event = require(filePath);

    // "once" means it only fires one time (like when the bot first logs in)
    if (event.once) {
      client.once(event.name, (...args) => event.execute(...args));
    } else {
      client.on(event.name, (...args) => event.execute(...args, client));
    }

    logger.debug(`Loaded event: ${event.name}`);
  }
}

module.exports = { loadEvents };
