// ============================================================
// src/commands/intelligence/enemy.js
// /enemy — Deep intelligence profile of any alliance
// ============================================================

const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { resolveAlliance, getAllianceMembers } = require('../../utils/pwApi');
const { calculateNationReadiness, getReadinessWeights, readinessEmoji, PER_CITY } = require('../../utils/mmrCalculator');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('enemy')
    .setDescription('Deep intelligence profile of any alliance')
    .addStringOption(opt =>
      opt.setName('alliance')
        .setDescription('Alliance name, ID, or P&W link')
        .setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('view')
        .setDescription('What to show')
        .addChoices(
          { name: '📊 Overview (default)', value: 'overview' },
          { name: '🪖 Military breakdown', value: 'military' },
          { name: '📋 Full member list (CSV)', value: 'members' },
        )
    ),

  requiredRole: 'military',

  async execute(interaction) {
    await interaction.deferReply();
    const input = interaction.options.getString('alliance');
    const view  = interaction.options.getString('view') || 'overview';

    await interaction.editReply(`🔍 Looking up **${input}**...`);

    const alliance = await resolveAlliance(input);
    if (!alliance) {
      return interaction.editReply(`❌ Could not find alliance **"${input}"**. Try name, ID, or P&W link.`);
    }

    await interaction.editReply(`⏳ Fetching member data for **${alliance.name}**...`);

    let members = [];
    try {
      members = await getAllianceMembers(alliance.id);
    } catch {
      return interaction.editReply('❌ Could not fetch member data from P&W. Try again shortly.');
    }

    if (members.length === 0) {
      return interaction.editReply(`❌ No members found for **${alliance.name}**.`);
    }

    const activeMembers  = members.filter(m => m.vacation_mode_turns === 0);
    const vacationCount  = members.length - activeMembers.length;
    const inBeige        = members.filter(m => (m.beige_turns || 0) > 0).length;
    const activeWars     = members.filter(m => (m.offensive_wars_count || 0) > 0).length;
    const underAttack    = members.filter(m => (m.defensive_wars_count || 0) > 0).length;
    const openOffSlots   = activeMembers.reduce((s, m) => s + Math.max(0, 5 - (m.offensive_wars_count || 0)), 0);

    // Military totals
    const totals = {
      soldiers: members.reduce((s, m) => s + (m.soldiers  || 0), 0),
      tanks:    members.reduce((s, m) => s + (m.tanks     || 0), 0),
      aircraft: members.reduce((s, m) => s + (m.aircraft  || 0), 0),
      ships:    members.reduce((s, m) => s + (m.ships     || 0), 0),
      missiles: members.reduce((s, m) => s + (m.missiles  || 0), 0),
      nukes:    members.reduce((s, m) => s + (m.nukes     || 0), 0),
      score:    members.reduce((s, m) => s + (m.score     || 0), 0),
      cities:   members.reduce((s, m) => s + (m.num_cities|| 0), 0),
    };

    // MMR capacity totals
    const maxTotals = {
      soldiers: totals.cities * PER_CITY.soldiers,
      tanks:    totals.cities * PER_CITY.tanks,
      aircraft: totals.cities * PER_CITY.aircraft,
      ships:    totals.cities * PER_CITY.ships,
    };

    // Readiness
    const weights = getReadinessWeights(interaction.guildId);
    const readinessScores = activeMembers.map(m => calculateNationReadiness(m, weights).total);
    const avgReadiness    = readinessScores.length > 0
      ? Math.round(readinessScores.reduce((a, b) => a + b, 0) / readinessScores.length)
      : 0;

    const embeds = [];

    // ── OVERVIEW ─────────────────────────────────────────────
    if (view === 'overview' || view === 'military') {
      embeds.push(
        new EmbedBuilder()
          .setTitle(`🕵️ Alliance Intelligence — ${alliance.name}`)
          .setColor(0x2c3e50)
          .addFields(
            { name: '👥 Members', value: `${members.length} total | ${activeMembers.length} active | ${vacationCount} vacation`, inline: false },
            { name: '⭐ Total Score', value: Math.round(totals.score).toLocaleString(), inline: true },
            { name: '🏙️ Total Cities', value: totals.cities.toLocaleString(), inline: true },
            { name: `${readinessEmoji(avgReadiness)} Avg Readiness`, value: `**${avgReadiness}%**`, inline: true },
            { name: '🟡 In Beige', value: `${inBeige}`, inline: true },
            { name: '⚔️ Actively Attacking', value: `${activeWars}`, inline: true },
            { name: '🛡️ Under Attack', value: `${underAttack}`, inline: true },
            { name: '🔓 Open Offensive Slots', value: `${openOffSlots}`, inline: true },
            {
              name: '🔗 Alliance Page',
              value: `[View on P&W](https://politicsandwar.com/alliance/id=${alliance.id})`,
              inline: true,
            },
          )
          .setTimestamp()
          .setFooter({ text: `Alliance ID: ${alliance.id}` })
      );

      // Military embed
      embeds.push(
        new EmbedBuilder()
          .setTitle('🪖 Combined Military')
          .setColor(0xe74c3c)
          .addFields(
            {
              name: '📊 Totals vs MMR Capacity',
              value: [
                `👮 Soldiers:  **${totals.soldiers.toLocaleString()}** / ${maxTotals.soldiers.toLocaleString()} (${Math.round(totals.soldiers / maxTotals.soldiers * 100)}%)`,
                `🚗 Tanks:     **${totals.tanks.toLocaleString()}** / ${maxTotals.tanks.toLocaleString()} (${Math.round(totals.tanks / maxTotals.tanks * 100)}%)`,
                `✈️ Aircraft:  **${totals.aircraft.toLocaleString()}** / ${maxTotals.aircraft.toLocaleString()} (${Math.round(totals.aircraft / maxTotals.aircraft * 100)}%)`,
                `🚢 Ships:     **${totals.ships.toLocaleString()}** / ${maxTotals.ships.toLocaleString()} (${Math.round(totals.ships / maxTotals.ships * 100)}%)`,
                `🚀 Missiles:  **${totals.missiles}**`,
                `☢️ Nukes:     **${totals.nukes}**`,
              ].join('\n'),
              inline: false,
            },
            {
              name: '⚠️ Threat Assessment',
              value: buildThreatAssessment(totals, avgReadiness, activeWars, members.length),
              inline: false,
            },
          )
      );

      // Top 5 strongest members
      const top5 = [...members]
        .sort((a, b) => (b.score || 0) - (a.score || 0))
        .slice(0, 5);

      embeds.push(
        new EmbedBuilder()
          .setTitle('🏆 Top 5 Strongest Members')
          .setColor(0x8e44ad)
          .setDescription(
            top5.map((m, i) =>
              `**${i + 1}.** [${m.nation_name}](https://politicsandwar.com/nation/id=${m.id}) — Score: ${m.score?.toLocaleString()} | ✈️ ${m.aircraft || 0} | 🚗 ${m.tanks || 0} | ☢️ ${m.nukes || 0}`
            ).join('\n')
          )
          .setFooter({ text: 'Use /nation [name] to get a full profile of any member | Use /enemy [alliance] members for full CSV list' })
      );
    }

    // ── FULL MEMBER LIST (CSV) ───────────────────────────────
    if (view === 'members') {
      const headers = ['Nation', 'Nation ID', 'Score', 'Cities', 'Soldiers', 'Tanks', 'Aircraft', 'Ships', 'Missiles', 'Nukes', 'Spies', 'Off Wars', 'Def Wars', 'Beige Turns', 'Vacation', 'Profile Link'];
      const rows = members.map(m => [
        m.nation_name || '',
        m.id,
        m.score || 0,
        m.num_cities || 0,
        m.soldiers || 0,
        m.tanks || 0,
        m.aircraft || 0,
        m.ships || 0,
        m.missiles || 0,
        m.nukes || 0,
        m.spies || 0,
        m.offensive_wars_count || 0,
        m.defensive_wars_count || 0,
        m.beige_turns || 0,
        m.vacation_mode_turns > 0 ? 'Yes' : 'No',
        `https://politicsandwar.com/nation/id=${m.id}`,
      ]);

      const csvLines = [headers, ...rows].map(row =>
        row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')
      );
      const csv = csvLines.join('\n');

      const tmpFile = path.join(os.tmpdir(), `enemy_${alliance.id}_${Date.now()}.csv`);
      fs.writeFileSync(tmpFile, csv, 'utf8');
      const attachment = new AttachmentBuilder(tmpFile, { name: `${alliance.name.replace(/[^a-z0-9]/gi, '_')}_members.csv` });

      const summaryEmbed = new EmbedBuilder()
        .setTitle(`📋 ${alliance.name} — Full Member List`)
        .setColor(0x3498db)
        .setDescription(`**${members.length} members** exported to CSV.\nOpen in Excel or Google Sheets for full details.`)
        .addFields(
          { name: '👥 Total Members', value: `${members.length}`, inline: true },
          { name: '⭐ Total Score', value: Math.round(totals.score).toLocaleString(), inline: true },
          { name: '☢️ Total Nukes', value: `${totals.nukes}`, inline: true },
        )
        .setTimestamp();

      await interaction.editReply({ content: '', embeds: [summaryEmbed], files: [attachment] });
      setTimeout(() => { try { fs.unlinkSync(tmpFile); } catch {} }, 10000);
      return;
    }

    await interaction.editReply({ content: '', embeds });
  },
};

function buildThreatAssessment(totals, avgReadiness, activeWars, memberCount) {
  const lines = [];

  if (totals.nukes > 5)    lines.push('☢️ **Nuclear threat** — significant nuke stockpile');
  if (totals.missiles > 20) lines.push('🚀 **Missile threat** — high missile count');
  if (avgReadiness > 80)   lines.push('⚠️ **High readiness** — well-prepared for war');
  if (avgReadiness < 50)   lines.push('✅ **Low readiness** — vulnerable to attack');
  if (activeWars > memberCount * 0.5) lines.push('⚔️ **Heavily engaged** — most members already at war');
  if (activeWars < memberCount * 0.2) lines.push('🎯 **Low engagement** — many members have open slots to attack us');

  const aircraftRatio = totals.aircraft / Math.max(totals.cities * PER_CITY.aircraft, 1);
  if (aircraftRatio > 0.8) lines.push('✈️ **Strong air force** — high aircraft fill rate');
  if (aircraftRatio < 0.4) lines.push('✈️ **Weak air force** — low aircraft fill rate, good counter opportunity');

  return lines.length > 0 ? lines.join('\n') : '⚪ No significant threat indicators detected.';
}
