// ============================================================
// scripts/deploy-commands.js
// Run this ONCE to register slash commands with Discord.
// Usage: node scripts/deploy-commands.js
// ============================================================

require('dotenv').config();
const { REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');

const commands = [];
const commandsPath = path.join(__dirname, '../src/commands');
const categoryFolders = fs.readdirSync(commandsPath);

// Collect all command definitions
for (const folder of categoryFolders) {
  const folderPath = path.join(commandsPath, folder);
  if (!fs.statSync(folderPath).isDirectory()) continue;

  const commandFiles = fs.readdirSync(folderPath).filter(f => f.endsWith('.js'));
  for (const file of commandFiles) {
    const command = require(path.join(folderPath, file));
    if ('data' in command) {
      commands.push(command.data.toJSON());
      console.log(`  Found command: /${command.data.name}`);
    }
  }
}

// Send them to Discord
const rest = new REST().setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log(`\nRegistering ${commands.length} command(s) with Discord...\n`);

    await rest.put(
      Routes.applicationGuildCommands(
        process.env.DISCORD_CLIENT_ID,
        process.env.DISCORD_GUILD_ID
      ),
      { body: commands }
    );

    console.log('✅ Commands registered successfully!');
    console.log('   You should now see the commands in Discord.');
  } catch (error) {
    console.error('❌ Failed to register commands:', error);
  }
})();
