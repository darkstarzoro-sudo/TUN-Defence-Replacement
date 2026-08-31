// ============================================================
// src/commands/military/blitzplan.js
// /blitzplan — Automatically pair your members with enemy targets
// based on war range, threat level, and attacker suitability
// ============================================================

const {
  SlashCommandBuilder, EmbedBuilder, AttachmentBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
} = require('discord.js');
const { queryOne, run } = require('../../utils/database');
const { buildNationToDiscordMap } = require('../../utils/nationLink');
const { resolveAlliance } = require('../../utils/pwApi');
const { planBlitz, scoreThreat } = require('../../systems/military/blitzPlanner');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('blitzplan')
    .setDescription('Automatically generate a blitz attack plan against an enemy alliance')

    .addSubcommand(sub =>
      sub.setName('generate')
        .setDescription('Generate a blitz plan pairing your members with enemy targets')
        .addStringOption(opt =>
          opt.setName('enemy')
            .setDescription('Enemy alliance name, ID, or P&W link')
            .setRequired(true)
        )
        .addIntegerOption(opt =>
          opt.setName('attackers')
            .setDescription('How many of our members to assign per enemy target (default: 3)')
            .addChoices(
              { name: '1 attacker per target', value: 1 },
              { name: '2 attackers per target', value: 2 },
              { name: '3 attackers per target (recommended)', value: 3 },
              { name: '4 attackers per target', value: 4 },
              { name: '5 attackers per target (full slot)', value: 5 },
            )
        )
        .addStringOption(opt =>
          opt.setName('output')
            .setDescription('How to display the plan')
            .addChoices(
              { name: '📊 Summary + CSV file (default)', value: 'csv' },
              { name: '📋 Discord embeds only (top 10 targets)', value: 'embed' },
            )
        )
    )

    .addSubcommand(sub =>
      sub.setName('convert')
        .setDescription('Convert a generated plan into real assignments in the bot')
        .addStringOption(opt =>
          opt.setName('enemy')
            .setDescription('Same enemy alliance you ran /blitzplan generate for')
            .setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('blitz_name')
            .setDescription('Name for this blitz operation e.g. "Operation Sunrise"')
            .setRequired(true)
        )
        .addIntegerOption(opt =>
          opt.setName('attackers')
            .setDescription('Same attackers-per-target value you used (default: 3)')
            .addChoices(
              { name: '1', value: 1 },
              { name: '2', value: 2 },
              { name: '3', value: 3 },
              { name: '4', value: 4 },
              { name: '5', value: 5 },
            )
        )
        .addStringOption(opt =>
          opt.setName('launch_time')
            .setDescription('Launch time UTC e.g. 2026-06-30 18:00 (optional)')
        )
    ),

  requiredRole: 'military',

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    const guildRow = queryOne('SELECT alliance_id FROM guilds WHERE guild_id = ?', [interaction.guildId]);
    if (!guildRow?.alliance_id) {
      return interaction.reply({ content: '❌ No alliance configured. Use `/config alliance` first.', flags: 64 });
    }

    // ── GENERATE ─────────────────────────────────────────────
    if (sub === 'generate') {
      await interaction.deferReply();

      const enemyInput       = interaction.options.getString('enemy');
      const attackersPerTarget = interaction.options.getInteger('attackers') || 3;
      const outputMode       = interaction.options.getString('output') || 'csv';

      await interaction.editReply(`🔍 Looking up **${enemyInput}**...`);

      const enemyAlliance = await resolveAlliance(enemyInput);
      if (!enemyAlliance) {
        return interaction.editReply(`❌ Could not find alliance **"${enemyInput}"**. Try name, ID, or P&W link.`);
      }

      await interaction.editReply(`⏳ Fetching both alliance rosters and calculating assignments...\nThis may take up to 30 seconds for large alliances.`);

      let plan;
      try {
        plan = await planBlitz(
          interaction.guildId,
          guildRow.alliance_id,
          enemyAlliance.id,
          attackersPerTarget
        );
      } catch (err) {
        return interaction.editReply(`❌ Failed to generate plan: ${err.message}`);
      }

      // ── SUMMARY EMBED ───────────────────────────────────────
      const coverageColor = plan.coverage >= 80 ? 0x2ecc71
                          : plan.coverage >= 60 ? 0xf1c40f
                          : plan.coverage >= 40 ? 0xe67e22
                          : 0xe74c3c;

      const summaryEmbed = new EmbedBuilder()
        .setTitle(`💥 Blitz Plan — vs ${enemyAlliance.name}`)
        .setColor(coverageColor)
        .setDescription(
          `**${attackersPerTarget} attacker(s) assigned per enemy target**\n` +
          `Targets are sorted by **threat level** — most dangerous enemies assigned first.\n\u200b`
        )
        .addFields(
          {
            name: '📊 Coverage',
            value:
              `Fully slotted targets: **${plan.fullySlottedCount} / ${plan.totalTargets}** (${plan.coverage}%)\n` +
              `Total assignments: **${plan.totalAssignments}**\n` +
              `Targets needing more attackers: **${plan.unmatched.length}**`,
            inline: false,
          },
          {
            name: '👥 Our Alliance',
            value:
              `Available attackers: **${plan.ourMemberCount}**\n` +
              `Members without assignment: **${plan.unusedMembers.length}**`,
            inline: true,
          },
          {
            name: '⚔️ Enemy Alliance',
            value:
              `Targetable members: **${plan.enemyMemberCount}**\n` +
              (plan.unmatched.length > 0
                ? `⚠️ ${plan.unmatched.length} target(s) couldn't be fully slotted`
                : `✅ All targets can be fully slotted`),
            inline: true,
          },
        )
        .setFooter({
          text:
            `Use /blitzplan convert enemy:${enemyAlliance.name} blitz_name:"Operation X" to create real assignments | ` +
            `Generated: ${new Date().toUTCString()}`
        })
        .setTimestamp();

      // Build Discord mention map from linked nations
      const discordMap = buildNationToDiscordMap(interaction.guildId);

      // ── EMBED OUTPUT MODE ───────────────────────────────────
      if (outputMode === 'embed') {
        const embeds = [summaryEmbed];

        // Show top 10 targets in embeds
        const top10 = plan.assignments.slice(0, 10);
        for (const [i, assignment] of top10.entries()) {
          const t = assignment.target;
          const attackerLines = assignment.attackers.length > 0
            ? assignment.attackers.map(a => {
                const discordId = discordMap.get(a.id);
                const mention   = discordId ? ` (<@${discordId}>)` : ' _(not linked)_';
                return `→ **[${a.nation_name}](https://politicsandwar.com/nation/id=${a.id})**${mention} — Score: ${Math.round(a.score).toLocaleString()} | Slots: ${a.openSlots}`;
              }).join('\n')
            : '❌ No eligible attackers found in range';

          const threatEmoji = t.threatScore >= 80 ? '🔴'
                            : t.threatScore >= 50 ? '🟠'
                            : t.threatScore >= 30 ? '🟡' : '🟢';

          embeds.push(
            new EmbedBuilder()
              .setTitle(`${threatEmoji} #${i + 1} — [${t.nation_name}](https://politicsandwar.com/nation/id=${t.id})`)
              .setColor(assignment.fullySlotted ? 0x2ecc71 : 0xe74c3c)
              .addFields(
                { name: '⭐ Score', value: t.score?.toLocaleString() || '?', inline: true },
                { name: '🏙️ Cities', value: `${t.num_cities}`, inline: true },
                { name: '🎯 Threat Score', value: `${t.threatScore}`, inline: true },
                { name: '🪖 Military', value: `✈️ ${t.aircraft || 0} | 🚗 ${t.tanks || 0} | ☢️ ${t.nukes || 0} | 🚀 ${t.missiles || 0}`, inline: false },
                { name: `👥 Assigned Attackers (${assignment.attackers.length}/${assignment.neededAttackers})`, value: attackerLines, inline: false },
              )
          );

          if (embeds.length >= 10) break;
        }

        if (plan.assignments.length > 10) {
          embeds[embeds.length - 1].setFooter({ text: `Showing 10 of ${plan.assignments.length} targets. Use output:CSV for the full plan.` });
        }

        return interaction.editReply({ content: '', embeds });
      }

      // ── CSV OUTPUT MODE (default) ───────────────────────────
      const csvHeaders = [
        'Priority', 'Threat Score', 'Target Nation', 'Target ID', 'Target Score', 'Target Cities',
        'Target Aircraft', 'Target Tanks', 'Target Nukes', 'Target Missiles',
        'Open Def Slots', 'Attacker 1', 'Attacker 1 Score', 'Attacker 1 ID',
        'Attacker 2', 'Attacker 2 Score', 'Attacker 2 ID',
        'Attacker 3', 'Attacker 3 Score', 'Attacker 3 ID',
        'Fully Slotted', 'Target Link',
      ];

      const csvRows = plan.assignments.map((a, i) => {
        const t   = a.target;
        const atk = a.attackers;
        return [
          i + 1,
          t.threatScore,
          t.nation_name || '',
          t.id,
          Math.round(t.score || 0),
          t.num_cities || 0,
          t.aircraft || 0,
          t.tanks || 0,
          t.nukes || 0,
          t.missiles || 0,
          t.openDefSlots || 0,
          atk[0]?.nation_name || '',
          Math.round(atk[0]?.score || 0),
          atk[0]?.id || '',
          atk[1]?.nation_name || '',
          Math.round(atk[1]?.score || 0),
          atk[1]?.id || '',
          atk[2]?.nation_name || '',
          Math.round(atk[2]?.score || 0),
          atk[2]?.id || '',
          a.fullySlotted ? 'YES' : 'NO',
          `https://politicsandwar.com/nation/id=${t.id}`,
        ];
      });

      // Add unassigned members at the bottom
      const csvLines = [
        csvHeaders,
        ...csvRows,
        [],
        ['--- UNASSIGNED MEMBERS (no target in range) ---'],
        ['Nation Name', 'Nation ID', 'Score', 'Open Slots'],
        ...plan.unusedMembers.map(m => [m.nation_name, m.id, Math.round(m.score || 0), m.openSlots]),
        [],
        ['--- UNDERSTAFFED TARGETS ---'],
        ['Target', 'Assigned', 'Needed'],
        ...plan.unmatched.map(u => [u.target.nation_name, u.assigned, u.needed]),
      ].map(row =>
        Array.isArray(row)
          ? row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')
          : ''
      );

      const csv = csvLines.join('\n');
      const safeAllianceName = (enemyAlliance.name || 'enemy').replace(/[^a-z0-9]/gi, '_');
      const tmpFile = path.join(os.tmpdir(), `blitzplan_${safeAllianceName}_${Date.now()}.csv`);
      fs.writeFileSync(tmpFile, csv, 'utf8');

      const attachment = new AttachmentBuilder(tmpFile, {
        name: `blitzplan_vs_${safeAllianceName}.csv`,
      });

      await interaction.editReply({
        content: '',
        embeds: [summaryEmbed],
        files: [attachment],
      });

      setTimeout(() => { try { fs.unlinkSync(tmpFile); } catch {} }, 15000);
    }

    // ── CONVERT TO REAL ASSIGNMENTS ───────────────────────────
    if (sub === 'convert') {
      await interaction.deferReply();

      const enemyInput       = interaction.options.getString('enemy');
      const attackersPerTarget = interaction.options.getInteger('attackers') || 3;
      const blitzName        = interaction.options.getString('blitz_name');
      const launchTimeStr    = interaction.options.getString('launch_time') || null;

      await interaction.editReply(`⏳ Re-generating plan for **${enemyInput}** and creating assignments...`);

      const enemyAlliance = await resolveAlliance(enemyInput);
      if (!enemyAlliance) {
        return interaction.editReply(`❌ Could not find **"${enemyInput}"**.`);
      }

      let plan;
      try {
        plan = await planBlitz(
          interaction.guildId,
          guildRow.alliance_id,
          enemyAlliance.id,
          attackersPerTarget
        );
      } catch (err) {
        return interaction.editReply(`❌ Failed to generate plan: ${err.message}`);
      }

      // Create a blitz operation record
      let launchTime = null;
      if (launchTimeStr) {
        const parsed = new Date(launchTimeStr + ' UTC');
        if (!isNaN(parsed.getTime())) launchTime = parsed.toISOString();
      }

      run(
        `INSERT INTO blitz_operations (guild_id, name, description, launch_time, created_by, status)
         VALUES (?, ?, ?, ?, ?, 'planning')`,
        [
          interaction.guildId,
          blitzName,
          `Auto-generated vs ${enemyAlliance.name} | ${attackersPerTarget} attackers/target`,
          launchTime,
          interaction.user.id,
        ]
      );

      const blitzRecord = queryOne(
        `SELECT id FROM blitz_operations WHERE guild_id = ? AND name = ? ORDER BY created_at DESC LIMIT 1`,
        [interaction.guildId, blitzName]
      );
      const blitzId = blitzRecord?.id;

      // Create real assignments for every pairing
      const expiresAt = launchTime
        ? new Date(new Date(launchTime).getTime() + 2 * 60 * 60 * 1000).toISOString()
        : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

      let assignmentsCreated = 0;

      // Build Discord ID map from linked nations
      const { buildNationToDiscordMap } = require('../../utils/nationLink');
      const discordMap = buildNationToDiscordMap(interaction.guildId);

      for (const assignment of plan.assignments) {
        for (const attacker of assignment.attackers) {
          // Use linked Discord ID if available, otherwise fall back to officer
          const attackerDiscordId = discordMap.get(attacker.id) || discordMap.get(String(attacker.id)) || interaction.user.id;
          const isLinked = discordMap.has(attacker.id) || discordMap.has(String(attacker.id));

          run(
            `INSERT INTO target_assignments
             (guild_id, target_nation_id, target_nation_name, assigned_to_discord_id,
              assigned_by_discord_id, status, priority, notes, expires_at)
             VALUES (?, ?, ?, ?, ?, 'assigned', 'high', ?, ?)`,
            [
              interaction.guildId,
              assignment.target.id,
              assignment.target.nation_name,
              attackerDiscordId,
              interaction.user.id,
              `[Blitz: ${blitzName}] Attacker: ${attacker.nation_name} (P&W ID: ${attacker.id})${!isLinked ? ' — NOT LINKED, reassign manually' : ''}`,
              expiresAt,
            ]
          );
          assignmentsCreated++;
        }
      }

      const launchTs = launchTime ? Math.floor(new Date(launchTime).getTime() / 1000) : null;

      const embed = new EmbedBuilder()
        .setTitle(`💥 Blitz Created — ${blitzName}`)
        .setColor(0xe74c3c)
        .addFields(
          { name: '🆔 Blitz ID', value: `#${blitzId}`, inline: true },
          { name: '⚔️ Enemy', value: enemyAlliance.name, inline: true },
          { name: '📋 Assignments Created', value: `${assignmentsCreated}`, inline: true },
          { name: '🎯 Targets Covered', value: `${plan.fullySlottedCount} / ${plan.totalTargets} fully slotted (${plan.coverage}%)`, inline: false },
          { name: '⏰ Launch Time', value: launchTs ? `<t:${launchTs}:F> (<t:${launchTs}:R>)` : 'Not set — use `/blitz ping` when ready', inline: false },
        )
        .setDescription(
          `⚠️ **Important:** The assignments have been created but since P&W and Discord accounts aren\'t linked, ` +
          `all assignments are currently attributed to you. Open the CSV from \`/blitzplan generate\` and ` +
          `use \`/assign create\` to reassign each pairing to the correct Discord member.\n\n` +
          `Alternatively, share the CSV with your officers and have them assign manually.`
        )
        .setFooter({ text: `Use /blitz view ${blitzId} to see the blitz | /blitz ping ${blitzId} to alert members` })
        .setTimestamp();

      return interaction.editReply({ content: '', embeds: [embed] });
    }
  },
};
