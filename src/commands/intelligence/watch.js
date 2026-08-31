// ============================================================
// src/commands/intelligence/watch.js
// Accepts nation/alliance by ID, name, or P&W URL
// ============================================================

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { query, run, queryOne } = require('../../utils/database');
const { resolveNation, resolveAlliance } = require('../../utils/pwApi');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('watch')
    .setDescription('Manage nation and alliance watchlists')

    .addSubcommandGroup(group =>
      group.setName('nation')
        .setDescription('Watch individual nations')
        .addSubcommand(sub =>
          sub.setName('add')
            .setDescription('Add a nation — use their ID, name, or P&W profile link')
            .addStringOption(opt =>
              opt.setName('nation')
                .setDescription('Nation ID, nation name, or P&W link (e.g. "Papyrus" or "12345" or the URL)')
                .setRequired(true)
            )
            .addStringOption(opt =>
              opt.setName('priority')
                .setDescription('Priority level for this nation')
                .addChoices(
                  { name: '🟡 Normal', value: 'normal' },
                  { name: '🟠 High', value: 'high' },
                  { name: '🔴 Critical', value: 'critical' },
                )
            )
            .addStringOption(opt =>
              opt.setName('notes')
                .setDescription('Optional notes about this nation (e.g. "Enemy gov member")')
            )
        )
        .addSubcommand(sub =>
          sub.setName('remove')
            .setDescription('Remove a nation — use their ID, name, or P&W link')
            .addStringOption(opt =>
              opt.setName('nation')
                .setDescription('Nation ID, nation name, or P&W link')
                .setRequired(true)
            )
        )
        .addSubcommand(sub =>
          sub.setName('list')
            .setDescription('Show all watched nations')
        )
    )

    .addSubcommandGroup(group =>
      group.setName('alliance')
        .setDescription('Watch entire alliances')
        .addSubcommand(sub =>
          sub.setName('add')
            .setDescription('Add an alliance — use their ID, name, or P&W alliance link')
            .addStringOption(opt =>
              opt.setName('alliance')
                .setDescription('Alliance ID, alliance name, or P&W link (e.g. "Rose" or "1234" or the URL)')
                .setRequired(true)
            )
            .addStringOption(opt =>
              opt.setName('type')
                .setDescription('What is this alliance to you?')
                .addChoices(
                  { name: '⚔️ Enemy', value: 'enemy' },
                  { name: '🤝 Friendly', value: 'friendly' },
                  { name: '⚪ Neutral', value: 'neutral' },
                )
            )
            .addStringOption(opt =>
              opt.setName('notes')
                .setDescription('Optional notes (e.g. "Currently at war with us")')
            )
        )
        .addSubcommand(sub =>
          sub.setName('remove')
            .setDescription('Remove an alliance — use their ID, name, or P&W link')
            .addStringOption(opt =>
              opt.setName('alliance')
                .setDescription('Alliance ID, alliance name, or P&W link')
                .setRequired(true)
            )
        )
        .addSubcommand(sub =>
          sub.setName('list')
            .setDescription('Show all watched alliances')
        )
    ),

  requiredRole: 'military',

  async execute(interaction) {
    const group = interaction.options.getSubcommandGroup();
    const sub = interaction.options.getSubcommand();

    // ----------------------------------------------------------------
    // NATION COMMANDS
    // ----------------------------------------------------------------
    if (group === 'nation') {

      if (sub === 'add') {
        await interaction.deferReply({ flags: 64 });
        const input = interaction.options.getString('nation');
        const priority = interaction.options.getString('priority') || 'normal';
        const notes = interaction.options.getString('notes') || null;

        await interaction.editReply(`🔍 Looking up **${input}**...`);

        const nation = await resolveNation(input);
        if (!nation) {
          return interaction.editReply(
            `❌ Could not find a nation matching **"${input}"**.\n` +
            `Try using their exact nation name, their nation ID, or paste their P&W profile link.`
          );
        }

        const existing = queryOne(
          'SELECT id FROM nation_watchlist WHERE guild_id = ? AND nation_id = ?',
          [interaction.guildId, nation.id]
        );
        if (existing) {
          return interaction.editReply(`⚠️ **${nation.nation_name}** is already on the watchlist.`);
        }

        run(
          `INSERT INTO nation_watchlist (guild_id, nation_id, nation_name, added_by, priority_level, notes)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [interaction.guildId, nation.id, nation.nation_name, interaction.user.id, priority, notes]
        );

        const priorityEmoji = { normal: '🟡', high: '🟠', critical: '🔴' };
        return interaction.editReply(
          `✅ Added **${nation.nation_name}** (ID: ${nation.id}) to the watchlist.\n` +
          `Alliance: ${nation.alliance?.name || 'None'} | Score: ${nation.score?.toLocaleString()}\n` +
          `Priority: ${priorityEmoji[priority]} ${priority}` +
          (notes ? `\nNotes: _${notes}_` : '')
        );
      }

      if (sub === 'remove') {
        await interaction.deferReply({ flags: 64 });
        const input = interaction.options.getString('nation');

        // First try to find it in our watchlist directly by name or ID
        let watchlistEntry = null;

        // If it's a number, try by nation_id first (fast, no API call)
        if (/^\d+$/.test(input.trim())) {
          watchlistEntry = queryOne(
            'SELECT * FROM nation_watchlist WHERE guild_id = ? AND nation_id = ?',
            [interaction.guildId, parseInt(input)]
          );
        }

        // Try matching by saved name in our DB
        if (!watchlistEntry) {
          watchlistEntry = queryOne(
            'SELECT * FROM nation_watchlist WHERE guild_id = ? AND LOWER(nation_name) = LOWER(?)',
            [interaction.guildId, input.trim()]
          );
        }

        // Fall back to API lookup
        if (!watchlistEntry) {
          await interaction.editReply(`🔍 Looking up **${input}**...`);
          const nation = await resolveNation(input);
          if (nation) {
            watchlistEntry = queryOne(
              'SELECT * FROM nation_watchlist WHERE guild_id = ? AND nation_id = ?',
              [interaction.guildId, nation.id]
            );
          }
        }

        if (!watchlistEntry) {
          return interaction.editReply(
            `❌ Could not find **"${input}"** on the watchlist.\n` +
            `Use \`/watch nation list\` to see all watched nations.`
          );
        }

        run('DELETE FROM nation_watchlist WHERE guild_id = ? AND nation_id = ?',
          [interaction.guildId, watchlistEntry.nation_id]);
        return interaction.editReply(`✅ Removed **${watchlistEntry.nation_name}** from the watchlist.`);
      }

      if (sub === 'list') {
        const nations = query(
          'SELECT * FROM nation_watchlist WHERE guild_id = ? ORDER BY priority_level DESC, created_at ASC',
          [interaction.guildId]
        ).rows;

        if (nations.length === 0) {
          return interaction.reply({
            content: '📋 No nations on the watchlist yet.\nUse `/watch nation add` and enter a nation name, ID, or P&W link.',
            flags: 64,
          });
        }

        const priorityEmoji = { critical: '🔴', high: '🟠', normal: '🟡' };
        const lines = nations.map(n =>
          `${priorityEmoji[n.priority_level] || '🟡'} **[${n.nation_name}](https://politicsandwar.com/nation/id=${n.nation_id})** (ID: \`${n.nation_id}\`)` +
          (n.notes ? `\n  └ _${n.notes}_` : '')
        );

        const embed = new EmbedBuilder()
          .setTitle(`📋 Nation Watchlist — ${nations.length} nation(s)`)
          .setColor(0x3498db)
          .setDescription(lines.join('\n'))
          .setFooter({ text: '🔴 Critical  🟠 High  🟡 Normal' })
          .setTimestamp();

        return interaction.reply({ embeds: [embed], flags: 64 });
      }
    }

    // ----------------------------------------------------------------
    // ALLIANCE COMMANDS
    // ----------------------------------------------------------------
    if (group === 'alliance') {

      if (sub === 'add') {
        await interaction.deferReply({ flags: 64 });
        const input = interaction.options.getString('alliance');
        const type = interaction.options.getString('type') || 'enemy';
        const notes = interaction.options.getString('notes') || null;

        await interaction.editReply(`🔍 Looking up **${input}**...`);

        const alliance = await resolveAlliance(input);
        if (!alliance) {
          return interaction.editReply(
            `❌ Could not find an alliance matching **"${input}"**.\n` +
            `Try using their exact alliance name, their alliance ID, or paste their P&W alliance link.`
          );
        }

        const existing = queryOne(
          'SELECT id FROM alliance_watchlist WHERE guild_id = ? AND alliance_id = ?',
          [interaction.guildId, alliance.id]
        );
        if (existing) {
          return interaction.editReply(`⚠️ **${alliance.name}** is already on the watchlist.`);
        }

        run(
          `INSERT INTO alliance_watchlist (guild_id, alliance_id, alliance_name, watchlist_type, added_by, notes)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [interaction.guildId, alliance.id, alliance.name, type, interaction.user.id, notes]
        );

        const typeEmoji = { enemy: '⚔️', friendly: '🤝', neutral: '⚪' };
        return interaction.editReply(
          `✅ Added **${alliance.name}** (ID: ${alliance.id}) as ${typeEmoji[type]} **${type}**.\n` +
          `Members: ${alliance.nations?.length || "?"} | Score: ${alliance.score?.toLocaleString()}\n` +
          `Beige tracking and intelligence monitoring is now active for this alliance.` +
          (notes ? `\nNotes: _${notes}_` : '')
        );
      }

      if (sub === 'remove') {
        await interaction.deferReply({ flags: 64 });
        const input = interaction.options.getString('alliance');

        let watchlistEntry = null;

        if (/^\d+$/.test(input.trim())) {
          watchlistEntry = queryOne(
            'SELECT * FROM alliance_watchlist WHERE guild_id = ? AND alliance_id = ?',
            [interaction.guildId, parseInt(input)]
          );
        }

        if (!watchlistEntry) {
          watchlistEntry = queryOne(
            'SELECT * FROM alliance_watchlist WHERE guild_id = ? AND LOWER(alliance_name) = LOWER(?)',
            [interaction.guildId, input.trim()]
          );
        }

        if (!watchlistEntry) {
          await interaction.editReply(`🔍 Looking up **${input}**...`);
          const alliance = await resolveAlliance(input);
          if (alliance) {
            watchlistEntry = queryOne(
              'SELECT * FROM alliance_watchlist WHERE guild_id = ? AND alliance_id = ?',
              [interaction.guildId, alliance.id]
            );
          }
        }

        if (!watchlistEntry) {
          return interaction.editReply(
            `❌ Could not find **"${input}"** on the watchlist.\n` +
            `Use \`/watch alliance list\` to see all watched alliances.`
          );
        }

        run('DELETE FROM alliance_watchlist WHERE guild_id = ? AND alliance_id = ?',
          [interaction.guildId, watchlistEntry.alliance_id]);
        return interaction.editReply(`✅ Removed **${watchlistEntry.alliance_name}** from the watchlist.`);
      }

      if (sub === 'list') {
        const alliances = query(
          'SELECT * FROM alliance_watchlist WHERE guild_id = ? ORDER BY watchlist_type, alliance_name',
          [interaction.guildId]
        ).rows;

        if (alliances.length === 0) {
          return interaction.reply({
            content: '📋 No alliances on the watchlist yet.\nUse `/watch alliance add` and enter an alliance name, ID, or P&W link.',
            flags: 64,
          });
        }

        const typeEmoji = { enemy: '⚔️', friendly: '🤝', neutral: '⚪' };
        const lines = alliances.map(a =>
          `${typeEmoji[a.watchlist_type] || '⚪'} **[${a.alliance_name}](https://politicsandwar.com/alliance/id=${a.alliance_id})** (ID: \`${a.alliance_id}\`) — ${a.watchlist_type}` +
          (a.notes ? `\n  └ _${a.notes}_` : '')
        );

        const embed = new EmbedBuilder()
          .setTitle(`📋 Alliance Watchlist — ${alliances.length} alliance(s)`)
          .setColor(0x3498db)
          .setDescription(lines.join('\n'))
          .setTimestamp();

        return interaction.reply({ embeds: [embed], flags: 64 });
      }
    }
  },
};
