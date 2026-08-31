// ============================================================
// src/commands/military/readiness.js
// MMR-based alliance readiness — each nation scored against
// its own maximum capacity, not fixed absolute numbers
// ============================================================

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { queryOne, run } = require('../../utils/database');
const { buildNationToDiscordMap } = require('../../utils/nationLink');
const { getAllianceMembers } = require('../../utils/pwApi');
const {
  calculateNationReadiness,
  calculateAllianceReadiness,
  getReadinessWeights,
  readinessEmoji,
  readinessColor,
  PER_CITY,
  MAX_SPIES,
  DEFAULT_WEIGHTS,
} = require('../../utils/mmrCalculator');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('readiness')
    .setDescription('Alliance military readiness based on MMR (5/5/5/3 standard)')

    .addSubcommand(sub =>
      sub.setName('check')
        .setDescription('View full alliance readiness report')
        .addStringOption(opt =>
          opt.setName('view')
            .setDescription('What to show')
            .addChoices(
              { name: '📊 Summary (default)', value: 'summary' },
              { name: '⚠️ Low readiness only (<70%)', value: 'low' },
              { name: '✅ Full member list', value: 'full' },
            )
        )
    )

    .addSubcommand(sub =>
      sub.setName('nation')
        .setDescription('Check readiness of a specific nation in your alliance')
        .addStringOption(opt =>
          opt.setName('name')
            .setDescription('Nation name or ID')
            .setRequired(true)
        )
    )

    .addSubcommand(sub =>
      sub.setName('weights')
        .setDescription('Configure readiness score weights (must add up to 100)')
        .addIntegerOption(opt =>
          opt.setName('units')
            .setDescription('Weight for military units filled (soldiers/tanks/aircraft/ships)')
        )
        .addIntegerOption(opt =>
          opt.setName('spies')
            .setDescription('Weight for spies filled (max 60)')
        )
        .addIntegerOption(opt =>
          opt.setName('missiles')
            .setDescription('Weight for missiles relative to capacity')
        )
        .addIntegerOption(opt =>
          opt.setName('nukes')
            .setDescription('Weight for nukes')
        )
        .addIntegerOption(opt =>
          opt.setName('score')
            .setDescription('Weight for nation score (development proxy)')
        )
    ),

  requiredRole: 'military',

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    // ── WEIGHTS CONFIG ───────────────────────────────────────
    if (sub === 'weights') {
      const fields = ['units', 'spies', 'missiles', 'nukes', 'score'];
      const provided = {};
      let total = 0;

      for (const f of fields) {
        const val = interaction.options.getInteger(f);
        if (val !== null) {
          provided[f] = val;
          total += val;
        }
      }

      if (Object.keys(provided).length === 0) {
        // Show current weights
        const weights = getReadinessWeights(interaction.guildId);
        const lines = Object.entries(weights).map(([k, v]) => `**${k}**: ${v}%`);
        return interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setTitle('⚖️ Readiness Score Weights')
              .setColor(0x3498db)
              .setDescription(
                'These weights determine how each factor contributes to the readiness score.\n\n' +
                lines.join('\n') + '\n\n' +
                '`units` — soldiers, tanks, aircraft, ships vs MMR capacity\n' +
                '`spies` — spies vs max 60\n' +
                '`missiles` — missiles vs city × 2\n' +
                '`nukes` — nukes vs 1 per 10 cities\n' +
                '`score` — nation score as development proxy'
              )
              .setFooter({ text: 'Use /readiness weights units:60 spies:20 missiles:10 nukes:5 score:5 to change' })
              .setTimestamp(),
          ],
          flags: 64,
        });
      }

      // Validate provided values are all positive
      if (Object.values(provided).some(v => v < 0)) {
        return interaction.reply({ content: '❌ All weights must be 0 or higher.', flags: 64 });
      }

      // Save each provided weight
      for (const [key, val] of Object.entries(provided)) {
        run(
          `INSERT INTO alert_settings (guild_id, alert_type, setting_key, setting_value)
           VALUES (?, 'readiness_weights', ?, ?)
           ON CONFLICT(guild_id, alert_type, setting_key) DO UPDATE SET setting_value = excluded.setting_value`,
          [interaction.guildId, key, String(val)]
        );
      }

      const currentWeights = getReadinessWeights(interaction.guildId);
      const currentTotal = Object.values(currentWeights).reduce((a, b) => a + b, 0);
      const updated = Object.entries(provided).map(([k, v]) => `**${k}**: ${v}%`).join(', ');

      return interaction.reply({
        content:
          `✅ Weights updated: ${updated}\n` +
          `Current total: **${currentTotal}%** ${currentTotal !== 100 ? '⚠️ (weights don\'t add to 100 — scores will be normalised automatically)' : '✅'}`,
        flags: 64,
      });
    }

    // ── CHECK ────────────────────────────────────────────────
    if (sub === 'check') {
      await interaction.deferReply();

      const view     = interaction.options.getString('view') || 'summary';
      const guildRow = queryOne('SELECT alliance_id FROM guilds WHERE guild_id = ?', [interaction.guildId]);
      if (!guildRow?.alliance_id) {
        return interaction.editReply('❌ No alliance configured. Use `/config alliance` first.');
      }

      await interaction.editReply('⏳ Fetching alliance military data from P&W...');

      let members;
      try {
        members = await getAllianceMembers(guildRow.alliance_id);
      } catch {
        return interaction.editReply('❌ Could not fetch alliance data. Try again shortly.');
      }

      const weights       = getReadinessWeights(interaction.guildId);
      const activeMembers = members.filter(m => m.vacation_mode_turns === 0);
      const vacationCount = members.length - activeMembers.length;

      const { average, breakdown, scores } = calculateAllianceReadiness(activeMembers, weights);

      // Pair each member with their score
      const memberScores = activeMembers.map((m, i) => ({ ...m, readiness: scores[i] }));
      const sorted       = [...memberScores].sort((a, b) => a.readiness.total - b.readiness.total);

      const fullyReady   = sorted.filter(m => m.readiness.total >= 90).length;
      const goodReady    = sorted.filter(m => m.readiness.total >= 70 && m.readiness.total < 90).length;
      const lowReady     = sorted.filter(m => m.readiness.total < 70).length;

      const embeds = [];

      // ── SUMMARY EMBED ──────────────────────────────────────
      embeds.push(
        new EmbedBuilder()
          .setTitle('🪖 Alliance MMR Readiness Report')
          .setColor(readinessColor(average))
          .setDescription(
            `**Readiness standard: 5/5/5/3 MMR** (5 Barracks · 5 Factories · 5 Hangars · 3 Drydocks per city)\n\u200b`
          )
          .addFields(
            {
              name: '📊 Overall Alliance Readiness',
              value:
                `${readinessEmoji(average)} **${average}%** average across **${activeMembers.length}** active members\n` +
                `🟢 90%+: **${fullyReady}** | 🟡 70-89%: **${goodReady}** | 🔴 <70%: **${lowReady}** | 🏖️ Vacation: **${vacationCount}**`,
              inline: false,
            },
            {
              name: '📈 Category Averages',
              value: [
                `🪖 Unit Fill Rate: **${breakdown.units}%**`,
                `🕵️ Spies: **${breakdown.spies}%**`,
                `🚀 Missiles: **${breakdown.missiles}%**`,
                `☢️ Nukes: **${breakdown.nukes}%**`,
                `⭐ Score: **${breakdown.score}%**`,
              ].join('\n'),
              inline: true,
            },
            {
              name: '⚖️ Score Weights',
              value: [
                `Units: **${weights.units}%**`,
                `Spies: **${weights.spies}%**`,
                `Missiles: **${weights.missiles}%**`,
                `Nukes: **${weights.nukes}%**`,
                `Score: **${weights.score}%**`,
              ].join('\n'),
              inline: true,
            },
            {
              name: '📏 MMR Capacity Formula',
              value:
                `Per city: 👮 ${PER_CITY.soldiers.toLocaleString()} soldiers | ` +
                `🚗 ${PER_CITY.tanks.toLocaleString()} tanks | ` +
                `✈️ ${PER_CITY.aircraft} aircraft | ` +
                `🚢 ${PER_CITY.ships} ships | ` +
                `🕵️ ${MAX_SPIES} spies (global cap)`,
              inline: false,
            },
          )
          .setFooter({ text: 'Use /readiness weights to configure score weights | /readiness nation to check one member' })
          .setTimestamp()
      );

      // ── MEMBER LIST EMBED ──────────────────────────────────
      // Build Discord mention map for linked members
      const discordMap = buildNationToDiscordMap(interaction.guildId);

      const toShow = view === 'low'
        ? sorted.filter(m => m.readiness.total < 70)
        : view === 'full' ? sorted : sorted.filter(m => m.readiness.total < 90);

      if (toShow.length > 0) {
        // Split into pages of 8
        const pages = [];
        for (let i = 0; i < toShow.length; i += 8) pages.push(toShow.slice(i, i + 8));

        for (const [pi, page] of pages.entries()) {
          if (embeds.length >= 10) break; // Discord max 10 embeds

          const lines = page.map(m => {
            const r  = m.readiness;
            const cap = r.capacity;
            const cities = m.num_cities || 1;
            return (
              `${readinessEmoji(r.total)} **[${m.nation_name}](https://politicsandwar.com/nation/id=${m.id})**${discordMap.get(m.id) ? ` (<@${discordMap.get(m.id)}>)` : ''} — **${r.total}%** | ${cities} cities\n` +
              `└ 👮 ${(m.soldiers || 0).toLocaleString()}/${cap.maxSoldiers.toLocaleString()} ` +
              `🚗 ${(m.tanks || 0).toLocaleString()}/${cap.maxTanks.toLocaleString()} ` +
              `✈️ ${m.aircraft || 0}/${cap.maxAircraft} ` +
              `🚢 ${m.ships || 0}/${cap.maxShips} ` +
              `🕵️ ${m.spies || 0}/${MAX_SPIES}`
            );
          });

          const title = pi === 0
            ? view === 'low' ? `⚠️ Low Readiness Members (<70%) — ${toShow.length}` : `📋 Member Readiness (${view})`
            : `📋 Member Readiness (continued)`;

          embeds.push(
            new EmbedBuilder()
              .setTitle(title)
              .setColor(readinessColor(average))
              .setDescription(lines.join('\n\n'))
              .setFooter({ text: `Page ${pi + 1} of ${pages.length}` })
          );
        }
      }

      await interaction.editReply({ content: '', embeds });
      return;
    }

    // ── NATION ───────────────────────────────────────────────
    if (sub === 'nation') {
      await interaction.deferReply({ flags: 64 });

      const nameInput = interaction.options.getString('name');
      const guildRow  = queryOne('SELECT alliance_id FROM guilds WHERE guild_id = ?', [interaction.guildId]);
      if (!guildRow?.alliance_id) {
        return interaction.editReply('❌ No alliance configured.');
      }

      await interaction.editReply(`🔍 Looking up **${nameInput}**...`);

      const members = await getAllianceMembers(guildRow.alliance_id);
      const nameLower = nameInput.toLowerCase();
      const member = members.find(m =>
        m.nation_name?.toLowerCase() === nameLower ||
        String(m.id) === nameInput.trim()
      );

      if (!member) {
        return interaction.editReply(`❌ Could not find **"${nameInput}"** in your alliance. They must be a member (not applicant).`);
      }

      const weights  = getReadinessWeights(interaction.guildId);
      const result   = calculateNationReadiness(member, weights);
      const cities   = member.num_cities || 1;
      const cap      = result.capacity;
      const bd       = result.breakdown;

      const embed = new EmbedBuilder()
        .setTitle(`🪖 MMR Readiness — ${member.nation_name}`)
        .setColor(readinessColor(result.total))
        .setDescription(`**Overall Readiness: ${readinessEmoji(result.total)} ${result.total}%**\nCities: **${cities}** | Score: **${member.score?.toLocaleString() || '?'}**\n\u200b`)
        .addFields(
          {
            name: '🪖 Military Units vs MMR Capacity',
            value: [
              `👮 Soldiers:  **${(member.soldiers || 0).toLocaleString()}** / ${cap.maxSoldiers.toLocaleString()} — ${bd.units}%`,
              `🚗 Tanks:     **${(member.tanks    || 0).toLocaleString()}** / ${cap.maxTanks.toLocaleString()}`,
              `✈️ Aircraft:  **${member.aircraft  || 0}** / ${cap.maxAircraft}`,
              `🚢 Ships:     **${member.ships     || 0}** / ${cap.maxShips}`,
            ].join('\n'),
            inline: false,
          },
          {
            name: '🕵️ Spies',
            value: `**${member.spies || 0}** / ${MAX_SPIES} — ${bd.spies}%`,
            inline: true,
          },
          {
            name: '🚀 Missiles',
            value: `**${member.missiles || 0}** / ${cap.maxMissiles} — ${bd.missiles}%`,
            inline: true,
          },
          {
            name: '☢️ Nukes',
            value: `**${member.nukes || 0}** — ${bd.nukes}%`,
            inline: true,
          },
          {
            name: '📊 Score Breakdown',
            value: [
              `🪖 Units: **${bd.units}%** (weight: ${weights.units}%)`,
              `🕵️ Spies: **${bd.spies}%** (weight: ${weights.spies}%)`,
              `🚀 Missiles: **${bd.missiles}%** (weight: ${weights.missiles}%)`,
              `☢️ Nukes: **${bd.nukes}%** (weight: ${weights.nukes}%)`,
              `⭐ Score: **${bd.score}%** (weight: ${weights.score}%)`,
            ].join('\n'),
            inline: false,
          },
        )
        .setFooter({ text: `Nation ID: ${member.id} | MMR standard: 5/5/5/3 per city` })
        .setTimestamp();

      return interaction.editReply({ content: '', embeds: [embed] });
    }
  },
};
