// ============================================================
// src/systems/intelligence/dnrMonitor.js
// Fixed: removed sendMessage mutation (not in P&W API)
// In-game messaging is not supported by the P&W GraphQL API
// ============================================================

const { EmbedBuilder } = require('discord.js');
const { query, run, queryOne } = require('../../utils/database');
const { pwQuery, MEMBER_POSITIONS } = require('../../utils/pwApi');
const { getLinkedDiscordUser } = require('../../utils/nationLink');
const logger = require('../../utils/logger');

const DEFAULT_DM_MSG = '🚨 **DNR Policy Violation!**\n\nYou have declared war on a nation in our Do Not Raid list. Please log into Politics & War **immediately** and offer peace to avoid a diplomatic incident.';

async function checkDnrViolations(client) {
  const guilds = query('SELECT guild_id, alliance_id FROM guilds WHERE alliance_id IS NOT NULL', []).rows;
  for (const guild of guilds) {
    await processGuildDnr(client, guild.guild_id, guild.alliance_id);
  }
}

async function processGuildDnr(client, guildId, allianceId) {
  try {
    const dnrList = query('SELECT alliance_id FROM dnr_list WHERE guild_id = ?', [guildId]).rows;
    if (dnrList.length === 0) return;

    const dnrAllianceIds = new Set(dnrList.map(d => String(d.alliance_id)));

    const channelRow =
      queryOne(`SELECT discord_channel_id FROM guild_channels WHERE guild_id=? AND channel_type='wars'`, [guildId]) ||
      queryOne(`SELECT discord_channel_id FROM guild_channels WHERE guild_id=? AND channel_type='intel'`, [guildId]);
    if (!channelRow) return;
    const channel = client.channels.cache.get(channelRow.discord_channel_id);
    if (!channel) return;

    const data = await pwQuery(`
      query GetOffensiveWars($allianceId:[Int]) {
        wars(alliance_id:$allianceId, active:true, first:100) {
          data {
            id att_alliance_id def_alliance_id attid defid
            attacker { id nation_name alliance_position }
            defender { id nation_name alliance_position alliance { id name } }
            turnsleft
          }
        }
      }
    `, { allianceId: [parseInt(allianceId)] });

    const allWars       = data?.wars?.data || [];
    const allianceIdStr = String(allianceId);
    const ourOffWars    = allWars.filter(w => String(w.att_alliance_id) === allianceIdStr);
    const memberOffWars = ourOffWars.filter(w =>
      MEMBER_POSITIONS.includes((w.attacker?.alliance_position || '').toUpperCase())
    );

    for (const war of memberOffWars) {
      const defAllianceId = String(war.defender?.alliance?.id || war.def_alliance_id || '');
      if (!dnrAllianceIds.has(defAllianceId)) continue;

      const alreadyAlerted = queryOne(
        `SELECT id FROM alert_settings WHERE guild_id=? AND alert_type='dnr_violation' AND setting_key=?`,
        [guildId, String(war.id)]
      );
      if (alreadyAlerted) continue;

      run(`INSERT OR IGNORE INTO alert_settings (guild_id,alert_type,setting_key,setting_value) VALUES(?,'dnr_violation',?,datetime('now'))`,
        [guildId, String(war.id)]);

      const dnrEntry = queryOne('SELECT * FROM dnr_list WHERE guild_id=? AND alliance_id=?', [guildId, parseInt(defAllianceId)]);
      await handleDnrViolation(client, channel, guildId, war, dnrEntry);
    }
  } catch (err) {
    logger.error(`DNR monitor error for guild ${guildId}: ${err.message}`);
  }
}

async function handleDnrViolation(client, channel, guildId, war, dnrEntry) {
  try {
    const attacker    = war.attacker;
    const defender    = war.defender;
    const dnrName     = dnrEntry?.alliance_name || defender?.alliance?.name || 'Unknown';
    const dnrReason   = dnrEntry?.reason || 'Alliance is on the Do Not Raid list';

    logger.warn(`DNR VIOLATION: ${attacker?.nation_name} (war ${war.id}) attacked ${defender?.nation_name} in DNR alliance ${dnrName}`);

    // Get custom DM message
    const dmRow = queryOne(`SELECT setting_value FROM alert_settings WHERE guild_id=? AND alert_type='dnr' AND setting_key='dm_message'`, [guildId]);
    const discordDmMsg = dmRow?.setting_value || DEFAULT_DM_MSG;

    // NOTE: P&W API does NOT support sendMessage mutation
    // In-game messaging is not possible via the API
    // Only Discord DM and channel alert are sent

    // Send Discord DM to linked member
    let dmSent = false;
    const link = getLinkedDiscordUser(guildId, attacker?.id);
    if (link) {
      try {
        const discordUser = await client.users.fetch(link.discord_user_id);
        const dmEmbed = new EmbedBuilder()
          .setTitle('🚨 DNR Policy Violation — Immediate Action Required')
          .setColor(0xff0000)
          .setDescription(discordDmMsg)
          .addFields(
            { name: '⚔️ Your War',     value: `[View War](https://politicsandwar.com/nation/war/timeline/war=${war.id})`, inline: true },
            { name: '🏛️ DNR Alliance', value: `**${dnrName}**`, inline: true },
            { name: '📝 Reason',        value: dnrReason, inline: false },
            { name: '🕊️ Offer Peace',  value: `[Click here to offer peace](https://politicsandwar.com/nation/war/timeline/war=${war.id})`, inline: false },
          )
          .setFooter({ text: 'Contact your government immediately if this was an accident' })
          .setTimestamp();
        await discordUser.send({ embeds: [dmEmbed] });
        dmSent = true;
      } catch (err) {
        logger.warn(`Could not DM DNR violator: ${err.message}`);
      }
    }

    // Channel alert with gov + military ping
    const govRole = queryOne(`SELECT discord_role_id FROM guild_roles WHERE guild_id=? AND role_type='government'`, [guildId]);
    const milRole = queryOne(`SELECT discord_role_id FROM guild_roles WHERE guild_id=? AND role_type='military'`, [guildId]);
    const pings   = [govRole ? `<@&${govRole.discord_role_id}>` : null, milRole ? `<@&${milRole.discord_role_id}>` : null].filter(Boolean).join(' ');

    const channelEmbed = new EmbedBuilder()
      .setTitle('🚨 DNR VIOLATION DETECTED!')
      .setColor(0xff0000)
      .setDescription(`A member has declared war on a nation in our **Do Not Raid** list!\n**They must offer peace immediately.**`)
      .addFields(
        { name: '⚔️ Our Member (Violator)', value: `[${attacker?.nation_name||'Unknown'}](https://politicsandwar.com/nation/id=${attacker?.id})` + (link ? ` (<@${link.discord_user_id}>)` : ' _(not linked)_'), inline: true },
        { name: '🎯 Their Target', value: `[${defender?.nation_name||'Unknown'}](https://politicsandwar.com/nation/id=${defender?.id})\nAlliance: **${dnrName}**`, inline: true },
        { name: '📝 DNR Reason', value: dnrReason, inline: false },
        { name: '📨 Actions Taken', value: dmSent ? '✅ Discord DM sent to violator' : link ? '❌ Discord DM failed' : '⚠️ Member not linked — DM not possible\n_Note: In-game messaging not supported by P&W API_', inline: false },
        { name: '🔗 Quick Links', value: `[View War](https://politicsandwar.com/nation/war/timeline/war=${war.id})`, inline: false },
      )
      .setFooter({ text: `War ID: ${war.id}` })
      .setTimestamp();

    await channel.send({ content: pings ? `${pings} 🚨 **DNR VIOLATION!**` : '🚨 **DNR VIOLATION!**', embeds: [channelEmbed] });

  } catch (err) {
    logger.error(`Failed to handle DNR violation for war ${war.id}: ${err.message}`);
  }
}

module.exports = { checkDnrViolations };
