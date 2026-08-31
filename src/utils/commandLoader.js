// ============================================================
// src/utils/commandLoader.js
// Automatically finds and loads all slash commands
// ============================================================

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

async function loadCommands(client) {
  const commandsPath = path.join(__dirname, '../commands');
  
  // Get all category folders (admin, intelligence, military, reporting)
  const categoryFolders = fs.readdirSync(commandsPath);

  for (const folder of categoryFolders) {
    const folderPath = path.join(commandsPath, folder);
    
    // Skip if not a folder
    if (!fs.statSync(folderPath).isDirectory()) continue;

    // Get all .js files in this category folder
    const commandFiles = fs.readdirSync(folderPath).filter(f => f.endsWith('.js'));

    for (const file of commandFiles) {
      const filePath = path.join(folderPath, file);
      const command = require(filePath);

      // Each command file must export a "data" (command info) and "execute" (what it does)
      if ('data' in command && 'execute' in command) {
        client.commands.set(command.data.name, command);
        logger.debug(`Loaded command: /${command.data.name}`);
      } else {
        logger.warn(`Skipping ${file} — missing "data" or "execute" export`);
      }
    }
  }

  logger.info(`Total commands loaded: ${client.commands.size}`);
}

module.exports = { loadCommands };
