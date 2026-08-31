// ============================================================
// src/systems/intelligence/spyDetector.js
//
// The P&W API does NOT expose spy attack logs or attacker info.
// We detect spy attacks INDIRECTLY by comparing periodic snapshots
// of our members' military and flagging drops that match
// spy sabotage patterns.
//
// Detectable operations (by their effects):
//   Sabotage Soldiers  — 1-5% troop loss
//   Sabotage Tanks     — 1-5% tank loss
//   Sabotage Aircraft  — 1-5% aircraft loss
//   Sabotage Ships     — 1-5% ship loss
//   Sabotage Missiles  — 1-2 missile loss
//   Sabotage Nukes     — 1 nuke loss
//   Assassinate Spies  — sudden spy count drop
//
// NOTE: We cannot detect Gather Intelligence or Terrorize Civilians
// from API data alone since those don't reduce trackable military fields.
// ============================================================

const { EmbedBuilder } = require('discord.js');
const { query, run, queryOne } = require('../../utils/database');
const { pwQuery, MEMBER_POSITIONS } = require('../../utils/pwApi');
const { getLinkedDiscordUser } = require('../../utils/nationLink');
const logger = require('../../utils/logger');

// How much of a drop (%) triggers a spy alert for unit-type fields
const SPY_THRESHOLDS = {
  soldiers:  { minPctDrop: 0.5,  maxPctDrop: 7,   label: 'Sabotage Soldiers',  emoji: '👮' },
  tanks:     { minPctDrop: 0.5,  maxPctDrop: 7,   label: 'Sabotage Tanks',     emoji: '🚗' },
  aircraft:  { minPctDrop: 0.5,  maxPctDrop: 7,   label: 'Sabotage Aircraft',  emoji: '✈️' },
  ships:     { minPctDrop: 0.5,  maxPctDrop: 7,   label: 'Sabotage Ships',     emoji: '🚢' },
  missiles:  { minAbsDrop: 1,    maxAbsDrop: 3,   label: 'Sabotage Missiles',  emoji: '🚀' },
  nukes:     { minAbsDrop: 1,    maxAbsDrop: 2,   label: 'Sabotage Nukes',     emoji: '☢️' },
  spies:     { minAbsDrop: 1,    maxAbsDrop: 60,  label: 'Spy Assassination',  emoji: '🕵️' },
};

// ============================================================
// TAKE A SNAPSHOT OF OUR ALLIANCE MEMBERS
// Called every 15 minutes from the scheduler
// ============================================================
async function snapshotOurMilitary(guildId, allianceId) {
  try {
    const data = await pwQuery(`
      query GetOurMembers($allianceId: [Int]) {
        nations(alliance_id: $allianceId, first: 500) {
          data {
            id
            nation_name
            alliance_position
            soldiers
            tanks
            aircraft
            ships
            missiles
            nukes
            spies
          }
        }
      }
    `, { allianceId: [parseInt(allianceId)] });

    const allNations = data?.nations?.data || [];
    const members = allNations.filter(n =>
      MEMBER_POSITIONS.includes((n.alliance_position || '').toUpperCase())
    );

    for (const nation of members) {
      run(
        `INSERT INTO spy_snapshots
         (guild_id, nation_id, nation_name, soldiers, tanks, aircraft, ships, missiles, nukes, spies)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          guildId,
          nation.id,
          nation.nation_name || '',
          nation.soldiers  || 0,
          nation.tanks     || 0,
          nation.aircraft  || 0,
          nation.ships     || 0,
          nation.missiles  || 0,
          nation.nukes     || 0,
          nation.spies     || 0,
        ]
      );
    }

    // Clean up snapshots older than 24 hours
    run(`DELETE FROM spy_snapshots WHERE guild_id = ? AND recorded_at < datetime('now', '-24 hours')`, [guildId]);

  } catch (err) {
    logger.error(`Spy snapshot error for guild ${guildId}: ${err.message}`);
  }
}

// ============================================================
// CHECK FOR DROPS THAT MATCH SPY ATTACK PATTERNS
// Compares the two most recent snapshots per member
// ============================================================
async function checkForSpyAttacks(client) {
  const guilds = query(
    'SELECT guild_id, alliance_id FROM guilds WHERE alliance_id IS NOT NULL', []
  ).rows;

  for (const guild of guilds) {
    await processSpyChecks(client, guild.guild_id, guild.alliance_id);
  }
}

async function processSpyChecks(client, guildId, allianceId) {
  try {
    // Get intel channel
    const channelRow =
      queryOne(`SELECT discord_channel_id FROM guild_channels WHERE guild_id = ? AND channel_type = 'intel'`, [guildId]) ||
      queryOne(`SELECT discord_channel_id FROM guild_channels WHERE guild_id = ? AND channel_type = 'wars'`, [guildId]);
    if (!channelRow) return;

    const channel = client.channels.cache.get(channelRow.discord_channel_id);
    if (!channel) return;

    // Get all unique nation IDs we have spy snapshots for (in this guild)
    const nations = query(
      `SELECT DISTINCT nation_id FROM spy_snapshots WHERE guild_id = ?`,
      [guildId]
    ).rows;

    for (const { nation_id } of nations) {
      // Get two most recent snapshots for this member
      const snapshots = query(
        `SELECT * FROM spy_snapshots WHERE guild_id = ? AND nation_id = ?
         ORDER BY recorded_at DESC LIMIT 2`,
        [guildId, nation_id]
      ).rows;

      if (snapshots.length < 2) continue;

      const latest   = snapshots[0];
      const previous = snapshots[1];

      const detectedOps = [];

      // ── CHECK EACH FIELD ─────────────────────────────────
      for (const [field, threshold] of Object.entries(SPY_THRESHOLDS)) {
        const prevVal = previous[field] || 0;
        const currVal = latest[field]   || 0;
        const drop    = prevVal - currVal;

        if (drop <= 0) continue; // Only care about drops, not gains

        let triggered = false;

        if (threshold.minPctDrop !== undefined) {
          // Percentage-based threshold (soldiers, tanks, aircraft, ships)
          if (prevVal === 0) continue;
          const pctDrop = (drop / prevVal) * 100;
          if (pctDrop >= threshold.minPctDrop && pctDrop <= threshold.maxPctDrop) {
            triggered = true;
          }
        } else if (threshold.minAbsDrop !== undefined) {
          // Absolute threshold (missiles, nukes, spies)
          if (drop >= threshold.minAbsDrop && drop <= threshold.maxAbsDrop) {
            triggered = true;
          }
        }

        if (triggered) {
          detectedOps.push({
            type:     threshold.label,
            emoji:    threshold.emoji,
            field,
            before:   prevVal,
            after:    currVal,
            lost:     drop,
            pctDrop:  prevVal > 0 ? Math.round((drop / prevVal) * 100) : 0,
          });
        }
      }

      if (detectedOps.length === 0) continue;

      // Check we haven't already alerted for this specific snapshot pair
      const alertKey = `spy_${guildId}_${nation_id}_${latest.recorded_at}`;
      const alreadySent = queryOne(
        `SELECT id FROM alert_settings WHERE guild_id = ? AND alert_type = 'spy_sent' AND setting_key = ?`,
        [guildId, alertKey]
      );
      if (alreadySent) continue;

      // Mark as sent
      run(
        `INSERT OR IGNORE INTO alert_settings (guild_id, alert_type, setting_key, setting_value)
         VALUES (?, 'spy_sent', ?, datetime('now'))`,
        [guildId, alertKey]
      );

      // Send the alert
      await sendSpyAlert(channel, guildId, latest, detectedOps);
    }

    // After checking, take a fresh snapshot
    await snapshotOurMilitary(guildId, allianceId);

  } catch (err) {
    logger.error(`Spy check error for guild ${guildId}: ${err.message}`);
  }
}

// ============================================================
// SEND SPY ATTACK ALERT
// ============================================================
async function sendSpyAlert(channel, guildId, nationSnapshot, detectedOps) {
  try {
    const nationName = nationSnapshot.nation_name || `Nation ${nationSnapshot.nation_id}`;
    const nationId   = nationSnapshot.nation_id;

    // Get Discord mention if linked
    const link    = getLinkedDiscordUser(guildId, nationId);
    const mention = link ? `<@${link.discord_user_id}> ` : '';

    // Categorise the severity
    const hasNukeSabotage     = detectedOps.some(o => o.field === 'nukes');
    const hasMissileSabotage  = detectedOps.some(o => o.field === 'missiles');
    const hasSpyAssassination = detectedOps.some(o => o.field === 'spies');
    const color = hasNukeSabotage    ? 0xff0000
                : hasMissileSabotage ? 0xe74c3c
                : 0xe67e22;

    const opLines = detectedOps.map(op => {
      const lost = op.field === 'soldiers'
        ? op.lost.toLocaleString()
        : String(op.lost);
      const pct = op.pctDrop > 0 ? ` (${op.pctDrop}% loss)` : '';
      return `${op.emoji} **${op.type}** — lost **${lost}** ${op.field}${pct}\n  └ Before: ${op.before.toLocaleString()} → After: ${op.after.toLocaleString()}`;
    });

    const embed = new EmbedBuilder()
      .setTitle(`🕵️ Spy Attack Detected!`)
      .setColor(color)
      .setDescription(
        `**[${nationName}](https://politicsandwar.com/nation/id=${nationId})** appears to have been hit by spy operations.\n\n` +
        `⚠️ **Note:** The P&W API does not expose spy attacker information. We cannot identify who did this.\n` +
        `Check your nation's spy report in-game for details.`
      )
      .addFields(
        {
          name: `🔍 Detected Operations (${detectedOps.length})`,
          value: opLines.join('\n\n'),
          inline: false,
        },
        {
          name: '🔗 Quick Links',
          value:
            `[View Nation](https://politicsandwar.com/nation/id=${nationId}) | ` +
            `[Spy Report](https://politicsandwar.com/nation/id=${nationId}&display=spies)`,
          inline: false,
        },
      )
      .setFooter({ text: 'Detected via military snapshot comparison • False positives possible during wars' })
      .setTimestamp();

    const content = mention
      ? `${mention}🕵️ You may have been hit by spy operations!`
      : `🕵️ **${nationName}** may have been hit by spy operations!`;

    await channel.send({ content, embeds: [embed] });
    logger.info(`Spy alert sent for ${nationName} in guild ${guildId} — ops: ${detectedOps.map(o => o.type).join(', ')}`);

  } catch (err) {
    logger.error(`Failed to send spy alert: ${err.message}`);
  }
}

module.exports = { checkForSpyAttacks, snapshotOurMilitary };
