// ============================================================
// src/jobs/reportJob.js — Automated daily alliance report
// ============================================================

const { EmbedBuilder } = require('discord.js');
const { query, queryOne } = require('../utils/database');
const { getAllianceMembers } = require('../utils/pwApi');
const { getAllLinks } = require('../utils/nationLink');
const { getBeigeTargets } = require('../systems/beige/beigeTracker');
const logger = require('../utils/logger');

const { calculateNationReadiness, getReadinessWeights } = require('../utils/mmrCalculator');
function scoreReadiness(member, weights) { return calculateNationReadiness(member, weights).total; }

async function generateDailyReport(client) {
  logger.info('Generating daily reports...');
  const guilds = query('SELECT guild_id, alliance_id FROM guilds WHERE alliance_id IS NOT NULL', []).rows;
  for (const g of guilds) {
    await sendDailyReport(client, g.guild_id, g.alliance_id);
  }
}

async function sendDailyReport(client, guildId, allianceId) {
  try {
    // Find a report channel — prefer intel, then wars, then beige
    let channelRow =
      queryOne(`SELECT discord_channel_id FROM guild_channels WHERE guild_id = ? AND channel_type = 'intel'`, [guildId]) ||
      queryOne(`SELECT discord_channel_id FROM guild_channels WHERE guild_id = ? AND channel_type = 'wars'`,  [guildId]) ||
      queryOne(`SELECT discord_channel_id FROM guild_channels WHERE guild_id = ? AND channel_type = 'beige'`, [guildId]);

    if (!channelRow) { logger.warn(`Daily report: no channel for guild ${guildId}`); return; }
    const channel = client.channels.cache.get(channelRow.discord_channel_id);
    if (!channel)   { logger.warn(`Daily report: channel missing for guild ${guildId}`); return; }

    const members = await getAllianceMembers(allianceId);
    const active  = members.filter(m => m.vacation_mode_turns === 0);

    const _weights     = getReadinessWeights(guildId);
    const scored       = active.map(m => scoreReadiness(m, _weights));
    const avgReadiness = scored.length > 0 ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length) : 0;
    const lowCount     = scored.filter(s => s < 50).length;

    const totalOffSlots   = active.reduce((s, m) => s + Math.max(0, 5 - (m.offensive_wars_count || 0)), 0);
    const underAttack     = active.filter(m => (m.defensive_wars_count  || 0) > 0).length;
    const activeAttackers = active.filter(m => (m.offensive_wars_count  || 0) > 0).length;
    const noWars          = active.filter(m => (m.offensive_wars_count  || 0) === 0).length;

    let beigeNations = [];
    try { beigeNations = await getBeigeTargets(guildId); } catch { /* skip */ }

    const completedYesterday = queryOne(
      `SELECT COUNT(*) as c FROM target_assignments WHERE guild_id = ? AND status = 'completed' AND updated_at >= datetime('now', '-1 day')`,
      [guildId]
    )?.c || 0;

    const pendingAssignments = queryOne(
      `SELECT COUNT(*) as c FROM target_assignments WHERE guild_id = ? AND status NOT IN ('completed','cancelled','expired')`,
      [guildId]
    )?.c || 0;

    const readinessEmoji = avgReadiness >= 75 ? '🟢' : avgReadiness >= 50 ? '🟡' : avgReadiness >= 25 ? '🟠' : '🔴';
    const dateStr = new Date().toUTCString().split(' ').slice(0, 4).join(' ');

    const embed = new EmbedBuilder()
      .setTitle(`📅 Daily Alliance Report — ${dateStr}`)
      .setColor(0x3498db)
      .addFields(
        {
          name: '👥 Alliance Status',
          value:
            `Members: **${members.length}** (${active.length} active, ${members.length - active.length} vacation)\n` +
            `${readinessEmoji} Avg Readiness: **${avgReadiness}%**\n` +
            (lowCount > 0 ? `⚠️ ${lowCount} member(s) below 50% readiness` : '✅ All members above 50% readiness'),
        },
        {
          name: '⚔️ War Activity',
          value:
            `Attacking: **${activeAttackers}** | Defending: **${underAttack}** | No Wars: **${noWars}**\n` +
            `Open Offensive Slots: **${totalOffSlots}**`,
        },
        {
          name: '🔗 Nation Links',
          value: (() => {
            const links = getAllLinks(guildId);
            const linkPct = members.length > 0 ? Math.round((links.length / members.length) * 100) : 0;
            return `${links.length} / ${members.length} members linked (${linkPct}%)${linkPct < 50 ? '\n⚠️ Encourage members to run `/link set`' : ''}`;
          })(),
        },
        {
          name: '📋 Bot Activity (Last 24h)',
          value: `Assignments Completed: **${completedYesterday}** | Pending: **${pendingAssignments}**`,
        },
        {
          name: `🟡 Nations in Beige — ${beigeNations.length}`,
          value: beigeNations.length > 0
            ? beigeNations.slice(0, 5).map(n =>
                `• **[${n.nation_name}](https://politicsandwar.com/nation/id=${n.id})** — <t:${n.expiryTimestamp}:R>`
              ).join('\n') + (beigeNations.length > 5 ? `\n_...and ${beigeNations.length - 5} more_` : '')
            : '✅ No tracked nations in beige',
        },
      )
      .setTimestamp()
      .setFooter({ text: 'PW Defense Bot • Automated Daily Report' });

    await channel.send({ embeds: [embed] });
    logger.info(`Daily report sent for guild ${guildId}`);

  } catch (err) {
    logger.error(`Daily report failed for guild ${guildId}: ${err.message}`);
  }
}

module.exports = { generateDailyReport };
