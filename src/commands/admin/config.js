// ============================================================
// src/commands/admin/config.js
// ============================================================

const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { query, run, queryOne } = require('../../utils/database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('config')
    .setDescription('Configure the bot settings for your alliance')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)

    .addSubcommandGroup(group =>
      group.setName('channel')
        .setDescription('Set alert channels')
        .addSubcommand(sub =>
          sub.setName('beige')
            .setDescription('Set the channel for beige exit alerts')
            .addChannelOption(opt =>
              opt.setName('channel').setDescription('The channel').setRequired(true)
            )
        )
        .addSubcommand(sub =>
          sub.setName('wars')
            .setDescription('Set the channel for war/defense alerts')
            .addChannelOption(opt =>
              opt.setName('channel').setDescription('The channel').setRequired(true)
            )
        )
        .addSubcommand(sub =>
          sub.setName('intel')
            .setDescription('Set the channel for intelligence alerts')
            .addChannelOption(opt =>
              opt.setName('channel').setDescription('The channel').setRequired(true)
            )
        )
    )

    .addSubcommandGroup(group =>
      group.setName('role')
        .setDescription('Set permission roles')
        .addSubcommand(sub =>
          sub.setName('military')
            .setDescription('Set the Military Officer role')
            .addRoleOption(opt =>
              opt.setName('role').setDescription('The role').setRequired(true)
            )
        )
        .addSubcommand(sub =>
          sub.setName('government')
            .setDescription('Set the Government role')
            .addRoleOption(opt =>
              opt.setName('role').setDescription('The role').setRequired(true)
            )
        )
    )

    .addSubcommand(sub =>
      sub.setName('alliance')
        .setDescription('Set your alliance ID from Politics & War')
        .addIntegerOption(opt =>
          opt.setName('id').setDescription('Your alliance ID number').setRequired(true)
        )
    )

    .addSubcommand(sub =>
      sub.setName('view')
        .setDescription('View all current bot settings')
    ),

  requiredRole: 'admin',

  async execute(interaction) {
    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand();

    // /config channel [type]
    if (group === 'channel') {
      const channel = interaction.options.getChannel('channel');
      // Delete old entry then insert new one (sql.js safe approach)
      run('DELETE FROM guild_channels WHERE guild_id = ? AND channel_type = ?',
        [interaction.guildId, sub]);
      run('INSERT INTO guild_channels (guild_id, channel_type, discord_channel_id) VALUES (?, ?, ?)',
        [interaction.guildId, sub, channel.id]);
      return interaction.reply({
        content: `✅ **${sub}** alerts will now be sent to ${channel}`,
        flags: 64,
      });
    }

    // /config role [type]
    if (group === 'role') {
      const role = interaction.options.getRole('role');
      run('DELETE FROM guild_roles WHERE guild_id = ? AND role_type = ?',
        [interaction.guildId, sub]);
      run('INSERT INTO guild_roles (guild_id, role_type, discord_role_id) VALUES (?, ?, ?)',
        [interaction.guildId, sub, role.id]);
      return interaction.reply({
        content: `✅ **${sub}** permission role set to ${role}`,
        flags: 64,
      });
    }

    // /config alliance
    if (sub === 'alliance') {
      const allianceId = interaction.options.getInteger('id');
      run('DELETE FROM guilds WHERE guild_id = ?', [interaction.guildId]);
      run('INSERT INTO guilds (guild_id, alliance_id) VALUES (?, ?)',
        [interaction.guildId, allianceId]);
      return interaction.reply({
        content: `✅ Alliance ID set to **${allianceId}**`,
        flags: 64,
      });
    }

    // /config view
    if (sub === 'view') {
      const guildRow = queryOne('SELECT * FROM guilds WHERE guild_id = ?', [interaction.guildId]);
      const channels = query('SELECT * FROM guild_channels WHERE guild_id = ?', [interaction.guildId]).rows;
      const roles = query('SELECT * FROM guild_roles WHERE guild_id = ?', [interaction.guildId]).rows;

      const embed = new EmbedBuilder()
        .setTitle('⚙️ Bot Configuration')
        .setColor(0x3498db)
        .addFields(
          {
            name: '🏛️ Alliance',
            value: guildRow?.alliance_id ? `ID: ${guildRow.alliance_id}` : '❌ Not set — use `/config alliance`',
          },
          {
            name: '📢 Alert Channels',
            value: channels.length
              ? channels.map(c => `**${c.channel_type}**: <#${c.discord_channel_id}>`).join('\n')
              : '❌ None configured — use `/config channel`',
          },
          {
            name: '🎭 Permission Roles',
            value: roles.length
              ? roles.map(r => `**${r.role_type}**: <@&${r.discord_role_id}>`).join('\n')
              : '❌ None configured — use `/config role`',
          }
        )
        .setTimestamp();

      return interaction.reply({ embeds: [embed], flags: 64 });
    }
  },
};
