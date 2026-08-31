// ============================================================
// src/utils/permissions.js
// ============================================================

const { query } = require('./database');
const logger = require('./logger');

const ROLE_LEVELS = {
  member: 1,
  military: 2,
  government: 3,
  admin: 4,
};

function checkPermission(interaction, requiredRole) {
  if (interaction.member.permissions.has('Administrator')) return true;

  try {
    const result = query(
      'SELECT role_type, discord_role_id FROM guild_roles WHERE guild_id = ?',
      [interaction.guildId]
    );

    const memberRoleIds = interaction.member.roles.cache.map(r => r.id);
    let userLevel = 0;

    for (const configuredRole of result.rows) {
      if (memberRoleIds.includes(configuredRole.discord_role_id)) {
        const level = ROLE_LEVELS[configuredRole.role_type] || 0;
        if (level > userLevel) userLevel = level;
      }
    }

    return userLevel >= (ROLE_LEVELS[requiredRole] || 0);
  } catch (error) {
    logger.error('Permission check failed:', error);
    return false;
  }
}

module.exports = { checkPermission, ROLE_LEVELS };
