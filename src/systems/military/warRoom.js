// ============================================================
// src/systems/military/warRoom.js
// Creates dedicated Discord channels for military operations
// ============================================================

const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { run, queryOne } = require('../../utils/database');
const logger = require('../../utils/logger');

// ============================================================
// CREATE A FULL WAR ROOM — category + 4 channels
// ============================================================
async function createWarRoom(guild, operationName, operationId, creatorId) {
  try {
    // Get configured roles for permission setup
    const militaryRole = queryOne(
      `SELECT discord_role_id FROM guild_roles WHERE guild_id = ? AND role_type = 'military'`,
      [guild.id]
    );
    const govRole = queryOne(
      `SELECT discord_role_id FROM guild_roles WHERE guild_id = ? AND role_type = 'government'`,
      [guild.id]
    );

    // Build permission overwrites — hide from @everyone, show to military+
    const overwrites = [
      {
        id: guild.roles.everyone.id,
        deny: [PermissionFlagsBits.ViewChannel],
      },
    ];

    if (militaryRole) {
      overwrites.push({
        id: militaryRole.discord_role_id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
      });
    }
    if (govRole) {
      overwrites.push({
        id: govRole.discord_role_id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
      });
    }

    // Create the category
    const safeName = operationName.replace(/[^a-zA-Z0-9 \-]/g, '').slice(0, 80);
    const category = await guild.channels.create({
      name: `⚔️ ${safeName}`,
      type: ChannelType.GuildCategory,
      permissionOverwrites: overwrites,
    });

    // Create the 4 standard channels inside it
    const mainChannel = await guild.channels.create({
      name: 'main',
      type: ChannelType.GuildText,
      parent: category.id,
      topic: `Main coordination channel for ${operationName}`,
    });

    const assignChannel = await guild.channels.create({
      name: 'assignments',
      type: ChannelType.GuildText,
      parent: category.id,
      topic: `Target assignments for ${operationName}`,
    });

    const intelChannel = await guild.channels.create({
      name: 'intel',
      type: ChannelType.GuildText,
      parent: category.id,
      topic: `Intelligence updates for ${operationName}`,
    });

    const resultsChannel = await guild.channels.create({
      name: 'results',
      type: ChannelType.GuildText,
      parent: category.id,
      topic: `Battle results for ${operationName}`,
    });

    // Save channel IDs linked to the operation
    run(
      `UPDATE operations SET
         war_room_category_id = ?,
         war_room_main_id = ?,
         war_room_assign_id = ?,
         war_room_intel_id = ?,
         war_room_results_id = ?
       WHERE id = ?`,
      [category.id, mainChannel.id, assignChannel.id, intelChannel.id, resultsChannel.id, operationId]
    );

    logger.info(`War room created for operation #${operationId}: ${operationName}`);

    return {
      category,
      mainChannel,
      assignChannel,
      intelChannel,
      resultsChannel,
    };

  } catch (err) {
    logger.error(`Failed to create war room: ${err.message}`);
    throw err;
  }
}

// ============================================================
// ARCHIVE A WAR ROOM — locks channels, optionally deletes after delay
// ============================================================
async function archiveWarRoom(guild, operationId) {
  try {
    const op = queryOne('SELECT * FROM operations WHERE id = ?', [operationId]);
    if (!op || !op.war_room_category_id) return false;

    const channelIds = [
      op.war_room_main_id,
      op.war_room_assign_id,
      op.war_room_intel_id,
      op.war_room_results_id,
    ].filter(Boolean);

    // Lock all channels (deny send messages for everyone)
    for (const channelId of channelIds) {
      const channel = guild.channels.cache.get(channelId);
      if (channel) {
        await channel.permissionOverwrites.edit(guild.roles.everyone, {
          SendMessages: false,
        }).catch(() => {});
      }
    }

    // Rename category to show it's archived
    const category = guild.channels.cache.get(op.war_room_category_id);
    if (category) {
      await category.setName(`📁 ${category.name} (archived)`).catch(() => {});
    }

    logger.info(`War room archived for operation #${operationId}`);
    return true;

  } catch (err) {
    logger.error(`Failed to archive war room: ${err.message}`);
    return false;
  }
}

// ============================================================
// DELETE A WAR ROOM — permanently removes all channels
// ============================================================
async function deleteWarRoom(guild, operationId) {
  try {
    const op = queryOne('SELECT * FROM operations WHERE id = ?', [operationId]);
    if (!op || !op.war_room_category_id) return false;

    const channelIds = [
      op.war_room_main_id,
      op.war_room_assign_id,
      op.war_room_intel_id,
      op.war_room_results_id,
      op.war_room_category_id, // delete category last
    ].filter(Boolean);

    for (const channelId of channelIds) {
      const channel = guild.channels.cache.get(channelId);
      if (channel) await channel.delete().catch(() => {});
    }

    run(
      `UPDATE operations SET
         war_room_category_id = NULL,
         war_room_main_id = NULL,
         war_room_assign_id = NULL,
         war_room_intel_id = NULL,
         war_room_results_id = NULL
       WHERE id = ?`,
      [operationId]
    );

    logger.info(`War room deleted for operation #${operationId}`);
    return true;

  } catch (err) {
    logger.error(`Failed to delete war room: ${err.message}`);
    return false;
  }
}

module.exports = { createWarRoom, archiveWarRoom, deleteWarRoom };
