// ============================================================
// src/commands/reporting/health.js
// /health — Alliance health score and strategic overview
// ============================================================

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { query, queryOne } = require('../../utils/database');
const { getAllianceMembers } = require('../../utils/pwApi');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('health')
    .setDescription('View your alliance\'s overall health score and strategic overview'),

  requiredRole: 'military',

  async execute(interaction) {
    await interaction.deferReply();

    const guildId = interaction.guildId;
    const guildRow = queryOne('SELECT alliance_id FROM guilds WHERE guild_id = ?', [guildId]);
    if (!guildRow?.alliance_id) {
      return interaction.editReply('❌ No alliance configured. Use `/config alliance` first.');
    }

    await interaction.editReply('⏳ Calculating alliance health...');

    // Fetch live member data
    let members = [];
    try {
      members = await getAllianceMembers(guildRow.alliance_id);
    } catch {
      return interaction.editReply('❌ Could not fetch alliance data from P&W. Try again shortly.');
    }

    if (members.length === 0) {
      return interaction.editReply('❌ No members found. Check your alliance ID with `/config view`.');
    }

    const activeMembers = members.filter(m => m.vacation_mode_turns === 0);
    const vacationCount = members.length - activeMembers.length;

    // ── SCORE 1: MILITARY READINESS (30 points) ──────────────
    const { calculateNationReadiness, getReadinessWeights } = require('../../utils/mmrCalculator');
    const weights = getReadinessWeights(guildId);

    const milScores = activeMembers.map(m => calculateNationReadiness(m, weights).total / 100);
    const avgMilScore = milScores.reduce((a, b) => a + b, 0) / (milScores.length || 1);
    const milPoints   = Math.round(avgMilScore * 30);

    // ── SCORE 2: WAR CAPACITY (25 points) ────────────────────
    const totalOffSlots = activeMembers.reduce((s, m) => s + Math.max(0, 5 - m.offensive_wars_count), 0);
    const maxOffSlots   = activeMembers.length * 5;
    const slotRatio     = maxOffSlots > 0 ? totalOffSlots / maxOffSlots : 0;
    const capacityPoints = Math.round(slotRatio * 25);

    // ── SCORE 3: ACTIVITY (20 points) ────────────────────────
    // Members with wars (offensive) = active fighters
    const activeWarriors = activeMembers.filter(m => m.offensive_wars_count > 0).length;
    const activityRatio  = activeMembers.length > 0 ? activeWarriors / activeMembers.length : 0;
    const activityPoints = Math.round(activityRatio * 20);

    // ── SCORE 4: WATCHLIST SETUP (15 points) ─────────────────
    const enemyCount   = query(`SELECT COUNT(*) as c FROM alliance_watchlist WHERE guild_id = ? AND watchlist_type = 'enemy'`, [guildId]).rows[0]?.c || 0;
    const channelCount = query(`SELECT COUNT(*) as c FROM guild_channels WHERE guild_id = ?`, [guildId]).rows[0]?.c || 0;
    const roleCount    = query(`SELECT COUNT(*) as c FROM guild_roles WHERE guild_id = ?`, [guildId]).rows[0]?.c || 0;
    const setupScore   = Math.min((enemyCount > 0 ? 5 : 0) + (channelCount >= 2 ? 5 : channelCount * 2) + (roleCount >= 2 ? 5 : roleCount * 2), 15);

    // ── SCORE 5: ASSIGNMENTS ACTIVITY (10 points) ────────────
    const recentAssignments = query(
      `SELECT COUNT(*) as c FROM target_assignments WHERE guild_id = ? AND created_at >= datetime('now', '-7 days')`,
      [guildId]
    ).rows[0]?.c || 0;
    const assignmentPoints = Math.min(recentAssignments * 2, 10);

    // ── TOTAL ─────────────────────────────────────────────────
    const totalScore = milPoints + capacityPoints + activityPoints + setupScore + assignmentPoints;

    // Grade
    const grade = totalScore >= 85 ? 'S' : totalScore >= 70 ? 'A' : totalScore >= 55 ? 'B' : totalScore >= 40 ? 'C' : totalScore >= 25 ? 'D' : 'F';
    const gradeColor = { S: 0x1abc9c, A: 0x2ecc71, B: 0x3498db, C: 0xf1c40f, D: 0xe67e22, F: 0xe74c3c };
    const gradeEmoji = { S: '🏆', A: '⭐', B: '✅', C: '⚠️', D: '🟠', F: '🔴' };

    // Strengths and weaknesses
    const strengths = [];
    const improvements = [];

    if (milPoints >= 24)       strengths.push('💪 Strong military readiness');
    else                       improvements.push('🪖 Improve military — soldiers, tanks, aircraft, ships below standard');

    if (capacityPoints >= 20)  strengths.push('⚔️ Excellent war slot availability');
    else                       improvements.push('⚔️ Members have too many active wars — fewer open slots');

    if (activityPoints >= 15)  strengths.push('🔥 High member war activity');
    else                       improvements.push('📢 Low war activity — encourage members to declare wars');

    if (setupScore >= 12)      strengths.push('🛠️ Bot well-configured with channels and roles');
    else                       improvements.push('⚙️ Finish bot setup — add channels, roles, enemy alliances');

    if (assignmentPoints >= 6) strengths.push('📋 Active use of target assignments');
    else                       improvements.push('🎯 Use `/assign create` more to coordinate attacks');

    if (vacationCount > members.length * 0.3)
      improvements.push(`🏖️ ${vacationCount} members in vacation mode — high absence rate`);

    const embed = new EmbedBuilder()
      .setTitle(`${gradeEmoji[grade]} Alliance Health Report — Grade ${grade}`)
      .setColor(gradeColor[grade])
      .setDescription(`**Overall Health Score: ${totalScore}/100**\n\u200b`)
      .addFields(
        {
          name: '📊 Score Breakdown',
          value: [
            `🪖 Military Readiness:  **${milPoints}/30**`,
            `⚔️ War Capacity:        **${capacityPoints}/25**`,
            `🔥 Member Activity:     **${activityPoints}/20**`,
            `⚙️ Bot Configuration:   **${setupScore}/15**`,
            `📋 Assignment Activity: **${assignmentPoints}/10**`,
          ].join('\n'),
          inline: false,
        },
        {
          name: '👥 Alliance Overview',
          value: [
            `Total Members: **${members.length}**`,
            `Active: **${activeMembers.length}** | Vacation: **${vacationCount}**`,
            `Open War Slots: **${totalOffSlots}** / ${maxOffSlots}`,
            `Currently at War: **${activeWarriors}** member(s)`,
          ].join('\n'),
          inline: false,
        },
      )
      .setTimestamp()
      .setFooter({ text: 'Health score updates in real-time from P&W data' });

    if (strengths.length > 0) {
      embed.addFields({ name: '✅ Strengths', value: strengths.join('\n'), inline: false });
    }
    if (improvements.length > 0) {
      embed.addFields({ name: '📈 Areas to Improve', value: improvements.join('\n'), inline: false });
    }

    await interaction.editReply({ content: '', embeds: [embed] });
  },
};
