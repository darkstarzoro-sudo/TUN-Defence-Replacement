// ============================================================
// src/jobs/backupJob.js
// Sends an automatic backup to a configured Discord channel
// every 6 hours so you always have a recent copy
// ============================================================

const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { query, queryOne } = require('../utils/database');
const logger = require('../utils/logger');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

async function runAutoBackup(client) {
  const guilds = query('SELECT guild_id FROM guilds WHERE alliance_id IS NOT NULL', []).rows;
  for (const guild of guilds) {
    await backupGuild(client, guild.guild_id);
  }
}

async function backupGuild(client, guildId) {
  try {
    // Check if a backup channel is configured
    const channelRow = queryOne(
      `SELECT setting_value FROM alert_settings WHERE guild_id = ? AND alert_type = 'backup' AND setting_key = 'channel_id'`,
      [guildId]
    );
    if (!channelRow) return; // No backup channel set — skip silently

    const channel = client.channels.cache.get(channelRow.setting_value);
    if (!channel) return;

    // Build the backup using the same logic as /backup export
    const { buildBackup } = require('../commands/admin/backup');
    const backup = buildBackup(guildId);
    const json   = JSON.stringify(backup, null, 2);

    const tmpFile = path.join(os.tmpdir(), `pw-bot-autobackup-${guildId}-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, json, 'utf8');

    const attachment = new AttachmentBuilder(tmpFile, {
      name: `pw-bot-backup-${new Date().toISOString().slice(0, 10)}.json`,
    });

    const dnrCount      = backup.dnrList?.length || 0;
    const treatyCount   = backup.treaties?.length || 0;
    const watchCount    = (backup.allianceWatchlist?.length || 0) + (backup.nationWatchlist?.length || 0);
    const linkCount     = backup.nationLinks?.length || 0;

    const embed = new EmbedBuilder()
      .setTitle('💾 Automatic Configuration Backup')
      .setColor(0x3498db)
      .setDescription('This is an automatic backup of your bot configuration. Save the attached file.')
      .addFields(
        { name: '🚫 DNR Entries', value: `${dnrCount}`, inline: true },
        { name: '🤝 Treaties',    value: `${treatyCount}`, inline: true },
        { name: '👁️ Watchlist',  value: `${watchCount}`, inline: true },
        { name: '🔗 Nation Links', value: `${linkCount}`, inline: true },
        { name: '📅 Time',        value: new Date().toUTCString(), inline: false },
        { name: '🔄 Restore',     value: 'Use `/backup import` and attach this file to restore.', inline: false },
      )
      .setFooter({ text: 'PW Defense Bot • Auto Backup' })
      .setTimestamp();

    await channel.send({ embeds: [embed], files: [attachment] });
    logger.info(`Auto backup sent for guild ${guildId}`);

    setTimeout(() => { try { fs.unlinkSync(tmpFile); } catch {} }, 15000);

  } catch (err) {
    logger.error(`Auto backup error for guild ${guildId}: ${err.message}`);
  }
}

module.exports = { runAutoBackup };
