// ============================================================
// src/commands/military/hq.js
// /hq — Full military command dashboard
// Shows active assignments, beige exits, reservations, and readiness
// ============================================================

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { query, queryOne } = require('../../utils/database');
const { getBeigeTargets, formatTimeRemaining } = require('../../systems/beige/beigeTracker');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('hq')
    .setDescription('Military command dashboard — full overview of active operations'),

  requiredRole: 'military',

  async execute(interaction) {
    await interaction.deferReply();

    const guildId = interaction.guildId;

    // Check alliance is set up
    const guildRow = queryOne('SELECT alliance_id FROM guilds WHERE guild_id = ?', [guildId]);
    if (!guildRow?.alliance_id) {
      return interaction.editReply('❌ No alliance configured. Use `/config alliance` first.');
    }

    // Run all queries in parallel for speed
    const [
      activeAssignments,
      pendingAssignments,
      completedToday,
      activeReservations,
      watchedNations,
      watchedAlliances,
    ] = await Promise.all([
      // Active assignments (not done/cancelled)
      Promise.resolve(query(
        `SELECT * FROM target_assignments
         WHERE guild_id = ? AND status NOT IN ('completed','cancelled','expired')
         ORDER BY priority DESC, created_at ASC`,
        [guildId]
      ).rows),

      // Unaccepted assignments
      Promise.resolve(query(
        `SELECT * FROM target_assignments
         WHERE guild_id = ? AND status = 'assigned'`,
        [guildId]
      ).rows),

      // Completed in last 24 hours
      Promise.resolve(query(
        `SELECT COUNT(*) as count FROM target_assignments
         WHERE guild_id = ? AND status = 'completed'
         AND updated_at >= datetime('now', '-1 day')`,
        [guildId]
      ).rows[0]),

      // Active reservations (not expired)
      Promise.resolve(query(
        `SELECT * FROM target_reservations
         WHERE guild_id = ? AND expires_at > datetime('now')`,
        [guildId]
      ).rows),

      // Watched nations count
      Promise.resolve(query(
        'SELECT COUNT(*) as count FROM nation_watchlist WHERE guild_id = ?',
        [guildId]
      ).rows[0]),

      // Watched alliances count
      Promise.resolve(query(
        'SELECT COUNT(*) as count FROM alliance_watchlist WHERE guild_id = ?',
        [guildId]
      ).rows[0]),
    ]);

    // Fetch beige targets (requires API call)
    let beigeNations = [];
    try {
      beigeNations = await getBeigeTargets(guildId);
    } catch {
      // Don't fail the whole dashboard if beige fetch fails
    }

    // Sort beige by soonest expiry
    const soonestBeige = beigeNations
      .sort((a, b) => a.minutesRemaining - b.minutesRemaining)
      .slice(0, 5);

    // Priority emoji maps
    const priorityEmoji = { normal: '🟡', high: '🟠', critical: '🔴' };
    const statusEmoji = { assigned: '📌', accepted: '✅', in_progress: '⚔️' };

    // ── EMBED 1: OVERVIEW ───────────────────────────────────
    const overviewEmbed = new EmbedBuilder()
      .setTitle('🏴 Military HQ — Command Dashboard')
      .setColor(0xe74c3c)
      .addFields(
        {
          name: '📋 Assignments',
          value: [
            `• Active: **${activeAssignments.length}**`,
            `• Awaiting acceptance: **${pendingAssignments.length}**`,
            `• Completed today: **${completedToday?.count || 0}**`,
          ].join('\n'),
          inline: true,
        },
        {
          name: '🟡 Beige Targets',
          value: `• In beige now: **${beigeNations.length}**\n• Expiring soon (<30min): **${beigeNations.filter(n => n.minutesRemaining <= 30).length}**`,
          inline: true,
        },
        {
          name: '🔒 Reservations',
          value: `• Active holds: **${activeReservations.length}**`,
          inline: true,
        },
        {
          name: '🕵️ Intelligence',
          value: `• Watched nations: **${watchedNations?.count || 0}**\n• Watched alliances: **${watchedAlliances?.count || 0}**`,
          inline: true,
        },
      )
      .setTimestamp()
      .setFooter({ text: 'PW Defense Bot • HQ Dashboard' });

    const embeds = [overviewEmbed];

    // ── EMBED 2: ACTIVE ASSIGNMENTS ─────────────────────────
    if (activeAssignments.length > 0) {
      const assignmentLines = activeAssignments.slice(0, 8).map(a => {
        const expiresTs = Math.floor(new Date(a.expires_at).getTime() / 1000);
        return (
          `${priorityEmoji[a.priority] || '🟡'} ${statusEmoji[a.status] || '📌'} ` +
          `**[${a.target_nation_name}](https://politicsandwar.com/nation/id=${a.target_nation_id})** → <@${a.assigned_to_discord_id}>\n` +
          `└ ID: \`#${a.id}\` | Expires <t:${expiresTs}:R>`
        );
      });

      if (pendingAssignments.length > 0) {
        assignmentLines.push(`\n⚠️ **${pendingAssignments.length}** assignment(s) not yet accepted!`);
      }

      embeds.push(
        new EmbedBuilder()
          .setTitle('📋 Active Assignments')
          .setColor(0x3498db)
          .setDescription(assignmentLines.join('\n\n'))
          .setFooter({ text: activeAssignments.length > 8 ? `Showing 8 of ${activeAssignments.length}. Use /assign list for full view.` : 'Use /assign list for detailed view' })
      );
    }

    // ── EMBED 3: UPCOMING BEIGE EXITS ──────────────────────
    if (soonestBeige.length > 0) {
      const beigeLines = soonestBeige.map(n => {
        const urgency = n.minutesRemaining <= 5 ? '🔴'
                      : n.minutesRemaining <= 15 ? '🟠'
                      : n.minutesRemaining <= 60 ? '🟡' : '🟢';
        return (
          `${urgency} **[${n.nation_name}](https://politicsandwar.com/nation/id=${n.id})** — ${n.allianceName}\n` +
          `└ Expires: <t:${n.expiryTimestamp}:R> | Score: ${n.score?.toLocaleString()}`
        );
      });

      embeds.push(
        new EmbedBuilder()
          .setTitle('🟡 Upcoming Beige Exits')
          .setColor(0xf1c40f)
          .setDescription(beigeLines.join('\n\n'))
          .setFooter({ text: beigeNations.length > 5 ? `Showing 5 of ${beigeNations.length}. Use /beige for full list.` : 'Use /beige for full list with eligible attackers' })
      );
    }

    // ── EMBED 4: ACTIVE RESERVATIONS ───────────────────────
    if (activeReservations.length > 0) {
      const reserveLines = activeReservations.map(r => {
        const expiresTs = Math.floor(new Date(r.expires_at).getTime() / 1000);
        return `🔒 **[Nation ${r.nation_id}](https://politicsandwar.com/nation/id=${r.nation_id})** — <@${r.reserved_by}> | Expires <t:${expiresTs}:R>`;
      });

      embeds.push(
        new EmbedBuilder()
          .setTitle('🔒 Active Target Reservations')
          .setColor(0xe67e22)
          .setDescription(reserveLines.join('\n'))
      );
    }

    await interaction.editReply({ embeds });
  },
};
