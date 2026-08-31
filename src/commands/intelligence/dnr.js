// ============================================================
// src/commands/intelligence/dnr.js
// /dnr — Do Not Raid list management
// Supports adding multiple alliances at once with comma separation
// ============================================================

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { query, run, queryOne } = require('../../utils/database');
const { resolveAlliance } = require('../../utils/pwApi');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('dnr')
    .setDescription('Manage the Do Not Raid (DNR) list')

    .addSubcommand(sub =>
      sub.setName('add')
        .setDescription('Add one or multiple alliances to the DNR list (separate with commas)')
        .addStringOption(opt =>
          opt.setName('alliances')
            .setDescription('Alliance name(s), ID(s), or P&W links — separate multiple with commas e.g. "Rose, Leviathan, 1234"')
            .setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('reason')
            .setDescription('Why these alliances are on the DNR list (applies to all added)')
        )
    )

    .addSubcommand(sub =>
      sub.setName('remove')
        .setDescription('Remove one or multiple alliances from the DNR list (separate with commas)')
        .addStringOption(opt =>
          opt.setName('alliances')
            .setDescription('Alliance name(s), ID(s), or P&W links — separate multiple with commas')
            .setRequired(true)
        )
    )

    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('Show the full DNR list')
    )

    .addSubcommand(sub =>
      sub.setName('check')
        .setDescription('Check if a specific alliance is on the DNR list')
        .addStringOption(opt =>
          opt.setName('alliance')
            .setDescription('Alliance name, ID, or P&W link')
            .setRequired(true)
        )
    )

    .addSubcommand(sub =>
      sub.setName('settings')
        .setDescription('Configure DNR enforcement messages')
        .addStringOption(opt =>
          opt.setName('ingame_message')
            .setDescription('Custom in-game message sent to the member who violated DNR')
        )
        .addStringOption(opt =>
          opt.setName('dm_message')
            .setDescription('Custom Discord DM message sent to the violating member')
        )
    ),

  requiredRole: 'government',

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    // ── ADD ─────────────────────────────────────────────────
    if (sub === 'add') {
      await interaction.deferReply({ flags: 64 });
      const input  = interaction.options.getString('alliances');
      const reason = interaction.options.getString('reason') || 'No reason specified';

      // Split by comma and clean up each entry
      const entries = input.split(',').map(s => s.trim()).filter(Boolean);

      if (entries.length === 0) {
        return interaction.editReply('❌ No alliances provided.');
      }

      await interaction.editReply(`🔍 Looking up ${entries.length} alliance(s)...`);

      const results = { added: [], updated: [], failed: [] };

      for (const entry of entries) {
        try {
          const alliance = await resolveAlliance(entry);
          if (!alliance) {
            results.failed.push({ input: entry, reason: 'Not found on P&W' });
            continue;
          }

          const existing = queryOne(
            'SELECT id FROM dnr_list WHERE guild_id = ? AND alliance_id = ?',
            [interaction.guildId, alliance.id]
          );

          if (existing) {
            run(
              `UPDATE dnr_list SET reason = ?, updated_at = datetime('now') WHERE guild_id = ? AND alliance_id = ?`,
              [reason, interaction.guildId, alliance.id]
            );
            results.updated.push(alliance.name);
          } else {
            run(
              `INSERT INTO dnr_list (guild_id, alliance_id, alliance_name, reason, added_by)
               VALUES (?, ?, ?, ?, ?)`,
              [interaction.guildId, alliance.id, alliance.name, reason, interaction.user.id]
            );
            results.added.push(alliance.name);
          }
        } catch (err) {
          results.failed.push({ input: entry, reason: err.message });
        }
      }

      // Build result summary
      const lines = [];
      if (results.added.length > 0)   lines.push(`✅ **Added:** ${results.added.join(', ')}`);
      if (results.updated.length > 0) lines.push(`🔄 **Updated:** ${results.updated.join(', ')}`);
      if (results.failed.length > 0)  lines.push(`❌ **Failed:** ${results.failed.map(f => `${f.input} (${f.reason})`).join(', ')}`);

      const embed = new EmbedBuilder()
        .setTitle('🚫 DNR List Updated')
        .setColor(results.added.length > 0 || results.updated.length > 0 ? 0x2ecc71 : 0xe74c3c)
        .setDescription(lines.join('\n'))
        .addFields({ name: '📝 Reason Applied', value: reason })
        .setFooter({ text: `${results.added.length + results.updated.length} alliance(s) processed | Use /dnr list to view full list` })
        .setTimestamp();

      return interaction.editReply({ content: '', embeds: [embed] });
    }

    // ── REMOVE ───────────────────────────────────────────────
    if (sub === 'remove') {
      await interaction.deferReply({ flags: 64 });
      const input = interaction.options.getString('alliances');

      const entries = input.split(',').map(s => s.trim()).filter(Boolean);

      if (entries.length === 0) {
        return interaction.editReply('❌ No alliances provided.');
      }

      await interaction.editReply(`🔍 Processing ${entries.length} alliance(s)...`);

      const results = { removed: [], notFound: [], failed: [] };

      for (const entry of entries) {
        try {
          // Try local DB first by name (fast, no API call)
          let dbEntry = queryOne(
            'SELECT * FROM dnr_list WHERE guild_id = ? AND LOWER(alliance_name) = LOWER(?)',
            [interaction.guildId, entry]
          );

          // Try by ID
          if (!dbEntry && /^\d+$/.test(entry)) {
            dbEntry = queryOne(
              'SELECT * FROM dnr_list WHERE guild_id = ? AND alliance_id = ?',
              [interaction.guildId, parseInt(entry)]
            );
          }

          // Fall back to API lookup
          if (!dbEntry) {
            const alliance = await resolveAlliance(entry);
            if (alliance) {
              dbEntry = queryOne(
                'SELECT * FROM dnr_list WHERE guild_id = ? AND alliance_id = ?',
                [interaction.guildId, alliance.id]
              );
            }
          }

          if (!dbEntry) {
            results.notFound.push(entry);
            continue;
          }

          run('DELETE FROM dnr_list WHERE guild_id = ? AND alliance_id = ?',
            [interaction.guildId, dbEntry.alliance_id]);
          results.removed.push(dbEntry.alliance_name);

        } catch (err) {
          results.failed.push({ input: entry, reason: err.message });
        }
      }

      const lines = [];
      if (results.removed.length > 0)  lines.push(`✅ **Removed:** ${results.removed.join(', ')}`);
      if (results.notFound.length > 0) lines.push(`⚠️ **Not on DNR list:** ${results.notFound.join(', ')}`);
      if (results.failed.length > 0)   lines.push(`❌ **Failed:** ${results.failed.map(f => `${f.input} (${f.reason})`).join(', ')}`);

      const embed = new EmbedBuilder()
        .setTitle('🚫 DNR List Updated')
        .setColor(results.removed.length > 0 ? 0x2ecc71 : 0xe74c3c)
        .setDescription(lines.join('\n'))
        .setFooter({ text: `${results.removed.length} alliance(s) removed | Use /dnr list to view full list` })
        .setTimestamp();

      return interaction.editReply({ content: '', embeds: [embed] });
    }

    // ── LIST ─────────────────────────────────────────────────
    if (sub === 'list') {
      const entries = query(
        'SELECT * FROM dnr_list WHERE guild_id = ? ORDER BY alliance_name ASC',
        [interaction.guildId]
      ).rows;

      if (entries.length === 0) {
        return interaction.reply({
          content: '📋 The DNR list is empty. Use `/dnr add` to add alliances.',
          flags: 64,
        });
      }

      const lines = entries.map((e, i) =>
        `**${i + 1}.** **[${e.alliance_name}](https://politicsandwar.com/alliance/id=${e.alliance_id})** \`ID: ${e.alliance_id}\`\n` +
        `└ _${e.reason || 'No reason specified'}_`
      );

      // Split across multiple embeds if list is long
      const pageSize = 15;
      const pages = [];
      for (let i = 0; i < lines.length; i += pageSize) {
        pages.push(lines.slice(i, i + pageSize));
      }

      const embeds = pages.map((page, i) =>
        new EmbedBuilder()
          .setTitle(i === 0 ? `🚫 Do Not Raid List — ${entries.length} alliance(s)` : '🚫 DNR List (continued)')
          .setColor(0xe74c3c)
          .setDescription(
            (i === 0
              ? '⚠️ Members must **NOT** declare war on nations in these alliances.\n\n'
              : '') + page.join('\n\n')
          )
          .setFooter({ text: `Page ${i + 1} of ${pages.length} | /dnr add to add | /dnr remove to remove` })
          .setTimestamp()
      );

      return interaction.reply({ embeds, flags: 64 });
    }

    // ── CHECK ────────────────────────────────────────────────
    if (sub === 'check') {
      await interaction.deferReply({ flags: 64 });
      const input = interaction.options.getString('alliance');

      await interaction.editReply(`🔍 Looking up **${input}**...`);
      const alliance = await resolveAlliance(input);
      if (!alliance) {
        return interaction.editReply(`❌ Could not find alliance **"${input}"**.`);
      }

      const entry = queryOne(
        'SELECT * FROM dnr_list WHERE guild_id = ? AND alliance_id = ?',
        [interaction.guildId, alliance.id]
      );

      if (entry) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle('🚫 ON DNR LIST')
              .setColor(0xe74c3c)
              .addFields(
                { name: '🏛️ Alliance', value: `[${alliance.name}](https://politicsandwar.com/alliance/id=${alliance.id})`, inline: true },
                { name: '⚠️ Status', value: '**DO NOT ATTACK**', inline: true },
                { name: '📝 Reason', value: entry.reason || 'None specified', inline: false },
              )
              .setTimestamp(),
          ],
        });
      } else {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle('✅ NOT on DNR List')
              .setColor(0x2ecc71)
              .setDescription(`**${alliance.name}** is not on the DNR list and can be attacked.`)
              .setTimestamp(),
          ],
        });
      }
    }

    // ── SETTINGS ─────────────────────────────────────────────
    if (sub === 'settings') {
      const ingameMsg = interaction.options.getString('ingame_message');
      const dmMsg     = interaction.options.getString('dm_message');

      if (!ingameMsg && !dmMsg) {
        const igRow = queryOne(
          `SELECT setting_value FROM alert_settings WHERE guild_id = ? AND alert_type = 'dnr' AND setting_key = 'ingame_message'`,
          [interaction.guildId]
        );
        const dmRow = queryOne(
          `SELECT setting_value FROM alert_settings WHERE guild_id = ? AND alert_type = 'dnr' AND setting_key = 'dm_message'`,
          [interaction.guildId]
        );

        const embed = new EmbedBuilder()
          .setTitle('⚙️ DNR Settings')
          .setColor(0x3498db)
          .addFields(
            {
              name: '📨 In-Game Message',
              value: igRow?.setting_value || '_Default: URGENT: You have declared war on a DNR alliance. Please offer peace IMMEDIATELY._',
            },
            {
              name: '💬 Discord DM Message',
              value: dmRow?.setting_value || '_Default: You have declared war on a nation in our DNR list. Please offer peace immediately._',
            },
          )
          .setFooter({ text: 'Use /dnr settings ingame_message:[text] dm_message:[text] to change' })
          .setTimestamp();

        return interaction.reply({ embeds: [embed], flags: 64 });
      }

      if (ingameMsg) {
        run(
          `INSERT INTO alert_settings (guild_id, alert_type, setting_key, setting_value)
           VALUES (?, 'dnr', 'ingame_message', ?)
           ON CONFLICT(guild_id, alert_type, setting_key) DO UPDATE SET setting_value = excluded.setting_value`,
          [interaction.guildId, ingameMsg]
        );
      }
      if (dmMsg) {
        run(
          `INSERT INTO alert_settings (guild_id, alert_type, setting_key, setting_value)
           VALUES (?, 'dnr', 'dm_message', ?)
           ON CONFLICT(guild_id, alert_type, setting_key) DO UPDATE SET setting_value = excluded.setting_value`,
          [interaction.guildId, dmMsg]
        );
      }

      return interaction.reply({ content: '✅ DNR message settings updated.', flags: 64 });
    }
  },
};
