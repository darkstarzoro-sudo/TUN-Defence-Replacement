// ============================================================
// src/jobs/beigeJob.js
// ============================================================
const { query } = require('../utils/database');
const { getBeigeTargets, getAlertsDue, wasAlertSent, markAlertSent, cleanOldAlerts } = require('../systems/beige/beigeTracker');
const { sendBeigeAlert, getAlertIntervals } = require('../systems/beige/beigeAlerts');
const logger = require('../utils/logger');

async function checkBeigeExits(client) {
  logger.debug('Running beige exit check...');
  try {
    const guilds = query('SELECT guild_id FROM guilds WHERE alliance_id IS NOT NULL', []).rows;
    for (const guild of guilds) await processGuildBeige(client, guild.guild_id);
  } catch (error) { logger.error('Beige job error:', error); }
}

async function processGuildBeige(client, guildId) {
  try {
    const beigeNations = await getBeigeTargets(guildId);
    cleanOldAlerts(guildId, beigeNations.map(n => n.id));
    if (beigeNations.length === 0) return;

    const intervals = getAlertIntervals(guildId);
    logger.debug(`Beige check guild ${guildId}: ${beigeNations.length} in beige, intervals: ${intervals.join(',')}`);

    for (const nation of beigeNations) {
      logger.debug(`  ${nation.nation_name}: ${Math.round(nation.minutesRemaining)}min remaining`);
      const alertsDue = getAlertsDue(nation, intervals);
      if (alertsDue.length === 0) continue;
      for (const interval of alertsDue) {
        if (wasAlertSent(guildId, nation.id, interval)) continue;
        logger.debug(`  Sending ${interval}min alert for ${nation.nation_name}`);
        await sendBeigeAlert(client, guildId, nation, interval);
        markAlertSent(guildId, nation.id, interval);
      }
    }
  } catch (error) { logger.error(`Beige error guild ${guildId}: ${error.message}`); }
}

module.exports = { checkBeigeExits };
