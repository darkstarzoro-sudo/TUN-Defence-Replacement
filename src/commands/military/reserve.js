// ============================================================
// src/commands/military/reserve.js
// Temporarily hold a target to prevent double-attacking
// ============================================================

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { run, queryOne, query } = require('../../utils/database');
const { resolveNation } = require('../../utils/pwApi');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('reserve')
    .setDescription('Temporarily reserve a target to prevent double-attacks')

    .addSubcommand(sub =>
      sub.setName('add')
        .setDescription('Reserve a target nation for yourself')
        .addStringOption(opt =>
          opt.setName('target')
            .setDescription('Nation name, ID, or P&W link')
            .setRequired(true)
        )
        .addIntegerOption(opt =>
          opt.setName('duration')
            .setDescription('How long to hold the reservation (default: 30 min)')
            .addChoices(
              { name: '10 minutes', value: 10 },
              { name: '30 minutes', value: 30 },
              { name: '1 hour', value: 60 },
              { name: '2 hours', value: 120 },
            )
        )
    )

    .addSubcommand(sub =>
      sub.setName('release')
        .setDescription('Release your reservation on a target')
        .addStringOption(opt =>
          opt.setName('target')
            .setDescription('Nation name, ID, or P&W link')
            .setRequired(true)
        )
    )

    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('See all currently reserved targets')
    ),

  requiredRole: 'military',

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    // Clean up expired reservations first on every command
    run(`DELETE FROM target_reservations WHERE expires_at < datetime('now')`);

    // ── ADD ─────────────────────────────────────────────────
    if (sub === 'add') {
      await interaction.deferReply();
      const input = interaction.options.getString('target');
      const duration = interaction.options.getInteger('duration') || 30;

      await interaction.editReply(`🔍 Looking up **${input}**...`);

      const nation = await resolveNation(input);
      if (!nation) {
        return interaction.editReply(`❌ Could not find nation **"${input}"**. Try the exact name, ID, or P&W link.`);
      }

      // Check if already reserved by someone else
      const existing = queryOne(
        'SELECT * FROM target_reservations WHERE guild_id = ? AND nation_id = ?',
        [interaction.guildId, nation.id]
      );

      if (existing) {
        const expiresTs = Math.floor(new Date(existing.expires_at).getTime() / 1000);
        if (existing.reserved_by === interaction.user.id) {
          return interaction.editReply(
            `⚠️ You already have **${nation.nation_name}** reserved.\nYour reservation expires <t:${expiresTs}:R>.`
          );
        }
        return interaction.editReply(
          `❌ **${nation.nation_name}** is already reserved by <@${existing.reserved_by}>.\nTheir reservation expires <t:${expiresTs}:R>.`
        );
      }

      const expiresAt = new Date(Date.now() + duration * 60 * 1000).toISOString();
      const expiresTs = Math.floor(new Date(expiresAt).getTime() / 1000);

      run(
        `INSERT INTO target_reservations (guild_id, nation_id, reserved_by, expires_at)
         VALUES (?, ?, ?, ?)`,
        [interaction.guildId, nation.id, interaction.user.id, expiresAt]
      );

      const embed = new EmbedBuilder()
        .setTitle('🔒 Target Reserved')
        .setColor(0xe67e22)
        .addFields(
          { name: '🎯 Nation', value: `[${nation.nation_name}](https://politicsandwar.com/nation/id=${nation.id})`, inline: true },
          { name: '🏛️ Alliance', value: nation.alliance?.name || 'None', inline: true },
          { name: '⭐ Score', value: nation.score?.toLocaleString() || '?', inline: true },
          { name: '👤 Reserved By', value: `<@${interaction.user.id}>`, inline: true },
          { name: '⏰ Expires', value: `<t:${expiresTs}:R> (<t:${expiresTs}:t>)`, inline: true },
        )
        .setFooter({ text: 'Use /reserve release to free this target early' })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    // ── RELEASE ─────────────────────────────────────────────
    if (sub === 'release') {
      await interaction.deferReply({ flags: 64 });
      const input = interaction.options.getString('target');

      // Try to find in reservations by ID first (no API call needed)
      let nationId = null;
      let nationName = input;

      if (/^\d+$/.test(input.trim())) {
        nationId = parseInt(input.trim());
      } else {
        // Try to match by looking up the nation
        const nation = await resolveNation(input);
        if (nation) {
          nationId = nation.id;
          nationName = nation.nation_name;
        }
      }

      if (!nationId) {
        return interaction.editReply(`❌ Could not find nation **"${input}"**.`);
      }

      const reservation = queryOne(
        'SELECT * FROM target_reservations WHERE guild_id = ? AND nation_id = ?',
        [interaction.guildId, nationId]
      );

      if (!reservation) {
        return interaction.editReply(`❌ No active reservation found for that nation.`);
      }

      // Only the person who reserved it (or an admin) can release it
      const { checkPermission } = require('../../utils/permissions');
      const isAdmin = checkPermission(interaction, 'government');
      if (reservation.reserved_by !== interaction.user.id && !isAdmin) {
        return interaction.editReply(`❌ You can only release your own reservations.`);
      }

      run('DELETE FROM target_reservations WHERE guild_id = ? AND nation_id = ?',
        [interaction.guildId, nationId]);

      return interaction.editReply(`✅ Reservation on **${nationName}** has been released.`);
    }

    // ── LIST ────────────────────────────────────────────────
    if (sub === 'list') {
      const reservations = query(
        `SELECT * FROM target_reservations WHERE guild_id = ? ORDER BY expires_at ASC`,
        [interaction.guildId]
      ).rows;

      if (reservations.length === 0) {
        return interaction.reply({ content: '📋 No targets are currently reserved.', flags: 64 });
      }

      const lines = reservations.map(r => {
        const expiresTs = Math.floor(new Date(r.expires_at).getTime() / 1000);
        return (
          `🔒 **[Nation ID: ${r.nation_id}](https://politicsandwar.com/nation/id=${r.nation_id})**\n` +
          `└ Reserved by: <@${r.reserved_by}> | Expires: <t:${expiresTs}:R>`
        );
      });

      const embed = new EmbedBuilder()
        .setTitle(`🔒 Active Reservations — ${reservations.length}`)
        .setColor(0xe67e22)
        .setDescription(lines.join('\n\n'))
        .setFooter({ text: 'Expired reservations are cleared automatically' })
        .setTimestamp();

      return interaction.reply({ embeds: [embed], flags: 64 });
    }
  },
};
