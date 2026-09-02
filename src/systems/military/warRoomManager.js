// ============================================================
// src/systems/military/warRoomManager.js
// Fixed: removed att_map/def_map (not in P&W API)
// MAP shown as N/A — fetch from war page directly
// ============================================================

const { ChannelType, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { query, run, queryOne } = require('../../utils/database');
const { pwQuery } = require('../../utils/pwApi');
const { getGif, normalizeAttackType } = require('../../utils/attackGifs');
const logger = require('../../utils/logger');

// Enemy nations inactive this many days are treated as raids/abandoned
// accounts — we don't want war rooms for those.
const INACTIVITY_DAYS = 5;

// P&W DateTime fields come back as "Y-m-d H:i:s" in UTC with no timezone
// suffix — append Z so JS parses it as UTC instead of local time.
function daysSinceActive(lastActiveStr) {
  if (!lastActiveStr) return null;
  const iso = lastActiveStr.includes('T') ? lastActiveStr : lastActiveStr.replace(' ', 'T') + 'Z';
  const then = new Date(iso);
  if (isNaN(then.getTime())) return null;
  return (Date.now() - then.getTime()) / 86400000;
}

function isInactiveNation(lastActiveStr, days = INACTIVITY_DAYS) {
  const d = daysSinceActive(lastActiveStr);
  return d !== null && d >= days;
}

async function closeWarRoomForInactivity(client, guild, room, daysInactive) {
  try {
    const channel = guild?.channels.cache.get(room.channel_id);
    if (channel) {
      await channel.send({ content: `🚫 Closing this war room — **${room.enemy_nation_name}** has been inactive for ${Math.floor(daysInactive)}+ days (raid target, not an active fight). Deleting in 10 seconds.` }).catch(()=>{});
      setTimeout(async () => { await channel.delete().catch(()=>{}); }, 10000);
    }
    run('DELETE FROM war_room_members WHERE war_room_id=?', [room.id]);
    run('UPDATE war_rooms SET status=? WHERE id=?', ['closed', room.id]);
    logger.info(`War room closed for inactivity: ${room.enemy_nation_name} (${Math.floor(daysInactive)}d inactive)`);
  } catch (err) { logger.error(`closeWarRoomForInactivity: ${err.message}`); }
}

// ── UNIFIED WAR CARD ──────────────────────────────────────────
// One card per ROOM (not per member) listing every one of our members
// currently fighting this enemy, followed by the enemy's overview.
// Rebuilt from scratch (fresh data for everyone) on every refresh — so any
// member clicking Refresh updates the whole room's picture, not just theirs.
//
// Discord hard limits respected here: 25 fields/embed, ~6000 chars/embed,
// 10 embeds/message. If a room somehow has more members than fits even
// after paginating into 10 embeds, remaining members are dropped from the
// card with a visible warning message instead of crashing or truncating
// silently — see the `overflowed` handling in sendUnifiedWarCard.
const EMBED_FIELD_LIMIT = 24; // leave 1 slot of buffer per page
const EMBED_CHAR_BUDGET = 5500; // buffer under Discord's hard 6000 cap
const MAX_EMBEDS_PER_MESSAGE = 10;

async function buildUnifiedWarCards(room) {
  const members = query('SELECT * FROM war_room_members WHERE war_room_id=?', [room.id]).rows;
  if (members.length === 0) return { embeds: [], components: [], overflowed: false, totalMembers: 0 };

  const enemyData = await fetchNationData(room.enemy_nation_id);

  const memberResults = await Promise.all(members.map(async (m) => {
    const [warData, ourData] = await Promise.all([
      fetchWarData(m.war_id, m.nation_id, room.enemy_nation_id),
      fetchNationData(m.nation_id),
    ]);
    return { member: m, warData, ourData };
  }));

  const memberFields = memberResults.map(({ member, warData, ourData }) => {
    const name = `🛡️ ${member.discord_user_id ? `<@${member.discord_user_id}> — ` : ''}${ourData?.nation_name || member.nation_name || 'Unknown'}`;
    const value = [
      `⭐ NS: **${Math.round(ourData?.score||0).toLocaleString()}** | 🏙️ Cities: **${ourData?.num_cities??'?'}**`,
      `👮 ${(ourData?.soldiers||0).toLocaleString()} | 🚗 ${(ourData?.tanks||0).toLocaleString()} | ✈️ ${ourData?.aircraft||0} | 🚢 ${ourData?.ships||0}`,
      `🚀 ${ourData?.missiles||0} | ☢️ ${ourData?.nukes||0} | 🕵️ ${ourData?.spies||0}`,
      `❤️ Resistance: **${warData?.ourResistance??'?'}/100** (enemy: **${warData?.enemyResistance??'?'}/100**) | ⏳ Turns Left: **${warData?.turnsleft??'?'}**`,
      `🎯 MAP: **${warData?.ourMAP??'?'}/12** (enemy: **${warData?.enemyMAP??'?'}/12**)`,
      `[View This War](https://politicsandwar.com/nation/war/timeline/war=${member.war_id})`,
    ].join('\n');
    return { name: name.slice(0,256), value: value.slice(0,1024), inline: false };
  });

  const enemyField = {
    name: `⚔️ Enemy — [${enemyData?.nation_name||room.enemy_nation_name||'Unknown'}](https://politicsandwar.com/nation/id=${room.enemy_nation_id}) (${enemyData?.alliance?.name||room.enemy_alliance_name||'None'})`,
    value: [
      `⭐ NS: **${Math.round(enemyData?.score||0).toLocaleString()}** | 🏙️ Cities: **${enemyData?.num_cities??'?'}**`,
      `👮 ${(enemyData?.soldiers||0).toLocaleString()} | 🚗 ${(enemyData?.tanks||0).toLocaleString()} | ✈️ ${enemyData?.aircraft||0} | 🚢 ${enemyData?.ships||0}`,
      `🚀 ${enemyData?.missiles||0} | ☢️ ${enemyData?.nukes||0} | 🕵️ ${enemyData?.spies||0}`,
      `_Resistance is per-war and shown against each member above — the enemy doesn't have one shared resistance number._`,
    ].join('\n'),
    inline: false,
  };

  // ── Paginate member fields to stay under Discord's per-embed limits ──
  const pages = [];
  let currentFields = [], currentChars = 0;
  for (const field of memberFields) {
    const fieldChars = field.name.length + field.value.length;
    if (currentFields.length >= EMBED_FIELD_LIMIT || currentChars + fieldChars > EMBED_CHAR_BUDGET) {
      pages.push(currentFields);
      currentFields = []; currentChars = 0;
    }
    currentFields.push(field);
    currentChars += fieldChars;
  }
  const enemyFieldChars = enemyField.name.length + enemyField.value.length;
  if (currentFields.length < EMBED_FIELD_LIMIT + 1 && currentChars + enemyFieldChars <= EMBED_CHAR_BUDGET) {
    currentFields.push(enemyField);
    pages.push(currentFields);
  } else {
    if (currentFields.length > 0) pages.push(currentFields);
    pages.push([enemyField]);
  }

  const overflowed = pages.length > MAX_EMBEDS_PER_MESSAGE;
  const usablePages = overflowed ? pages.slice(0, MAX_EMBEDS_PER_MESSAGE) : pages;

  const embeds = usablePages.map((fields, idx) => {
    const embed = new EmbedBuilder().setColor(0x3498db).addFields(fields).setTimestamp();
    if (idx === 0) embed.setTitle(`⚔️ War Room — ${members.length} Member${members.length===1?'':'s'} vs ${room.enemy_nation_name||'Unknown'}`);
    if (usablePages.length > 1) embed.setFooter({ text: `Page ${idx+1}/${usablePages.length}` });
    return embed;
  });

  const components = [buildWarButtons(room.id), ...buildMemberLinkButtons(members)];

  return { embeds, components, overflowed, totalMembers: members.length, shownPages: usablePages.length, totalPages: pages.length };
}

function buildMemberLinkButtons(members) {
  const rows = [];
  for (let i = 0; i < members.length && rows.length < 4; i += 5) { // max 4 extra rows (+1 action row = Discord's 5-row cap)
    const chunk = members.slice(i, i + 5);
    rows.push(new ActionRowBuilder().addComponents(
      chunk.map(m => new ButtonBuilder()
        .setLabel(`🔗 ${(m.nation_name||'War').slice(0,25)}`)
        .setStyle(ButtonStyle.Link)
        .setURL(`https://politicsandwar.com/nation/war/timeline/war=${m.war_id}`))
    ));
  }
  return rows;
}

function buildWarButtons(roomId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`war_claim_${roomId}`).setLabel('🎖️ Claim').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`war_status_${roomId}`).setLabel('🔄 Refresh').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`war_counter_${roomId}`).setLabel('⚔️ Counter').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`war_spies_${roomId}`).setLabel('🕵️ Spies').setStyle(ButtonStyle.Secondary),
  );
}

async function sendUnifiedWarCard(channel, room) {
  try {
    if (room.card_message_id) {
      const oldMsg = await channel.messages.fetch(room.card_message_id).catch(()=>null);
      if (oldMsg) await oldMsg.delete().catch(()=>{});
    }
    const { embeds, components, overflowed, totalMembers, shownPages, totalPages } = await buildUnifiedWarCards(room);
    if (embeds.length === 0) return null;
    const newMsg = await channel.send({ embeds, components });
    await newMsg.pin().catch(()=>{});
    run('UPDATE war_rooms SET card_message_id=? WHERE id=?', [newMsg.id, room.id]);
    if (overflowed) {
      await channel.send({ content: `⚠️ This war room has **${totalMembers} members** — too many to fit on one card (Discord's embed limit). Showing ${shownPages} of ${totalPages} pages; the rest aren't displayed. Consider using \`/war\` to look up individual members not shown here.` }).catch(()=>{});
    }
    return newMsg;
  } catch (err) { logger.error(`sendUnifiedWarCard: ${err.message}`); return null; }
}

async function fetchWarData(warId, ourNationId, enemyNationId) {
  // att_points/def_points are our best-evidence guess for the MAP (Military
  // Action Points) field names — inferred from the confirmed att_resistance/
  // def_resistance naming pattern and the old v2 API's equivalent field
  // names, but NOT directly confirmed against the live v3 schema. A wrong
  // field name fails the ENTIRE GraphQL query (not just that one field, as
  // we've hit twice before in this same file), so this tries the enhanced
  // query first and falls back to the known-safe query if it errors —
  // MAP will just show as unavailable rather than breaking the whole card.
  try {
    const data = await pwQuery(`
      query W($id:[Int]){wars(id:$id,first:1){data{
        id turnsleft att_resistance def_resistance att_points def_points attid defid
      }}}
    `, { id:[parseInt(warId)] });
    const war = data?.wars?.data?.[0];
    if (war) {
      const weAtt = String(war.attid)===String(ourNationId);
      return {
        ...war,
        isOurAttack:     weAtt,
        ourNationId,
        ourResistance:   weAtt ? war.att_resistance : war.def_resistance,
        ourMAP:          weAtt ? war.att_points : war.def_points,
        enemyResistance: weAtt ? war.def_resistance : war.att_resistance,
        enemyMAP:        weAtt ? war.def_points : war.att_points,
      };
    }
  } catch (err) {
    logger.warn(`fetchWarData: att_points/def_points query failed (${err.message}) — falling back to MAP-less query. This likely means those field names are wrong; MAP will show as unavailable until corrected.`);
  }

  // Fallback — known-safe query without the unverified MAP fields.
  try {
    const data = await pwQuery(`
      query W($id:[Int]){wars(id:$id,first:1){data{
        id turnsleft att_resistance def_resistance attid defid
      }}}
    `, { id:[parseInt(warId)] });
    const war = data?.wars?.data?.[0];
    if (!war) return null;
    const weAtt = String(war.attid)===String(ourNationId);
    return {
      ...war,
      isOurAttack:     weAtt,
      ourNationId,
      ourResistance:   weAtt ? war.att_resistance : war.def_resistance,
      ourMAP:          null,
      enemyResistance: weAtt ? war.def_resistance : war.att_resistance,
      enemyMAP:        null,
    };
  } catch (err) { logger.error(`fetchWarData: ${err.message}`); return null; }
}

async function fetchNationData(nationId) {
  try {
    const data = await pwQuery(`
      query N($id:[Int]){nations(id:$id,first:1){data{
        id nation_name score num_cities soldiers tanks aircraft ships missiles nukes spies alliance{name}
      }}}
    `, { id:[parseInt(nationId)] });
    return data?.nations?.data?.[0]||null;
  } catch { return null; }
}

async function fetchNewAttacks(warId, lastAttackId) {
  const attacks = await fetchAttacksBatch([warId]);
  if (!lastAttackId) return attacks;
  return attacks.filter(a => parseInt(a.id) > parseInt(lastAttackId));
}

// Fetches attacks for MULTIPLE wars in a single API call. Politics & War's
// API has a hard DAILY quota (2,000/day standard, 5,000/day VIP) — it is
// NOT a per-minute limit. Querying once per war-room-member (the old
// behavior) burns through that quota multiple times faster than necessary
// for zero benefit, since one query can cover every active war at once.
async function fetchAttacksBatch(warIds) {
  const ids = [...new Set(warIds.map(id => parseInt(id)).filter(Boolean))];
  if (ids.length === 0) return [];
  try {
    const data = await pwQuery(`
      query A($warId:[Int]){warattacks(war_id:$warId,orderBy:{column:ID,order:DESC},first:100){data{
        id war_id attid defid
        type victor success
        att_mun_used def_mun_used att_gas_used def_gas_used
        infra_destroyed infra_destroyed_value
        att_soldiers_lost def_soldiers_lost att_tanks_lost def_tanks_lost
        att_aircraft_lost def_aircraft_lost att_ships_lost def_ships_lost
        moneystolen loot_info
        date
      }}}
    `, { warId: ids });
    return data?.warattacks?.data || [];
  } catch (err) { logger.error(`fetchAttacksBatch: ${err.message}`); return []; }
}

// WarAttack.success is returned as an Int by the P&W API (confirmed by a live
// "successOutcome.includes is not a function" crash), NOT a string enum like
// "IMMENSE_TRIUMPH". It represents how many of the 3 combat rolls the attacker
// won: 0=Utter Failure, 1=Pyrrhic Victory, 2=Moderate Success, 3=Immense Triumph.
const SUCCESS_CODE_MAP = { 0:'UTTER_FAILURE', 1:'PYRRHIC_VICTORY', 2:'MODERATE_SUCCESS', 3:'IMMENSE_TRIUMPH' };
function normalizeSuccess(success) {
  if (typeof success === 'string') return success; // already a tag (defensive, in case API changes back)
  return SUCCESS_CODE_MAP[Number(success)] || 'MODERATE_SUCCESS';
}

function resolveAttackName(nationId, ctx) {
  if (String(nationId)===String(ctx?.ourNationId))   return ctx.ourNationName||'Our Member';
  if (String(nationId)===String(ctx?.enemyNationId))  return ctx.enemyNationName||'Enemy';
  return `Nation #${nationId}`;
}

// Human-friendly names for the P&W AttackType enum — nobody outside the
// game knows what "AIRVAIR" or "AIRVSHIPS" means, so we translate these
// for the war room reports.
const ATTACK_TYPE_INFO = {
  GROUND:        { emoji:'⚔️', label:'Ground Attack',              verb:'launched a ground assault on' },
  AIRVINFRA:     { emoji:'✈️', label:'Airstrike on Infrastructure', verb:'bombed the infrastructure of' },
  AIRVSOLDIERS:  { emoji:'✈️', label:'Airstrike on Soldiers',       verb:'bombed the troops of' },
  AIRVTANKS:     { emoji:'✈️', label:'Airstrike on Tanks',          verb:'bombed the tanks of' },
  AIRVMONEY:     { emoji:'✈️', label:'Airstrike on Treasury',       verb:'raided the treasury of' },
  AIRVSHIPS:     { emoji:'✈️', label:'Airstrike on Ships',          verb:'bombed the navy of' },
  AIRVAIR:       { emoji:'✈️', label:'Dogfight',                    verb:'engaged in a dogfight with' },
  NAVAL:         { emoji:'🚢', label:'Naval Attack',                verb:'launched a naval attack on' },
  NAVALVSHIPS:   { emoji:'🚢', label:'Naval Attack on Ships',        verb:'engaged the navy of' },
  NAVALVINFRA:   { emoji:'🚢', label:'Naval Attack on Infrastructure', verb:'shelled the coast of' },
  NAVALVMONEY:   { emoji:'🚢', label:'Naval Attack on Treasury',     verb:'raided the ports of' },
  MISSILE:       { emoji:'🚀', label:'Missile Strike',              verb:'fired a missile at' },
  MISSILEFAIL:   { emoji:'🛰️', label:'Missile Intercepted',         verb:'attempted a missile strike on' },
  NUKE:          { emoji:'☢️', label:'Nuclear Strike',              verb:'launched a nuke at' },
  NUKEFAIL:      { emoji:'🛡️', label:'Nuke Intercepted',            verb:'attempted a nuclear strike on' },
  FORTIFY:       { emoji:'🏰', label:'Fortify',                     verb:'fortified against' },
  PEACE:         { emoji:'🕊️', label:'Peace Offer',                 verb:'offered peace to' },
  VICTORY:       { emoji:'🏆', label:'Victory',                     verb:'claimed victory over' },
  ALLIANCELOOT:  { emoji:'💰', label:'Alliance Loot',                verb:'looted alliance funds from' },
};
function getAttackTypeInfo(rawType) {
  const type = normalizeAttackType(rawType);
  return ATTACK_TYPE_INFO[type] || { emoji:'⚔️', label:(rawType||'Unknown').replace(/_/g,' '), verb:'attacked' };
}

// P&W's `loot_info` field on WarAttack is a String whose exact serialization
// format isn't confirmed from documentation, so this parses defensively:
// tries JSON first, then a "{KEY=1,234, KEY2=56}" style map-toString format.
// Either way, if parsing fails entirely we still have `moneystolen` (a plain
// float) as a reliable fallback for at least the money figure.
const LOOT_RESOURCE_INFO = {
  MONEY:     { emoji:'💵', label:'Money',     isDollar:true },
  FOOD:      { emoji:'🌾', label:'Food' },
  COAL:      { emoji:'⚫', label:'Coal' },
  OIL:       { emoji:'🛢️', label:'Oil' },
  URANIUM:   { emoji:'☢️', label:'Uranium' },
  IRON:      { emoji:'⛏️', label:'Iron' },
  BAUXITE:   { emoji:'🪨', label:'Bauxite' },
  GASOLINE:  { emoji:'⛽', label:'Gasoline' },
  MUNITIONS: { emoji:'💣', label:'Munitions' },
  STEEL:     { emoji:'🔩', label:'Steel' },
  ALUMINUM:  { emoji:'🔧', label:'Aluminum' },
};

function normalizeLootKeys(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj||{})) {
    const key = k.toUpperCase();
    if (LOOT_RESOURCE_INFO[key]) out[key] = Number(v) || 0;
  }
  return out;
}

function parseLootInfo(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return normalizeLootKeys(parsed);
  } catch {}
  const matches = [...raw.matchAll(/([A-Za-z_]+)\s*=\s*(-?[\d,]+(?:\.\d+)?)/g)];
  if (matches.length > 0) {
    const obj = {};
    for (const [, key, val] of matches) obj[key.toUpperCase()] = parseFloat(val.replace(/,/g,''));
    return normalizeLootKeys(obj);
  }
  return null;
}

function formatLootLine(lootObj) {
  if (!lootObj) return null;
  const parts = [];
  for (const [key, info] of Object.entries(LOOT_RESOURCE_INFO)) {
    const val = lootObj[key];
    if (!val) continue;
    const display = info.isDollar ? `$${Math.round(val).toLocaleString()}` : val.toLocaleString();
    parts.push(`${info.emoji} ${info.label}: **${display}**`);
  }
  return parts.length > 0 ? parts.join(' | ') : null;
}

function getLootLineForAttack(attack) {
  const parsed = parseLootInfo(attack.loot_info);
  const line = formatLootLine(parsed);
  if (line) return line;
  if ((attack.moneystolen||0) > 0) return `💵 Money: **$${Number(attack.moneystolen).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}**`;
  return null;
}

// NOTE: WarAttack does NOT expose att_nation_name/def_nation_name in the P&W API
// (confirmed via live GraphQL validation error). Names are resolved from the
// war room's own known nations (ctx) instead of the attack payload.
function buildAttackReport(attack, ctx={}) {
  const successTag  = normalizeSuccess(attack.success);
  const typeInfo     = getAttackTypeInfo(attack.type);
  const attName      = resolveAttackName(attack.attid, ctx);
  const defName      = resolveAttackName(attack.defid, ctx);
  const normType     = normalizeAttackType(attack.type);
  const isPeace      = normType === 'PEACE';

  // A peace offer isn't a combat roll — "pyrrhic victory" / "immense
  // triumph" style commentary doesn't make sense attached to it, so peace
  // gets its own plain description with no success-tier language or color.
  const resultText = isPeace ? null
    : successTag==='UTTER_FAILURE' ? 'an **utter failure**'
    : successTag==='PYRRHIC_VICTORY' ? 'a **pyrrhic victory** — won at great cost'
    : successTag==='MODERATE_SUCCESS' ? 'a **moderate success**'
    : 'an **immense triumph**';

  const color = isPeace ? 0x95a5a6
    : successTag==='UTTER_FAILURE' ? 0xe74c3c
    : successTag==='PYRRHIC_VICTORY' ? 0xf39c12
    : successTag==='MODERATE_SUCCESS' ? 0x3498db
    : 0x2ecc71;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`${typeInfo.emoji} ${typeInfo.label}`)
    .setDescription(
      isPeace
        ? `**${attName}** ${typeInfo.verb} **${defName}**.`
        : `**[${attName}](https://politicsandwar.com/nation/id=${attack.attid})** ${typeInfo.verb} ` +
          `**[${defName}](https://politicsandwar.com/nation/id=${attack.defid})** — it was ${resultText}!`
    );

  if ((attack.infra_destroyed||0)>0) {
    embed.addFields({ name:'🏗️ Infrastructure Destroyed', value:`${Number(attack.infra_destroyed).toFixed(2)} infra ($${Number(attack.infra_destroyed_value||0).toLocaleString()})`, inline:false });
  }

  // Ground attacks (and any other type) can loot a straight dollar amount.
  if (normType === 'GROUND') {
    const lootLine = getLootLineForAttack(attack);
    if (lootLine) embed.addFields({ name:'💰 Looted', value:lootLine, inline:false });
  }

  // VICTORY = resources looted from the defeated NATION when their
  // resistance is finished off. ALLIANCELOOT = resources looted from that
  // nation's ALLIANCE. Both show a full resource breakdown when available,
  // and explicitly say so when nothing was looted rather than omitting it.
  if (normType === 'VICTORY') {
    const lootLine = getLootLineForAttack(attack);
    embed.addFields({ name:'🏆 Looted from Nation', value: lootLine || 'Nothing was looted.', inline:false });
  }
  if (normType === 'ALLIANCELOOT') {
    const lootLine = getLootLineForAttack(attack);
    embed.addFields({ name:'💰 Looted from Alliance', value: lootLine || 'Nothing was looted.', inline:false });
  }

  const attLosses=[], defLosses=[];
  if ((attack.att_soldiers_lost||0)>0) attLosses.push(`👮 ${Number(attack.att_soldiers_lost).toLocaleString()} soldiers`);
  if ((attack.att_tanks_lost||0)>0)    attLosses.push(`🚗 ${Number(attack.att_tanks_lost).toLocaleString()} tanks`);
  if ((attack.att_aircraft_lost||0)>0) attLosses.push(`✈️ ${Number(attack.att_aircraft_lost).toLocaleString()} planes`);
  if ((attack.att_ships_lost||0)>0)    attLosses.push(`🚢 ${Number(attack.att_ships_lost).toLocaleString()} ships`);
  if ((attack.def_soldiers_lost||0)>0) defLosses.push(`👮 ${Number(attack.def_soldiers_lost).toLocaleString()} soldiers`);
  if ((attack.def_tanks_lost||0)>0)    defLosses.push(`🚗 ${Number(attack.def_tanks_lost).toLocaleString()} tanks`);
  if ((attack.def_aircraft_lost||0)>0) defLosses.push(`✈️ ${Number(attack.def_aircraft_lost).toLocaleString()} planes`);
  if ((attack.def_ships_lost||0)>0)    defLosses.push(`🚢 ${Number(attack.def_ships_lost).toLocaleString()} ships`);
  if (attLosses.length>0) embed.addFields({ name:`⚔️ ${attName} Lost`, value:attLosses.join('\n'), inline:true });
  if (defLosses.length>0) embed.addFields({ name:`🛡️ ${defName} Lost`, value:defLosses.join('\n'), inline:true });

  const munUsed=(attack.att_mun_used||0)+(attack.def_mun_used||0);
  const gasUsed=(attack.att_gas_used||0)+(attack.def_gas_used||0);
  if (munUsed>0||gasUsed>0) embed.addFields({ name:'⛽ Resources Used', value:`Munitions: ${munUsed.toFixed(1)} | Gasoline: ${gasUsed.toFixed(1)}`, inline:false });

  const gifUrl = getGif(attack.type, successTag);
  if (gifUrl) embed.setImage(gifUrl);

  if (attack.date) {
    const d = new Date(attack.date);
    if (!isNaN(d.getTime())) embed.setTimestamp(d);
  }

  return embed;
}

async function checkWarRoomAttacks(client) {
  const rooms = query(`SELECT wr.* FROM war_rooms wr WHERE wr.status='active'`, []).rows;
  if (rooms.length === 0) return;

  // Build war_id -> { room, ctx } once, then fetch every active war's
  // attacks in a SINGLE API call (see fetchAttacksBatch) instead of one
  // call per room-member — this is what actually frees up headroom to
  // poll more often within P&W's daily request quota.
  const warMap = new Map(); // war_id -> { room, ctx }
  for (const room of rooms) {
    const members = query('SELECT DISTINCT war_id, nation_id, nation_name FROM war_room_members WHERE war_room_id=?', [room.id]).rows;
    for (const { war_id, nation_id, nation_name } of members) {
      if (!war_id || warMap.has(String(war_id))) continue;
      warMap.set(String(war_id), {
        room,
        ctx: {
          ourNationId:     nation_id,
          ourNationName:   nation_name,
          enemyNationId:   room.enemy_nation_id,
          enemyNationName: room.enemy_nation_name,
        },
      });
    }
  }
  if (warMap.size === 0) return;

  const allAttacks = await fetchAttacksBatch([...warMap.keys()]);
  if (allAttacks.length === 0) return;

  // Group by war_id so each room only processes its own attacks.
  const byWar = new Map();
  for (const attack of allAttacks) {
    const key = String(attack.war_id);
    if (!byWar.has(key)) byWar.set(key, []);
    byWar.get(key).push(attack);
  }

  for (const [warId, warAttacks] of byWar) {
    const entry = warMap.get(warId);
    if (!entry) continue;
    await sendWarAttacks(client, entry.room, warId, entry.ctx, warAttacks);
  }
}

async function sendWarAttacks(client, room, war_id, ctx, attacks) {
  try {
    const channel = client.channels.cache.get(room.channel_id);
    if (!channel) return;

    const lastRow = queryOne(`SELECT setting_value FROM alert_settings WHERE guild_id=? AND alert_type='war_attack_last' AND setting_key=?`, [room.guild_id, String(war_id)]);
    const lastAttackId = lastRow?.setting_value || null;
    const newAttacks = lastAttackId ? attacks.filter(a => parseInt(a.id) > parseInt(lastAttackId)) : attacks;
    if (newAttacks.length === 0) return;
    newAttacks.sort((a,b)=>parseInt(a.id)-parseInt(b.id));

    for (const attack of newAttacks) {
      if (['FORTIFY'].includes(attack.type)) continue;
      const embed = buildAttackReport(attack, ctx);
      try {
        await channel.send({ embeds: [embed] });
      } catch (sendErr) {
        // Do NOT mark this attack as reported — the send genuinely failed
        // (often a transient Discord network blip). Stop here so this
        // attack (and anything after it) gets retried in order on the
        // next cycle instead of being silently lost.
        logger.error(`Failed to send attack report (attack ${attack.id}, war ${war_id}): ${sendErr.message}`);
        break;
      }
      run(`INSERT INTO alert_settings (guild_id,alert_type,setting_key,setting_value) VALUES(?,'war_attack_last',?,?) ON CONFLICT(guild_id,alert_type,setting_key) DO UPDATE SET setting_value=excluded.setting_value`,
        [room.guild_id, String(war_id), String(attack.id)]);
    }
  } catch (err) { logger.error(`sendWarAttacks: ${err.message}`); }
}

async function getOrCreateWarRoom(client, guild, guildId, enemyNation, ourDiscordId, ourMemberName, war, isCounter, counterDetail) {
  try {
    const existing = queryOne('SELECT * FROM war_rooms WHERE guild_id=? AND enemy_nation_id=? AND status=?', [guildId, enemyNation.id, 'active']);
    if (existing) {
      // The DB row can outlive the actual Discord channel if someone
      // deletes the channel manually instead of through the bot — the row
      // still says 'active', so this used to silently route to
      // addMemberToWarRoom, which just no-ops when the channel is missing
      // (no error, no new room, nothing visibly wrong). Detect that here
      // and treat the stale room as gone instead.
      const channelStillExists = guild.channels.cache.get(existing.channel_id);
      if (!channelStillExists) {
        logger.warn(`War room for ${enemyNation.nation_name} pointed at a deleted channel (${existing.channel_id}) — marking stale and creating a fresh room.`);
        run('UPDATE war_rooms SET status=? WHERE id=?', ['closed', existing.id]);
        run('DELETE FROM war_room_members WHERE war_room_id=?', [existing.id]);
      } else {
        await addMemberToWarRoom(client, guild, guildId, existing, ourDiscordId, ourMemberName, war, isCounter, counterDetail);
        return existing;
      }
    }
    return await createWarRoom(client, guild, guildId, enemyNation, ourDiscordId, ourMemberName, war, isCounter, counterDetail);
  } catch (err) { logger.error(`War room error: ${err?.message || JSON.stringify(err)}`); }
}

async function createWarRoom(client, guild, guildId, enemyNation, ourDiscordId, ourMemberName, war, isCounter, counterDetail) {
  const catRow = queryOne(`SELECT setting_value FROM alert_settings WHERE guild_id=? AND alert_type='warroom' AND setting_key='category_id'`, [guildId]);
  if (!catRow) return null;
  const category = guild.channels.cache.get(catRow.setting_value);
  if (!category) return null;

  const childCount = guild.channels.cache.filter(c => c.parentId === category.id).size;
  if (childCount >= 50) {
    logger.warn(`War room category "${category.name}" is full (50 channels) — skipping room for ${enemyNation.nation_name}. Archive/close old war rooms or use a second category.`);
    return null;
  }

  if (isInactiveNation(enemyNation.last_active)) {
    logger.info(`Skipping war room for ${enemyNation.nation_name} — inactive ${Math.floor(daysSinceActive(enemyNation.last_active))}+ days (likely a raid).`);
    return null;
  }

  const milRole = queryOne(`SELECT discord_role_id FROM guild_roles WHERE guild_id=? AND role_type='military'`, [guildId]);
  const govRole = queryOne(`SELECT discord_role_id FROM guild_roles WHERE guild_id=? AND role_type='government'`, [guildId]);
  const overwrites = [{ id:guild.roles.everyone.id, deny:[PermissionFlagsBits.ViewChannel] }];
  if (milRole) overwrites.push({ id:milRole.discord_role_id, allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages] });
  if (govRole) overwrites.push({ id:govRole.discord_role_id, allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages] });

  const safeName = (enemyNation.nation_name||'unknown').toLowerCase().replace(/[^a-z0-9]/g,'-').replace(/-+/g,'-').slice(0,80);
  const channel  = await guild.channels.create({ name:`⚔️-${safeName}`, type:ChannelType.GuildText, parent:category.id, topic:`War vs ${enemyNation.nation_name} | ${enemyNation.alliance?.name||'None'}`, permissionOverwrites:overwrites });

  run(`INSERT INTO war_rooms (guild_id,channel_id,enemy_nation_id,enemy_nation_name,enemy_alliance_name,status) VALUES(?,?,?,?,?,'active')`,
    [guildId, channel.id, enemyNation.id, enemyNation.nation_name, enemyNation.alliance?.name||'None']);

  const roomRow = queryOne('SELECT id FROM war_rooms WHERE guild_id=? AND channel_id=?', [guildId, channel.id]);
  const roomId  = roomRow?.id;

  run(`INSERT OR IGNORE INTO war_room_members (war_room_id,discord_user_id,nation_id,nation_name,war_id) VALUES(?,?,?,?,?)`,
    [roomId, ourDiscordId, war.ourNationId, ourMemberName, war.id]);

  if (ourDiscordId) await channel.permissionOverwrites.create(ourDiscordId, {ViewChannel:true,SendMessages:true}).catch(()=>{});

  const link = ourDiscordId ? `<@${ourDiscordId}>` : `**${ourMemberName}**`;
  await channel.send({ content:`${link} joined the fray! ⚔️`+(isCounter?`\n🔄 **COUNTER WAR** — _${counterDetail}_`:'') });

  const roomFull = queryOne('SELECT * FROM war_rooms WHERE id=?', [roomId]);
  await sendUnifiedWarCard(channel, roomFull);

  logger.info(`War room created: ${channel.name} for war ${war.id}`);
  return { id:roomId, channel_id:channel.id };
}

// Adds ANOTHER of our members to an already-existing war room against this
// same enemy. Previously this only sent a plain-text line and never gave
// the new member their own war card — the unified card fixes that by
// rebuilding the WHOLE room's card (now including this member) instead.
// Deduped by war_id, not discord_user_id: the same member can legitimately
// start a brand new, separate war against this same enemy later on
// (declare, peace out, redeclare) — deduping by member alone silently
// dropped that new war from tracking entirely, which is why some members'
// attacks were never reported.
async function addMemberToWarRoom(client, guild, guildId, roomRow, ourDiscordId, ourMemberName, war, isCounter, counterDetail) {
  const channel = guild.channels.cache.get(roomRow.channel_id);
  if (!channel) return;
  const already = queryOne('SELECT id FROM war_room_members WHERE war_room_id=? AND war_id=?', [roomRow.id, war.id]);
  if (already) return;
  run(`INSERT OR IGNORE INTO war_room_members (war_room_id,discord_user_id,nation_id,nation_name,war_id) VALUES(?,?,?,?,?)`, [roomRow.id,ourDiscordId,war.ourNationId,ourMemberName,war.id]);
  if (ourDiscordId) await channel.permissionOverwrites.create(ourDiscordId, {ViewChannel:true,SendMessages:true}).catch(()=>{});
  await channel.send({ content:`${ourDiscordId?`<@${ourDiscordId}>`:`**${ourMemberName}**`} also joined the fray! ⚔️`+(isCounter?`\n🔄 **COUNTER WAR** — _${counterDetail}_`:'') });
  await sendUnifiedWarCard(channel, roomRow);
}

async function removeMemberFromWarRoom(client, guild, guildId, nationId, warId) {
  try {
    const member = queryOne(`SELECT wrm.*,wr.channel_id,wr.id as room_id FROM war_room_members wrm JOIN war_rooms wr ON wr.id=wrm.war_room_id WHERE wr.guild_id=? AND wrm.nation_id=? AND wrm.war_id=?`, [guildId,nationId,warId]);
    if (!member) return;
    run('DELETE FROM war_room_members WHERE id=?', [member.id]);
    const channel = guild.channels.cache.get(member.channel_id);
    if (channel) {
      if (member.discord_user_id) await channel.permissionOverwrites.delete(member.discord_user_id).catch(()=>{});
      await channel.send({ content:`✅ <@${member.discord_user_id}>'s war ended — removed from this room.` });
    }
    const remaining = query('SELECT * FROM war_room_members WHERE war_room_id=?', [member.room_id]).rows;
    if (remaining.length===0) {
      if (channel) { await channel.send({content:'🏁 All wars concluded — deleting in 10 seconds.'}); setTimeout(async()=>{ await channel.delete().catch(()=>{}); },10000); }
      run('UPDATE war_rooms SET status=? WHERE id=?', ['closed',member.room_id]);
    }
  } catch (err) { logger.error(`removeMemberFromWarRoom: ${err.message}`); }
}

module.exports = { getOrCreateWarRoom, removeMemberFromWarRoom, buildWarButtons, fetchWarData, fetchNationData, sendUnifiedWarCard, checkWarRoomAttacks, isInactiveNation, daysSinceActive, closeWarRoomForInactivity, INACTIVITY_DAYS };
