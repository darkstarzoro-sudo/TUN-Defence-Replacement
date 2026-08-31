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

function buildWarCard(war, ourMember, enemyNation, assignedTo=null, isCounter=false, counterDetail=null) {
  const color   = war.isOurAttack ? 0x3498db : 0xe74c3c;
  const typeTag = isCounter ? '🔄 **COUNTER WAR**' : war.isOurAttack ? '⚔️ **OFFENSIVE WAR**' : '🛡️ **DEFENSIVE WAR**';

  return new EmbedBuilder()
    .setTitle(`${typeTag} — vs ${enemyNation?.nation_name||'Unknown'}`)
    .setColor(color)
    .setDescription((isCounter&&counterDetail?`✅ _${counterDetail}_\n\n`:'')+`[View War](https://politicsandwar.com/nation/war/timeline/war=${war.id})`)
    .addFields(
      {
        name: `🛡️ Our Member — ${ourMember?.nation_name||'Unknown'}`,
        value: [
          `⭐ NS: **${Math.round(ourMember?.score||0).toLocaleString()}** | 🏙️ Cities: **${ourMember?.num_cities||'?'}**`,
          `👮 ${(ourMember?.soldiers||0).toLocaleString()} | 🚗 ${(ourMember?.tanks||0).toLocaleString()} | ✈️ ${ourMember?.aircraft||0} | 🚢 ${ourMember?.ships||0}`,
          `🚀 ${ourMember?.missiles||0} | ☢️ ${ourMember?.nukes||0} | 🕵️ ${ourMember?.spies||0}`,
          `❤️ Resistance: **${war.ourResistance??'?'}/100**`,
        ].join('\n'),
        inline: false,
      },
      {
        name: `⚔️ Enemy — [${enemyNation?.nation_name||'Unknown'}](https://politicsandwar.com/nation/id=${enemyNation?.id}) (${enemyNation?.alliance?.name||'None'})`,
        value: [
          `⭐ NS: **${Math.round(enemyNation?.score||0).toLocaleString()}** | 🏙️ Cities: **${enemyNation?.num_cities||'?'}**`,
          `👮 ${(enemyNation?.soldiers||0).toLocaleString()} | 🚗 ${(enemyNation?.tanks||0).toLocaleString()} | ✈️ ${enemyNation?.aircraft||0} | 🚢 ${enemyNation?.ships||0}`,
          `🚀 ${enemyNation?.missiles||0} | ☢️ ${enemyNation?.nukes||0} | 🕵️ ${enemyNation?.spies||0}`,
          `❤️ Resistance: **${war.enemyResistance??'?'}/100**`,
        ].join('\n'),
        inline: false,
      },
      { name: '⏳ War Status', value: `Turns Left: **${war.turnsleft??'?'}** | War ID: \`${war.id}\`\n_MAP values — check war page_`, inline: false },
    )
    .setTimestamp()
    .setFooter({ text: assignedTo?`Director: @${assignedTo}`:'No director — click Claim to take command' });
}

function buildWarButtons(warId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`war_claim_${warId}`).setLabel('🎖️ Claim').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`war_status_${warId}`).setLabel('📊 War Status').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`war_counter_${warId}`).setLabel('⚔️ Counter').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`war_spies_${warId}`).setLabel('🕵️ Spies').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setLabel('🔗 View War').setStyle(ButtonStyle.Link).setURL(`https://politicsandwar.com/nation/war/timeline/war=${warId}`),
  );
}

async function fetchWarData(warId, ourNationId, enemyNationId) {
  try {
    // NOTE: att_map/def_map do NOT exist in P&W API wars query
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
  try {
    const data = await pwQuery(`
      query A($warId:[Int]){warattacks(war_id:$warId,orderBy:{column:ID,order:DESC},first:20){data{
        id war_id attid defid
        type victor success
        att_mun_used def_mun_used att_gas_used def_gas_used
        infra_destroyed infra_destroyed_value
        att_soldiers_lost def_soldiers_lost att_tanks_lost def_tanks_lost
        att_aircraft_lost def_aircraft_lost att_ships_lost def_ships_lost
        date
      }}}
    `, { warId:[parseInt(warId)] });
    const attacks = data?.warattacks?.data||[];
    if (!lastAttackId) return attacks;
    return attacks.filter(a => parseInt(a.id) > parseInt(lastAttackId));
  } catch (err) { logger.error(`fetchNewAttacks: ${err.message}`); return []; }
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

// NOTE: WarAttack does NOT expose att_nation_name/def_nation_name in the P&W API
// (confirmed via live GraphQL validation error). Names are resolved from the
// war room's own known nations (ctx) instead of the attack payload.
function buildAttackReport(attack, ctx={}) {
  const successTag  = normalizeSuccess(attack.success);
  const typeInfo     = getAttackTypeInfo(attack.type);
  const attName      = resolveAttackName(attack.attid, ctx);
  const defName      = resolveAttackName(attack.defid, ctx);

  const resultText = successTag==='UTTER_FAILURE' ? 'an **utter failure**'
    : successTag==='PYRRHIC_VICTORY' ? 'a **pyrrhic victory** — won at great cost'
    : successTag==='MODERATE_SUCCESS' ? 'a **moderate success**'
    : 'an **immense triumph**';

  const color = successTag==='UTTER_FAILURE' ? 0xe74c3c
    : successTag==='PYRRHIC_VICTORY' ? 0xf39c12
    : successTag==='MODERATE_SUCCESS' ? 0x3498db
    : 0x2ecc71;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`${typeInfo.emoji} ${typeInfo.label}`)
    .setDescription(
      `**[${attName}](https://politicsandwar.com/nation/id=${attack.attid})** ${typeInfo.verb} ` +
      `**[${defName}](https://politicsandwar.com/nation/id=${attack.defid})** — it was ${resultText}!`
    );

  if ((attack.infra_destroyed||0)>0) {
    embed.addFields({ name:'🏗️ Infrastructure Destroyed', value:`${Number(attack.infra_destroyed).toFixed(2)} infra ($${Number(attack.infra_destroyed_value||0).toLocaleString()})`, inline:false });
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
  for (const room of rooms) await processRoomAttacks(client, room);
}

async function processRoomAttacks(client, room) {
  try {
    const channel = client.channels.cache.get(room.channel_id);
    if (!channel) return;
    const members = query('SELECT DISTINCT war_id, nation_id, nation_name FROM war_room_members WHERE war_room_id=?', [room.id]).rows;
    for (const { war_id, nation_id, nation_name } of members) {
      if (!war_id) continue;
      const ctx = {
        ourNationId:     nation_id,
        ourNationName:   nation_name,
        enemyNationId:   room.enemy_nation_id,
        enemyNationName: room.enemy_nation_name,
      };
      const lastRow = queryOne(`SELECT setting_value FROM alert_settings WHERE guild_id=? AND alert_type='war_attack_last' AND setting_key=?`, [room.guild_id, String(war_id)]);
      const newAttacks = await fetchNewAttacks(war_id, lastRow?.setting_value||null);
      if (newAttacks.length===0) continue;
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
          // next 1-minute cycle instead of being silently lost.
          logger.error(`Failed to send attack report (attack ${attack.id}, war ${war_id}): ${sendErr.message}`);
          break;
        }
        run(`INSERT INTO alert_settings (guild_id,alert_type,setting_key,setting_value) VALUES(?,'war_attack_last',?,?) ON CONFLICT(guild_id,alert_type,setting_key) DO UPDATE SET setting_value=excluded.setting_value`,
          [room.guild_id, String(war_id), String(attack.id)]);
      }
    }
  } catch (err) { logger.error(`processRoomAttacks: ${err.message}`); }
}

async function sendOrRefreshWarCard(channel, room, warData, ourData, enemyData, director, isCounter, counterDetail) {
  try {
    if (room.card_message_id) {
      const oldMsg = await channel.messages.fetch(room.card_message_id).catch(()=>null);
      if (oldMsg) await oldMsg.delete().catch(()=>{});
    }
    const embed   = buildWarCard(warData||{id:room.enemy_nation_id,isOurAttack:true,turnsleft:'?'}, ourData||{nation_name:'Our Member'}, enemyData||{id:room.enemy_nation_id,nation_name:room.enemy_nation_name,alliance:{name:room.enemy_alliance_name}}, director, isCounter||false, counterDetail||null);
    const buttons = buildWarButtons(warData?.id||room.enemy_nation_id);
    const newMsg  = await channel.send({ embeds:[embed], components:[buttons] });
    await newMsg.pin().catch(()=>{});
    run('UPDATE war_rooms SET card_message_id=? WHERE id=?', [newMsg.id, room.id]);
    return newMsg;
  } catch (err) { logger.error(`sendOrRefreshWarCard: ${err.message}`); return null; }
}

async function getOrCreateWarRoom(client, guild, guildId, enemyNation, ourDiscordId, ourMemberName, war, isCounter, counterDetail) {
  try {
    const existing = queryOne('SELECT * FROM war_rooms WHERE guild_id=? AND enemy_nation_id=? AND status=?', [guildId, enemyNation.id, 'active']);
    if (existing) { await addMemberToWarRoom(client, guild, guildId, existing, ourDiscordId, ourMemberName, war); return existing; }
    return await createWarRoom(client, guild, guildId, enemyNation, ourDiscordId, ourMemberName, war, isCounter, counterDetail);
  } catch (err) { logger.error(`War room error: ${err.message}`); }
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

  const [warData, ourData] = await Promise.all([fetchWarData(war.id, war.ourNationId, enemyNation.id), fetchNationData(war.ourNationId)]);
  const roomFull = queryOne('SELECT * FROM war_rooms WHERE id=?', [roomId]);
  await sendOrRefreshWarCard(channel, roomFull, warData||{...war,isOurAttack:!isCounter}, ourData||{nation_name:ourMemberName}, enemyNation, null, isCounter, counterDetail);

  logger.info(`War room created: ${channel.name} for war ${war.id}`);
  return { id:roomId, channel_id:channel.id };
}

async function addMemberToWarRoom(client, guild, guildId, roomRow, ourDiscordId, ourMemberName, war) {
  const channel = guild.channels.cache.get(roomRow.channel_id);
  if (!channel) return;
  const already = queryOne('SELECT id FROM war_room_members WHERE war_room_id=? AND discord_user_id=?', [roomRow.id, ourDiscordId]);
  if (already) return;
  run(`INSERT OR IGNORE INTO war_room_members (war_room_id,discord_user_id,nation_id,nation_name,war_id) VALUES(?,?,?,?,?)`, [roomRow.id,ourDiscordId,war.ourNationId,ourMemberName,war.id]);
  if (ourDiscordId) await channel.permissionOverwrites.create(ourDiscordId, {ViewChannel:true,SendMessages:true}).catch(()=>{});
  await channel.send({ content:`${ourDiscordId?`<@${ourDiscordId}>`:`**${ourMemberName}**`} also joined the fray! ⚔️` });
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

module.exports = { getOrCreateWarRoom, removeMemberFromWarRoom, buildWarCard, buildWarButtons, fetchWarData, fetchNationData, sendOrRefreshWarCard, checkWarRoomAttacks, isInactiveNation, daysSinceActive, closeWarRoomForInactivity, INACTIVITY_DAYS };
