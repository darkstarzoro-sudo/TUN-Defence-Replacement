// ============================================================
// src/utils/nationLink.js
// Helper functions for Discord <-> P&W nation linking
// ============================================================

const { query, queryOne } = require('./database');

// Get a member's linked nation by Discord user ID
function getLinkedNation(guildId, discordUserId) {
  return queryOne(
    'SELECT * FROM nation_links WHERE guild_id = ? AND discord_user_id = ?',
    [guildId, discordUserId]
  );
}

// Get a Discord user ID by P&W nation ID
function getLinkedDiscordUser(guildId, nationId) {
  return queryOne(
    'SELECT * FROM nation_links WHERE guild_id = ? AND nation_id = ?',
    [guildId, nationId]
  );
}

// Get all links for a guild
function getAllLinks(guildId) {
  return query(
    'SELECT * FROM nation_links WHERE guild_id = ?',
    [guildId]
  ).rows;
}

// Build a map of nationId -> discordUserId for fast lookup
function buildNationToDiscordMap(guildId) {
  const links = getAllLinks(guildId);
  const map = new Map();
  for (const link of links) {
    map.set(link.nation_id, link.discord_user_id);
    map.set(String(link.nation_id), link.discord_user_id);
  }
  return map;
}

// Build a map of discordUserId -> nationId for fast lookup
function buildDiscordToNationMap(guildId) {
  const links = getAllLinks(guildId);
  const map = new Map();
  for (const link of links) {
    map.set(link.discord_user_id, link.nation_id);
  }
  return map;
}

// Format a nation with Discord mention if linked, plain name if not
function formatNationWithMention(nationId, nationName, guildId) {
  const link = getLinkedDiscordUser(guildId, nationId);
  if (link) {
    return `<@${link.discord_user_id}> ([${nationName}](https://politicsandwar.com/nation/id=${nationId}))`;
  }
  return `[${nationName}](https://politicsandwar.com/nation/id=${nationId})`;
}

module.exports = {
  getLinkedNation,
  getLinkedDiscordUser,
  getAllLinks,
  buildNationToDiscordMap,
  buildDiscordToNationMap,
  formatNationWithMention,
};
