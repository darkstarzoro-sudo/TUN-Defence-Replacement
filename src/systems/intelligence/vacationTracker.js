// ============================================================
// src/systems/intelligence/vacationTracker.js
// Tracks vacation mode changes and war expiry for watched nations
// ============================================================

const { EmbedBuilder } = require('discord.js');
const { query, run, queryOne } = require('../../utils/database');
const { pwQuery, MEMBER_POSITIONS } = require('../../utils/pwApi');
const logger = require('../../utils/logger');

// ============================================================
// VACATION MODE TRACKER
// Detects when watched enemy nations enter or exit vacation mode
// ============================================================
async function checkVacationChanges(client) {
  const guilds = query(
    'SELECT guild_id FROM guilds WHERE alliance_id IS NOT NULL', []
  ).rows;

  for (const guild of guilds) {
    await processVacationChanges(client, guild.guild_id);
  }
}

async function processVacationChanges(client, guildId) {
  try {
    const watchedNations   = query('SELECT nation_id, nation_name FROM nation_watchlist WHERE guild_id = ?', [guildId]).rows;
    const enemyAlliances   = query(`SELECT alliance_id FROM alliance_watchlist WHERE guild_id = ? AND watchlist_type = 'enemy'`, [guildId]).rows;

    if (watchedNations.length === 0 && enemyAlliances.length === 0) return;

    const channelRow =
      queryOne(`SELECT discord_channel_id FROM guild_channels WHERE guild_id = ? AND channel_type = 'intel'`, [guildId]) ||
      queryOne(`SELECT discord_channel_id FROM guild_channels WHERE guild_id = ? AND channel_type = 'wars'`, [guildId]);
    if (!channelRow) return;

    const channel = client.channels.cache.get(channelRow.discord_channel_id);
    if (!channel) return;

    // Fetch current vacation status for enemy alliances
    const allianceIds = enemyAlliances.map(a => a.alliance_id);
    const nationIds   = watchedNations.map(n => n.nation_id);

    if (allianceIds.length === 0 && nationIds.length === 0) return;

    const data = await pwQuery(`
      query GetVacationStatus($allianceIds: [Int], $nationIds: [Int]) {
        nations(alliance_id: $allianceIds, id: $nationIds, first: 500) {
          data {
            id
            nation_name
            alliance_position
            vacation_mode_turns
            alliance { name }
          }
        }
      }
    `, {
      allianceIds: allianceIds.length > 0 ? allianceIds : undefined,
      nationIds:   nationIds.length   > 0 ? nationIds   : undefined,
    });

    const nations = (data?.nations?.data || []).filter(n =>
      MEMBER_POSITIONS.includes((n.alliance_position || '').toUpperCase())
    );

    for (const nation of nations) {
      const isOnVacation = (nation.vacation_mode_turns || 0) > 0;
      const cacheKey     = `vmode_${guildId}_${nation.id}`;

      // Get last known vacation state from DB
      const lastState = queryOne(
        'SELECT setting_value FROM alert_settings WHERE guild_id = ? AND alert_type = ? AND setting_key = ?',
        [guildId, 'vacation_cache', String(nation.id)]
      );

      const wasOnVacation = lastState?.setting_value === '1';

      // Save current state
      run(
        `INSERT INTO alert_settings (guild_id, alert_type, setting_key, setting_value)
         VALUES (?, 'vacation_cache', ?, ?)
         ON CONFLICT(guild_id, alert_type, setting_key) DO UPDATE SET setting_value = excluded.setting_value`,
        [guildId, String(nation.id), isOnVacation ? '1' : '0']
      );

      // Alert on state change
      if (isOnVacation && !wasOnVacation) {
        // Nation just entered vacation mode
        const embed = new EmbedBuilder()
          .setTitle('🏖️ Enemy Entered Vacation Mode')
          .setColor(0x3498db)
          .setDescription(
            `**[${nation.nation_name}](https://politicsandwar.com/nation/id=${nation.id})** entered vacation mode.\n` +
            `Alliance: **${nation.alliance?.name || 'None'}**\n\n` +
            `This nation cannot be attacked while in vacation mode.`
          )
          .setFooter({ text: 'PW Defense Bot • Vacation Tracker' })
          .setTimestamp();

        await channel.send({ embeds: [embed] });
        logger.info(`Vacation alert: ${nation.nation_name} entered vacation (guild ${guildId})`);

      } else if (!isOnVacation && wasOnVacation) {
        // Nation just exited vacation mode — this is important!
        const embed = new EmbedBuilder()
          .setTitle('⚠️ Enemy Exited Vacation Mode!')
          .setColor(0xe67e22)
          .setDescription(
            `**[${nation.nation_name}](https://politicsandwar.com/nation/id=${nation.id})** has exited vacation mode and is now **attackable**!\n` +
            `Alliance: **${nation.alliance?.name || 'None'}**\n\n` +
            `Use \`/nation ${nation.nation_name}\` to see their military profile.\nUse \`/counter find ${nation.nation_name}\` to find who can attack them.`
          )
          .setFooter({ text: 'PW Defense Bot • Vacation Tracker' })
          .setTimestamp();

        await channel.send({ embeds: [embed] });
        logger.info(`Vacation alert: ${nation.nation_name} exited vacation (guild ${guildId})`);
      }
    }
  } catch (err) {
    logger.error(`Vacation tracker error for guild ${guildId}: ${err.message}`);
  }
}

// ============================================================
// WAR EXPIRY ALERTS
// Notifies when active wars are about to expire (run out of turns)
// P&W wars expire after 60 turns (5 days) if no attacks are made
// ============================================================
async function checkWarExpiry(client) {
  const guilds = query(
    'SELECT guild_id, alliance_id FROM guilds WHERE alliance_id IS NOT NULL', []
  ).rows;

  for (const guild of guilds) {
    await processWarExpiry(client, guild.guild_id, guild.alliance_id);
  }
}

async function processWarExpiry(client, guildId, allianceId) {
  try {
    const channelRow =
      queryOne(`SELECT discord_channel_id FROM guild_channels WHERE guild_id = ? AND channel_type = 'wars'`, [guildId]) ||
      queryOne(`SELECT discord_channel_id FROM guild_channels WHERE guild_id = ? AND channel_type = 'intel'`, [guildId]);
    if (!channelRow) return;

    const channel = client.channels.cache.get(channelRow.discord_channel_id);
    if (!channel) return;

    // Fetch active wars for our alliance
    const data = await pwQuery(`
      query GetAllianceWars($allianceId: [Int]) {
        wars(alliance_id: $allianceId, active: true, first: 100) {
          data {
            id
            att_alliance_id
            def_alliance_id
            attacker { id nation_name }
            defender { id nation_name }
            turnsleft
          }
        }
      }
    `, { allianceId: [parseInt(allianceId)] });

    const allWars     = data?.wars?.data || [];
    const allianceStr = String(allianceId);

    // Only check wars where WE are the attacker (our offensive wars expiring = bad)
    const ourWars = allWars.filter(w => String(w.att_alliance_id) === allianceStr);

    for (const war of ourWars) {
      const turnsLeft = war.turnsleft || 0;

      // Alert at 12 turns (~1 day) and 6 turns (~12 hours)
      const alertThresholds = [12, 6];

      for (const threshold of alertThresholds) {
        if (turnsLeft <= threshold) {
          const alreadyAlerted = queryOne(
            'SELECT id FROM defense_alerts_sent WHERE guild_id = ? AND war_id = ?',
            [guildId, `expiry_${war.id}_${threshold}`]
          );
          if (alreadyAlerted) continue;

          const hoursLeft = turnsLeft * 2;
          const embed = new EmbedBuilder()
            .setTitle(`⏰ War Expiring Soon!`)
            .setColor(turnsLeft <= 6 ? 0xe74c3c : 0xe67e22)
            .setDescription(
              `An offensive war is about to expire!\n\n` +
              `**[${war.attacker?.nation_name || 'Our member'}](https://politicsandwar.com/nation/id=${war.attacker?.id})** vs ` +
              `**[${war.defender?.nation_name || 'Enemy'}](https://politicsandwar.com/nation/id=${war.defender?.id})**\n\n` +
              `**${turnsLeft} turns left** (~${hoursLeft} hours)\n\n` +
              `If no attack is made before the war expires, it will end without resolution.\n` +
              `[View War](https://politicsandwar.com/nation/war/timeline/war=${war.id})`
            )
            .setFooter({ text: `War ID: ${war.id}` })
            .setTimestamp();

          await channel.send({ embeds: [embed] });

          run('INSERT OR IGNORE INTO defense_alerts_sent (guild_id, war_id) VALUES (?, ?)',
            [guildId, `expiry_${war.id}_${threshold}`]);

          logger.info(`War expiry alert sent for war ${war.id} (${turnsLeft} turns left) in guild ${guildId}`);
        }
      }
    }
  } catch (err) {
    logger.error(`War expiry check error for guild ${guildId}: ${err.message}`);
  }
}

module.exports = { checkVacationChanges, checkWarExpiry };
