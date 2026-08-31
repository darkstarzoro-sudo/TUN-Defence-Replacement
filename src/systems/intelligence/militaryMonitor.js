// ============================================================
// src/systems/intelligence/militaryMonitor.js
// Detects significant military changes in watched enemy nations
// ============================================================

const { EmbedBuilder } = require('discord.js');
const { query, run, queryOne } = require('../../utils/database');
const { pwQuery, MEMBER_POSITIONS } = require('../../utils/pwApi');
const logger = require('../../utils/logger');

const THRESHOLDS = {
  soldiers: 10000,
  tanks:    500,
  aircraft: 50,
  ships:    10,
  missiles: 1,
  nukes:    1,
};

async function snapshotEnemyMilitary(guildId) {
  const enemyAlliances = query(
    `SELECT alliance_id FROM alliance_watchlist WHERE guild_id = ? AND watchlist_type = 'enemy'`,
    [guildId]
  ).rows;

  if (enemyAlliances.length === 0) return;

  const allianceIds = enemyAlliances.map(a => a.alliance_id);

  // Query nations directly — nested nations inside alliances does NOT return missiles/nukes
  const data = await pwQuery(`
    query GetEnemyMilitary($allianceIds: [Int]) {
      nations(alliance_id: $allianceIds, first: 500) {
        data {
          id
          nation_name
          num_cities
          alliance_id
          alliance_position
          alliance { name }
          soldiers
          tanks
          aircraft
          ships
          missiles
          nukes
          score
        }
      }
    }
  `, { allianceIds });

  const allNations = data?.nations?.data || [];
  const members = allNations.filter(n =>
    MEMBER_POSITIONS.includes((n.alliance_position || '').toUpperCase())
  );

  for (const nation of members) {
    run(
      `INSERT INTO military_snapshots
       (nation_id, soldiers, tanks, aircraft, ships, missiles, nukes, score)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [nation.id, nation.soldiers || 0, nation.tanks || 0, nation.aircraft || 0,
       nation.ships || 0, nation.missiles || 0, nation.nukes || 0, nation.score || 0]
    );
    // Store nation name/alliance separately for display in alerts
    run(
      `INSERT OR REPLACE INTO nation_cache (nation_id, nation_name, alliance_name, num_cities, score, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
      [nation.id, nation.nation_name || '', nation.alliance?.name || '', nation.num_cities || 0, nation.score || 0]
    );
  }

  // Clean up snapshots older than 7 days
  run(`DELETE FROM military_snapshots WHERE recorded_at < datetime('now', '-7 days')`);
}

async function checkMilitaryChanges(client) {
  const guilds = query(
    'SELECT guild_id FROM guilds WHERE alliance_id IS NOT NULL', []
  ).rows;

  for (const guild of guilds) {
    await processGuildMilitaryChanges(client, guild.guild_id);
  }
}

async function processGuildMilitaryChanges(client, guildId) {
  try {
    const channelRow = queryOne(
      `SELECT discord_channel_id FROM guild_channels WHERE guild_id = ? AND channel_type = 'intel'`,
      [guildId]
    );
    if (!channelRow) return;

    const channel = client.channels.cache.get(channelRow.discord_channel_id);
    if (!channel) return;

    const nations = query(
      `SELECT DISTINCT nation_id FROM military_snapshots`, []
    ).rows;

    for (const { nation_id } of nations) {
      const snapshots = query(
        `SELECT * FROM military_snapshots WHERE nation_id = ?
         ORDER BY recorded_at DESC LIMIT 2`,
        [nation_id]
      ).rows;

      if (snapshots.length < 2) continue;

      const latest   = snapshots[0];
      const previous = snapshots[1];
      const changes  = [];

      for (const field of ['soldiers', 'tanks', 'aircraft', 'ships', 'missiles', 'nukes']) {
        const diff = (latest[field] || 0) - (previous[field] || 0);
        if (Math.abs(diff) >= THRESHOLDS[field]) {
          const emoji = { soldiers: '👮', tanks: '🚗', aircraft: '✈️', ships: '🚢', missiles: '🚀', nukes: '☢️' };
          changes.push({ field, diff, emoji: emoji[field], from: previous[field], to: latest[field] });
        }
      }

      if (changes.length === 0) continue;

      const nationInfo = queryOne('SELECT * FROM nation_cache WHERE nation_id = ?', [nation_id]);
      const changeLines = changes.map(c =>
        `${c.emoji} **${c.field}**: ${c.from.toLocaleString()} → ${c.to.toLocaleString()} (${c.diff > 0 ? '+' : ''}${c.diff.toLocaleString()})`
      );

      const isRebuy  = changes.every(c => c.diff > 0);
      const isLoss   = changes.every(c => c.diff < 0);
      const color    = isRebuy ? 0xe74c3c : isLoss ? 0x2ecc71 : 0xf39c12;
      const titleTag = isRebuy ? '📈 Military Buildup Detected' : isLoss ? '📉 Military Loss Detected' : '🔄 Military Change Detected';

      const embed = new EmbedBuilder()
        .setTitle(titleTag)
        .setColor(color)
        .setDescription(
          `**[${nationInfo?.nation_name || `Nation ${nation_id}`}](https://politicsandwar.com/nation/id=${nation_id})** — ${nationInfo?.alliance_name || 'Unknown Alliance'} | Cities: ${nationInfo?.num_cities || '?'} | Score: ${Number(nationInfo?.score || 0).toLocaleString()}\n\n` +
          changeLines.join('\n')
        )
        .setFooter({ text: 'PW Defense Bot • Military Intelligence' })
        .setTimestamp();

      await channel.send({ embeds: [embed] });
      logger.info(`Military change alert sent for nation ${nation_id} in guild ${guildId}`);
    }

    // Take a fresh snapshot after checking
    await snapshotEnemyMilitary(guildId);

  } catch (err) {
    logger.error(`Military monitor error for guild ${guildId}: ${err.message}`);
  }
}

module.exports = { checkMilitaryChanges, snapshotEnemyMilitary };
