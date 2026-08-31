// ============================================================
// src/commands/utility/link.js
// /link — Members register their P&W nation once
// Connects Discord account to P&W nation for all bot features
// ============================================================

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { run, queryOne, query } = require('../../utils/database');
const { resolveNation } = require('../../utils/pwApi');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('link')
    .setDescription('Link your Discord account to your P&W nation')

    .addSubcommand(sub =>
      sub.setName('set')
        .setDescription('Register your P&W nation')
        .addStringOption(opt =>
          opt.setName('nation')
            .setDescription('Your nation name, ID, or P&W link')
            .setRequired(true)
        )
    )

    .addSubcommand(sub =>
      sub.setName('remove')
        .setDescription('Unlink your nation from your Discord account')
    )

    .addSubcommand(sub =>
      sub.setName('check')
        .setDescription('Check which nation a Discord member has linked')
        .addUserOption(opt =>
          opt.setName('member')
            .setDescription('Discord member to check (leave blank to check yourself)')
        )
    )

    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('Show all linked members in this server (Military+ only)')
    )

    .addSubcommand(sub =>
      sub.setName('admin_set')
        .setDescription('Force-link a nation to a Discord member (Military Officer only)')
        .addUserOption(opt =>
          opt.setName('member')
            .setDescription('Discord member to link')
            .setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('nation')
            .setDescription('Nation name, ID, or P&W link')
            .setRequired(true)
        )
    ),

  requiredRole: null, // Anyone can link themselves

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    // ── SET ──────────────────────────────────────────────────
    if (sub === 'set') {
      await interaction.deferReply({ flags: 64 });
      const input = interaction.options.getString('nation');

      await interaction.editReply(`🔍 Looking up **${input}**...`);

      const nation = await resolveNation(input);
      if (!nation) {
        return interaction.editReply(
          `❌ Could not find nation **"${input}"**.\nTry your exact nation name, your nation ID, or paste your P&W profile link.`
        );
      }

      // Check if this nation is already linked to someone else
      const existingNation = queryOne(
        'SELECT discord_user_id FROM nation_links WHERE guild_id = ? AND nation_id = ?',
        [interaction.guildId, nation.id]
      );
      if (existingNation && existingNation.discord_user_id !== interaction.user.id) {
        return interaction.editReply(
          `❌ **${nation.nation_name}** is already linked to another Discord member.\nIf this is your nation, contact a Military Officer to fix it with \`/link admin_set\`.`
        );
      }

      // Save the link
      run(
        `INSERT INTO nation_links (guild_id, discord_user_id, nation_id, nation_name, alliance_id, alliance_name)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(guild_id, discord_user_id) DO UPDATE SET
           nation_id = excluded.nation_id,
           nation_name = excluded.nation_name,
           alliance_id = excluded.alliance_id,
           alliance_name = excluded.alliance_name,
           updated_at = datetime('now')`,
        [
          interaction.guildId,
          interaction.user.id,
          nation.id,
          nation.nation_name,
          nation.alliance_id || null,
          nation.alliance?.name || null,
        ]
      );

      const embed = new EmbedBuilder()
        .setTitle('✅ Nation Linked!')
        .setColor(0x2ecc71)
        .setDescription(`Your Discord account is now linked to your P&W nation.`)
        .addFields(
          { name: '🏴 Nation', value: `[${nation.nation_name}](https://politicsandwar.com/nation/id=${nation.id})`, inline: true },
          { name: '🏛️ Alliance', value: nation.alliance?.name || 'None', inline: true },
          { name: '⭐ Score', value: nation.score?.toLocaleString() || '?', inline: true },
          { name: '🏙️ Cities', value: `${nation.num_cities}`, inline: true },
        )
        .setFooter({ text: 'You can update this anytime with /link set | Remove with /link remove' })
        .setTimestamp();

      return interaction.editReply({ content: '', embeds: [embed] });
    }

    // ── REMOVE ───────────────────────────────────────────────
    if (sub === 'remove') {
      const existing = queryOne(
        'SELECT nation_name FROM nation_links WHERE guild_id = ? AND discord_user_id = ?',
        [interaction.guildId, interaction.user.id]
      );

      if (!existing) {
        return interaction.reply({ content: '❌ You don\'t have a nation linked. Use `/link set` to link one.', flags: 64 });
      }

      run('DELETE FROM nation_links WHERE guild_id = ? AND discord_user_id = ?',
        [interaction.guildId, interaction.user.id]);

      return interaction.reply({
        content: `✅ Your link to **${existing.nation_name}** has been removed.`,
        flags: 64,
      });
    }

    // ── CHECK ────────────────────────────────────────────────
    if (sub === 'check') {
      const target = interaction.options.getUser('member') || interaction.user;

      const link = queryOne(
        'SELECT * FROM nation_links WHERE guild_id = ? AND discord_user_id = ?',
        [interaction.guildId, target.id]
      );

      if (!link) {
        return interaction.reply({
          content: target.id === interaction.user.id
            ? '❌ You haven\'t linked a nation yet. Use `/link set` to register yours.'
            : `❌ <@${target.id}> hasn't linked a nation yet.`,
          flags: 64,
        });
      }

      const embed = new EmbedBuilder()
        .setTitle(`🔗 Linked Nation — ${target.username}`)
        .setColor(0x3498db)
        .addFields(
          { name: '🏴 Nation', value: `[${link.nation_name}](https://politicsandwar.com/nation/id=${link.nation_id})`, inline: true },
          { name: '🏛️ Alliance', value: link.alliance_name || 'None', inline: true },
          { name: '🆔 Nation ID', value: `${link.nation_id}`, inline: true },
        )
        .setFooter({ text: `Last updated: ${link.updated_at || link.created_at}` })
        .setTimestamp();

      return interaction.reply({ embeds: [embed], flags: 64 });
    }

    // ── LIST ─────────────────────────────────────────────────
    if (sub === 'list') {
      const { checkPermission } = require('../../utils/permissions');
      if (!checkPermission(interaction, 'military')) {
        return interaction.reply({ content: '❌ You need the Military Officer role to view all links.', flags: 64 });
      }

      const links = query(
        'SELECT * FROM nation_links WHERE guild_id = ? ORDER BY nation_name ASC',
        [interaction.guildId]
      ).rows;

      if (links.length === 0) {
        return interaction.reply({
          content: '📋 No members have linked their nations yet. Share `/link set` with your alliance!',
          flags: 64,
        });
      }

      const lines = links.map(l =>
        `<@${l.discord_user_id}> → **[${l.nation_name}](https://politicsandwar.com/nation/id=${l.nation_id})** (ID: \`${l.nation_id}\`)`
      );

      // Split into pages of 20 if needed
      const pages = [];
      for (let i = 0; i < lines.length; i += 20) pages.push(lines.slice(i, i + 20));

      const embeds = pages.map((page, i) =>
        new EmbedBuilder()
          .setTitle(i === 0 ? `🔗 Linked Nations — ${links.length} member(s)` : '🔗 Linked Nations (continued)')
          .setColor(0x3498db)
          .setDescription(page.join('\n'))
          .setFooter({ text: `Page ${i + 1} of ${pages.length} | Use /link set to link your nation` })
      );

      return interaction.reply({ embeds: embeds.slice(0, 10), flags: 64 });
    }

    // ── ADMIN SET ────────────────────────────────────────────
    if (sub === 'admin_set') {
      const { checkPermission } = require('../../utils/permissions');
      if (!checkPermission(interaction, 'military')) {
        return interaction.reply({ content: '❌ You need the Military Officer role to force-link nations.', flags: 64 });
      }

      await interaction.deferReply({ flags: 64 });
      const member = interaction.options.getUser('member');
      const input  = interaction.options.getString('nation');

      await interaction.editReply(`🔍 Looking up **${input}**...`);

      const nation = await resolveNation(input);
      if (!nation) {
        return interaction.editReply(`❌ Could not find nation **"${input}"**.`);
      }

      run(
        `INSERT INTO nation_links (guild_id, discord_user_id, nation_id, nation_name, alliance_id, alliance_name)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(guild_id, discord_user_id) DO UPDATE SET
           nation_id = excluded.nation_id,
           nation_name = excluded.nation_name,
           alliance_id = excluded.alliance_id,
           alliance_name = excluded.alliance_name,
           updated_at = datetime('now')`,
        [
          interaction.guildId,
          member.id,
          nation.id,
          nation.nation_name,
          nation.alliance_id || null,
          nation.alliance?.name || null,
        ]
      );

      return interaction.editReply(
        `✅ Linked <@${member.id}> to **[${nation.nation_name}](https://politicsandwar.com/nation/id=${nation.id})**.`
      );
    }
  },
};
