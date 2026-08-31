// ============================================================
// src/commands/intelligence/intel.js
// /intel — Full intelligence dashboard
// Shows watchlisted nations, enemy alliances, recent changes
// ============================================================

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { query, queryOne } = require('../../utils/database');
const { getAllianceInfo, getAllianceMembers } = require('../../utils/pwApi');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('intel')
    .setDescription('Intelligence dashboard — enemy activity and watchlist overview'),

  requiredRole: 'military',

  async execute(interaction) {
    await interaction.deferReply();

    const guildId = interaction.guildId;

    // Gather watchlist data from DB
    const watchedNations   = query('SELECT * FROM nation_watchlist WHERE guild_id = ? ORDER BY priority_level DESC', [guildId]).rows;
    const watchedAlliances = query('SELECT * FROM alliance_watchlist WHERE guild_id = ?', [guildId]).rows;
    const enemyAlliances   = watchedAlliances.filter(a => a.watchlist_type === 'enemy');
    const friendlyAlliances = watchedAlliances.filter(a => a.watchlist_type === 'friendly');

    const embeds = [];

    // ── EMBED 1: OVERVIEW ────────────────────────────────────
    embeds.push(
      new EmbedBuilder()
        .setTitle('🕵️ Intelligence Dashboard')
        .setColor(0x2c3e50)
        .addFields(
          { name: '⚔️ Enemy Alliances Tracked', value: `${enemyAlliances.length}`, inline: true },
          { name: '🤝 Friendly Alliances Tracked', value: `${friendlyAlliances.length}`, inline: true },
          { name: '👁️ Individual Nations Watched', value: `${watchedNations.length}`, inline: true },
        )
        .setTimestamp()
        .setFooter({ text: 'PW Defense Bot • Intelligence System' })
    );

    // ── EMBED 2: ENEMY ALLIANCES ─────────────────────────────
    if (enemyAlliances.length > 0) {
      await interaction.editReply('⏳ Fetching enemy alliance data from P&W...');

      const allianceLines = [];
      for (const ea of enemyAlliances.slice(0, 5)) {
        try {
          const members = await getAllianceMembers(ea.alliance_id);
          const totalAircraft  = members.reduce((s, m) => s + (m.aircraft || 0), 0);
          const totalTanks     = members.reduce((s, m) => s + (m.tanks || 0), 0);
          const activeWars     = members.reduce((s, m) => s + (m.offensive_wars_count || 0), 0);
          const inVacation     = members.filter(m => m.vacation_mode_turns > 0).length;

          allianceLines.push(
            `⚔️ **[${ea.alliance_name}](https://politicsandwar.com/alliance/id=${ea.alliance_id})**\n` +
            `└ Members: **${members.length}** | Vacation: ${inVacation}\n` +
            `└ ✈️ ${totalAircraft.toLocaleString()} aircraft | 🚗 ${totalTanks.toLocaleString()} tanks | ⚔️ ${activeWars} active wars`
            + (ea.notes ? `\n└ _${ea.notes}_` : '')
          );
        } catch {
          allianceLines.push(
            `⚔️ **[${ea.alliance_name}](https://politicsandwar.com/alliance/id=${ea.alliance_id})**\n└ _Could not fetch live data_`
          );
        }
      }

      embeds.push(
        new EmbedBuilder()
          .setTitle('⚔️ Enemy Alliance Intelligence')
          .setColor(0xe74c3c)
          .setDescription(allianceLines.join('\n\n'))
          .setFooter({ text: enemyAlliances.length > 5 ? `Showing 5 of ${enemyAlliances.length} enemy alliances` : 'Use /watch alliance add to track more alliances' })
      );
    }

    // ── EMBED 3: WATCHED NATIONS ─────────────────────────────
    if (watchedNations.length > 0) {
      const priorityEmoji = { critical: '🔴', high: '🟠', normal: '🟡' };
      const lines = watchedNations.slice(0, 15).map(n =>
        `${priorityEmoji[n.priority_level] || '🟡'} **[${n.nation_name}](https://politicsandwar.com/nation/id=${n.nation_id})**` +
        (n.notes ? ` — _${n.notes}_` : '')
      );

      embeds.push(
        new EmbedBuilder()
          .setTitle(`👁️ Watched Nations (${watchedNations.length})`)
          .setColor(0x8e44ad)
          .setDescription(lines.join('\n'))
          .setFooter({
            text: watchedNations.length > 15
              ? `Showing 15 of ${watchedNations.length} — use /watch nation list for full list`
              : 'Use /watch nation add to track individual nations'
          })
      );
    }

    // ── EMBED 4: FRIENDLY ALLIANCES ──────────────────────────
    if (friendlyAlliances.length > 0) {
      const lines = friendlyAlliances.map(a =>
        `🤝 **[${a.alliance_name}](https://politicsandwar.com/alliance/id=${a.alliance_id})**` +
        (a.notes ? ` — _${a.notes}_` : '')
      );
      embeds.push(
        new EmbedBuilder()
          .setTitle('🤝 Friendly/Neutral Alliances')
          .setColor(0x2ecc71)
          .setDescription(lines.join('\n'))
      );
    }

    // If nothing is set up yet
    if (watchedNations.length === 0 && watchedAlliances.length === 0) {
      embeds.push(
        new EmbedBuilder()
          .setColor(0x95a5a6)
          .setDescription(
            '📋 No watchlists configured yet.\n\n' +
            'Get started:\n' +
            '• `/watch alliance add` — track an enemy alliance\n' +
            '• `/watch nation add` — track a specific nation'
          )
      );
    }

    await interaction.editReply({ content: '', embeds });
  },
};
