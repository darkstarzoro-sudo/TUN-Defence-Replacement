// ============================================================
// src/commands/admin/backup.js
// Fixed: coalition table name, graceful handling of missing tables
// ============================================================

const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { query, run, queryOne } = require('../../utils/database');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const os    = require('os');

function safeQuery(sql, params) {
  try {
    return query(sql, params).rows;
  } catch (err) {
    return []; // table doesn't exist yet — return empty
  }
}

function buildBackup(guildId) {
  return {
    _meta: {
      type:       'pw-bot-backup',
      version:    '1.0',
      guildId,
      exportedAt: new Date().toUTCString(),
    },
    guild:               queryOne('SELECT * FROM guilds WHERE guild_id = ?', [guildId]),
    channels:            safeQuery('SELECT * FROM guild_channels WHERE guild_id = ?', [guildId]),
    roles:               safeQuery('SELECT * FROM guild_roles WHERE guild_id = ?', [guildId]),
    dnrList:             safeQuery('SELECT * FROM dnr_list WHERE guild_id = ?', [guildId]),
    treaties:            safeQuery('SELECT * FROM treaties WHERE guild_id = ?', [guildId]),
    allianceWatchlist:   safeQuery('SELECT * FROM alliance_watchlist WHERE guild_id = ?', [guildId]),
    nationWatchlist:     safeQuery('SELECT * FROM nation_watchlist WHERE guild_id = ?', [guildId]),
    // coalition may be stored in alliance_watchlist with watchlist_type='friendly'
    // or in a separate coalition table — we try both
    coalition:           safeQuery('SELECT * FROM coalition WHERE guild_id = ?', [guildId]),
    coalitionFromWatch:  safeQuery(`SELECT * FROM alliance_watchlist WHERE guild_id = ? AND watchlist_type IN ('friendly','coalition')`, [guildId]),
    nationLinks:         safeQuery('SELECT * FROM nation_links WHERE guild_id = ?', [guildId]),
    alertSettings:       safeQuery('SELECT * FROM alert_settings WHERE guild_id = ?', [guildId]),
    readinessWeights:    safeQuery(`SELECT * FROM alert_settings WHERE guild_id = ? AND alert_type = 'readiness_weights'`, [guildId]),
    complianceStandards: safeQuery(`SELECT * FROM alert_settings WHERE guild_id = ? AND alert_type = 'compliance'`, [guildId]),
  };
}

function buildSummaryText(backup) {
  const lines = [];
  if (backup.guild?.alliance_id)            lines.push(`⚙️ Alliance ID: **${backup.guild.alliance_id}**`);
  if (backup.channels?.length)               lines.push(`📺 **${backup.channels.length}** channel mapping(s)`);
  if (backup.roles?.length)                  lines.push(`🎭 **${backup.roles.length}** role mapping(s)`);
  if (backup.dnrList?.length)                lines.push(`🚫 **${backup.dnrList.length}** DNR entry/entries`);
  if (backup.treaties?.length)               lines.push(`🤝 **${backup.treaties.length}** treaty/treaties`);
  if (backup.allianceWatchlist?.length)      lines.push(`👁️ **${backup.allianceWatchlist.length}** watched alliance(s)`);
  if (backup.nationWatchlist?.length)        lines.push(`👁️ **${backup.nationWatchlist.length}** watched nation(s)`);
  if (backup.nationLinks?.length)            lines.push(`🔗 **${backup.nationLinks.length}** nation link(s)`);
  if (backup.complianceStandards?.length)    lines.push(`📊 Compliance standards`);
  if (backup.readinessWeights?.length)       lines.push(`⚖️ Readiness weights`);
  return lines.length > 0 ? lines.join('\n') : 'No configuration found';
}

function restoreBackup(guildId, backup) {
  const results = [];

  if (backup.guild) {
    run(`INSERT INTO guilds (guild_id, alliance_id, alliance_name) VALUES (?, ?, ?)
         ON CONFLICT(guild_id) DO UPDATE SET alliance_id=excluded.alliance_id, alliance_name=excluded.alliance_name`,
      [guildId, backup.guild.alliance_id, backup.guild.alliance_name]);
    results.push(`Guild settings (Alliance ID: ${backup.guild.alliance_id})`);
  }

  if (backup.channels?.length > 0) {
    for (const ch of backup.channels) {
      run(`INSERT INTO guild_channels (guild_id, channel_type, discord_channel_id) VALUES (?, ?, ?)
           ON CONFLICT(guild_id, channel_type) DO UPDATE SET discord_channel_id=excluded.discord_channel_id`,
        [guildId, ch.channel_type, ch.discord_channel_id]);
    }
    results.push(`${backup.channels.length} channel mapping(s)`);
  }

  if (backup.roles?.length > 0) {
    for (const r of backup.roles) {
      run(`INSERT INTO guild_roles (guild_id, role_type, discord_role_id) VALUES (?, ?, ?)
           ON CONFLICT(guild_id, role_type) DO UPDATE SET discord_role_id=excluded.discord_role_id`,
        [guildId, r.role_type, r.discord_role_id]);
    }
    results.push(`${backup.roles.length} role mapping(s)`);
  }

  if (backup.dnrList?.length > 0) {
    for (const d of backup.dnrList) {
      run(`INSERT INTO dnr_list (guild_id, alliance_id, alliance_name, reason, added_by) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(guild_id, alliance_id) DO UPDATE SET alliance_name=excluded.alliance_name, reason=excluded.reason`,
        [guildId, d.alliance_id, d.alliance_name, d.reason, d.added_by]);
    }
    results.push(`${backup.dnrList.length} DNR entry/entries`);
  }

  if (backup.treaties?.length > 0) {
    for (const t of backup.treaties) {
      run(`INSERT INTO treaties (guild_id, alliance_id, alliance_name, treaty_type, notes, added_by) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(guild_id, alliance_id, treaty_type) DO UPDATE SET alliance_name=excluded.alliance_name, notes=excluded.notes`,
        [guildId, t.alliance_id, t.alliance_name, t.treaty_type, t.notes, t.added_by]);
    }
    results.push(`${backup.treaties.length} treaty/treaties`);
  }

  if (backup.allianceWatchlist?.length > 0) {
    for (const a of backup.allianceWatchlist) {
      run(`INSERT OR IGNORE INTO alliance_watchlist (guild_id, alliance_id, alliance_name, watchlist_type) VALUES (?, ?, ?, ?)`,
        [guildId, a.alliance_id, a.alliance_name, a.watchlist_type]);
    }
    results.push(`${backup.allianceWatchlist.length} watched alliance(s)`);
  }

  if (backup.nationWatchlist?.length > 0) {
    for (const n of backup.nationWatchlist) {
      run(`INSERT OR IGNORE INTO nation_watchlist (guild_id, nation_id, nation_name) VALUES (?, ?, ?)`,
        [guildId, n.nation_id, n.nation_name]);
    }
    results.push(`${backup.nationWatchlist.length} watched nation(s)`);
  }

  if (backup.nationLinks?.length > 0) {
    for (const l of backup.nationLinks) {
      run(`INSERT INTO nation_links (guild_id, discord_user_id, nation_id, nation_name, alliance_id, alliance_name)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(guild_id, discord_user_id) DO UPDATE SET
             nation_id=excluded.nation_id, nation_name=excluded.nation_name,
             alliance_id=excluded.alliance_id, alliance_name=excluded.alliance_name`,
        [guildId, l.discord_user_id, l.nation_id, l.nation_name, l.alliance_id, l.alliance_name]);
    }
    results.push(`${backup.nationLinks.length} nation link(s)`);
  }

  if (backup.alertSettings?.length > 0) {
    const configTypes = ['beige', 'dnr', 'warroom', 'readiness_weights', 'compliance'];
    const cfg = backup.alertSettings.filter(s => configTypes.includes(s.alert_type));
    for (const s of cfg) {
      run(`INSERT INTO alert_settings (guild_id, alert_type, setting_key, setting_value) VALUES (?, ?, ?, ?)
           ON CONFLICT(guild_id, alert_type, setting_key) DO UPDATE SET setting_value=excluded.setting_value`,
        [guildId, s.alert_type, s.setting_key, s.setting_value]);
    }
    if (cfg.length > 0) results.push(`${cfg.length} alert/config setting(s)`);
  }

  return results;
}

function downloadUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('backup')
    .setDescription('Export or import all bot configuration data')
    .addSubcommand(sub => sub.setName('export').setDescription('Export all bot configuration to a JSON file'))
    .addSubcommand(sub =>
      sub.setName('import')
        .setDescription('Restore configuration from a backup file')
        .addAttachmentOption(opt => opt.setName('file').setDescription('The .json backup file').setRequired(true))
    )
    .addSubcommand(sub => sub.setName('status').setDescription('Show a summary of current configuration')),

  requiredRole: 'admin',

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'export') {
      await interaction.deferReply({ flags: 64 });

      const backup  = buildBackup(interaction.guildId);
      const json    = JSON.stringify(backup, null, 2);
      const tmpFile = path.join(os.tmpdir(), `pw-bot-backup-${Date.now()}.json`);
      fs.writeFileSync(tmpFile, json, 'utf8');

      const embed = new EmbedBuilder()
        .setTitle('✅ Configuration Backup Created')
        .setColor(0x2ecc71)
        .setDescription('Your full bot configuration is attached.\n\n**Store this file safely.** Use `/backup import` to restore.')
        .addFields(
          { name: '📋 Contents', value: buildSummaryText(backup) },
          { name: '⏰ Created',  value: new Date().toUTCString() },
        )
        .setFooter({ text: 'Use /backup import to restore' })
        .setTimestamp();

      await interaction.editReply({
        embeds: [embed],
        files:  [new AttachmentBuilder(tmpFile, { name: `pw-bot-backup-${new Date().toISOString().slice(0,10)}.json` })],
      });
      setTimeout(() => { try { fs.unlinkSync(tmpFile); } catch {} }, 15000);
    }

    if (sub === 'import') {
      await interaction.deferReply({ flags: 64 });
      const attachment = interaction.options.getAttachment('file');
      if (!attachment.name.endsWith('.json')) return interaction.editReply('❌ Please attach a `.json` file from `/backup export`.');

      let backup;
      try {
        const text = await downloadUrl(attachment.url);
        backup = JSON.parse(text);
      } catch (err) {
        return interaction.editReply(`❌ Could not read backup file: ${err.message}`);
      }

      if (!backup._meta || backup._meta.type !== 'pw-bot-backup') {
        return interaction.editReply('❌ This file doesn\'t look like a valid PW Bot backup.');
      }

      const results = restoreBackup(interaction.guildId, backup);

      return interaction.editReply({
        embeds: [new EmbedBuilder()
          .setTitle('✅ Configuration Restored')
          .setColor(0x2ecc71)
          .setDescription(`Backup from **${backup._meta.exportedAt}** restored.`)
          .addFields(
            { name: '📋 Restored', value: results.map(r => `✅ ${r}`).join('\n') || 'Nothing to restore' },
            { name: '⚠️ Note', value: 'Settings are live immediately. No restart needed.' },
          )
          .setTimestamp()],
      });
    }

    if (sub === 'status') {
      const backup = buildBackup(interaction.guildId);
      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setTitle('📋 Current Bot Configuration')
          .setColor(0x3498db)
          .addFields(
            { name: '⚙️ Core', value: `Alliance ID: **${backup.guild?.alliance_id || 'Not set'}** | Channels: **${backup.channels?.length || 0}** | Roles: **${backup.roles?.length || 0}**` },
            { name: '🚫 DNR List', value: backup.dnrList?.length > 0 ? backup.dnrList.map(d => `• **${d.alliance_name}** — ${d.reason||'No reason'}`).join('\n').slice(0,1020) : '_(empty)_' },
            { name: '🤝 Treaties', value: backup.treaties?.length > 0 ? backup.treaties.map(t => `• **${t.alliance_name}** — ${t.treaty_type}`).join('\n').slice(0,1020) : '_(empty)_' },
            { name: '👁️ Watchlists', value: `Enemy alliances: **${backup.allianceWatchlist?.filter(w=>w.watchlist_type==='enemy').length||0}** | Nations: **${backup.nationWatchlist?.length||0}**` },
            { name: '🔗 Nation Links', value: `**${backup.nationLinks?.length||0}** members linked`, inline: true },
          )
          .setFooter({ text: 'Use /backup export to save to a file' })
          .setTimestamp()],
        flags: 64,
      });
    }
  },
};

module.exports.buildBackup = buildBackup;
