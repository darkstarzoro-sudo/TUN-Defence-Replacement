// ============================================================
// src/systems/defense/defenseMonitor.js
// Monitors alliance members for new defensive wars
// ============================================================

const { EmbedBuilder } = require('discord.js');
const { query, run, queryOne } = require('../../utils/database');
const { pwQuery } = require('../../utils/pwApi');
const logger = require('../../utils/logger');

async function checkAllianceDefense(client) {
  const guilds = query(
    'SELECT guild_id, alliance_id FROM guilds WHERE alliance_id IS NOT NULL', []
  ).rows;
  for (const guild of guilds) {
    await processGuildDefense(client, guild.guild_id, guild.alliance_id);
  }
}

async function processGuildDefense(client, guildId, allianceId) {
  try {
    const channelRow =
      queryOne(`SELECT discord_channel_id FROM guild_channels WHERE guild_id = ? AND channel_type = 'wars'`, [guildId]) ||
      queryOne(`SELECT discord_channel_id FROM guild_channels WHERE guild_id = ? AND channel_type = 'intel'`, [guildId]);
    if (!channelRow) return;

    const channel = client.channels.cache.get(channelRow.discord_channel_id);
    if (!channel) return;

    const data = await pwQuery(`
      query GetAllianceWars($allianceId: [Int]) {
        wars(alliance_id: $allianceId, active: true, first: 100) {
          data {
            id
            att_alliance_id
            def_alliance_id
            attacker {
              id nation_name score
              soldiers tanks aircraft ships missiles nukes
              alliance { name }
            }
            defender {
              id nation_name score
              alliance { name }
            }
            turnsleft
          }
        }
      }
    `, { allianceId: [parseInt(allianceId)] });

    const allWars = data?.wars?.data || [];

    // P&W returns IDs as strings — compare as strings
    const allianceIdStr = String(allianceId);
    const defWars = allWars.filter(w => String(w.def_alliance_id) === allianceIdStr);
    if (defWars.length === 0) return;

    // Only alert on wars we haven't seen before
    const newWars = [];
    for (const war of defWars) {
      const seen = queryOne(
        'SELECT id FROM defense_alerts_sent WHERE guild_id = ? AND war_id = ?',
        [guildId, String(war.id)]
      );
      if (!seen) {
        newWars.push(war);
        run('INSERT OR IGNORE INTO defense_alerts_sent (guild_id, war_id) VALUES (?, ?)',
          [guildId, String(war.id)]);
      }
    }
    if (newWars.length === 0) return;

    const roleRow = queryOne(
      `SELECT discord_role_id FROM guild_roles WHERE guild_id = ? AND role_type = 'military'`,
      [guildId]
    );
    const ping = roleRow ? `<@&${roleRow.discord_role_id}>` : '';

    if (newWars.length >= 3) {
      await sendMassAttackAlert(channel, ping, newWars);
    } else {
      for (const war of newWars) {
        await sendDefenseAlert(channel, ping, war);
      }
    }
  } catch (err) {
    logger.error(`Defense monitor error for guild ${guildId}: ${err.message}`);
  }
}

async function sendDefenseAlert(channel, ping, war) {
  try {
    const attacker = war.attacker;
    const defender = war.defender;

    const embed = new EmbedBuilder()
      .setTitle('🆘 Member Under Attack!')
      .setColor(0xe74c3c)
      .addFields(
        {
          name: '🛡️ Defender (Our Member)',
          value: `[${defender.nation_name}](https://politicsandwar.com/nation/id=${defender.id}) — Score: ${defender.score?.toLocaleString() || '?'}`,
          inline: true,
        },
        {
          name: '⚔️ Attacker (Enemy)',
          value: `[${attacker.nation_name}](https://politicsandwar.com/nation/id=${attacker.id}) — ${attacker.alliance?.name || 'No Alliance'} — Score: ${attacker.score?.toLocaleString() || '?'}`,
          inline: true,
        },
        {
          name: '🪖 Enemy Military',
          value: `✈️ ${attacker.aircraft || 0} | 🚗 ${attacker.tanks || 0} | 👮 ${attacker.soldiers?.toLocaleString() || 0} | 🚢 ${attacker.ships || 0} | 🚀 ${attacker.missiles || 0} | ☢️ ${attacker.nukes || 0}`,
          inline: false,
        },
        {
          name: '🔗 Quick Links',
          value: `[View War](https://politicsandwar.com/nation/war/timeline/war=${war.id}) | [Counter Attacker](https://politicsandwar.com/nation/id=${attacker.id})`,
          inline: false,
        },
      )
      .setFooter({ text: `War ID: ${war.id} | Use /counter find to see who can counter` })
      .setTimestamp();

    await channel.send({
      content: ping ? `${ping} — Member under attack!` : '🆘 Member under attack!',
      embeds: [embed],
    });
    logger.info(`Defense alert sent for war ${war.id}`);
  } catch (err) {
    logger.error(`Failed to send defense alert for war ${war.id}: ${err.message}`);
  }
}

async function sendMassAttackAlert(channel, ping, wars) {
  try {
    const attackerAlliances = [...new Set(
      wars.map(w => w.attacker?.alliance?.name || 'Unknown')
    )];

    const memberLines = wars.slice(0, 10).map(w =>
      `• [${w.defender.nation_name}](https://politicsandwar.com/nation/id=${w.defender.id}) ← [${w.attacker.nation_name}](https://politicsandwar.com/nation/id=${w.attacker.id}) (${w.attacker.alliance?.name || 'None'})`
    );

    // Discord requires field values to be non-empty strings
    const membersValue = memberLines.length > 0
      ? memberLines.join('\n') + (wars.length > 10 ? `\n_...and ${wars.length - 10} more_` : '')
      : 'See war list above';

    const embed = new EmbedBuilder()
      .setTitle(`🚨 MASS ATTACK — ${wars.length} Members Hit!`)
      .setColor(0xff0000)
      .setDescription(
        `**${wars.length} members attacked simultaneously!**\n` +
        `Attacking: **${attackerAlliances.join(', ')}**`
      )
      .addFields(
        {
          name: '🛡️ Members Under Attack',
          value: membersValue,
        },
        {
          name: '⚡ Immediate Actions',
          value: '`/counter check` — see all under attack\n`/counter find` — find counter options\n`/war defensive` — full details',
        },
      )
      .setFooter({ text: 'PW Defense Bot • Emergency Defense Alert' })
      .setTimestamp();

    await channel.send({
      content: ping ? `${ping} 🚨 **EMERGENCY — MASS ATTACK!**` : '🚨 **EMERGENCY — MASS ATTACK!**',
      embeds: [embed],
    });
    logger.warn(`Mass attack alert sent — ${wars.length} wars`);
  } catch (err) {
    logger.error(`Failed to send mass attack alert: ${err.message}`);
  }
}

module.exports = { checkAllianceDefense };
