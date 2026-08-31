// ============================================================
// src/commands/military/compliance.js
// /compliance — Set and check alliance military requirements
// ============================================================

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { query, run, queryOne } = require('../../utils/database');
const { buildNationToDiscordMap } = require('../../utils/nationLink');
const { getAllianceMembers } = require('../../utils/pwApi');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('compliance')
    .setDescription('Set minimum military thresholds for compliance checks (separate from readiness weights)')

    .addSubcommand(sub =>
      sub.setName('set')
        .setDescription('Set minimum military standards for your alliance')
        .addIntegerOption(opt =>
          opt.setName('soldiers')
            .setDescription('Minimum soldiers required')
        )
        .addIntegerOption(opt =>
          opt.setName('tanks')
            .setDescription('Minimum tanks required')
        )
        .addIntegerOption(opt =>
          opt.setName('aircraft')
            .setDescription('Minimum aircraft required')
        )
        .addIntegerOption(opt =>
          opt.setName('ships')
            .setDescription('Minimum ships required')
        )
        .addIntegerOption(opt =>
          opt.setName('missiles')
            .setDescription('Minimum missiles required')
        )
    )

    .addSubcommand(sub =>
      sub.setName('view')
        .setDescription('View current compliance standards')
    )

    .addSubcommand(sub =>
      sub.setName('check')
        .setDescription('Check which members meet or fail compliance standards')
        .addStringOption(opt =>
          opt.setName('filter')
            .setDescription('What to show')
            .addChoices(
              { name: '❌ Non-compliant only (default)', value: 'fail' },
              { name: '✅ Compliant only', value: 'pass' },
              { name: '📋 All members', value: 'all' },
            )
        )
    )

    .addSubcommand(sub =>
      sub.setName('report')
        .setDescription('Generate a full compliance report for the alliance')
    ),

  requiredRole: 'military',

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    // Helper — load standards from DB with defaults
    function getStandards(guildId) {
      const rows = query(
        `SELECT setting_key, setting_value FROM alert_settings
         WHERE guild_id = ? AND alert_type = 'compliance'`,
        [guildId]
      ).rows;

      const standards = {
        soldiers: 15000,
        tanks:    1250,
        aircraft: 75,
        ships:    15,
        missiles: 0,
      };

      for (const row of rows) {
        if (row.setting_key in standards) {
          standards[row.setting_key] = parseInt(row.setting_value);
        }
      }
      return standards;
    }

    // Check a single member against standards
    function checkMember(member, standards) {
      const checks = {
        soldiers: member.soldiers >= standards.soldiers,
        tanks:    member.tanks    >= standards.tanks,
        aircraft: member.aircraft >= standards.aircraft,
        ships:    member.ships    >= standards.ships,
        missiles: standards.missiles === 0 || member.missiles >= standards.missiles,
      };
      const passed = Object.values(checks).filter(Boolean).length;
      const total  = Object.keys(checks).filter(k => standards[k] > 0).length || 1;
      const score  = Math.round((passed / total) * 100);
      const compliant = Object.values(checks).every(Boolean);
      return { checks, score, compliant };
    }

    // ── SET ──────────────────────────────────────────────────
    if (sub === 'set') {
      const fields = ['soldiers', 'tanks', 'aircraft', 'ships', 'missiles'];
      let updated = [];

      for (const field of fields) {
        const val = interaction.options.getInteger(field);
        if (val !== null) {
          run(
            `INSERT INTO alert_settings (guild_id, alert_type, setting_key, setting_value)
             VALUES (?, 'compliance', ?, ?)
             ON CONFLICT(guild_id, alert_type, setting_key) DO UPDATE SET setting_value = excluded.setting_value`,
            [interaction.guildId, field, String(val)]
          );
          updated.push(`${field}: **${val.toLocaleString()}**`);
        }
      }

      if (updated.length === 0) {
        return interaction.reply({
          content: '❌ No standards provided. Include at least one value e.g. `/compliance set aircraft:75`',
          flags: 64,
        });
      }

      return interaction.reply({
        content: `✅ Compliance standards updated:\n${updated.join('\n')}`,
        flags: 64,
      });
    }

    // ── VIEW ─────────────────────────────────────────────────
    if (sub === 'view') {
      const standards = getStandards(interaction.guildId);

      const embed = new EmbedBuilder()
        .setTitle('📏 Alliance Compliance Standards')
        .setColor(0x3498db)
        .addFields(
          { name: '👮 Min Soldiers', value: standards.soldiers.toLocaleString(), inline: true },
          { name: '🚗 Min Tanks',    value: standards.tanks.toLocaleString(),    inline: true },
          { name: '✈️ Min Aircraft', value: standards.aircraft.toLocaleString(), inline: true },
          { name: '🚢 Min Ships',    value: standards.ships.toLocaleString(),    inline: true },
          { name: '🚀 Min Missiles', value: standards.missiles === 0 ? 'Not required' : standards.missiles.toString(), inline: true },
        )
        .setFooter({ text: 'Use /compliance set to change standards | /compliance check to run a check' })
        .setTimestamp();

      return interaction.reply({ embeds: [embed], flags: 64 });
    }

    // ── CHECK ────────────────────────────────────────────────
    if (sub === 'check') {
      await interaction.deferReply();

      const filter   = interaction.options.getString('filter') || 'fail';
      const guildRow = queryOne('SELECT alliance_id FROM guilds WHERE guild_id = ?', [interaction.guildId]);
      if (!guildRow?.alliance_id) {
        return interaction.editReply('❌ No alliance configured. Use `/config alliance` first.');
      }

      await interaction.editReply('⏳ Checking member compliance...');

      let members;
      try { members = await getAllianceMembers(guildRow.alliance_id); }
      catch { return interaction.editReply('❌ Could not fetch alliance data. Try again shortly.'); }

      const standards    = getStandards(interaction.guildId);
      const activeMembers = members.filter(m => m.vacation_mode_turns === 0);
      const results      = activeMembers.map(m => ({ ...m, ...checkMember(m, standards) }));

      const filtered = filter === 'fail' ? results.filter(m => !m.compliant)
                     : filter === 'pass' ? results.filter(m =>  m.compliant)
                     : results;

      const passCount = results.filter(m =>  m.compliant).length;
      const failCount = results.filter(m => !m.compliant).length;

      if (filtered.length === 0) {
        const msg = filter === 'fail'
          ? '✅ All active members are compliant with military standards!'
          : '❌ No compliant members found.';
        return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x2ecc71).setDescription(msg).setTimestamp()] });
      }

      // Sort non-compliant by score ascending (worst first)
      const discordMap = buildNationToDiscordMap(interaction.guildId);
      const sorted = [...filtered].sort((a, b) => a.score - b.score);

      const lines = sorted.slice(0, 20).map(m => {
        const statusEmoji = m.compliant ? '✅' : '❌';
        const issues = [];
        if (!m.checks.soldiers) issues.push(`👮 ${m.soldiers.toLocaleString()}/${standards.soldiers.toLocaleString()}`);
        if (!m.checks.tanks)    issues.push(`🚗 ${m.tanks}/${standards.tanks}`);
        if (!m.checks.aircraft) issues.push(`✈️ ${m.aircraft}/${standards.aircraft}`);
        if (!m.checks.ships)    issues.push(`🚢 ${m.ships}/${standards.ships}`);
        if (standards.missiles > 0 && !m.checks.missiles) issues.push(`🚀 ${m.missiles}/${standards.missiles}`);

        return (
          `${statusEmoji} **[${m.nation_name}](https://politicsandwar.com/nation/id=${m.id})** — ${m.score}%\n` +
          (issues.length > 0 ? `└ Below standard: ${issues.join(' | ')}` : '└ All standards met')
        );
      });

      const embed = new EmbedBuilder()
        .setTitle(`📋 Compliance Check — ${filtered.length} member(s)`)
        .setColor(failCount === 0 ? 0x2ecc71 : 0xe74c3c)
        .setDescription(lines.join('\n\n'))
        .addFields({
          name: '📊 Summary',
          value: `✅ Compliant: **${passCount}** | ❌ Non-compliant: **${failCount}** | 🏖️ Vacation (excluded): **${members.length - activeMembers.length}**`,
        })
        .setFooter({ text: filtered.length > 20 ? `Showing 20 of ${filtered.length}` : 'Use /compliance set to adjust standards' })
        .setTimestamp();

      return interaction.editReply({ content: '', embeds: [embed] });
    }

    // ── REPORT ───────────────────────────────────────────────
    if (sub === 'report') {
      await interaction.deferReply();

      const guildRow = queryOne('SELECT alliance_id FROM guilds WHERE guild_id = ?', [interaction.guildId]);
      if (!guildRow?.alliance_id) {
        return interaction.editReply('❌ No alliance configured. Use `/config alliance` first.');
      }

      await interaction.editReply('⏳ Generating compliance report...');

      let members;
      try { members = await getAllianceMembers(guildRow.alliance_id); }
      catch { return interaction.editReply('❌ Could not fetch alliance data. Try again shortly.'); }

      const standards     = getStandards(interaction.guildId);
      const activeMembers = members.filter(m => m.vacation_mode_turns === 0);
      const results       = activeMembers.map(m => ({ ...m, ...checkMember(m, standards) }));

      const passCount  = results.filter(m =>  m.compliant).length;
      const failCount  = results.filter(m => !m.compliant).length;
      const passRate   = Math.round((passCount / (results.length || 1)) * 100);

      // Breakdown by military type
      const failSoldiers = results.filter(m => !m.checks.soldiers).length;
      const failTanks    = results.filter(m => !m.checks.tanks).length;
      const failAircraft = results.filter(m => !m.checks.aircraft).length;
      const failShips    = results.filter(m => !m.checks.ships).length;
      const failMissiles = standards.missiles > 0 ? results.filter(m => !m.checks.missiles).length : 0;

      const embed = new EmbedBuilder()
        .setTitle('📊 Alliance Compliance Report')
        .setColor(passRate >= 80 ? 0x2ecc71 : passRate >= 60 ? 0xf1c40f : 0xe74c3c)
        .addFields(
          {
            name: '📈 Overall Compliance',
            value:
              `✅ Compliant: **${passCount}** (${passRate}%)\n` +
              `❌ Non-compliant: **${failCount}**\n` +
              `🏖️ Vacation (excluded): **${members.length - activeMembers.length}**`,
            inline: false,
          },
          {
            name: '🔍 Failures by Category',
            value: [
              `👮 Soldiers below standard: **${failSoldiers}** member(s)`,
              `🚗 Tanks below standard: **${failTanks}** member(s)`,
              `✈️ Aircraft below standard: **${failAircraft}** member(s)`,
              `🚢 Ships below standard: **${failShips}** member(s)`,
              standards.missiles > 0 ? `🚀 Missiles below standard: **${failMissiles}** member(s)` : '',
            ].filter(Boolean).join('\n'),
            inline: false,
          },
          {
            name: '📏 Standards Used',
            value: [
              `Soldiers: ${standards.soldiers.toLocaleString()}`,
              `Tanks: ${standards.tanks.toLocaleString()}`,
              `Aircraft: ${standards.aircraft.toLocaleString()}`,
              `Ships: ${standards.ships.toLocaleString()}`,
              standards.missiles > 0 ? `Missiles: ${standards.missiles}` : '',
            ].filter(Boolean).join(' | '),
            inline: false,
          },
        )
        .setFooter({ text: 'Use /compliance check to see individual member details' })
        .setTimestamp();

      return interaction.editReply({ content: '', embeds: [embed] });
    }
  },
};
