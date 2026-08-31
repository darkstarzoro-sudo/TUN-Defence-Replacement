// ============================================================
// src/commands/reporting/participation.js
// /participation — War participation leaderboards and stats
// ============================================================

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { query, run, queryOne } = require('../../utils/database');
const { buildNationToDiscordMap } = require('../../utils/nationLink');
const { getAllianceMembers } = require('../../utils/pwApi');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('participation')
    .setDescription('View war participation leaderboards and member statistics')

    .addSubcommand(sub =>
      sub.setName('leaderboard')
        .setDescription('Show the top most active war participants')
        .addStringOption(opt =>
          opt.setName('type')
            .setDescription('What to rank by')
            .addChoices(
              { name: '⚔️ Most wars declared', value: 'wars' },
              { name: '✅ Most assignments completed', value: 'assignments' },
              { name: '🛡️ Most counters done', value: 'counters' },
            )
        )
    )

    .addSubcommand(sub =>
      sub.setName('snapshot')
        .setDescription('Pull a fresh snapshot of alliance war activity from P&W')
    )

    .addSubcommand(sub =>
      sub.setName('inactive')
        .setDescription('Show members with zero offensive wars right now')
    ),

  requiredRole: 'military',

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    // ── LEADERBOARD ──────────────────────────────────────────
    if (sub === 'leaderboard') {
      const type = interaction.options.getString('type') || 'assignments';

      // Wars leaderboard — needs a live snapshot
      if (type === 'wars') {
        const snap = queryOne(
          `SELECT * FROM participation_snapshots WHERE guild_id = ? ORDER BY recorded_at DESC LIMIT 1`,
          [interaction.guildId]
        );
        if (!snap) {
          return interaction.reply({
            content: '❌ No snapshot yet. Run `/participation snapshot` first to pull live data from P&W.',
            flags: 64,
          });
        }

        const data   = JSON.parse(snap.data);
        const sorted = [...data].sort((a, b) => b.offensive_wars_count - a.offensive_wars_count);
        const medals = ['🥇', '🥈', '🥉'];
        const lines  = sorted.slice(0, 15).map((m, i) =>
          `${medals[i] || `**${i + 1}.**`} **[${m.nation_name}](https://politicsandwar.com/nation/id=${m.id})** — ${m.offensive_wars_count} active war(s)`
        );

        const embed = new EmbedBuilder()
          .setTitle('⚔️ Leaderboard — Most Active Wars')
          .setColor(0xf39c12)
          .setDescription(lines.length > 0 ? lines.join('\n') : 'No war data found.')
          .setFooter({ text: `Snapshot: ${snap.recorded_at} UTC | Use /participation snapshot to refresh` })
          .setTimestamp();

        return interaction.reply({ embeds: [embed], flags: 64 });
      }

      // Assignments leaderboard — from bot DB
      if (type === 'assignments') {
        const rows = query(
          `SELECT assigned_to_discord_id as user_id, COUNT(*) as count
           FROM target_assignments
           WHERE guild_id = ? AND status = 'completed'
           GROUP BY assigned_to_discord_id
           ORDER BY count DESC LIMIT 15`,
          [interaction.guildId]
        ).rows;

        if (rows.length === 0) {
          return interaction.reply({
            content: '📋 No completed assignments yet. Complete some targets to appear here!',
            flags: 64,
          });
        }

        const medals = ['🥇', '🥈', '🥉'];
        const lines  = rows.map((r, i) =>
          `${medals[i] || `**${i + 1}.**`} <@${r.user_id}> — **${r.count}** assignment(s) completed`
        );

        const embed = new EmbedBuilder()
          .setTitle('✅ Leaderboard — Most Assignments Completed')
          .setColor(0x2ecc71)
          .setDescription(lines.join('\n'))
          .setFooter({ text: 'Based on bot assignment records' })
          .setTimestamp();

        return interaction.reply({ embeds: [embed], flags: 64 });
      }

      // Counters leaderboard — from bot DB, filter by [COUNTER] note tag
      if (type === 'counters') {
        const rows = query(
          `SELECT assigned_to_discord_id as user_id, COUNT(*) as count
           FROM target_assignments
           WHERE guild_id = ? AND status = 'completed'
           AND notes LIKE '%[COUNTER]%'
           GROUP BY assigned_to_discord_id
           ORDER BY count DESC LIMIT 15`,
          [interaction.guildId]
        ).rows;

        if (rows.length === 0) {
          return interaction.reply({
            content: '📋 No completed counter-attacks recorded yet.',
            flags: 64,
          });
        }

        const medals = ['🥇', '🥈', '🥉'];
        const lines  = rows.map((r, i) =>
          `${medals[i] || `**${i + 1}.**`} <@${r.user_id}> — **${r.count}** counter(s) completed`
        );

        const embed = new EmbedBuilder()
          .setTitle('🛡️ Leaderboard — Most Counters Completed')
          .setColor(0xe74c3c)
          .setDescription(lines.join('\n'))
          .setFooter({ text: 'Based on bot counter-assignment records' })
          .setTimestamp();

        return interaction.reply({ embeds: [embed], flags: 64 });
      }
    }

    // ── SNAPSHOT ─────────────────────────────────────────────
    if (sub === 'snapshot') {
      await interaction.deferReply();

      const guildRow = queryOne('SELECT alliance_id FROM guilds WHERE guild_id = ?', [interaction.guildId]);
      if (!guildRow?.alliance_id) {
        return interaction.editReply('❌ No alliance configured. Use `/config alliance` first.');
      }

      await interaction.editReply('⏳ Pulling live war data from P&W...');

      let members;
      try {
        members = await getAllianceMembers(guildRow.alliance_id);
      } catch {
        return interaction.editReply('❌ Could not fetch alliance data from P&W. Try again shortly.');
      }

      const snapshot = members.map(m => ({
        id:                   m.id,
        nation_name:          m.nation_name,
        offensive_wars_count: m.offensive_wars_count || 0,
        defensive_wars_count: m.defensive_wars_count || 0,
        score:                m.score,
        num_cities:           m.num_cities,
      }));

      run(
        `INSERT INTO participation_snapshots (guild_id, data, recorded_at)
         VALUES (?, ?, datetime('now'))`,
        [interaction.guildId, JSON.stringify(snapshot)]
      );

      const totalOff      = snapshot.reduce((s, m) => s + m.offensive_wars_count, 0);
      const totalDef      = snapshot.reduce((s, m) => s + m.defensive_wars_count, 0);
      const activeAtt     = snapshot.filter(m => m.offensive_wars_count > 0).length;
      const underAttack   = snapshot.filter(m => m.defensive_wars_count > 0).length;
      const noWars        = snapshot.filter(m => m.offensive_wars_count === 0).length;

      const embed = new EmbedBuilder()
        .setTitle('📸 Participation Snapshot Saved')
        .setColor(0x3498db)
        .setDescription('Live data pulled from P&W and saved. Use `/participation leaderboard` to view rankings.')
        .addFields(
          { name: '👥 Members Scanned',     value: `${snapshot.length}`,   inline: true },
          { name: '⚔️ Offensive Wars',      value: `${totalOff}`,          inline: true },
          { name: '🛡️ Defensive Wars',      value: `${totalDef}`,          inline: true },
          { name: '🔥 Active Attackers',    value: `${activeAtt}`,         inline: true },
          { name: '🆘 Under Attack',        value: `${underAttack}`,       inline: true },
          { name: '😴 No Offensive Wars',   value: `${noWars}`,            inline: true },
        )
        .setTimestamp();

      return interaction.editReply({ content: '', embeds: [embed] });
    }

    // ── INACTIVE ─────────────────────────────────────────────
    if (sub === 'inactive') {
      await interaction.deferReply();

      const guildRow = queryOne('SELECT alliance_id FROM guilds WHERE guild_id = ?', [interaction.guildId]);
      if (!guildRow?.alliance_id) {
        return interaction.editReply('❌ No alliance configured. Use `/config alliance` first.');
      }

      await interaction.editReply('⏳ Checking member activity from P&W...');

      let members;
      try {
        members = await getAllianceMembers(guildRow.alliance_id);
      } catch {
        return interaction.editReply('❌ Could not fetch data. Try again shortly.');
      }

      const discordMap = buildNationToDiscordMap(guildRow.guild_id || interaction.guildId);
      const inactive = members.filter(m =>
        m.offensive_wars_count === 0 && m.vacation_mode_turns === 0
      );

      if (inactive.length === 0) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle('📊 Inactivity Check')
              .setColor(0x2ecc71)
              .setDescription('✅ All active members have at least one offensive war!')
              .setTimestamp()
          ]
        });
      }

      const lines = inactive.map(m =>
        `• **[${m.nation_name}](https://politicsandwar.com/nation/id=${m.id})**${discordMap.get(m.id) ? ` <@${discordMap.get(m.id)}>` : ''} — Score: ${Math.round(m.score).toLocaleString()} | Cities: ${m.num_cities}`
      );

      const embed = new EmbedBuilder()
        .setTitle(`⚠️ Members With No Offensive Wars — ${inactive.length}`)
        .setColor(0xe67e22)
        .setDescription(lines.join('\n'))
        .setFooter({ text: 'These members have zero active offensive wars right now.' })
        .setTimestamp();

      return interaction.editReply({ content: '', embeds: [embed] });
    }
  },
};
