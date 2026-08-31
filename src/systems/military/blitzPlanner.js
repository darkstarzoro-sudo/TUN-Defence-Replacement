// ============================================================
// src/systems/military/blitzPlanner.js
// Automatically pairs your members with enemy targets
// based on war range, prioritizing dangerous targets first
// ============================================================

const { getAllianceMembers, resolveAlliance } = require('../../utils/pwApi');
const { calculateNationReadiness, getReadinessWeights, PER_CITY } = require('../../utils/mmrCalculator');

// ============================================================
// SCORE A TARGET — higher score = higher priority to hit
// We want to hit the most dangerous enemies first
// ============================================================
function scoreThreat(nation) {
  let threat = 0;

  // More cities = more infrastructure = higher priority
  threat += (nation.num_cities || 0) * 10;

  // Strong air force is the biggest threat in P&W
  const maxAircraft = (nation.num_cities || 1) * PER_CITY.aircraft;
  const aircraftFill = (nation.aircraft || 0) / maxAircraft;
  threat += aircraftFill * 40;

  // Nukes and missiles are very dangerous
  threat += (nation.nukes    || 0) * 15;
  threat += (nation.missiles || 0) * 3;

  // High score = stronger nation overall
  threat += Math.min((nation.score || 0) / 100, 30);

  // Tank fill rate
  const maxTanks = (nation.num_cities || 1) * PER_CITY.tanks;
  const tankFill = (nation.tanks || 0) / maxTanks;
  threat += tankFill * 20;

  // Already has open def slots = easier to slot them in
  const openDefSlots = 3 - (nation.defensive_wars_count || 0);
  if (openDefSlots > 0) threat += openDefSlots * 5;

  // Bonus for government members (inferred from score/cities)
  if ((nation.num_cities || 0) >= 20) threat += 20;

  return Math.round(threat);
}

// ============================================================
// SCORE AN ATTACKER'S SUITABILITY FOR A TARGET
// Higher = better match
// ============================================================
function scoreAttackerSuitability(attacker, target, weights) {
  let suitability = 0;

  // Check if in range (required — this is a hard filter)
  const minScore = target.score * 0.75;
  const maxScore = target.score * 1.75;
  if (attacker.score < minScore || attacker.score > maxScore) return -1;

  // Skip if no open offensive slots
  if ((attacker.offensive_wars_count || 0) >= 5) return -1;

  // Skip vacation mode
  if ((attacker.vacation_mode_turns || 0) > 0) return -1;

  // Prefer attackers closer to the target's score (better matchup)
  const scoreDiff = Math.abs(attacker.score - target.score) / target.score;
  suitability += (1 - scoreDiff) * 30;

  // Prefer attackers with more open slots (versatile)
  suitability += (5 - (attacker.offensive_wars_count || 0)) * 5;

  // Prefer attackers with higher readiness
  const readiness = calculateNationReadiness(attacker, weights);
  suitability += readiness.total * 0.3;

  // Prefer attackers with stronger aircraft (air superiority matters)
  const maxAircraft = (attacker.num_cities || 1) * PER_CITY.aircraft;
  const aircraftFill = (attacker.aircraft || 0) / maxAircraft;
  suitability += aircraftFill * 20;

  return Math.round(suitability);
}

// ============================================================
// MAIN PLANNER — pairs members to targets
// Returns an attack plan with assignments and unmatched lists
// ============================================================
async function planBlitz(guildId, ourAllianceId, enemyAllianceId, attackersPerTarget = 3) {
  // Fetch both alliances in parallel
  const [ourMembers, enemyMembers] = await Promise.all([
    getAllianceMembers(ourAllianceId),
    getAllianceMembers(enemyAllianceId),
  ]);

  const weights = getReadinessWeights(guildId);

  // Filter our members — only active, available members
  const availableAttackers = ourMembers
    .filter(m =>
      m.vacation_mode_turns === 0 &&
      (m.offensive_wars_count || 0) < 5
    )
    .map(m => ({
      ...m,
      openSlots: 5 - (m.offensive_wars_count || 0),
      slotsUsed: 0, // Track how many we assign in this plan
    }));

  // Filter enemy — only members with open defensive slots
  const validTargets = enemyMembers
    .filter(m =>
      m.vacation_mode_turns === 0 &&
      (m.defensive_wars_count || 0) < 3 // max 3 def wars
    )
    .map(m => ({
      ...m,
      threatScore: scoreThreat(m),
      openDefSlots: 3 - (m.defensive_wars_count || 0),
      assignedAttackers: [],
    }))
    .sort((a, b) => b.threatScore - a.threatScore); // Highest threat first

  // Track attacker slot usage
  const attackerMap = new Map(availableAttackers.map(a => [a.id, { ...a }]));

  const assignments   = []; // Successfully paired targets
  const unmatched     = []; // Targets we couldn't fill
  const unusedMembers = []; // Our members with no assignment

  // ── ASSIGNMENT LOOP ───────────────────────────────────────
  for (const target of validTargets) {
    const neededAttackers = Math.min(attackersPerTarget, target.openDefSlots);
    const assignedToTarget = [];

    // Score every available attacker against this target
    const candidates = [];
    for (const [id, attacker] of attackerMap) {
      if (attacker.slotsUsed >= attacker.openSlots) continue; // No slots left

      const suit = scoreAttackerSuitability(attacker, target, weights);
      if (suit >= 0) {
        candidates.push({ ...attacker, suitability: suit });
      }
    }

    // Sort by suitability descending
    candidates.sort((a, b) => b.suitability - a.suitability);

    // Assign top N candidates
    for (const candidate of candidates.slice(0, neededAttackers)) {
      assignedToTarget.push(candidate);
      // Update slot usage
      const atk = attackerMap.get(candidate.id);
      if (atk) atk.slotsUsed++;
    }

    assignments.push({
      target,
      attackers: assignedToTarget,
      fullySlotted: assignedToTarget.length >= neededAttackers,
      neededAttackers,
    });

    if (assignedToTarget.length < neededAttackers) {
      unmatched.push({
        target,
        assigned: assignedToTarget.length,
        needed: neededAttackers,
      });
    }
  }

  // Find our members who weren't assigned anything
  for (const [id, attacker] of attackerMap) {
    if (attacker.slotsUsed === 0) {
      unusedMembers.push(attacker);
    }
  }

  // Stats
  const totalAssignments  = assignments.reduce((s, a) => s + a.attackers.length, 0);
  const fullySlottedCount = assignments.filter(a => a.fullySlotted).length;
  const coverage          = validTargets.length > 0
    ? Math.round((fullySlottedCount / validTargets.length) * 100)
    : 0;

  return {
    ourMemberCount:    availableAttackers.length,
    enemyMemberCount:  validTargets.length,
    totalTargets:      validTargets.length,
    assignments,
    unmatched,
    unusedMembers,
    totalAssignments,
    fullySlottedCount,
    coverage,
    attackersPerTarget,
  };
}

module.exports = { planBlitz, scoreThreat };
