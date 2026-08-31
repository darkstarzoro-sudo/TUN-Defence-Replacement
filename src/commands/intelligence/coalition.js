// ============================================================
// src/commands/intelligence/coalition.js
// /coalition — Track coalition partners and compare combined
// military strength against enemy coalitions
// ============================================================

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { query, run, queryOne } = require('../../utils/database');
const { resolveAlliance, getAllianceMembers } = require('../../utils/pwApi');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('coalition')
    .setDescription('Manage coalition partners and compare combined strength')

    .addSubcommand(sub =>
      sub.setName('add')
        .setDescription('Add an alliance to your coalition')
        .addStringOption(opt =>
          opt.setName('alliance')
            .setDescription('Alliance name, ID, or P&W link')
            .setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('side')
            .setDescription('Which side is this alliance on?')
            .setRequired(true)
            .addChoices(
              { name: '🤝 Our side (friendly)', value: 'friendly' },
              { name: '⚔️ Enemy side', value: 'enemy' },
            )
        )
        .addStringOption(opt =>
          opt.setName('notes')
            .setDescription('Optional notes e.g. "Treaty partner" or "Co-belligerent"')
        )
    )

    .addSubcommand(sub =>
      sub.setName('remove')
        .setDescription('Remove an alliance from the coalition list')
        .addStringOption(opt =>
          opt.setName('alliance')
            .setDescription('Alliance name, ID, or P&W link')
            .setRequired(true)
        )
    )

    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('Show all coalition members and enemies')
    )

    .addSubcommand(sub =>
      sub.setName('compare')
        .setDescription('Compare our coalition vs enemy coalition military strength')
    ),

  requiredRole: 'government',

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    // ── ADD ─────────────────────────────────────────────────
    if (sub === 'add') {
      await interaction.deferReply({ flags: 64 });
      const input = interaction.options.getString('alliance');
      const side  = interaction.options.getString('side');
      const notes = interaction.options.getString('notes') || null;

      await interaction.editReply(`🔍 Looking up **${input}**...`);

      const alliance = await resolveAlliance(input);
      if (!alliance) {
        return interaction.editReply(
          `❌ Could not find alliance **"${input}"**.\nTry their exact name, ID, or P&W link.`
        );
      }

      // Check if already on the alliance_watchlist — update it to include coalition flag
      const existing = queryOne(
        'SELECT * FROM alliance_watchlist WHERE guild_id = ? AND alliance_id = ?',
        [interaction.guildId, alliance.id]
      );

      if (existing) {
        run(
          `UPDATE alliance_watchlist SET watchlist_type = ?, notes = ? WHERE guild_id = ? AND alliance_id = ?`,
          [side, notes || existing.notes, interaction.guildId, alliance.id]
        );
      } else {
        run(
          `INSERT INTO alliance_watchlist (guild_id, alliance_id, alliance_name, watchlist_type, added_by, notes)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [interaction.guildId, alliance.id, alliance.name, side, interaction.user.id, notes]
        );
      }

      const sideEmoji = side === 'friendly' ? '🤝' : '⚔️';
      return interaction.editReply(
        `✅ Added **${alliance.name}** to the coalition as ${sideEmoji} **${side}**.\n` +
        (notes ? `Notes: _${notes}_` : '')
      );
    }

    // ── REMOVE ───────────────────────────────────────────────
    if (sub === 'remove') {
      await interaction.deferReply({ flags: 64 });
      const input = interaction.options.getString('alliance');

      // Try local DB first by name
      let entry = queryOne(
        'SELECT * FROM alliance_watchlist WHERE guild_id = ? AND LOWER(alliance_name) = LOWER(?)',
        [interaction.guildId, input.trim()]
      );

      // Try by ID
      if (!entry && /^\d+$/.test(input.trim())) {
        entry = queryOne(
          'SELECT * FROM alliance_watchlist WHERE guild_id = ? AND alliance_id = ?',
          [interaction.guildId, parseInt(input)]
        );
      }

      // Fall back to API lookup
      if (!entry) {
        await interaction.editReply(`🔍 Looking up **${input}**...`);
        const alliance = await resolveAlliance(input);
        if (alliance) {
          entry = queryOne(
            'SELECT * FROM alliance_watchlist WHERE guild_id = ? AND alliance_id = ?',
            [interaction.guildId, alliance.id]
          );
        }
      }

      if (!entry) {
        return interaction.editReply(`❌ **"${input}"** is not in the coalition list.`);
      }

      run('DELETE FROM alliance_watchlist WHERE guild_id = ? AND alliance_id = ?',
        [interaction.guildId, entry.alliance_id]);
      return interaction.editReply(`✅ Removed **${entry.alliance_name}** from the coalition list.`);
    }

    // ── LIST ─────────────────────────────────────────────────
    if (sub === 'list') {
      const alliances = query(
        'SELECT * FROM alliance_watchlist WHERE guild_id = ? ORDER BY watchlist_type, alliance_name',
        [interaction.guildId]
      ).rows;

      if (alliances.length === 0) {
        return interaction.reply({
          content: '📋 No alliances in the coalition list yet.\nUse `/coalition add` to add allies and enemies.',
          flags: 64,
        });
      }

      const friendly = alliances.filter(a => a.watchlist_type === 'friendly');
      const enemy    = alliances.filter(a => a.watchlist_type === 'enemy');
      const neutral  = alliances.filter(a => a.watchlist_type === 'neutral');

      const embed = new EmbedBuilder()
        .setTitle('🌐 Coalition Overview')
        .setColor(0x3498db)
        .setTimestamp();

      if (friendly.length > 0) {
        embed.addFields({
          name: `🤝 Our Coalition (${friendly.length})`,
          value: friendly.map(a =>
            `**[${a.alliance_name}](https://politicsandwar.com/alliance/id=${a.alliance_id})**` +
            (a.notes ? ` — _${a.notes}_` : '')
          ).join('\n'),
        });
      }

      if (enemy.length > 0) {
        embed.addFields({
          name: `⚔️ Enemy Coalition (${enemy.length})`,
          value: enemy.map(a =>
            `**[${a.alliance_name}](https://politicsandwar.com/alliance/id=${a.alliance_id})**` +
            (a.notes ? ` — _${a.notes}_` : '')
          ).join('\n'),
        });
      }

      if (neutral.length > 0) {
        embed.addFields({
          name: `⚪ Neutral (${neutral.length})`,
          value: neutral.map(a => `**${a.alliance_name}**`).join('\n'),
        });
      }

      embed.setFooter({ text: 'Use /coalition compare to see combined military strength' });
      return interaction.reply({ embeds: [embed], flags: 64 });
    }

    // ── COMPARE ──────────────────────────────────────────────
    if (sub === 'compare') {
      await interaction.deferReply();
      await interaction.editReply('⏳ Fetching military data for all coalition members...');

      const guildRow = queryOne('SELECT alliance_id FROM guilds WHERE guild_id = ?', [interaction.guildId]);

      const friendly = query(
        `SELECT * FROM alliance_watchlist WHERE guild_id = ? AND watchlist_type = 'friendly'`,
        [interaction.guildId]
      ).rows;

      const enemies = query(
        `SELECT * FROM alliance_watchlist WHERE guild_id = ? AND watchlist_type = 'enemy'`,
        [interaction.guildId]
      ).rows;

      // Helper to sum up military across a list of alliances
      async function sumMilitary(allianceList, includeOurs = false) {
        const totals = {
          members: 0, score: 0, cities: 0,
          soldiers: 0, tanks: 0, aircraft: 0,
          ships: 0, missiles: 0, nukes: 0,
          offWars: 0, defWars: 0,
          names: [],
        };

        const ids = [...allianceList.map(a => a.alliance_id)];
        if (includeOurs && guildRow?.alliance_id) ids.push(guildRow.alliance_id);

        for (const id of ids) {
          try {
            const members = await getAllianceMembers(id);
            totals.members   += members.length;
            totals.score     += members.reduce((s, m) => s + (m.score     || 0), 0);
            totals.cities    += members.reduce((s, m) => s + (m.num_cities|| 0), 0);
            totals.soldiers  += members.reduce((s, m) => s + (m.soldiers  || 0), 0);
            totals.tanks     += members.reduce((s, m) => s + (m.tanks     || 0), 0);
            totals.aircraft  += members.reduce((s, m) => s + (m.aircraft  || 0), 0);
            totals.ships     += members.reduce((s, m) => s + (m.ships     || 0), 0);
            totals.missiles  += members.reduce((s, m) => s + (m.missiles  || 0), 0);
            totals.nukes     += members.reduce((s, m) => s + (m.nukes     || 0), 0);
            totals.offWars   += members.reduce((s, m) => s + (m.offensive_wars_count || 0), 0);
            totals.defWars   += members.reduce((s, m) => s + (m.defensive_wars_count || 0), 0);
          } catch { /* skip if fetch fails */ }
        }
        return totals;
      }

      const [ourTotals, enemyTotals] = await Promise.all([
        sumMilitary(friendly, true),  // friendly + our own alliance
        sumMilitary(enemies,  false),
      ]);

      // Comparison helper
      const cmp = (ours, theirs) => {
        const diff = ours - theirs;
        if (diff > 0) return `✅ +${diff.toLocaleString()} advantage`;
        if (diff < 0) return `❌ ${diff.toLocaleString()} deficit`;
        return '⚖️ Equal';
      };

      const ourAllianceCount   = friendly.length + (guildRow?.alliance_id ? 1 : 0);
      const enemyAllianceCount = enemies.length;

      const embed = new EmbedBuilder()
        .setTitle('⚖️ Coalition Military Comparison')
        .setColor(0x8e44ad)
        .addFields(
          {
            name: '🏳️ Our Coalition',
            value: `${ourAllianceCount} alliance(s) | **${ourTotals.members}** members | Score: **${Math.round(ourTotals.score).toLocaleString()}**`,
            inline: true,
          },
          {
            name: '🏴 Enemy Coalition',
            value: `${enemyAllianceCount} alliance(s) | **${enemyTotals.members}** members | Score: **${Math.round(enemyTotals.score).toLocaleString()}**`,
            inline: true,
          },
          { name: '\u200b', value: '\u200b', inline: false },
          {
            name: '⚔️ Head-to-Head Comparison',
            value: [
              `👮 Soldiers:  **${ourTotals.soldiers.toLocaleString()}** vs **${enemyTotals.soldiers.toLocaleString()}** — ${cmp(ourTotals.soldiers, enemyTotals.soldiers)}`,
              `🚗 Tanks:     **${ourTotals.tanks.toLocaleString()}** vs **${enemyTotals.tanks.toLocaleString()}** — ${cmp(ourTotals.tanks, enemyTotals.tanks)}`,
              `✈️ Aircraft:  **${ourTotals.aircraft.toLocaleString()}** vs **${enemyTotals.aircraft.toLocaleString()}** — ${cmp(ourTotals.aircraft, enemyTotals.aircraft)}`,
              `🚢 Ships:     **${ourTotals.ships.toLocaleString()}** vs **${enemyTotals.ships.toLocaleString()}** — ${cmp(ourTotals.ships, enemyTotals.ships)}`,
              `🚀 Missiles:  **${ourTotals.missiles}** vs **${enemyTotals.missiles}** — ${cmp(ourTotals.missiles, enemyTotals.missiles)}`,
              `☢️ Nukes:     **${ourTotals.nukes}** vs **${enemyTotals.nukes}** — ${cmp(ourTotals.nukes, enemyTotals.nukes)}`,
              `🏙️ Cities:    **${ourTotals.cities.toLocaleString()}** vs **${enemyTotals.cities.toLocaleString()}** — ${cmp(ourTotals.cities, enemyTotals.cities)}`,
            ].join('\n'),
            inline: false,
          },
          {
            name: '⚔️ Active Wars',
            value:
              `Our side attacking: **${ourTotals.offWars}** | Defending: **${ourTotals.defWars}**\n` +
              `Enemy attacking: **${enemyTotals.offWars}** | Defending: **${enemyTotals.defWars}**`,
            inline: false,
          },
        )
        .setFooter({ text: 'Use /coalition add to add more alliances to either side' })
        .setTimestamp();

      return interaction.editReply({ content: '', embeds: [embed] });
    }
  },
};
