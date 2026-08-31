// ============================================================
// src/commands/intelligence/targets.js
// /targets — Recommended attack targets from enemy watchlists
// Scores each target and categorises them
// ============================================================

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { query, queryOne } = require('../../utils/database');
const { pwQuery, getAllianceMembers } = require('../../utils/pwApi');

// Score a nation as an attack target (higher = better target)
function scoreTarget(nation, ourMembers) {
  let score = 0;

  // Weak military = good target
  if (nation.aircraft < 50)  score += 30;
  if (nation.tanks < 500)    score += 20;
  if (nation.soldiers < 10000) score += 10;

  // No active wars = more slots to fill
  if (nation.offensive_wars_count === 0) score += 15;
  if (nation.defensive_wars_count === 0) score += 10;

  // More cities = more loot potential
  score += Math.min(nation.num_cities * 2, 30);

  // How many of our members can hit them?
  const minScore = nation.score / 1.75;
  const maxScore = nation.score / 0.75;
  const eligible = ourMembers.filter(m =>
    m.score >= minScore && m.score <= maxScore &&
    m.vacation_mode_turns === 0 && m.offensive_wars_count < 5
  );
  score += Math.min(eligible.length * 5, 25);

  return { score, eligibleCount: eligible.length };
}

// Assign a category label based on the nation's profile
function categorise(nation, scoreResult) {
  if (nation.defensive_wars_count > 0 && nation.offensive_wars_count > 0)
    return { label: '⚔️ Counter Target', desc: 'Currently attacking our ally/member' };
  if (nation.aircraft < 30 && nation.tanks < 300)
    return { label: '🎯 Easy Target', desc: 'Very low military — easy win' };
  if (nation.num_cities >= 15)
    return { label: '💰 High Value', desc: 'Large nation with high loot potential' };
  if (scoreResult.score >= 80)
    return { label: '⭐ Priority', desc: 'High overall target value' };
  return { label: '📋 Standard', desc: 'Regular target' };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('targets')
    .setDescription('View recommended attack targets from enemy watchlists')
    .addStringOption(opt =>
      opt.setName('filter')
        .setDescription('Filter by category')
        .addChoices(
          { name: 'All targets', value: 'all' },
          { name: '🎯 Easy targets only', value: 'easy' },
          { name: '💰 High value only', value: 'value' },
          { name: '🟡 In beige (exiting soon)', value: 'beige' },
        )
    )
    .addIntegerOption(opt =>
      opt.setName('limit')
        .setDescription('How many targets to show (default 10, max 25)')
        .setMinValue(1)
        .setMaxValue(25)
    ),

  requiredRole: 'military',

  async execute(interaction) {
    await interaction.deferReply();

    const guildId = interaction.guildId;
    const filter  = interaction.options.getString('filter') || 'all';
    const limit   = interaction.options.getInteger('limit') || 10;

    const guildRow = queryOne('SELECT alliance_id FROM guilds WHERE guild_id = ?', [guildId]);
    if (!guildRow?.alliance_id) {
      return interaction.editReply('❌ No alliance configured. Use `/config alliance` first.');
    }

    const enemyAlliances = query(
      `SELECT alliance_id, alliance_name FROM alliance_watchlist WHERE guild_id = ? AND watchlist_type = 'enemy'`,
      [guildId]
    ).rows;

    const watchedNations = query(
      'SELECT nation_id FROM nation_watchlist WHERE guild_id = ?',
      [guildId]
    ).rows;

    if (enemyAlliances.length === 0 && watchedNations.length === 0) {
      return interaction.editReply('❌ No enemy alliances or nations on watchlist. Use `/watch alliance add` first.');
    }

    await interaction.editReply('⏳ Fetching target data from P&W...');

    // Fetch our members (for eligibility scoring) — no applicants
    const ourMembers = await getAllianceMembers(guildRow.alliance_id);

    // Fetch enemy nations
    const allianceIds = enemyAlliances.map(a => a.alliance_id);
    const nationIds   = watchedNations.map(n => n.nation_id);

    const data = await pwQuery(`
      query GetTargets($allianceIds: [Int], $nationIds: [Int]) {
        nations(alliance_id: $allianceIds, id: $nationIds, vmode: false, first: 500) {
          data {
            id nation_name alliance_position
            alliance { name }
            score num_cities beige_turns
            soldiers tanks aircraft ships missiles nukes
            offensive_wars_count defensive_wars_count
          }
        }
      }
    `, {
      allianceIds: allianceIds.length > 0 ? allianceIds : undefined,
      nationIds:   nationIds.length   > 0 ? nationIds   : undefined,
    });

    let nations = data?.nations?.data || [];

    // Exclude applicants from target lists too (they're not real members)
    const MEMBER_POSITIONS = ['MEMBER', 'OFFICER', 'HEIR', 'LEADER'];
    nations = nations.filter(n =>
      !n.alliance_position || MEMBER_POSITIONS.includes(n.alliance_position?.toUpperCase())
    );

    // Apply filter
    if (filter === 'beige') {
      nations = nations.filter(n => n.beige_turns > 0);
    } else if (filter === 'easy') {
      nations = nations.filter(n => n.aircraft < 50 && n.tanks < 500);
    } else if (filter === 'value') {
      nations = nations.filter(n => n.num_cities >= 12);
    }

    if (nations.length === 0) {
      return interaction.editReply(`❌ No targets found for filter: **${filter}**.`);
    }

    // Score and sort all targets
    const scored = nations
      .map(n => {
        const result = scoreTarget(n, ourMembers);
        const category = categorise(n, result);
        return { ...n, targetScore: result.score, eligibleCount: result.eligibleCount, category };
      })
      .filter(n => n.eligibleCount > 0) // Only show targets we can actually hit
      .sort((a, b) => b.targetScore - a.targetScore)
      .slice(0, limit);

    if (scored.length === 0) {
      return interaction.editReply('❌ No targets found that any alliance member can currently attack. Check `/readiness` to see available war slots.');
    }

    const lines = scored.map((n, i) => {
      const beigeNote = n.beige_turns > 0 ? ` 🟡 Beige: ${n.beige_turns * 2}h left` : '';
      return [
        `**${i + 1}. ${n.category.label} — [${n.nation_name}](https://politicsandwar.com/nation/id=${n.id})**`,
        `└ ${n.category.desc}${beigeNote}`,
        `└ Alliance: ${n.alliance?.name || 'None'} | Score: ${Math.round(n.score).toLocaleString()} | Cities: ${n.num_cities}`,
        `└ ✈️ ${n.aircraft} | 🚗 ${n.tanks} | 👮 ${n.soldiers?.toLocaleString()} | ⚔️ ${n.offensive_wars_count}off/${n.defensive_wars_count}def`,
        `└ 👥 ${n.eligibleCount} member(s) in range`,
      ].join('\n');
    });

    const embed = new EmbedBuilder()
      .setTitle(`🎯 Recommended Targets — ${scored.length} found`)
      .setColor(0xe74c3c)
      .setDescription(lines.join('\n\n'))
      .setFooter({ text: `Filter: ${filter} | Only showing targets with at least 1 eligible attacker | Use /assign create to assign` })
      .setTimestamp();

    await interaction.editReply({ content: '', embeds: [embed] });
  },
};
