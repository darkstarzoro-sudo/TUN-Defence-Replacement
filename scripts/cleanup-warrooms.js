// ============================================================
// scripts/cleanup-warrooms.js
// ONE-OFF: deletes every channel in the configured war-room
// category and wipes the war_rooms / war_room_members tables so
// you can start fresh with the fixed logic (/warroom sync only).
//
// Run once from the project root:  node scripts/cleanup-warrooms.js
// ============================================================

require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { connectDatabase, query, run, queryOne } = require('../src/utils/database');

async function main() {
  await connectDatabase();

  const catRow = queryOne(
    `SELECT setting_value FROM alert_settings WHERE guild_id=? AND alert_type='warroom' AND setting_key='category_id'`,
    [process.env.DISCORD_GUILD_ID]
  );
  if (!catRow) {
    console.log('No war room category configured for this guild — nothing to clean up.');
    process.exit(0);
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(process.env.DISCORD_TOKEN);

  await new Promise(resolve => client.once('clientReady', resolve));

  const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);
  await guild.channels.fetch(); // populate cache

  const category = guild.channels.cache.get(catRow.setting_value);
  if (!category) {
    console.log('Configured category not found in this guild.');
    await client.destroy();
    process.exit(0);
  }

  const children = guild.channels.cache.filter(c => c.parentId === category.id);
  console.log(`Found ${children.size} channels in "${category.name}". Deleting...`);

  let deleted = 0;
  for (const [, channel] of children) {
    try {
      await channel.delete('War room cleanup — mass-creation bug');
      deleted++;
      console.log(`  Deleted: ${channel.name}`);
      await new Promise(r => setTimeout(r, 500)); // avoid rate limits
    } catch (err) {
      console.log(`  Failed to delete ${channel.name}: ${err.message}`);
    }
  }

  const roomCount = query('SELECT COUNT(*) as c FROM war_rooms', []).rows[0]?.c || 0;
  run('DELETE FROM war_room_members', []);
  run('DELETE FROM war_rooms', []);
  run(`DELETE FROM alert_settings WHERE alert_type IN ('war_seen','war_attack_last')`, []);

  console.log(`\nDone. Deleted ${deleted} channels, cleared ${roomCount} war_rooms row(s), and reset war_seen / war_attack_last tracking.`);
  console.log('You can now run /warroom sync in Discord to recreate rooms for wars you actually want tracked.');

  await client.destroy();
  process.exit(0);
}

main().catch(err => {
  console.error('Cleanup failed:', err);
  process.exit(1);
});
