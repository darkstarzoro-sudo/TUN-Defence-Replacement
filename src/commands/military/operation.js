// ============================================================
// src/commands/military/operation.js
// Create and manage war operations with full tracking
// ============================================================

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { query, run, queryOne } = require('../../utils/database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('operation')
    .setDescription('Create and manage war operations')

    .addSubcommand(sub =>
      sub.setName('create')
        .setDescription('Create a new military operation')
        .addStringOption(opt =>
          opt.setName('name')
            .setDescription('Operation name e.g. "Operation Iron Fist"')
            .setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('description')
            .setDescription('Operation briefing / objectives')
        )
        .addStringOption(opt =>
          opt.setName('start')
            .setDescription('Start time UTC e.g. 2026-06-25 18:00 (optional)')
        )
    )

    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('View all operations')
        .addStringOption(opt =>
          opt.setName('filter')
            .setDescription('Filter by status')
            .addChoices(
              { name: 'Active', value: 'active' },
              { name: 'Planning', value: 'planning' },
              { name: 'Completed', value: 'completed' },
              { name: 'All', value: 'all' },
            )
        )
    )

    .addSubcommand(sub =>
      sub.setName('view')
        .setDescription('View full details of an operation')
        .addIntegerOption(opt =>
          opt.setName('id').setDescription('Operation ID').setRequired(true)
        )
    )

    .addSubcommand(sub =>
      sub.setName('status')
        .setDescription('Update an operation\'s status')
        .addIntegerOption(opt =>
          opt.setName('id').setDescription('Operation ID').setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('status')
            .setDescription('New status')
            .setRequired(true)
            .addChoices(
              { name: '📋 Planning', value: 'planning' },
              { name: '⚔️ Active', value: 'active' },
              { name: '✅ Completed', value: 'completed' },
              { name: '🚫 Cancelled', value: 'cancelled' },
            )
        )
    )

    .addSubcommand(sub =>
      sub.setName('addtarget')
        .setDescription('Add a target nation to an operation')
        .addIntegerOption(opt =>
          opt.setName('id').setDescription('Operation ID').setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('target')
            .setDescription('Nation name, ID, or P&W link')
            .setRequired(true)
        )
        .addUserOption(opt =>
          opt.setName('assignee')
            .setDescription('Alliance member to attack this target')
        )
    )

    .addSubcommand(sub =>
      sub.setName('report')
        .setDescription('Generate a summary report for an operation')
        .addIntegerOption(opt =>
          opt.setName('id').setDescription('Operation ID').setRequired(true)
        )
    )

    .addSubcommand(sub =>
      sub.setName('warroom')
        .setDescription('Create a dedicated war room (channels) for an operation')
        .addIntegerOption(opt =>
          opt.setName('id').setDescription('Operation ID').setRequired(true)
        )
    )

    .addSubcommand(sub =>
      sub.setName('archive')
        .setDescription('Archive a war room (locks channels, keeps history)')
        .addIntegerOption(opt =>
          opt.setName('id').setDescription('Operation ID').setRequired(true)
        )
    )

    .addSubcommand(sub =>
      sub.setName('deleteroom')
        .setDescription('Permanently delete a war room\'s channels')
        .addIntegerOption(opt =>
          opt.setName('id').setDescription('Operation ID').setRequired(true)
        )
    ),

  requiredRole: 'military',

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    // ── CREATE ──────────────────────────────────────────────
    if (sub === 'create') {
      const name        = interaction.options.getString('name');
      const description = interaction.options.getString('description') || null;
      const startStr    = interaction.options.getString('start') || null;

      let startTime = null;
      if (startStr) {
        startTime = new Date(startStr + ' UTC');
        if (isNaN(startTime.getTime())) {
          return interaction.reply({
            content: '❌ Invalid time format. Use: `YYYY-MM-DD HH:MM` (UTC)',
            flags: 64,
          });
        }
        startTime = startTime.toISOString();
      }

      run(
        `INSERT INTO operations (guild_id, name, description, created_by, status, start_time)
         VALUES (?, ?, ?, ?, 'planning', ?)`,
        [interaction.guildId, name, description, interaction.user.id, startTime]
      );

      const op = queryOne(
        `SELECT id FROM operations WHERE guild_id = ? AND name = ? ORDER BY created_at DESC LIMIT 1`,
        [interaction.guildId, name]
      );

      const embed = new EmbedBuilder()
        .setTitle(`🏴 Operation Created — ${name}`)
        .setColor(0x8e44ad)
        .addFields(
          { name: '🆔 Operation ID', value: `#${op?.id}`, inline: true },
          { name: '📊 Status', value: '📋 Planning', inline: true },
          { name: '👤 Commander', value: `<@${interaction.user.id}>`, inline: true },
        )
        .setFooter({ text: `Use /operation addtarget ${op?.id} to add targets | /operation status ${op?.id} to update status` })
        .setTimestamp();

      if (description) embed.addFields({ name: '📋 Objectives', value: description });
      if (startTime) {
        const ts = Math.floor(new Date(startTime).getTime() / 1000);
        embed.addFields({ name: '⏰ Start Time', value: `<t:${ts}:F> (<t:${ts}:R>)` });
      }

      return interaction.reply({ embeds: [embed] });
    }

    // ── LIST ────────────────────────────────────────────────
    if (sub === 'list') {
      const filter = interaction.options.getString('filter') || 'active';

      const ops = filter === 'all'
        ? query(`SELECT * FROM operations WHERE guild_id = ? ORDER BY created_at DESC LIMIT 20`, [interaction.guildId]).rows
        : query(`SELECT * FROM operations WHERE guild_id = ? AND status = ? ORDER BY created_at DESC LIMIT 20`, [interaction.guildId, filter]).rows;

      if (ops.length === 0) {
        return interaction.reply({
          content: `📋 No **${filter}** operations found. Use \`/operation create\` to start one.`,
          flags: 64,
        });
      }

      const statusEmoji = { planning: '📋', active: '⚔️', completed: '✅', cancelled: '🚫' };
      const lines = ops.map(op => {
        const targetCount = query(`SELECT COUNT(*) as c FROM operation_targets WHERE operation_id = ?`, [op.id]).rows[0]?.c || 0;
        const doneCount   = query(`SELECT COUNT(*) as c FROM operation_targets WHERE operation_id = ? AND status = 'completed'`, [op.id]).rows[0]?.c || 0;
        return (
          `${statusEmoji[op.status] || '📋'} **${op.name}** — \`#${op.id}\`\n` +
          `└ Status: **${op.status}** | Targets: ${doneCount}/${targetCount} completed`
          + (op.description ? `\n└ _${op.description.slice(0, 80)}${op.description.length > 80 ? '...' : ''}_` : '')
        );
      });

      const embed = new EmbedBuilder()
        .setTitle(`🏴 Operations — ${ops.length} found`)
        .setColor(0x8e44ad)
        .setDescription(lines.join('\n\n'))
        .setFooter({ text: 'Use /operation view [id] for full details' })
        .setTimestamp();

      return interaction.reply({ embeds: [embed], flags: 64 });
    }

    // ── VIEW ─────────────────────────────────────────────────
    if (sub === 'view') {
      const id = interaction.options.getInteger('id');
      const op = queryOne(`SELECT * FROM operations WHERE id = ? AND guild_id = ?`, [id, interaction.guildId]);
      if (!op) return interaction.reply({ content: `❌ Operation #${id} not found.`, flags: 64 });

      const targets = query(`SELECT * FROM operation_targets WHERE operation_id = ? ORDER BY created_at ASC`, [id]).rows;
      const statusEmoji = { planning: '📋', active: '⚔️', completed: '✅', cancelled: '🚫' };
      const targetStatus = { assigned: '📌', completed: '✅', failed: '❌', unassigned: '⬜' };

      const embed = new EmbedBuilder()
        .setTitle(`🏴 ${op.name} — Operation #${op.id}`)
        .setColor(0x8e44ad)
        .addFields(
          { name: '📊 Status', value: `${statusEmoji[op.status]} ${op.status}`, inline: true },
          { name: '👤 Commander', value: `<@${op.created_by}>`, inline: true },
          { name: '🎯 Targets', value: `${targets.filter(t => t.status === 'completed').length}/${targets.length} completed`, inline: true },
        )
        .setTimestamp();

      if (op.description) embed.addFields({ name: '📋 Objectives', value: op.description });
      if (op.start_time) {
        const ts = Math.floor(new Date(op.start_time).getTime() / 1000);
        embed.addFields({ name: '⏰ Start Time', value: `<t:${ts}:F>`, inline: true });
      }

      if (targets.length > 0) {
        const targetLines = targets.map(t =>
          `${targetStatus[t.status] || '⬜'} **[${t.nation_name}](https://politicsandwar.com/nation/id=${t.nation_id})**` +
          (t.assigned_to ? ` → <@${t.assigned_to}>` : ' — _unassigned_')
        );
        embed.addFields({ name: '🎯 Target List', value: targetLines.join('\n') });
      } else {
        embed.addFields({ name: '🎯 Targets', value: `No targets yet. Use \`/operation addtarget ${id}\` to add some.` });
      }

      embed.setFooter({ text: `Use /operation addtarget ${id} | /operation status ${id} | /operation report ${id}` });
      return interaction.reply({ embeds: [embed], flags: 64 });
    }

    // ── STATUS ───────────────────────────────────────────────
    if (sub === 'status') {
      const id     = interaction.options.getInteger('id');
      const status = interaction.options.getString('status');
      const op = queryOne(`SELECT * FROM operations WHERE id = ? AND guild_id = ?`, [id, interaction.guildId]);
      if (!op) return interaction.reply({ content: `❌ Operation #${id} not found.`, flags: 64 });

      run(`UPDATE operations SET status = ? WHERE id = ?`, [status, id]);
      const statusEmoji = { planning: '📋', active: '⚔️', completed: '✅', cancelled: '🚫' };
      return interaction.reply({
        content: `✅ Operation **${op.name}** (#${id}) status updated to ${statusEmoji[status]} **${status}**.`,
      });
    }

    // ── ADD TARGET ───────────────────────────────────────────
    if (sub === 'addtarget') {
      await interaction.deferReply();
      const id       = interaction.options.getInteger('id');
      const input    = interaction.options.getString('target');
      const assignee = interaction.options.getUser('assignee');

      const op = queryOne(`SELECT * FROM operations WHERE id = ? AND guild_id = ?`, [id, interaction.guildId]);
      if (!op) return interaction.editReply(`❌ Operation #${id} not found.`);

      await interaction.editReply(`🔍 Looking up **${input}**...`);

      const { resolveNation } = require('../../utils/pwApi');
      const nation = await resolveNation(input);
      if (!nation) {
        return interaction.editReply(`❌ Could not find nation **"${input}"**. Try name, ID, or P&W link.`);
      }

      run(
        `INSERT OR IGNORE INTO operation_targets
         (operation_id, nation_id, nation_name, assigned_to, status)
         VALUES (?, ?, ?, ?, 'assigned')`,
        [id, nation.id, nation.nation_name, assignee?.id || null]
      );

      // Also create a formal assignment if assignee provided
      if (assignee) {
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        run(
          `INSERT INTO target_assignments
           (guild_id, target_nation_id, target_nation_name, assigned_to_discord_id,
            assigned_by_discord_id, status, priority, notes, expires_at)
           VALUES (?, ?, ?, ?, ?, 'assigned', 'high', ?, ?)`,
          [interaction.guildId, nation.id, nation.nation_name,
           assignee.id, interaction.user.id,
           `[Operation: ${op.name}]`, expiresAt]
        );
      }

      return interaction.editReply(
        `✅ Added **${nation.nation_name}** to operation **${op.name}**` +
        (assignee ? ` — assigned to <@${assignee.id}>` : ' — unassigned') +
        `\nUse \`/operation view ${id}\` to see the full target list.`
      );
    }

    // ── REPORT ───────────────────────────────────────────────
    if (sub === 'report') {
      const id = interaction.options.getInteger('id');
      const op = queryOne(`SELECT * FROM operations WHERE id = ? AND guild_id = ?`, [id, interaction.guildId]);
      if (!op) return interaction.reply({ content: `❌ Operation #${id} not found.`, flags: 64 });

      const targets    = query(`SELECT * FROM operation_targets WHERE operation_id = ?`, [id]).rows;
      const completed  = targets.filter(t => t.status === 'completed');
      const failed     = targets.filter(t => t.status === 'failed');
      const pending    = targets.filter(t => !['completed', 'failed'].includes(t.status));
      const successRate = targets.length > 0 ? Math.round((completed.length / targets.length) * 100) : 0;

      const embed = new EmbedBuilder()
        .setTitle(`📊 Operation Report — ${op.name}`)
        .setColor(successRate >= 75 ? 0x2ecc71 : successRate >= 50 ? 0xf1c40f : 0xe74c3c)
        .addFields(
          { name: '🎯 Total Targets', value: `${targets.length}`, inline: true },
          { name: '✅ Completed', value: `${completed.length}`, inline: true },
          { name: '❌ Failed', value: `${failed.length}`, inline: true },
          { name: '⏳ Pending', value: `${pending.length}`, inline: true },
          { name: '📈 Success Rate', value: `${successRate}%`, inline: true },
          { name: '📊 Final Status', value: op.status, inline: true },
        )
        .setTimestamp()
        .setFooter({ text: `Operation #${id} | Commander: ${op.created_by}` });

      if (op.description) embed.addFields({ name: '📋 Objectives', value: op.description });
      return interaction.reply({ embeds: [embed] });
    }

    // ── WAR ROOM ─────────────────────────────────────────────
    if (sub === 'warroom') {
      await interaction.deferReply();
      const id = interaction.options.getInteger('id');
      const op = queryOne(`SELECT * FROM operations WHERE id = ? AND guild_id = ?`, [id, interaction.guildId]);
      if (!op) return interaction.editReply(`❌ Operation #${id} not found.`);

      if (op.war_room_category_id) {
        const existingCategory = interaction.guild.channels.cache.get(op.war_room_category_id);
        if (existingCategory) {
          return interaction.editReply(`⚠️ A war room already exists for **${op.name}**: ${existingCategory}`);
        }
      }

      await interaction.editReply('⏳ Creating war room channels...');

      const { createWarRoom } = require('../../systems/military/warRoom');
      try {
        const rooms = await createWarRoom(interaction.guild, op.name, id, interaction.user.id);

        const embed = new EmbedBuilder()
          .setTitle(`🏴 War Room Created — ${op.name}`)
          .setColor(0x8e44ad)
          .setDescription(
            `A dedicated war room has been created for this operation:\n\n` +
            `📁 Category: **${rooms.category.name}**\n` +
            `└ ${rooms.mainChannel} — Main coordination\n` +
            `└ ${rooms.assignChannel} — Target assignments\n` +
            `└ ${rooms.intelChannel} — Intelligence updates\n` +
            `└ ${rooms.resultsChannel} — Battle results\n\n` +
            `Only Military and Government roles can see these channels.`
          )
          .setFooter({ text: `Use /operation archive ${id} when finished | /operation deleteroom ${id} to remove` })
          .setTimestamp();

        return interaction.editReply({ content: '', embeds: [embed] });
      } catch (err) {
        return interaction.editReply(`❌ Failed to create war room: ${err.message}\n\nMake sure the bot has "Manage Channels" permission.`);
      }
    }

    // ── ARCHIVE WAR ROOM ─────────────────────────────────────
    if (sub === 'archive') {
      await interaction.deferReply();
      const id = interaction.options.getInteger('id');
      const op = queryOne(`SELECT * FROM operations WHERE id = ? AND guild_id = ?`, [id, interaction.guildId]);
      if (!op) return interaction.editReply(`❌ Operation #${id} not found.`);
      if (!op.war_room_category_id) return interaction.editReply(`❌ Operation **${op.name}** has no war room to archive.`);

      const { archiveWarRoom } = require('../../systems/military/warRoom');
      const success = await archiveWarRoom(interaction.guild, id);

      if (success) {
        run(`UPDATE operations SET status = 'completed' WHERE id = ?`, [id]);
        return interaction.editReply(`✅ War room for **${op.name}** has been archived. Channels are locked but history is preserved.`);
      } else {
        return interaction.editReply(`❌ Failed to archive war room. Check bot permissions.`);
      }
    }

    // ── DELETE WAR ROOM ──────────────────────────────────────
    if (sub === 'deleteroom') {
      await interaction.deferReply();
      const id = interaction.options.getInteger('id');
      const op = queryOne(`SELECT * FROM operations WHERE id = ? AND guild_id = ?`, [id, interaction.guildId]);
      if (!op) return interaction.editReply(`❌ Operation #${id} not found.`);
      if (!op.war_room_category_id) return interaction.editReply(`❌ Operation **${op.name}** has no war room to delete.`);

      const { deleteWarRoom } = require('../../systems/military/warRoom');
      const success = await deleteWarRoom(interaction.guild, id);

      if (success) {
        return interaction.editReply(`✅ War room channels for **${op.name}** have been permanently deleted.`);
      } else {
        return interaction.editReply(`❌ Failed to delete war room. Check bot permissions.`);
      }
    }
  },
};
