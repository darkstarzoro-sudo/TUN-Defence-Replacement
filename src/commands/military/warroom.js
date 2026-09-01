// ============================================================
// src/commands/military/warroom.js — fixed: no att_map/def_map
// ============================================================

const { SlashCommandBuilder, EmbedBuilder, ChannelType } = require('discord.js');
const { run, queryOne, query } = require('../../utils/database');
const { pwQuery, MEMBER_POSITIONS } = require('../../utils/pwApi');
const { getOrCreateWarRoom, isInactiveNation } = require('../../systems/military/warRoomManager');
const { buildNationToDiscordMap } = require('../../utils/nationLink');
const { isLegitimateCounter } = require('../../utils/counterDetector');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('warroom')
    .setDescription('Configure and manage war rooms')
    .addSubcommand(sub =>
      sub.setName('setup')
        .setDescription('Set the category where war rooms will be created')
        .addChannelOption(opt => opt.setName('category').setDescription('Discord category for war rooms').setRequired(true))
    )
    .addSubcommand(sub => sub.setName('status').setDescription('Show current war room config and active rooms'))
    .addSubcommand(sub =>
      sub.setName('sync')
        .setDescription('Force-create war rooms for ALL currently active wars (including old ones)')
        .addBooleanOption(opt => opt.setName('offensive').setDescription('Also create rooms for offensive wars (default: true)'))
    ),

  requiredRole: 'military',

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    // ── SETUP ─────────────────────────────────────────────────
    if (sub === 'setup') {
      if (!interaction.member.permissions.has('Administrator')) {
        return interaction.reply({ content: '❌ Only Administrators can configure the war room category.', flags: 64 });
      }
      const category = interaction.options.getChannel('category');
      if (category.type !== ChannelType.GuildCategory) {
        return interaction.reply({ content: '❌ Please select a **Category**, not a text channel.', flags: 64 });
      }
      run(`INSERT INTO alert_settings (guild_id,alert_type,setting_key,setting_value) VALUES(?,'warroom','category_id',?) ON CONFLICT(guild_id,alert_type,setting_key) DO UPDATE SET setting_value=excluded.setting_value`,
        [interaction.guildId, category.id]);
      return interaction.reply({
        embeds: [new EmbedBuilder().setTitle('✅ War Room Category Set').setColor(0x2ecc71)
          .setDescription(`War rooms will be created in **${category.name}**.\n\n**Bot needs:**\n• Manage Channels\n• Manage Permissions\n• View Channel\n• Send Messages\n\nRun \`/warroom sync\` to create rooms for all active wars now.`).setTimestamp()],
        flags: 64,
      });
    }

    // ── STATUS ────────────────────────────────────────────────
    if (sub === 'status') {
      const catRow      = queryOne(`SELECT setting_value FROM alert_settings WHERE guild_id=? AND alert_type='warroom' AND setting_key='category_id'`, [interaction.guildId]);
      const activeRooms = query(`SELECT * FROM war_rooms WHERE guild_id=? AND status='active' ORDER BY created_at DESC`, [interaction.guildId]).rows;
      const category    = catRow ? interaction.guild.channels.cache.get(catRow.setting_value) : null;

      const roomLines = activeRooms.slice(0, 10).map(r => {
        const ch = interaction.guild.channels.cache.get(r.channel_id);
        const mc = query('SELECT COUNT(*) as c FROM war_room_members WHERE war_room_id=?', [r.id]).rows[0]?.c || 0;
        return `• ${ch ? ch.toString() : '#deleted'} — vs **${r.enemy_nation_name}** (${r.enemy_alliance_name}) | ${mc} member(s)`;
      });

      return interaction.reply({
        embeds: [new EmbedBuilder().setTitle('⚙️ War Room Configuration').setColor(0x3498db)
          .addFields(
            { name: '📁 Category', value: category ? `**${category.name}**` : catRow ? '❌ Not found — reconfigure' : '❌ Not configured — run `/warroom setup`' },
            { name: `⚔️ Active War Rooms (${activeRooms.length})`, value: roomLines.length > 0 ? roomLines.join('\n') + (activeRooms.length > 10 ? `\n_+${activeRooms.length - 10} more_` : '') : '_None_' },
          ).setFooter({ text: 'Use /warroom sync to create rooms for missing active wars' }).setTimestamp()],
        flags: 64,
      });
    }

    // ── SYNC ──────────────────────────────────────────────────
    if (sub === 'sync') {
      await interaction.deferReply({ flags: 64 });

      const catRow   = queryOne(`SELECT setting_value FROM alert_settings WHERE guild_id=? AND alert_type='warroom' AND setting_key='category_id'`, [interaction.guildId]);
      if (!catRow) return interaction.editReply('❌ No war room category configured. Run `/warroom setup` first.');

      const guildRow = queryOne('SELECT alliance_id FROM guilds WHERE guild_id=?', [interaction.guildId]);
      if (!guildRow?.alliance_id) return interaction.editReply('❌ No alliance configured.');

      const includeOff    = interaction.options.getBoolean('offensive') ?? true;
      const allianceId    = guildRow.alliance_id;
      const allianceIdStr = String(allianceId);

      await interaction.editReply('⏳ Fetching active wars from P&W...');

      let allWars = [];
      try {
        // No att_map/def_map — they don't exist in P&W API
        const data = await pwQuery(`
          query GetAllianceWars($allianceId:[Int]) {
            wars(alliance_id:$allianceId, active:true, first:100) {
              data {
                id att_alliance_id def_alliance_id attid defid
                att_resistance def_resistance turnsleft
                attacker { id nation_name score alliance_position soldiers tanks aircraft ships missiles nukes spies last_active alliance { id name } }
                defender { id nation_name score alliance_position soldiers tanks aircraft ships missiles nukes spies last_active alliance { id name } }
              }
            }
          }
        `, { allianceId: [parseInt(allianceId)] });
        allWars = data?.wars?.data || [];
      } catch (err) {
        return interaction.editReply(`❌ Failed to fetch wars: ${err.message}`);
      }

      const defWars       = allWars.filter(w => String(w.def_alliance_id) === allianceIdStr);
      const offWars       = includeOff ? allWars.filter(w => String(w.att_alliance_id) === allianceIdStr) : [];
      const warsToProcess = [...defWars, ...offWars];

      if (warsToProcess.length === 0) return interaction.editReply('✅ No active wars found.');

      await interaction.editReply(`⏳ Found **${defWars.length}** defensive + **${offWars.length}** offensive wars. Creating rooms...`);

      const discordMap = buildNationToDiscordMap(interaction.guildId);
      const guild      = interaction.guild;
      let created = 0, existing = 0, skipped = 0, inactive = 0, addedToExisting = 0;
      const errors = [];

      for (const war of warsToProcess) {
        try {
          const isOff      = String(war.att_alliance_id) === allianceIdStr;
          const ourNation  = isOff ? war.attacker : war.defender;
          const enemyNation = isOff ? war.defender : war.attacker;

          if (!ourNation || !enemyNation) { skipped++; continue; }
          if (!MEMBER_POSITIONS.includes((ourNation.alliance_position || '').toUpperCase())) { skipped++; continue; }

          const existingRoom = queryOne('SELECT id FROM war_rooms WHERE guild_id=? AND enemy_nation_id=? AND status=?', [interaction.guildId, enemyNation.id, 'active']);
          // Only skip if THIS SPECIFIC war is already tracked in that room —
          // not just because a room exists for the enemy. A room existing
          // only means at least one of our members is already fighting this
          // enemy; a second/third member with a DIFFERENT war_id against the
          // same enemy still needs to be added via getOrCreateWarRoom below
          // (which correctly routes to addMemberToWarRoom for an existing room).
          const alreadyTrackedThisWar = existingRoom && queryOne('SELECT id FROM war_room_members WHERE war_room_id=? AND war_id=?', [existingRoom.id, war.id]);
          if (alreadyTrackedThisWar) { existing++; continue; }

          if (isInactiveNation(enemyNation.last_active)) { inactive++; continue; }

          const counterResult = await isLegitimateCounter(interaction.guildId, allianceId, enemyNation.id, enemyNation.alliance?.id);

          if (isOff && !counterResult.isCounter) {
            const dnrEntry = queryOne('SELECT id FROM dnr_list WHERE guild_id=? AND alliance_id=?', [interaction.guildId, parseInt(enemyNation.alliance?.id || 0)]);
            if (dnrEntry) { skipped++; continue; }
          }

          const ourDiscordId = discordMap.get(ourNation.id) || discordMap.get(String(ourNation.id));

          // Mark as seen to prevent double-alerts
          run(`INSERT OR IGNORE INTO alert_settings (guild_id,alert_type,setting_key,setting_value) VALUES(?,'war_seen',?,datetime('now'))`,
            [interaction.guildId, `war_${interaction.guildId}_${war.id}_${isOff ? 'off' : 'def'}`]);

          const enrichedWar = {
            id:              war.id,
            isOurAttack:     isOff,
            ourNationId:     ourNation.id,
            turnsleft:       war.turnsleft,
            ourResistance:   isOff ? war.att_resistance : war.def_resistance,
            ourMAP:          null,
            enemyResistance: isOff ? war.def_resistance : war.att_resistance,
            enemyMAP:        null,
          };

          const result = await getOrCreateWarRoom(interaction.client, guild, interaction.guildId, enemyNation, ourDiscordId, ourNation.nation_name, enrichedWar, counterResult.isCounter, counterResult.detail);
          if (result && existingRoom) addedToExisting++;
          else if (result) created++;
          else skipped++;

          await new Promise(r => setTimeout(r, 1500));
        } catch (err) {
          errors.push(`War ${war.id}: ${err.message}`);
          skipped++;
        }
      }

      const embed = new EmbedBuilder()
        .setTitle('✅ War Room Sync Complete')
        .setColor((created + addedToExisting) > 0 ? 0x2ecc71 : 0x95a5a6)
        .addFields(
          { name: '🆕 New Rooms',        value: `${created}`,  inline: true },
          { name: '➕ Added as Member',  value: `${addedToExisting}`, inline: true },
          { name: '✅ Already Tracked',  value: `${existing}`, inline: true },
          { name: '💤 Skipped (inactive 5d+)', value: `${inactive}`, inline: true },
          { name: '⏭️ Skipped (other)',   value: `${skipped}`,  inline: true },
          { name: '📊 Wars Scanned',     value: `${defWars.length} def + ${offWars.length} off = **${warsToProcess.length}**`, inline: false },
        ).setTimestamp();
      if (errors.length > 0) embed.addFields({ name: '⚠️ Errors', value: errors.slice(0, 5).join('\n').slice(0, 1020) });

      return interaction.editReply({ content: '', embeds: [embed] });
    }
  },
};
