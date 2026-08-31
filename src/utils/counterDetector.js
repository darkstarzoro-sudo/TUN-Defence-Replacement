const { pwQuery } = require('./pwApi');
const { query, run, queryOne } = require('./database');
const logger = require('./logger');
const COUNTER_TREATY_TYPES = ['MDP', 'MDOAP', 'ODP', 'PROTECTORATE'];

async function syncTreatiesFromPW(guildId, allianceId) {
  try {
    const data = await pwQuery(`query T($id:[Int]){alliances(id:$id,first:1){data{treaties{id alliance1_id alliance2_id treaty_type alliance1{id name}alliance2{id name}}}}}`, { id: [parseInt(allianceId)] });
    const treaties = data?.alliances?.data?.[0]?.treaties || [];
    for (const t of treaties) {
      const partnerId   = String(t.alliance1_id) === String(allianceId) ? t.alliance2_id   : t.alliance1_id;
      const partnerName = String(t.alliance1_id) === String(allianceId) ? t.alliance2?.name : t.alliance1?.name;
      if (!partnerId || !partnerName) continue;
      const typeMap = { MDP:'MDP', MDOAP:'MDOAP', ODP:'ODP', ODOAP:'MDOAP', Protectorate:'PROTECTORATE', NAP:'NAP' };
      run(`INSERT INTO treaties (guild_id,alliance_id,alliance_name,treaty_type,notes,added_by) VALUES(?,?,?,?,?,'auto-sync') ON CONFLICT(guild_id,alliance_id,treaty_type) DO UPDATE SET alliance_name=excluded.alliance_name,notes='Auto-synced from P&W'`,
        [guildId, partnerId, partnerName, typeMap[t.treaty_type]||t.treaty_type, 'Auto-synced from P&W']);
    }
    logger.debug(`Treaty sync: ${treaties.length} treaties for ${allianceId}`);
  } catch (err) { logger.error(`Treaty sync error: ${err.message}`); }
}

function getTreatyPartnerIds(guildId) {
  const rows = query(`SELECT alliance_id FROM treaties WHERE guild_id=? AND treaty_type IN (${COUNTER_TREATY_TYPES.map(()=>'?').join(',')})`, [guildId,...COUNTER_TREATY_TYPES]).rows;
  return new Set(rows.map(r => String(r.alliance_id)));
}

async function isLegitimateCounter(guildId, allianceId, targetNationId, targetNationAllianceId) {
  try {
    const data = await pwQuery(`query W($id:[Int]){wars(nation_id:$id,active:true,first:10){data{id attid defid att_alliance_id def_alliance_id}}}`, { id: [parseInt(targetNationId)] });
    const wars = data?.wars?.data || [];
    const ourId = String(allianceId);
    const treatyIds = getTreatyPartnerIds(guildId);
    for (const war of wars) {
      if (String(war.attid) !== String(targetNationId)) continue;
      const defId = String(war.def_alliance_id);
      if (defId === ourId) return { isCounter:true, reason:'direct', detail:'Target is actively attacking one of our members' };
      if (treatyIds.has(defId)) {
        const t = queryOne('SELECT alliance_name,treaty_type FROM treaties WHERE guild_id=? AND alliance_id=?', [guildId, parseInt(defId)]);
        return { isCounter:true, reason:'treaty', detail:`Target is attacking ${t?.alliance_name||'a treaty ally'} (${t?.treaty_type||'Treaty'})` };
      }
    }
    return { isCounter:false, reason:null, detail:null };
  } catch (err) { logger.error(`Counter detection error: ${err.message}`); return { isCounter:false, reason:null, detail:null }; }
}

module.exports = { syncTreatiesFromPW, isLegitimateCounter, getTreatyPartnerIds, COUNTER_TREATY_TYPES };
