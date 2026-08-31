// ============================================================
// src/commands/intelligence/treaty.js
// /treaty — Track treaties with other alliances
// (MDP, ODP, Protectorate, NAP, etc.)
// ============================================================

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { query, run, queryOne } = require('../../utils/database');
const { resolveAlliance } = require('../../utils/pwApi');

const TREATY_TYPES = {
  MDP:           { emoji: '🛡️', label: 'Mutual Defense Pact' },
  ODP:           { emoji: '⚔️', label: 'Optional Defense Pact' },
  MDOAP:         { emoji: '🤝', label: 'Mutual Defense & Optional Aggression Pact' },
  PROTECTORATE:  { emoji: '👑', label: 'Protectorate' },
  NAP:           { emoji: '🕊️', label: 'Non-Aggression Pact' },
  EXTENDED_NAP:  { emoji: '🕊️', label: 'Extended Non-Aggression Pact' },
  TRADE:         { emoji: '💰', label: 'Trade Agreement' },
  INTELLIGENCE:  { emoji: '🕵️', label: 'Intelligence Sharing' },
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName('treaty')
    .setDescription('Track treaties with other alliances')

    .addSubcommand(sub =>
      sub.setName('add')
        .setDescription('Record a treaty with another alliance')
        .addStringOption(opt =>
          opt.setName('alliance')
            .setDescription('Alliance name, ID, or P&W link')
            .setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('type')
            .setDescription('Type of treaty')
            .setRequired(true)
            .addChoices(
              { name: '🛡️ MDP — Mutual Defense Pact', value: 'MDP' },
              { name: '⚔️ ODP — Optional Defense Pact', value: 'ODP' },
              { name: '🤝 MDoAP — Mutual Defense & Optional Aggression', value: 'MDOAP' },
              { name: '👑 Protectorate', value: 'PROTECTORATE' },
              { name: '🕊️ NAP — Non-Aggression Pact', value: 'NAP' },
              { name: '🕊️ Extended NAP', value: 'EXTENDED_NAP' },
              { name: '💰 Trade Agreement', value: 'TRADE' },
              { name: '🕵️ Intelligence Sharing', value: 'INTELLIGENCE' },
            )
        )
        .addStringOption(opt =>
          opt.setName('notes')
            .setDescription('Notes about this treaty (optional)')
        )
        .addStringOption(opt =>
          opt.setName('expires')
            .setDescription('Expiry date YYYY-MM-DD (optional — leave blank for permanent)')
        )
    )

    .addSubcommand(sub =>
      sub.setName('remove')
        .setDescription('Remove a treaty record')
        .addStringOption(opt =>
          opt.setName('alliance')
            .setDescription('Alliance name, ID, or P&W link')
            .setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('type')
            .setDescription('Type of treaty to remove')
            .setRequired(true)
            .addChoices(
              { name: 'MDP', value: 'MDP' },
              { name: 'ODP', value: 'ODP' },
              { name: 'MDoAP', value: 'MDOAP' },
              { name: 'Protectorate', value: 'PROTECTORATE' },
              { name: 'NAP', value: 'NAP' },
              { name: 'Extended NAP', value: 'EXTENDED_NAP' },
              { name: 'Trade', value: 'TRADE' },
              { name: 'Intelligence', value: 'INTELLIGENCE' },
            )
        )
    )

    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('Show all tracked treaties')
        .addStringOption(opt =>
          opt.setName('type')
            .setDescription('Filter by treaty type')
            .addChoices(
              { name: 'MDP', value: 'MDP' },
              { name: 'ODP', value: 'ODP' },
              { name: 'MDoAP', value: 'MDOAP' },
              { name: 'Protectorate', value: 'PROTECTORATE' },
              { name: 'NAP', value: 'NAP' },
              { name: 'All', value: 'all' },
            )
        )
    )

    .addSubcommand(sub =>
      sub.setName('check')
        .setDescription('Check what treaties we have with a specific alliance')
        .addStringOption(opt =>
          opt.setName('alliance')
            .setDescription('Alliance name, ID, or P&W link')
            .setRequired(true)
        )
    ),

  requiredRole: 'government',

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    // ── ADD ─────────────────────────────────────────────────
    if (sub === 'add') {
      await interaction.deferReply({ flags: 64 });
      const input   = interaction.options.getString('alliance');
      const type    = interaction.options.getString('type');
      const notes   = interaction.options.getString('notes') || null;
      const expires = interaction.options.getString('expires') || null;

      await interaction.editReply(`🔍 Looking up **${input}**...`);

      const alliance = await resolveAlliance(input);
      if (!alliance) {
        return interaction.editReply(`❌ Could not find alliance **"${input}"**. Try name, ID, or P&W link.`);
      }

      let expiresAt = null;
      if (expires) {
        const parsed = new Date(expires);
        if (isNaN(parsed.getTime())) {
          return interaction.editReply(`❌ Invalid date format. Use YYYY-MM-DD e.g. 2026-12-31.`);
        }
        expiresAt = parsed.toISOString();
      }

      const existing = queryOne(
        'SELECT id FROM treaties WHERE guild_id = ? AND alliance_id = ? AND treaty_type = ?',
        [interaction.guildId, alliance.id, type]
      );

      if (existing) {
        run(
          `UPDATE treaties SET notes = ?, expires_at = ? WHERE id = ?`,
          [notes, expiresAt, existing.id]
        );
        return interaction.editReply(`✅ Updated **${TREATY_TYPES[type].label}** with **${alliance.name}**.`);
      }

      run(
        `INSERT INTO treaties (guild_id, alliance_id, alliance_name, treaty_type, notes, added_by, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [interaction.guildId, alliance.id, alliance.name, type, notes, interaction.user.id, expiresAt]
      );

      const t = TREATY_TYPES[type];
      return interaction.editReply(
        `✅ Recorded ${t.emoji} **${t.label}** with **${alliance.name}**.` +
        (notes ? `\nNotes: _${notes}_` : '') +
        (expiresAt ? `\nExpires: ${new Date(expiresAt).toDateString()}` : '')
      );
    }

    // ── REMOVE ───────────────────────────────────────────────
    if (sub === 'remove') {
      await interaction.deferReply({ flags: 64 });
      const input = interaction.options.getString('alliance');
      const type  = interaction.options.getString('type');

      let allianceId = null;
      let allianceName = input;

      if (/^\d+$/.test(input.trim())) {
        allianceId = parseInt(input.trim());
      } else {
        const existing = queryOne(
          'SELECT alliance_id, alliance_name FROM treaties WHERE guild_id = ? AND LOWER(alliance_name) = LOWER(?) AND treaty_type = ?',
          [interaction.guildId, input.trim(), type]
        );
        if (existing) {
          allianceId = existing.alliance_id;
          allianceName = existing.alliance_name;
        } else {
          await interaction.editReply(`🔍 Looking up **${input}**...`);
          const alliance = await resolveAlliance(input);
          if (alliance) {
            allianceId = alliance.id;
            allianceName = alliance.name;
          }
        }
      }

      if (!allianceId) {
        return interaction.editReply(`❌ Could not find alliance **"${input}"**.`);
      }

      const existing = queryOne(
        'SELECT * FROM treaties WHERE guild_id = ? AND alliance_id = ? AND treaty_type = ?',
        [interaction.guildId, allianceId, type]
      );

      if (!existing) {
        return interaction.editReply(`❌ No **${TREATY_TYPES[type].label}** found with **${allianceName}**.`);
      }

      run('DELETE FROM treaties WHERE id = ?', [existing.id]);
      return interaction.editReply(`✅ Removed **${TREATY_TYPES[type].label}** with **${existing.alliance_name}**.`);
    }

    // ── LIST ─────────────────────────────────────────────────
    if (sub === 'list') {
      const filter = interaction.options.getString('type') || 'all';

      const treaties = filter === 'all'
        ? query('SELECT * FROM treaties WHERE guild_id = ? ORDER BY treaty_type, alliance_name', [interaction.guildId]).rows
        : query('SELECT * FROM treaties WHERE guild_id = ? AND treaty_type = ? ORDER BY alliance_name', [interaction.guildId, filter]).rows;

      if (treaties.length === 0) {
        return interaction.reply({
          content: '📋 No treaties recorded yet. Use `/treaty add` to start tracking.',
          flags: 64,
        });
      }

      // Group by type
      const grouped = {};
      for (const t of treaties) {
        if (!grouped[t.treaty_type]) grouped[t.treaty_type] = [];
        grouped[t.treaty_type].push(t);
      }

      const embed = new EmbedBuilder()
        .setTitle(`🤝 Treaty Network — ${treaties.length} total`)
        .setColor(0x3498db)
        .setTimestamp();

      for (const [type, list] of Object.entries(grouped)) {
        const info = TREATY_TYPES[type] || { emoji: '📄', label: type };
        const lines = list.map(t => {
          const expiryNote = t.expires_at ? ` (expires ${new Date(t.expires_at).toDateString()})` : '';
          return `**[${t.alliance_name}](https://politicsandwar.com/alliance/id=${t.alliance_id})**${expiryNote}` +
                 (t.notes ? `\n  └ _${t.notes}_` : '');
        });

        embed.addFields({
          name: `${info.emoji} ${info.label} (${list.length})`,
          value: lines.join('\n'),
          inline: false,
        });
      }

      return interaction.reply({ embeds: [embed], flags: 64 });
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

      const treaties = query(
        'SELECT * FROM treaties WHERE guild_id = ? AND alliance_id = ?',
        [interaction.guildId, alliance.id]
      ).rows;

      if (treaties.length === 0) {
        return interaction.editReply(`📋 No treaties on record with **${alliance.name}**.`);
      }

      const lines = treaties.map(t => {
        const info = TREATY_TYPES[t.treaty_type] || { emoji: '📄', label: t.treaty_type };
        const expiryNote = t.expires_at ? ` — expires ${new Date(t.expires_at).toDateString()}` : ' — permanent';
        return `${info.emoji} **${info.label}**${expiryNote}` + (t.notes ? `\n  └ _${t.notes}_` : '');
      });

      const embed = new EmbedBuilder()
        .setTitle(`🤝 Treaties with ${alliance.name}`)
        .setColor(0x3498db)
        .setDescription(lines.join('\n\n'))
        .setTimestamp();

      return interaction.editReply({ content: '', embeds: [embed] });
    }
  },
};
