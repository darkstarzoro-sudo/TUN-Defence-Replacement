// ============================================================
// src/commands/intelligence/beige.js
// /beige — Shows all currently tracked beige nations
// ============================================================

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getBeigeTargets, formatTimeRemaining } = require('../../systems/beige/beigeTracker');
const { queryOne } = require('../../utils/database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('beige')
    .setDescription('Show all currently tracked nations in beige')
    .addStringOption(opt =>
      opt.setName('sort')
        .setDescription('Sort by...')
        .addChoices(
          { name: 'Soonest expiry first (default)', value: 'soonest' },
          { name: 'Latest expiry first', value: 'latest' },
          { name: 'Highest score first', value: 'score' },
        )
    ),

  requiredRole: 'military',

  async execute(interaction) {
    await interaction.deferReply(); // Show "thinking..." while we fetch data

    // Check alliance is configured
    const guildRow = queryOne('SELECT alliance_id FROM guilds WHERE guild_id = ?', [interaction.guildId]);
    if (!guildRow?.alliance_id) {
      return interaction.editReply('❌ No alliance configured. Use `/config alliance` first.');
    }

    const targets = await getBeigeTargets(interaction.guildId);

    if (targets.length === 0) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle('🟡 Beige Tracker')
            .setColor(0xf1c40f)
            .setDescription('No tracked nations are currently in beige.\n\nMake sure you have enemy alliances set up with `/watch alliance add`.')
            .setTimestamp()
        ]
      });
    }

    // Sort the results
    const sort = interaction.options.getString('sort') || 'soonest';
    const sorted = [...targets].sort((a, b) => {
      if (sort === 'soonest') return a.minutesRemaining - b.minutesRemaining;
      if (sort === 'latest') return b.minutesRemaining - a.minutesRemaining;
      if (sort === 'score') return b.score - a.score;
      return 0;
    });

    // Build one embed per page (max 10 nations per embed to keep it clean)
    const pageSize = 10;
    const page = sorted.slice(0, pageSize);

    const lines = page.map((n, i) => {
      const urgency = n.minutesRemaining <= 5 ? '🔴'
                    : n.minutesRemaining <= 15 ? '🟠'
                    : n.minutesRemaining <= 60 ? '🟡'
                    : '🟢';

      return [
        `${urgency} **[${n.nation_name}](https://politicsandwar.com/nation/id=${n.id})**`,
        `┣ Alliance: ${n.allianceName}`,
        `┣ Score: ${n.score?.toLocaleString()} | Cities: ${n.num_cities}`,
        `┗ Expires: <t:${n.expiryTimestamp}:R>`,
      ].join('\n');
    });

    const embed = new EmbedBuilder()
      .setTitle(`🟡 Beige Tracker — ${targets.length} Nation(s) in Beige`)
      .setColor(0xf1c40f)
      .setDescription(lines.join('\n\n'))
      .setFooter({
        text: `Showing ${page.length} of ${targets.length} • 🔴 <5min 🟠 <15min 🟡 <1hr 🟢 1hr+`
      })
      .setTimestamp();

    if (targets.length > pageSize) {
      embed.addFields({
        name: '📋 Note',
        value: `Showing first ${pageSize} results. Use the sort option to change order.`,
      });
    }

    await interaction.editReply({ embeds: [embed] });
  },
};
