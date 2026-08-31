// ============================================================
// src/commands/reporting/govDashboard.js
// /gov-dashboard — Government-level strategic overview
// ============================================================

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { query, queryOne } = require('../../utils/database');
const { getAllianceMembers } = require('../../utils/pwApi');
const { getBeigeTargets } = require('../../systems/beige/beigeTracker');

const { calculateNationReadiness, getReadinessWeights } = require('../../utils/mmrCalculator');
function scoreReadiness(member, weights) { return calculateNationReadiness(member, weights).total; }

module.exports = {
  data: new SlashCommandBuilder()
    .setName('gov-dashboard')
    .setDescription('Government strategic overview — full alliance and enemy picture'),

  requiredRole: 'government',

  async execute(interaction) {
    await interaction.deferReply();

    const guildId  = interaction.guildId;
    const guildRow = queryOne('SELECT alliance_id FROM guilds WHERE guild_id = ?', [guildId]);
    if (!guildRow?.alliance_id) {
      return interaction.editReply('❌ No alliance configured. Use `/config alliance` first.');
    }

    await interaction.editReply('⏳ Compiling government intelligence report...');

    // Our members
    let ourMembers = [];
    try { ourMembers = await getAllianceMembers(guildRow.alliance_id); }
    catch { return interaction.editReply('❌ Could not fetch alliance data from P&W.'); }

    const activeMembers   = ourMembers.filter(m => m.vacation_mode_turns === 0);
    const vacationCount   = ourMembers.length - activeMembers.length;
    const totalSoldiers   = ourMembers.reduce((s, m) => s + (m.soldiers  || 0), 0);
    const totalTanks      = ourMembers.reduce((s, m) => s + (m.tanks     || 0), 0);
    const totalAircraft   = ourMembers.reduce((s, m) => s + (m.aircraft  || 0), 0);
    const totalShips      = ourMembers.reduce((s, m) => s + (m.ships     || 0), 0);
    const totalMissiles   = ourMembers.reduce((s, m) => s + (m.missiles  || 0), 0);
    const totalNukes      = ourMembers.reduce((s, m) => s + (m.nukes     || 0), 0);
    const totalScore      = ourMembers.reduce((s, m) => s + (m.score     || 0), 0);
    const totalCities     = ourMembers.reduce((s, m) => s + (m.num_cities|| 0), 0);
    const totalOffSlots   = activeMembers.reduce((s, m) => s + Math.max(0, 5 - (m.offensive_wars_count || 0)), 0);
    const underAttack     = activeMembers.filter(m => (m.defensive_wars_count  || 0) > 0).length;
    const activeAttackers = activeMembers.filter(m => (m.offensive_wars_count  || 0) > 0).length;

    const _weights      = getReadinessWeights(guildId);
    const scored        = activeMembers.map(m => scoreReadiness(m, _weights));
    const avgReadiness  = scored.length > 0 ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length) : 0;
    const fullyReady    = scored.filter(s => s >= 75).length;
    const lowReadiness  = scored.filter(s => s <  50).length;

    // Enemy alliances
    const enemyAlliances = query(
      `SELECT * FROM alliance_watchlist WHERE guild_id = ? AND watchlist_type = 'enemy'`,
      [guildId]
    ).rows;

    const enemySummary = [];
    for (const ea of enemyAlliances.slice(0, 3)) {
      try {
        const mem = await getAllianceMembers(ea.alliance_id);
        enemySummary.push({
          name:     ea.alliance_name,
          id:       ea.alliance_id,
          members:  mem.length,
          aircraft: mem.reduce((s, m) => s + (m.aircraft || 0), 0),
          tanks:    mem.reduce((s, m) => s + (m.tanks    || 0), 0),
          score:    mem.reduce((s, m) => s + (m.score    || 0), 0),
          atWar:    mem.filter(m => (m.offensive_wars_count || 0) > 0).length,
        });
      } catch { /* skip */ }
    }

    // Beige
    let beigeNations = [];
    try { beigeNations = await getBeigeTargets(guildId); } catch { /* skip */ }
    const urgentBeige = beigeNations.filter(n => n.minutesRemaining <= 60);

    // Bot activity
    const activeAssignments = queryOne(`SELECT COUNT(*) as c FROM target_assignments WHERE guild_id = ? AND status NOT IN ('completed','cancelled','expired')`, [guildId])?.c || 0;
    const completedToday    = queryOne(`SELECT COUNT(*) as c FROM target_assignments WHERE guild_id = ? AND status = 'completed' AND updated_at >= datetime('now', '-1 day')`, [guildId])?.c || 0;
    const activeBlitzes     = queryOne(`SELECT COUNT(*) as c FROM blitz_operations WHERE guild_id = ? AND status = 'active'`, [guildId])?.c || 0;
    const activeOps         = queryOne(`SELECT COUNT(*) as c FROM operations WHERE guild_id = ? AND status = 'active'`, [guildId])?.c || 0;

    const readinessEmoji = avgReadiness >= 75 ? '🟢' : avgReadiness >= 50 ? '🟡' : avgReadiness >= 25 ? '🟠' : '🔴';
    const embeds = [];

    // EMBED 1 — HEADER
    embeds.push(
      new EmbedBuilder()
        .setTitle('🏛️ Government Strategic Dashboard')
        .setColor(0x8e44ad)
        .setDescription(
          `**Alliance ID:** ${guildRow.alliance_id}\n` +
          `**Members:** ${ourMembers.length} total (${activeMembers.length} active, ${vacationCount} on vacation)\n` +
          `**Total Score:** ${Math.round(totalScore).toLocaleString()} | **Total Cities:** ${totalCities}`
        )
        .setTimestamp()
        .setFooter({ text: 'PW Defense Bot • Government Dashboard' })
    );

    // EMBED 2 — OUR MILITARY
    embeds.push(
      new EmbedBuilder()
        .setTitle('🪖 Our Military Strength')
        .setColor(0x2ecc71)
        .addFields(
          { name: '👮 Soldiers',  value: totalSoldiers.toLocaleString(), inline: true },
          { name: '🚗 Tanks',     value: totalTanks.toLocaleString(),    inline: true },
          { name: '✈️ Aircraft',  value: totalAircraft.toLocaleString(), inline: true },
          { name: '🚢 Ships',     value: totalShips.toLocaleString(),    inline: true },
          { name: '🚀 Missiles',  value: `${totalMissiles}`,             inline: true },
          { name: '☢️ Nukes',     value: `${totalNukes}`,                inline: true },
          {
            name: '📊 Readiness',
            value: `${readinessEmoji} Average: **${avgReadiness}%**\n✅ Fully ready: **${fullyReady}** | ⚠️ Low readiness: **${lowReadiness}**`,
            inline: false,
          },
          {
            name: '⚔️ War Status',
            value: `Open slots: **${totalOffSlots}** | Attacking: **${activeAttackers}** | Defending: **${underAttack}**`,
            inline: false,
          },
        )
    );

    // EMBED 3 — ENEMY INTELLIGENCE
    if (enemySummary.length > 0) {
      const totalEnemyAircraft = enemySummary.reduce((s, e) => s + e.aircraft, 0);
      const totalEnemyTanks    = enemySummary.reduce((s, e) => s + e.tanks,    0);
      const airAdv  = totalAircraft - totalEnemyAircraft;
      const tankAdv = totalTanks    - totalEnemyTanks;

      const lines = enemySummary.map(e =>
        `⚔️ **[${e.name}](https://politicsandwar.com/alliance/id=${e.id})** — ${e.members} members | Score: ${Math.round(e.score).toLocaleString()}\n` +
        `└ ✈️ ${e.aircraft.toLocaleString()} | 🚗 ${e.tanks.toLocaleString()} | 🔥 ${e.atWar} at war`
      );

      embeds.push(
        new EmbedBuilder()
          .setTitle('🕵️ Enemy Intelligence')
          .setColor(0xe74c3c)
          .setDescription(lines.join('\n\n'))
          .addFields({
            name: '⚖️ Us vs Enemies Combined',
            value:
              `✈️ Aircraft: **${totalAircraft.toLocaleString()}** vs **${totalEnemyAircraft.toLocaleString()}** — ${airAdv  >= 0 ? `✅ +${airAdv.toLocaleString()}  advantage` : `❌ ${airAdv.toLocaleString()} deficit`}\n` +
              `🚗 Tanks:    **${totalTanks.toLocaleString()}**    vs **${totalEnemyTanks.toLocaleString()}**    — ${tankAdv >= 0 ? `✅ +${tankAdv.toLocaleString()} advantage` : `❌ ${tankAdv.toLocaleString()} deficit`}`,
          })
          .setFooter({ text: enemyAlliances.length > 3 ? `Showing 3 of ${enemyAlliances.length} enemy alliances` : 'Use /coalition compare for full side-by-side comparison' })
      );
    } else {
      embeds.push(
        new EmbedBuilder()
          .setTitle('🕵️ Enemy Intelligence')
          .setColor(0xe74c3c)
          .setDescription('No enemy alliances tracked.\nUse `/watch alliance add` to add enemies.')
      );
    }

    // EMBED 4 — OPERATIONS & BEIGE
    const beigeLines = urgentBeige.length > 0
      ? urgentBeige.slice(0, 5).map(n => `🟡 **[${n.nation_name}](https://politicsandwar.com/nation/id=${n.id})** — <t:${n.expiryTimestamp}:R>`)
      : ['✅ No urgent beige exits in the next 60 minutes'];

    embeds.push(
      new EmbedBuilder()
        .setTitle('📋 Operations & Beige')
        .setColor(0xf39c12)
        .addFields(
          {
            name: '🗂️ Current Operations',
            value:
              `📌 Active Assignments: **${activeAssignments}**\n` +
              `✅ Completed Today: **${completedToday}**\n` +
              `💥 Active Blitzes: **${activeBlitzes}**\n` +
              `🏴 Active Operations: **${activeOps}**`,
            inline: false,
          },
          {
            name: `🟡 Urgent Beige Exits — ${urgentBeige.length} in next 60min`,
            value: beigeLines.join('\n'),
            inline: false,
          },
        )
    );

    await interaction.editReply({ content: '', embeds });
  },
};
