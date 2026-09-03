// ============================================================
// src/systems/beige/beigeTracker.js
// ============================================================
const { pwQuery, getAllianceMembers } = require('../../utils/pwApi');
const { query, run, queryOne } = require('../../utils/database');
const logger = require('../../utils/logger');

const HOURS_PER_TURN = 2;

async function getBeigeTargets(guildId) {
  try {
    const watchedAlliances = query(`SELECT alliance_id FROM alliance_watchlist WHERE guild_id = ? AND watchlist_type = 'enemy'`, [guildId]).rows;
    const watchedNations   = query(`SELECT nation_id FROM nation_watchlist WHERE guild_id = ?`, [guildId]).rows;
    if (watchedAlliances.length === 0 && watchedNations.length === 0) return [];

    let nations = [];

    if (watchedAlliances.length > 0) {
      const d = await pwQuery(`query B1($ids:[Int]){nations(alliance_id:$ids,vmode:false,first:500){data{id nation_name leader_name alliance_id alliance_position alliance{name} score num_cities beige_turns vacation_mode_turns soldiers tanks aircraft ships missiles nukes offensive_wars_count defensive_wars_count}}}`, { ids: watchedAlliances.map(a => a.alliance_id) });
      nations = nations.concat(d?.nations?.data || []);
    }

    if (watchedNations.length > 0) {
      const d = await pwQuery(`query B2($ids:[Int]){nations(id:$ids,vmode:false,first:100){data{id nation_name leader_name alliance_id alliance_position alliance{name} score num_cities beige_turns vacation_mode_turns soldiers tanks aircraft ships missiles nukes offensive_wars_count defensive_wars_count}}}`, { ids: watchedNations.map(n => n.nation_id) });
      nations = nations.concat(d?.nations?.data || []);
    }

    const seen = new Set();
    nations = nations.filter(n => { if (seen.has(n.id)) return false; seen.add(n.id); return true; });

    const beige = nations.filter(n => (n.beige_turns || 0) > 0);
    logger.debug(`Beige: ${nations.length} total, ${beige.length} in beige`);
    return beige.map(n => enrichBeigeData(n));
  } catch (error) {
    logger.error('Error fetching beige targets:', error.message);
    return [];
  }
}

function enrichBeigeData(nation) {
  const minutesRemaining = (nation.beige_turns || 0) * HOURS_PER_TURN * 60;
  const expiryDate       = new Date(Date.now() + minutesRemaining * 60 * 1000);
  return { ...nation, minutesRemaining, hoursRemaining: minutesRemaining / 60, expiryDate, expiryTimestamp: Math.floor(expiryDate.getTime() / 1000), allianceName: nation.alliance?.name || 'None' };
}

async function getEligibleAttackers(guildId, targetScore) {
  try {
    const guildRow = queryOne('SELECT alliance_id FROM guilds WHERE guild_id = ?', [guildId]);
    if (!guildRow?.alliance_id) return [];
    const members = await getAllianceMembers(guildRow.alliance_id);
    // War range: member.score must be within targetScore/1.5 to targetScore/0.75
    // (target's score within 75%-150% of the member's own score, solved for member.score)
    const min = targetScore / 1.5, max = targetScore / 0.75;
    return members.filter(m => m.score >= min && m.score <= max && !m.vacation_mode_turns && (m.offensive_wars_count || 0) < 5).map(m => ({ ...m, openSlots: 5 - (m.offensive_wars_count || 0) }));
  } catch { return []; }
}

function getAlertsDue(nation, intervals) { return intervals.filter(i => nation.minutesRemaining <= i); }
function wasAlertSent(guildId, nationId, interval) { return !!queryOne('SELECT id FROM beige_alerts_sent WHERE guild_id = ? AND nation_id = ? AND alert_interval = ?', [guildId, nationId, interval]); }
function markAlertSent(guildId, nationId, interval) { run(`INSERT OR IGNORE INTO beige_alerts_sent (guild_id, nation_id, alert_interval) VALUES (?, ?, ?)`, [guildId, nationId, interval]); }
function cleanOldAlerts(guildId, activeIds) {
  if (activeIds.length === 0) { run('DELETE FROM beige_alerts_sent WHERE guild_id = ?', [guildId]); return; }
  run(`DELETE FROM beige_alerts_sent WHERE guild_id = ? AND nation_id NOT IN (${activeIds.map(() => '?').join(',')})`, [guildId, ...activeIds]);
}
function formatTimeRemaining(minutes) {
  if (minutes < 1) return 'Less than 1 minute';
  if (minutes < 60) return `${Math.floor(minutes)}m`;
  const h = Math.floor(minutes / 60), m = Math.floor(minutes % 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

module.exports = { getBeigeTargets, getEligibleAttackers, getAlertsDue, wasAlertSent, markAlertSent, cleanOldAlerts, formatTimeRemaining, enrichBeigeData };
