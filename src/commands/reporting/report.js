// ============================================================
// src/commands/reporting/report.js
// /report — Manually trigger reports on demand
// ============================================================

const { SlashCommandBuilder } = require('discord.js');
const { generateDailyReport } = require('../../jobs/reportJob');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('report')
    .setDescription('Generate and send alliance reports')

    .addSubcommand(sub =>
      sub.setName('daily')
        .setDescription('Send the daily alliance report right now (same as the automated one)')
    ),

  requiredRole: 'government',

  async execute(interaction, client) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'daily') {
      await interaction.reply({ content: '⏳ Generating daily report...', flags: 64 });

      try {
        await generateDailyReport(client);
        await interaction.editReply('✅ Daily report sent to your configured channel.');
      } catch (err) {
        await interaction.editReply(`❌ Failed to generate report: ${err.message}`);
      }
    }
  },
};
