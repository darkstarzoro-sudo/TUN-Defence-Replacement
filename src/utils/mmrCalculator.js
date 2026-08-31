// ============================================================
// src/utils/mmrCalculator.js
// MMR-based military readiness calculation
//
// In P&W, maximum military per city is 5/5/5/3:
//   5 Barracks  → 3,000 soldiers each  → 15,000 soldiers/city
//   5 Factories → 250 tanks each       → 1,250 tanks/city
//   5 Hangars   → 15 aircraft each     → 75 aircraft/city
//   3 Drydocks  → 5 ships each         → 15 ships/city
//
// Max spies = 60 (global cap regardless of cities)
// Max missiles = cities * 2 (rough cap)
// Max nukes = depends on projects but we use cities as a proxy
//
// NOTE: The P&W API does NOT return building counts per city.
// We therefore calculate UNIT capacity from city count using
// the 5/5/5/3 formula, then measure how filled those units are.
// This is the standard way alliances calculate MMR compliance.
// ============================================================

// Per-city military maximums at full 5/5/5/3 MMR
const PER_CITY = {
  soldiers: 15000,  // 5 barracks × 3000
  tanks:    1250,   // 5 factories × 250
  aircraft: 75,     // 5 hangars × 15
  ships:    15,     // 3 drydocks × 5
};

const MAX_SPIES = 60;

// ============================================================
// DEFAULT READINESS WEIGHTS
// These add up to 100. Configurable via /compliance set weights.
// ============================================================
const DEFAULT_WEIGHTS = {
  units:    60,  // Military units filled relative to MMR capacity
  spies:    20,  // Spies filled relative to max 60
  missiles: 10,  // Missiles relative to city count × 2
  nukes:     5,  // Nukes (binary — has any or not, scaled)
  score:     5,  // Nation score (proxy for overall development)
};

// ============================================================
// LOAD WEIGHTS FROM DB (set via /compliance set)
// Falls back to defaults if not configured
// ============================================================
function getReadinessWeights(guildId) {
  try {
    const { query } = require('./database');
    const rows = query(
      `SELECT setting_key, setting_value FROM alert_settings
       WHERE guild_id = ? AND alert_type = 'readiness_weights'`,
      [guildId]
    ).rows;

    const weights = { ...DEFAULT_WEIGHTS };
    for (const row of rows) {
      if (row.setting_key in weights) {
        weights[row.setting_key] = parseFloat(row.setting_value);
      }
    }
    return weights;
  } catch {
    return { ...DEFAULT_WEIGHTS };
  }
}

// ============================================================
// CALCULATE READINESS FOR A SINGLE NATION
// Returns a score 0-100 and a breakdown per category
// ============================================================
function calculateNationReadiness(nation, weights) {
  const cities = nation.num_cities || 1;

  // ── UNIT READINESS (soldiers, tanks, aircraft, ships) ────
  const maxSoldiers = cities * PER_CITY.soldiers;
  const maxTanks    = cities * PER_CITY.tanks;
  const maxAircraft = cities * PER_CITY.aircraft;
  const maxShips    = cities * PER_CITY.ships;

  const soldierPct  = Math.min((nation.soldiers  || 0) / maxSoldiers, 1);
  const tankPct     = Math.min((nation.tanks     || 0) / maxTanks,    1);
  const aircraftPct = Math.min((nation.aircraft  || 0) / maxAircraft, 1);
  const shipPct     = Math.min((nation.ships     || 0) / maxShips,    1);

  // Average of the four unit types
  const unitScore = (soldierPct + tankPct + aircraftPct + shipPct) / 4;

  // ── SPY READINESS ────────────────────────────────────────
  const spyScore = Math.min((nation.spies || 0) / MAX_SPIES, 1);

  // ── MISSILE READINESS ────────────────────────────────────
  // Max missiles ≈ cities * 2 (simplified — actual depends on projects)
  const maxMissiles  = cities * 2;
  const missileScore = maxMissiles > 0
    ? Math.min((nation.missiles || 0) / maxMissiles, 1)
    : 0;

  // ── NUKE READINESS ───────────────────────────────────────
  // We treat nukes as a bonus score — having ≥1 nuke per 10 cities = 100%
  const nukeTarget = Math.max(1, Math.floor(cities / 10));
  const nukeScore  = Math.min((nation.nukes || 0) / nukeTarget, 1);

  // ── SCORE (development proxy) ────────────────────────────
  // Expected score at full MMR ≈ roughly 100 per city (very rough)
  const expectedScore = cities * 100;
  const scoreScore    = Math.min((nation.score || 0) / expectedScore, 1);

  // ── WEIGHTED TOTAL ───────────────────────────────────────
  const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0) || 100;
  const readiness = (
    (unitScore    * weights.units    / totalWeight) +
    (spyScore     * weights.spies    / totalWeight) +
    (missileScore * weights.missiles / totalWeight) +
    (nukeScore    * weights.nukes    / totalWeight) +
    (scoreScore   * weights.score    / totalWeight)
  ) * 100;

  return {
    total:     Math.round(readiness),
    breakdown: {
      units:    Math.round(unitScore    * 100),
      spies:    Math.round(spyScore     * 100),
      missiles: Math.round(missileScore * 100),
      nukes:    Math.round(nukeScore    * 100),
      score:    Math.round(scoreScore   * 100),
    },
    capacity: {
      maxSoldiers, maxTanks, maxAircraft, maxShips,
      maxMissiles, maxSpies: MAX_SPIES,
    },
  };
}

// ============================================================
// CALCULATE ALLIANCE READINESS (average across all members)
// ============================================================
function calculateAllianceReadiness(members, weights) {
  if (members.length === 0) return { average: 0, breakdown: {} };

  const scores = members.map(m => calculateNationReadiness(m, weights));
  const avg    = Math.round(scores.reduce((s, r) => s + r.total, 0) / scores.length);

  // Average each breakdown category too
  const breakdown = {};
  for (const key of Object.keys(DEFAULT_WEIGHTS)) {
    breakdown[key] = Math.round(
      scores.reduce((s, r) => s + (r.breakdown[key] || 0), 0) / scores.length
    );
  }

  return { average: avg, breakdown, scores };
}

// ============================================================
// EMOJI HELPERS
// ============================================================
function readinessEmoji(pct) {
  if (pct >= 90) return '🟢';
  if (pct >= 70) return '🟡';
  if (pct >= 50) return '🟠';
  return '🔴';
}

function readinessColor(pct) {
  if (pct >= 90) return 0x2ecc71;
  if (pct >= 70) return 0xf1c40f;
  if (pct >= 50) return 0xe67e22;
  return 0xe74c3c;
}

module.exports = {
  calculateNationReadiness,
  calculateAllianceReadiness,
  getReadinessWeights,
  readinessEmoji,
  readinessColor,
  PER_CITY,
  MAX_SPIES,
  DEFAULT_WEIGHTS,
};
