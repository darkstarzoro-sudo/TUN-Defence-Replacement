// ============================================================
// src/commands/intelligence/nation.js
// /nation — Full intelligence profile of any P&W nation
// ============================================================

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { resolveNation, pwQuery } = require('../../utils/pwApi');
const { calculateNationReadiness, getReadinessWeights, readinessEmoji, PER_CITY, MAX_SPIES } = require('../../utils/mmrCalculator');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('nation')
    .setDescription('Full intelligence profile of any P&W nation')
    .addStringOption(opt =>
      opt.setName('nation')
        .setDescription('Nation name, ID, or P&W link')
        .setRequired(true)
    ),

  requiredRole: 'military',

  async execute(interaction) {
    await interaction.deferReply();
    const input = interaction.options.getString('nation');
    await interaction.editReply(`🔍 Looking up **${input}**...`);

    const nation = await resolveNation(input);
    if (!nation) {
      return interaction.editReply(`❌ Could not find nation **"${input}"**. Try name, ID, or P&W link.`);
    }

    // Fetch active wars for this nation
    let wars = [];
    try {
      const warData = await pwQuery(`
        query GetNationWars($id: [Int]) {
          wars(nation_id: $id, active: true, first: 10) {
            data {
              id attid defid
              attacker { id nation_name score alliance { name } }
              defender { id nation_name score alliance { name } }
              turnsleft
            }
          }
        }
      `, { id: [parseInt(nation.id)] });
      wars = warData?.wars?.data || [];
    } catch { /* skip if war fetch fails */ }

    const cities     = nation.num_cities || 1;
    const inBeige    = (nation.beige_turns || 0) > 0;
    const inVacation = (nation.vacation_mode_turns || 0) > 0;
    const beigeHours = (nation.beige_turns || 0) * 2;

    // MMR capacity
    const maxSoldiers = cities * PER_CITY.soldiers;
    const maxTanks    = cities * PER_CITY.tanks;
    const maxAircraft = cities * PER_CITY.aircraft;
    const maxShips    = cities * PER_CITY.ships;
    const maxMissiles = cities * 2;

    // Readiness
    const weights  = getReadinessWeights(interaction.guildId);
    const readiness = calculateNationReadiness(nation, weights);

    // War breakdown
    const nationIdStr = String(nation.id);
    const offWars = wars.filter(w => String(w.attid) === nationIdStr);
    const defWars = wars.filter(w => String(w.defid) === nationIdStr);

    // Status badges
    const badges = [];
    if (inBeige)    badges.push(`🟡 In Beige (${beigeHours}h remaining)`);
    if (inVacation) badges.push(`🏖️ Vacation Mode (${nation.vacation_mode_turns} turns)`);
    if (nation.nukes > 0)    badges.push(`☢️ Nuclear Armed (${nation.nukes} nukes)`);
    if (nation.missiles > 0) badges.push(`🚀 ${nation.missiles} missiles`);
    if (offWars.length >= 4) badges.push(`⚔️ Heavily Engaged (${offWars.length} off wars)`);
    if (defWars.length >= 3) badges.push(`🛡️ Under Heavy Attack (${defWars.length} def wars)`);

    const embeds = [];

    // ── EMBED 1: OVERVIEW ────────────────────────────────────
    embeds.push(
      new EmbedBuilder()
        .setTitle(`🔍 Nation Intelligence — ${nation.nation_name}`)
        .setColor(inBeige ? 0xf1c40f : 0x2c3e50)
        .setDescription(
          `**[View Nation](https://politicsandwar.com/nation/id=${nation.id})**` +
          (badges.length > 0 ? `\n\n${badges.join('\n')}` : '')
        )
        .addFields(
          { name: '👑 Leader', value: nation.leader_name || 'Unknown', inline: true },
          { name: '🏛️ Alliance', value: nation.alliance?.name ? `[${nation.alliance.name}](https://politicsandwar.com/alliance/id=${nation.alliance_id})` : 'None', inline: true },
          { name: '🎭 Position', value: nation.alliance_position || 'N/A', inline: true },
          { name: '🏙️ Cities', value: `${cities}`, inline: true },
          { name: '⭐ Score', value: nation.score?.toLocaleString() || '?', inline: true },
          { name: '🌈 Color', value: nation.color || 'Unknown', inline: true },
        )
        .setFooter({ text: `Nation ID: ${nation.id}` })
        .setTimestamp()
    );

    // ── EMBED 2: MILITARY ────────────────────────────────────
    embeds.push(
      new EmbedBuilder()
        .setTitle('🪖 Military Intelligence')
        .setColor(0xe74c3c)
        .addFields(
          {
            name: '⚔️ vs MMR Capacity (5/5/5/3)',
            value: [
              `👮 Soldiers:  **${(nation.soldiers || 0).toLocaleString()}** / ${maxSoldiers.toLocaleString()} (${Math.round((nation.soldiers || 0) / maxSoldiers * 100)}%)`,
              `🚗 Tanks:     **${(nation.tanks    || 0).toLocaleString()}** / ${maxTanks.toLocaleString()} (${Math.round((nation.tanks    || 0) / maxTanks    * 100)}%)`,
              `✈️ Aircraft:  **${nation.aircraft  || 0}** / ${maxAircraft} (${Math.round((nation.aircraft  || 0) / maxAircraft  * 100)}%)`,
              `🚢 Ships:     **${nation.ships     || 0}** / ${maxShips}    (${Math.round((nation.ships     || 0) / maxShips     * 100)}%)`,
              `🕵️ Spies:     **${nation.spies     || 0}** / ${MAX_SPIES}`,
              `🚀 Missiles:  **${nation.missiles  || 0}** / ${maxMissiles}`,
              `☢️ Nukes:     **${nation.nukes     || 0}**`,
            ].join('\n'),
            inline: false,
          },
          {
            name: `${readinessEmoji(readiness.total)} MMR Readiness`,
            value: `**${readiness.total}%** overall readiness`,
            inline: true,
          },
          {
            name: '⚔️ Active Wars',
            value: `Offensive: **${offWars.length}** | Defensive: **${defWars.length}** | Open slots: **${5 - offWars.length}**`,
            inline: true,
          },
        )
    );

    // ── EMBED 3: ACTIVE WARS ─────────────────────────────────
    if (wars.length > 0) {
      const warLines = wars.map(w => {
        const isAtt = String(w.attid) === nationIdStr;
        const opp   = isAtt ? w.defender : w.attacker;
        return `${isAtt ? '⚔️' : '🛡️'} **[${opp.nation_name || 'Unknown'}](https://politicsandwar.com/nation/id=${opp.id})** (${opp.alliance?.name || 'None'}) — ${w.turnsleft} turns left`;
      });

      embeds.push(
        new EmbedBuilder()
          .setTitle(`⚔️ Active Wars — ${wars.length}`)
          .setColor(0xe67e22)
          .setDescription(warLines.join('\n'))
          .setFooter({ text: 'Use /counter find to see who can counter this nation' })
      );
    }

    // ── EMBED 4: WAR RANGE ───────────────────────────────────
    const score = nation.score || 0;
    const minScore = Math.round(score * 0.75);
    const maxScore = Math.round(score * 1.75);

    embeds.push(
      new EmbedBuilder()
        .setTitle('📏 War Range Information')
        .setColor(0x8e44ad)
        .addFields(
          {
            name: '🎯 Who can attack this nation',
            value: `Nations with score between **${minScore.toLocaleString()}** and **${maxScore.toLocaleString()}**`,
            inline: false,
          },
          {
            name: '🗡️ Who this nation can attack',
            value: `Nations with score between **${Math.round(score / 1.75).toLocaleString()}** and **${Math.round(score / 0.75).toLocaleString()}**`,
            inline: false,
          },
          {
            name: '🔗 Quick Links',
            value: `[Nation Page](https://politicsandwar.com/nation/id=${nation.id}) | [Declare War](https://politicsandwar.com/nation/id=${nation.id}&sAction=war)`,
            inline: false,
          },
        )
    );

    await interaction.editReply({ content: '', embeds });
  },
};
