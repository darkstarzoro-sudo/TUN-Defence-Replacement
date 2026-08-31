// ============================================================
// src/commands/military/blitz.js
// Plan and coordinate timed alliance blitzes with countdowns
// ============================================================

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { query, run, queryOne } = require('../../utils/database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('blitz')
    .setDescription('Plan and coordinate timed alliance blitzes')

    .addSubcommand(sub =>
      sub.setName('create')
        .setDescription('Create a new blitz operation')
        .addStringOption(opt =>
          opt.setName('name')
            .setDescription('Name for this blitz e.g. "Operation Sunrise"')
            .setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('time')
            .setDescription('When to launch — format: YYYY-MM-DD HH:MM (UTC) e.g. 2026-06-25 18:00')
            .setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('description')
            .setDescription('Brief description or target list')
        )
    )

    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('View all active blitz operations')
    )

    .addSubcommand(sub =>
      sub.setName('view')
        .setDescription('View details of a specific blitz')
        .addIntegerOption(opt =>
          opt.setName('id')
            .setDescription('Blitz ID from /blitz list')
            .setRequired(true)
        )
    )

    .addSubcommand(sub =>
      sub.setName('ready')
        .setDescription('Mark yourself as ready for a blitz')
        .addIntegerOption(opt =>
          opt.setName('id')
            .setDescription('Blitz ID')
            .setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('status')
            .setDescription('Your readiness status')
            .setRequired(true)
            .addChoices(
              { name: '✅ Ready', value: 'ready' },
              { name: '❌ Not Ready', value: 'not_ready' },
              { name: '⏳ Delayed', value: 'delayed' },
            )
        )
    )

    .addSubcommand(sub =>
      sub.setName('cancel')
        .setDescription('Cancel a blitz operation')
        .addIntegerOption(opt =>
          opt.setName('id')
            .setDescription('Blitz ID')
            .setRequired(true)
        )
    )

    .addSubcommand(sub =>
      sub.setName('ping')
        .setDescription('Ping all participants of a blitz')
        .addIntegerOption(opt =>
          opt.setName('id')
            .setDescription('Blitz ID')
            .setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('message')
            .setDescription('Message to include in the ping')
        )
    ),

  requiredRole: 'military',

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    // ── CREATE ──────────────────────────────────────────────
    if (sub === 'create') {
      const name        = interaction.options.getString('name');
      const timeStr     = interaction.options.getString('time');
      const description = interaction.options.getString('description') || null;

      // Parse the time string into a Date
      const launchTime = new Date(timeStr + ' UTC');
      if (isNaN(launchTime.getTime())) {
        return interaction.reply({
          content: '❌ Invalid time format. Use: `YYYY-MM-DD HH:MM` (UTC)\nExample: `2026-06-25 18:00`',
          flags: 64,
        });
      }

      if (launchTime < new Date()) {
        return interaction.reply({
          content: '❌ Launch time must be in the future.',
          flags: 64,
        });
      }

      run(
        `INSERT INTO blitz_operations
         (guild_id, name, description, launch_time, created_by, status)
         VALUES (?, ?, ?, ?, ?, 'active')`,
        [interaction.guildId, name, description, launchTime.toISOString(), interaction.user.id]
      );

      const blitz = queryOne(
        `SELECT id FROM blitz_operations WHERE guild_id = ? AND name = ? ORDER BY created_at DESC LIMIT 1`,
        [interaction.guildId, name]
      );

      const launchTs = Math.floor(launchTime.getTime() / 1000);
      const embed = new EmbedBuilder()
        .setTitle(`💥 Blitz Created — ${name}`)
        .setColor(0xe74c3c)
        .addFields(
          { name: '🆔 Blitz ID', value: `#${blitz?.id || '?'}`, inline: true },
          { name: '⏰ Launch Time', value: `<t:${launchTs}:F>\n<t:${launchTs}:R>`, inline: true },
          { name: '👤 Created By', value: `<@${interaction.user.id}>`, inline: true },
        )
        .setFooter({ text: `Use /blitz ready ${blitz?.id} to mark yourself ready | /blitz ping ${blitz?.id} to alert members` })
        .setTimestamp();

      if (description) embed.addFields({ name: '📋 Description', value: description });

      return interaction.reply({ embeds: [embed] });
    }

    // ── LIST ────────────────────────────────────────────────
    if (sub === 'list') {
      const blitzes = query(
        `SELECT * FROM blitz_operations WHERE guild_id = ? AND status = 'active' ORDER BY launch_time ASC`,
        [interaction.guildId]
      ).rows;

      if (blitzes.length === 0) {
        return interaction.reply({
          content: '📋 No active blitz operations. Use `/blitz create` to plan one.',
          flags: 64,
        });
      }

      const lines = blitzes.map(b => {
        const launchTs = Math.floor(new Date(b.launch_time).getTime() / 1000);
        const readyRows = query(
          `SELECT status, COUNT(*) as count FROM blitz_participants WHERE blitz_id = ? GROUP BY status`,
          [b.id]
        ).rows;
        const readyCount = readyRows.find(r => r.status === 'ready')?.count || 0;
        const total      = readyRows.reduce((s, r) => s + Number(r.count), 0);

        return (
          `💥 **${b.name}** — \`#${b.id}\`\n` +
          `└ Launch: <t:${launchTs}:R> (<t:${launchTs}:f>)\n` +
          `└ Ready: **${readyCount}/${total}** confirmed` +
          (b.description ? `\n└ _${b.description}_` : '')
        );
      });

      const embed = new EmbedBuilder()
        .setTitle(`💥 Active Blitz Operations — ${blitzes.length}`)
        .setColor(0xe74c3c)
        .setDescription(lines.join('\n\n'))
        .setFooter({ text: 'Use /blitz view [id] for full details | /blitz ready [id] to confirm' })
        .setTimestamp();

      return interaction.reply({ embeds: [embed], flags: 64 });
    }

    // ── VIEW ─────────────────────────────────────────────────
    if (sub === 'view') {
      const id = interaction.options.getInteger('id');
      const blitz = queryOne(
        `SELECT * FROM blitz_operations WHERE id = ? AND guild_id = ?`,
        [id, interaction.guildId]
      );

      if (!blitz) {
        return interaction.reply({ content: `❌ Blitz #${id} not found.`, flags: 64 });
      }

      const participants = query(
        `SELECT * FROM blitz_participants WHERE blitz_id = ? ORDER BY status, responded_at ASC`,
        [id]
      ).rows;

      const launchTs = Math.floor(new Date(blitz.launch_time).getTime() / 1000);

      const readyList    = participants.filter(p => p.status === 'ready');
      const notReadyList = participants.filter(p => p.status === 'not_ready');
      const delayedList  = participants.filter(p => p.status === 'delayed');

      const embed = new EmbedBuilder()
        .setTitle(`💥 ${blitz.name} — Blitz #${blitz.id}`)
        .setColor(0xe74c3c)
        .addFields(
          { name: '⏰ Launch Time', value: `<t:${launchTs}:F>\n<t:${launchTs}:R>`, inline: true },
          { name: '📊 Status', value: blitz.status, inline: true },
          { name: '👤 Created By', value: `<@${blitz.created_by}>`, inline: true },
        )
        .setTimestamp();

      if (blitz.description) {
        embed.addFields({ name: '📋 Description / Targets', value: blitz.description });
      }

      if (readyList.length > 0) {
        embed.addFields({
          name: `✅ Ready (${readyList.length})`,
          value: readyList.map(p => `<@${p.discord_user_id}>`).join(', '),
        });
      }
      if (notReadyList.length > 0) {
        embed.addFields({
          name: `❌ Not Ready (${notReadyList.length})`,
          value: notReadyList.map(p => `<@${p.discord_user_id}>`).join(', '),
        });
      }
      if (delayedList.length > 0) {
        embed.addFields({
          name: `⏳ Delayed (${delayedList.length})`,
          value: delayedList.map(p => `<@${p.discord_user_id}>`).join(', '),
        });
      }
      if (participants.length === 0) {
        embed.addFields({ name: '👥 Participants', value: 'No responses yet. Use `/blitz ready` to respond.' });
      }

      embed.setFooter({ text: `Use /blitz ready ${id} to update your status | /blitz ping ${id} to alert members` });
      return interaction.reply({ embeds: [embed], flags: 64 });
    }

    // ── READY ────────────────────────────────────────────────
    if (sub === 'ready') {
      const id     = interaction.options.getInteger('id');
      const status = interaction.options.getString('status');

      const blitz = queryOne(
        `SELECT * FROM blitz_operations WHERE id = ? AND guild_id = ? AND status = 'active'`,
        [id, interaction.guildId]
      );
      if (!blitz) {
        return interaction.reply({ content: `❌ Active blitz #${id} not found.`, flags: 64 });
      }

      // Upsert the participant's status
      run(
        `DELETE FROM blitz_participants WHERE blitz_id = ? AND discord_user_id = ?`,
        [id, interaction.user.id]
      );
      run(
        `INSERT INTO blitz_participants (blitz_id, discord_user_id, status, responded_at)
         VALUES (?, ?, ?, datetime('now'))`,
        [id, interaction.user.id, status]
      );

      const emoji = { ready: '✅', not_ready: '❌', delayed: '⏳' };
      return interaction.reply({
        content: `${emoji[status]} You marked yourself as **${status.replace('_', ' ')}** for blitz **${blitz.name}** (#${id}).`,
        flags: 64,
      });
    }

    // ── CANCEL ───────────────────────────────────────────────
    if (sub === 'cancel') {
      const id = interaction.options.getInteger('id');
      const blitz = queryOne(
        `SELECT * FROM blitz_operations WHERE id = ? AND guild_id = ?`,
        [id, interaction.guildId]
      );
      if (!blitz) return interaction.reply({ content: `❌ Blitz #${id} not found.`, flags: 64 });
      if (blitz.status === 'cancelled') return interaction.reply({ content: `❌ Blitz #${id} is already cancelled.`, flags: 64 });

      run(`UPDATE blitz_operations SET status = 'cancelled' WHERE id = ?`, [id]);
      return interaction.reply({ content: `✅ Blitz **${blitz.name}** (#${id}) has been cancelled.` });
    }

    // ── PING ─────────────────────────────────────────────────
    if (sub === 'ping') {
      const id      = interaction.options.getInteger('id');
      const message = interaction.options.getString('message') || '';

      const blitz = queryOne(
        `SELECT * FROM blitz_operations WHERE id = ? AND guild_id = ? AND status = 'active'`,
        [id, interaction.guildId]
      );
      if (!blitz) return interaction.reply({ content: `❌ Active blitz #${id} not found.`, flags: 64 });

      const launchTs = Math.floor(new Date(blitz.launch_time).getTime() / 1000);

      // Get military role to ping
      const roleRow = queryOne(
        `SELECT discord_role_id FROM guild_roles WHERE guild_id = ? AND role_type = 'military'`,
        [interaction.guildId]
      );
      const ping = roleRow ? `<@&${roleRow.discord_role_id}>` : '@everyone';

      const embed = new EmbedBuilder()
        .setTitle(`💥 BLITZ ALERT — ${blitz.name}`)
        .setColor(0xe74c3c)
        .setDescription(
          `**Launch Time:** <t:${launchTs}:F> (<t:${launchTs}:R>)\n\n` +
          (blitz.description ? `**Targets:** ${blitz.description}\n\n` : '') +
          (message ? `**Message:** ${message}\n\n` : '') +
          `Use \`/blitz ready ${id}\` to confirm your status!`
        )
        .setTimestamp();

      return interaction.reply({ content: `${ping} — Blitz alert!`, embeds: [embed] });
    }
  },
};
