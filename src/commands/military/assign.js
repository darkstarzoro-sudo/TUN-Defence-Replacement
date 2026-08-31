// ============================================================
// src/commands/military/assign.js
// Fix 4: Accept/decline buttons on assignment embeds
//        DM members when assignment is cancelled
// ============================================================

const {
  SlashCommandBuilder, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
} = require('discord.js');
const { query, run, queryOne } = require('../../utils/database');
const { buildNationToDiscordMap, getLinkedDiscordUser } = require('../../utils/nationLink');
const { resolveNation } = require('../../utils/pwApi');
const { checkPermission } = require('../../utils/permissions');

// Build the assignment embed with Accept/Decline buttons
function buildAssignmentEmbed(nation, assignment, priority, notes, expiresAt, assignedBy) {
  const priorityEmoji = { normal: '🟡', high: '🟠', critical: '🔴' };
  const expiresTs = Math.floor(new Date(expiresAt).getTime() / 1000);

  const embed = new EmbedBuilder()
    .setTitle(`${priorityEmoji[priority] || '🟡'} Target Assignment`)
    .setColor(priority === 'critical' ? 0xe74c3c : priority === 'high' ? 0xe67e22 : 0x3498db)
    .addFields(
      { name: '🎯 Target Nation', value: `[${nation.nation_name}](https://politicsandwar.com/nation/id=${nation.id})`, inline: true },
      { name: '🏛️ Alliance', value: nation.alliance?.name || 'None', inline: true },
      { name: '⭐ Score', value: nation.score?.toLocaleString() || '?', inline: true },
      { name: '🪖 Military', value: `✈️ ${nation.aircraft || 0} | 🚗 ${nation.tanks || 0} | 🚀 ${nation.missiles || 0} | ☢️ ${nation.nukes || 0}`, inline: false },
      { name: '📋 Priority', value: `${priorityEmoji[priority]} ${priority}`, inline: true },
      { name: '⏰ Expires', value: `<t:${expiresTs}:R>`, inline: true },
    )
    .setTimestamp();

  if (notes) embed.addFields({ name: '📝 Instructions', value: notes });
  if (assignedBy) embed.setFooter({ text: `Assigned by ${assignedBy} • Click Accept or Decline below` });

  return embed;
}

// Build Accept/Decline buttons with assignment ID encoded in customId
function buildAssignmentButtons(assignmentId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`assignment_accept_${assignmentId}`)
      .setLabel('✅ Accept')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`assignment_decline_${assignmentId}`)
      .setLabel('❌ Decline')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setLabel('View Nation')
      .setStyle(ButtonStyle.Link)
      .setURL(`https://politicsandwar.com/nation/id=${assignmentId}`), // fixed below per nation
  );
}

function buildAssignmentButtonsWithNation(assignmentId, nationId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`assignment_accept_${assignmentId}`)
      .setLabel('✅ Accept')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`assignment_decline_${assignmentId}`)
      .setLabel('❌ Decline')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setLabel('🔗 View Nation')
      .setStyle(ButtonStyle.Link)
      .setURL(`https://politicsandwar.com/nation/id=${nationId}`),
  );
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('assign')
    .setDescription('Manage target assignments')

    .addSubcommand(sub =>
      sub.setName('create')
        .setDescription('Assign a target nation to an alliance member')
        .addStringOption(opt =>
          opt.setName('target').setDescription('Target nation — name, ID, or P&W link').setRequired(true)
        )
        .addUserOption(opt =>
          opt.setName('member').setDescription('Alliance member to assign this target to').setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('priority')
            .setDescription('Priority level')
            .addChoices(
              { name: '🟡 Normal', value: 'normal' },
              { name: '🟠 High', value: 'high' },
              { name: '🔴 Critical', value: 'critical' },
            )
        )
        .addStringOption(opt =>
          opt.setName('notes').setDescription('Instructions for the assigned member')
        )
        .addIntegerOption(opt =>
          opt.setName('expires')
            .setDescription('Hours until this assignment expires (default: 6)')
            .addChoices(
              { name: '1 hour', value: 1 },
              { name: '3 hours', value: 3 },
              { name: '6 hours', value: 6 },
              { name: '12 hours', value: 12 },
              { name: '24 hours', value: 24 },
            )
        )
    )

    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('View all active assignments')
        .addStringOption(opt =>
          opt.setName('filter')
            .setDescription('Filter by status')
            .addChoices(
              { name: 'All active', value: 'active' },
              { name: 'Assigned (pending)', value: 'assigned' },
              { name: 'Accepted', value: 'accepted' },
              { name: 'Completed', value: 'completed' },
            )
        )
    )

    .addSubcommand(sub =>
      sub.setName('cancel')
        .setDescription('Cancel an assignment by its ID number')
        .addIntegerOption(opt =>
          opt.setName('id').setDescription('Assignment ID (shown in /assign list)').setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('reason').setDescription('Reason for cancellation (sent to the member)')
        )
    )

    .addSubcommand(sub =>
      sub.setName('complete')
        .setDescription('Mark your assignment as completed')
        .addIntegerOption(opt =>
          opt.setName('id').setDescription('Assignment ID').setRequired(true)
        )
    )

    .addSubcommand(sub =>
      sub.setName('mine')
        .setDescription('View assignments given to you')
    ),

  requiredRole: null,

  async execute(interaction, client) {
    const sub = interaction.options.getSubcommand();

    // ── CREATE ──────────────────────────────────────────────
    if (sub === 'create') {
      if (!checkPermission(interaction, 'military')) {
        return interaction.reply({ content: '❌ You need the Military Officer role to assign targets.', flags: 64 });
      }

      await interaction.deferReply();
      const targetInput  = interaction.options.getString('target');
      const member       = interaction.options.getUser('member');
      const priority     = interaction.options.getString('priority') || 'normal';
      const notes        = interaction.options.getString('notes') || null;
      const expiresHours = interaction.options.getInteger('expires') || 6;

      await interaction.editReply(`🔍 Looking up **${targetInput}**...`);

      const nation = await resolveNation(targetInput);
      if (!nation) {
        return interaction.editReply(`❌ Could not find nation **"${targetInput}"**. Try name, ID, or P&W link.`);
      }

      const expiresAt = new Date(Date.now() + expiresHours * 60 * 60 * 1000).toISOString();

      run(
        `INSERT INTO target_assignments
         (guild_id, target_nation_id, target_nation_name, assigned_to_discord_id,
          assigned_by_discord_id, status, priority, notes, expires_at)
         VALUES (?, ?, ?, ?, ?, 'assigned', ?, ?, ?)`,
        [interaction.guildId, nation.id, nation.nation_name,
         member.id, interaction.user.id, priority, notes, expiresAt]
      );

      const assignment = queryOne(
        `SELECT id FROM target_assignments WHERE guild_id = ? AND target_nation_id = ? AND assigned_to_discord_id = ? ORDER BY created_at DESC LIMIT 1`,
        [interaction.guildId, nation.id, member.id]
      );

      const assignmentId = assignment?.id;
      const embed = buildAssignmentEmbed(nation, assignment, priority, notes, expiresAt, interaction.user.username);
      const buttons = buildAssignmentButtonsWithNation(assignmentId, nation.id);

      await interaction.editReply({
        content: `📌 <@${member.id}> — you have been assigned a target!`,
        embeds: [embed],
        components: [buttons],
      });

      // DM the assigned member with buttons
      try {
        await member.send({
          content: `📌 You have a new target assignment in **${interaction.guild.name}**!`,
          embeds: [embed],
          components: [buttons],
        });
      } catch { /* DMs closed */ }
    }

    // ── LIST ────────────────────────────────────────────────
    if (sub === 'list') {
      if (!checkPermission(interaction, 'military')) {
        return interaction.reply({ content: '❌ You need the Military Officer role to view all assignments.', flags: 64 });
      }

      const filter = interaction.options.getString('filter') || 'active';

      let assignments;
      if (filter === 'active') {
        assignments = query(
          `SELECT * FROM target_assignments WHERE guild_id = ? AND status NOT IN ('completed','cancelled','expired') ORDER BY priority DESC, created_at ASC`,
          [interaction.guildId]
        ).rows;
      } else {
        assignments = query(
          `SELECT * FROM target_assignments WHERE guild_id = ? AND status = ? ORDER BY created_at DESC LIMIT 20`,
          [interaction.guildId, filter]
        ).rows;
      }

      if (assignments.length === 0) {
        return interaction.reply({ content: `📋 No assignments found for filter: **${filter}**.`, flags: 64 });
      }

      const statusEmoji = { assigned: '📌', accepted: '✅', in_progress: '⚔️', completed: '🏆', failed: '❌', expired: '⏰', cancelled: '🚫' };
      const priorityEmoji = { normal: '🟡', high: '🟠', critical: '🔴' };

      const lines = assignments.slice(0, 15).map(a =>
        `${priorityEmoji[a.priority] || '🟡'} ${statusEmoji[a.status] || '📌'} **[${a.target_nation_name}](https://politicsandwar.com/nation/id=${a.target_nation_id})** — <@${a.assigned_to_discord_id}>\n` +
        `└ ID: \`#${a.id}\` | Expires: <t:${Math.floor(new Date(a.expires_at).getTime() / 1000)}:R>`
        + (a.notes ? `\n└ _${a.notes}_` : '')
      );

      const embed = new EmbedBuilder()
        .setTitle(`📋 Target Assignments — ${assignments.length}`)
        .setColor(0x3498db)
        .setDescription(lines.join('\n\n'))
        .setFooter({ text: 'Use /assign cancel [id] to cancel | /assign complete [id] to complete' })
        .setTimestamp();

      return interaction.reply({ embeds: [embed], flags: 64 });
    }

    // ── CANCEL — now DMs the member ─────────────────────────
    if (sub === 'cancel') {
      if (!checkPermission(interaction, 'military')) {
        return interaction.reply({ content: '❌ You need the Military Officer role to cancel assignments.', flags: 64 });
      }

      const id     = interaction.options.getInteger('id');
      const reason = interaction.options.getString('reason') || 'No reason provided.';

      const assignment = queryOne(
        'SELECT * FROM target_assignments WHERE id = ? AND guild_id = ?',
        [id, interaction.guildId]
      );

      if (!assignment) return interaction.reply({ content: `❌ Assignment #${id} not found.`, flags: 64 });
      if (['completed', 'cancelled'].includes(assignment.status)) {
        return interaction.reply({ content: `❌ Assignment #${id} is already **${assignment.status}**.`, flags: 64 });
      }

      run(`UPDATE target_assignments SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`, [id]);

      await interaction.reply({
        content: `✅ Assignment **#${id}** (${assignment.target_nation_name}) cancelled.\nReason sent to <@${assignment.assigned_to_discord_id}>.`,
        flags: 64,
      });

      // DM the member about cancellation
      try {
        const assignedMember = await interaction.client.users.fetch(assignment.assigned_to_discord_id);
        const cancelEmbed = new EmbedBuilder()
          .setTitle('🚫 Assignment Cancelled')
          .setColor(0x95a5a6)
          .setDescription(
            `Your assignment to attack **[${assignment.target_nation_name}](https://politicsandwar.com/nation/id=${assignment.target_nation_id})** has been cancelled.`
          )
          .addFields(
            { name: '📋 Assignment ID', value: `#${id}`, inline: true },
            { name: '👤 Cancelled By', value: interaction.user.username, inline: true },
            { name: '📝 Reason', value: reason, inline: false },
          )
          .setTimestamp();

        await assignedMember.send({
          content: `🚫 Your assignment in **${interaction.guild.name}** has been cancelled.`,
          embeds: [cancelEmbed],
        });
      } catch { /* DMs closed */ }
    }

    // ── COMPLETE ────────────────────────────────────────────
    if (sub === 'complete') {
      const id = interaction.options.getInteger('id');
      const assignment = queryOne(
        'SELECT * FROM target_assignments WHERE id = ? AND guild_id = ? AND assigned_to_discord_id = ?',
        [id, interaction.guildId, interaction.user.id]
      );

      if (!assignment) return interaction.reply({ content: `❌ Assignment #${id} not found or not assigned to you.`, flags: 64 });
      if (assignment.status === 'completed') return interaction.reply({ content: `✅ Assignment #${id} is already marked complete.`, flags: 64 });

      run(`UPDATE target_assignments SET status = 'completed', updated_at = datetime('now') WHERE id = ?`, [id]);
      return interaction.reply({
        content: `🏆 Assignment **#${id}** — **${assignment.target_nation_name}** — marked as completed! Great work!`,
      });
    }

    // ── MINE ────────────────────────────────────────────────
    if (sub === 'mine') {
      const assignments = query(
        `SELECT * FROM target_assignments WHERE guild_id = ? AND assigned_to_discord_id = ? AND status NOT IN ('cancelled','expired') ORDER BY created_at DESC LIMIT 10`,
        [interaction.guildId, interaction.user.id]
      ).rows;

      if (assignments.length === 0) {
        return interaction.reply({ content: '📋 You have no active assignments.', flags: 64 });
      }

      const statusEmoji = { assigned: '📌', accepted: '✅', in_progress: '⚔️', completed: '🏆' };

      const embeds = assignments.map(a => {
        const expiresTs = Math.floor(new Date(a.expires_at).getTime() / 1000);
        const embed = new EmbedBuilder()
          .setColor(a.status === 'assigned' ? 0xe67e22 : 0x2ecc71)
          .addFields(
            { name: `${statusEmoji[a.status] || '📌'} #${a.id} — ${a.target_nation_name}`, value: `[View Nation](https://politicsandwar.com/nation/id=${a.target_nation_id})`, inline: true },
            { name: 'Status', value: a.status, inline: true },
            { name: 'Expires', value: `<t:${expiresTs}:R>`, inline: true },
          );
        if (a.notes) embed.addFields({ name: 'Instructions', value: a.notes });
        return embed;
      });

      // Add action buttons for pending assignments
      // Build action buttons for pending and accepted assignments
      const actionableRows = [];

      const pending  = assignments.filter(a => a.status === 'assigned').slice(0, 3);
      const accepted = assignments.filter(a => a.status === 'accepted').slice(0, 3);

      if (pending.length > 0) {
        actionableRows.push(
          new ActionRowBuilder().addComponents(
            ...pending.map(a =>
              new ButtonBuilder()
                .setCustomId(`assignment_accept_${a.id}`)
                .setLabel(`✅ Accept #${a.id}`)
                .setStyle(ButtonStyle.Success)
            )
          )
        );
      }

      if (accepted.length > 0) {
        actionableRows.push(
          new ActionRowBuilder().addComponents(
            ...accepted.map(a =>
              new ButtonBuilder()
                .setCustomId(`assignment_complete_${a.id}`)
                .setLabel(`🏆 Complete #${a.id}`)
                .setStyle(ButtonStyle.Primary)
            )
          )
        );
      }

      return interaction.reply({ embeds, components: actionableRows, flags: 64 });
    }
  },
};
