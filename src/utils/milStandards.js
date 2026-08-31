// ============================================================
// src/utils/milStandards.js
// Loads military readiness standards from the database
// Set via /compliance set — falls back to sensible defaults
// if not yet configured by the alliance
// ============================================================

const { query } = require('./database');

const DEFAULTS = {
  soldiers: 15000,
  tanks:    1250,
  aircraft: 75,
  ships:    15,
  missiles: 0,
};

function getMilStandards(guildId) {
  const rows = query(
    `SELECT setting_key, setting_value FROM alert_settings
     WHERE guild_id = ? AND alert_type = 'compliance'`,
    [guildId]
  ).rows;

  const standards = { ...DEFAULTS };
  for (const row of rows) {
    if (row.setting_key in standards) {
      standards[row.setting_key] = parseInt(row.setting_value);
    }
  }
  return standards;
}

function scoreReadiness(member, standards) {
  const checks = [
    standards.soldiers > 0 ? Math.min(member.soldiers / standards.soldiers, 1) : 1,
    standards.tanks    > 0 ? Math.min(member.tanks    / standards.tanks,    1) : 1,
    standards.aircraft > 0 ? Math.min(member.aircraft / standards.aircraft, 1) : 1,
    standards.ships    > 0 ? Math.min(member.ships    / standards.ships,    1) : 1,
  ];
  return Math.round((checks.reduce((a, b) => a + b, 0) / checks.length) * 100);
}

module.exports = { getMilStandards, scoreReadiness, DEFAULTS };
