// ============================================================
// src/commands/admin/ping.js
// A simple test command to verify the bot is working
// ============================================================

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  // Command definition — what Discord sees
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check if the bot is online and working'),

  // No permission required — anyone can use this
  requiredRole: null,

  // What happens when someone uses /ping
  async execute(interaction) {
    const latency = Date.now() - interaction.createdTimestamp;

    const embed = new EmbedBuilder()
      .setTitle('🛡️ PW Defense Bot — Online')
      .setColor(0x00ff00) // Green
      .addFields(
        { name: '⚡ Bot Latency', value: `${latency}ms`, inline: true },
        { name: '🌐 API Latency', value: `${Math.round(interaction.client.ws.ping)}ms`, inline: true },
        { name: '📡 Status', value: 'All systems operational', inline: true },
      )
      .setTimestamp()
      .setFooter({ text: 'PW Defense Bot' });

    await interaction.reply({ embeds: [embed] });
  },
};
