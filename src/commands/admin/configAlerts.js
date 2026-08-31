// ============================================================
// src/commands/admin/configAlerts.js
// /alerts — Configure personal alert preferences
// /config-alerts — Configure guild-wide alert settings (admin)
// ============================================================

const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { run, query, queryOne } = require('../../utils/database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('alerts')
    .setDescription('Configure alert settings')

    // /alerts beige — personal toggle
    .addSubcommandGroup(group =>
      group.setName('beige')
        .setDescription('Beige alert preferences')
        .addSubcommand(sub =>
          sub.setName('on')
            .setDescription('Enable beige DM alerts for yourself')
        )
        .addSubcommand(sub =>
          sub.setName('off')
            .setDescription('Disable beige DM alerts for yourself')
        )
    )

    // /alerts intervals — admin sets timing
    .addSubcommand(sub =>
      sub.setName('intervals')
        .setDescription('(Admin) Set beige alert intervals in minutes')
        .addStringOption(opt =>
          opt.setName('minutes')
            .setDescription('Comma-separated minutes before beige expires. Example: 60,30,15,5')
            .setRequired(true)
        )
    )

    // /alerts view
    .addSubcommand(sub =>
      sub.setName('view')
        .setDescription('View current alert configuration')
    ),

  requiredRole: null, // Handled per-subcommand below

  async execute(interaction) {
    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand();

    // Personal DM toggle — anyone can use this
    if (group === 'beige') {
      const enabled = sub === 'on' ? 1 : 0;
      run(
        `INSERT INTO user_alert_preferences (guild_id, discord_user_id, alert_type, dm_enabled)
         VALUES (?, ?, 'beige', ?)
         ON CONFLICT(guild_id, discord_user_id, alert_type) DO UPDATE SET dm_enabled = ?`,
        [interaction.guildId, interaction.user.id, enabled, enabled]
      );
      return interaction.reply({
        content: enabled
          ? '✅ You will now receive beige alerts via DM.'
          : '✅ You will no longer receive beige alerts via DM.',
        flags: 64,
      });
    }

    // Admin-only: set intervals
    if (sub === 'intervals') {
      if (!interaction.member.permissions.has('Administrator')) {
        return interaction.reply({ content: '❌ Only administrators can change alert intervals.', flags: 64 });
      }

      const raw = interaction.options.getString('minutes');
      const intervals = raw.split(',')
        .map(s => parseInt(s.trim()))
        .filter(n => !isNaN(n) && n > 0)
        .sort((a, b) => b - a); // Highest first

      if (intervals.length === 0) {
        return interaction.reply({ content: '❌ No valid intervals found. Example: `60,30,15,5`', flags: 64 });
      }

      run(
        `INSERT INTO alert_settings (guild_id, alert_type, setting_key, setting_value)
         VALUES (?, 'beige', 'intervals', ?)
         ON CONFLICT(guild_id, alert_type, setting_key) DO UPDATE SET setting_value = ?`,
        [interaction.guildId, JSON.stringify(intervals), JSON.stringify(intervals)]
      );

      return interaction.reply({
        content: `✅ Beige alert intervals set to: **${intervals.join(', ')} minutes** before expiry.`,
        flags: 64,
      });
    }

    // View current settings
    if (sub === 'view') {
      const intervalRow = queryOne(
        `SELECT setting_value FROM alert_settings WHERE guild_id = ? AND alert_type = 'beige' AND setting_key = 'intervals'`,
        [interaction.guildId]
      );
      const intervals = intervalRow ? JSON.parse(intervalRow.setting_value) : [60, 30, 15, 5];

      const embed = new EmbedBuilder()
        .setTitle('🔔 Alert Configuration')
        .setColor(0x3498db)
        .addFields(
          {
            name: '⏰ Beige Alert Intervals',
            value: intervals.map(i => `• ${i} minutes before expiry`).join('\n'),
          },
          {
            name: '💡 How to change',
            value: 'Use `/alerts intervals 60,30,15,5` to set custom intervals.\nUse `/alerts beige on` to receive personal DM alerts.',
          }
        )
        .setTimestamp();

      return interaction.reply({ embeds: [embed], flags: 64 });
    }
  },
};
