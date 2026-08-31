// ============================================================
// src/systems/beige/beigeAlerts.js
// ============================================================
const { EmbedBuilder } = require('discord.js');
const { query, queryOne } = require('../../utils/database');
const { getEligibleAttackers, formatTimeRemaining } = require('./beigeTracker');
const logger = require('../../utils/logger');

const DEFAULT_INTERVALS = [60, 30, 15, 5];

function getAlertIntervals(guildId) {
  const rows = query(`SELECT setting_value FROM alert_settings WHERE guild_id = ? AND alert_type = 'beige' AND setting_key = 'intervals'`, [guildId]).rows;
  if (rows.length > 0) { try { return JSON.parse(rows[0].setting_value); } catch { return DEFAULT_INTERVALS; } }
  return DEFAULT_INTERVALS;
}

async function sendBeigeAlert(client, guildId, nation, interval) {
  try {
    const channelRow = queryOne(`SELECT discord_channel_id FROM guild_channels WHERE guild_id = ? AND channel_type = 'beige'`, [guildId]);
    if (!channelRow) { logger.warn(`No beige channel for guild ${guildId} — use /config channel beige`); return; }
    const channel = client.channels.cache.get(channelRow.discord_channel_id);
    if (!channel) { logger.warn(`Beige channel ${channelRow.discord_channel_id} not in cache`); return; }

    const eligibleAttackers = await getEligibleAttackers(guildId, nation.score);
    const isUrgent   = nation.minutesRemaining <= 15;
    const isExpiring = nation.minutesRemaining <= 5;
    const color      = isExpiring ? 0xff0000 : isUrgent ? 0xff9900 : 0xf1c40f;

    const embed = new EmbedBuilder()
      .setTitle(`${isExpiring ? '🚨' : isUrgent ? '⚠️' : '🟡'} Beige Exit Alert — ${nation.nation_name}`)
      .setColor(color)
      .setDescription(interval === 0 ? '**This nation has exited beige!**' : `Exits beige in approximately **${formatTimeRemaining(nation.minutesRemaining)}**`)
      .addFields(
        { name: '🏴 Nation',    value: `[${nation.nation_name}](https://politicsandwar.com/nation/id=${nation.id})`, inline: true },
        { name: '🏛️ Alliance', value: nation.allianceName || 'None', inline: true },
        { name: '⭐ Score',    value: nation.score?.toLocaleString() || '?', inline: true },
        { name: '🏙️ Cities',  value: `${nation.num_cities}`, inline: true },
        { name: '⚔️ Wars',    value: `${nation.offensive_wars_count||0} off / ${nation.defensive_wars_count||0} def`, inline: true },
        { name: '⏰ Expires', value: `<t:${nation.expiryTimestamp}:R>`, inline: true },
        { name: '🪖 Military', value: `👮 ${(nation.soldiers||0).toLocaleString()} | 🚗 ${(nation.tanks||0).toLocaleString()} | ✈️ ${nation.aircraft||0} | 🚢 ${nation.ships||0} | 🚀 ${nation.missiles||0} | ☢️ ${nation.nukes||0}`, inline: false },
        {
          name: eligibleAttackers.length > 0 ? `✅ Eligible Attackers (${eligibleAttackers.length})` : '❌ Eligible Attackers',
          value: eligibleAttackers.length > 0
            ? eligibleAttackers.slice(0, 8).map(a => `• **${a.nation_name}** — Score: ${Math.round(a.score).toLocaleString()} | ${a.openSlots} slot(s)`).join('\n') + (eligibleAttackers.length > 8 ? `\n_+${eligibleAttackers.length - 8} more_` : '')
            : 'No members in range with open slots.',
          inline: false,
        },
      )
      .setFooter({ text: `Nation ID: ${nation.id} • PW Defense Bot` })
      .setTimestamp();

    const roleRow = queryOne(`SELECT discord_role_id FROM guild_roles WHERE guild_id = ? AND role_type = 'military'`, [guildId]);
    const ping    = roleRow ? `<@&${roleRow.discord_role_id}>` : '';
    const label   = interval === 0 ? '**BEIGE EXPIRED**' : `**${formatTimeRemaining(nation.minutesRemaining)} warning**`;

    await channel.send({ content: ping ? `${ping} — ${label}` : label, embeds: [embed] });
    logger.info(`✅ Beige alert sent for ${nation.nation_name} (${interval}min) in guild ${guildId}`);
  } catch (error) {
    logger.error(`Beige alert error for ${nation.nation_name}: ${error.message}`);
  }
}

module.exports = { sendBeigeAlert, getAlertIntervals };
