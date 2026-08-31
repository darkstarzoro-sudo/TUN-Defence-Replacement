// ============================================================
// src/commands/military/war.js
// Fixed: removed broken alliance_position filter
// ============================================================

const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { queryOne } = require('../../utils/database');
const { pwQuery, resolveNation } = require('../../utils/pwApi');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

function safeName(n) { return n || 'Unknown'; }
function safeScore(s) { return s ? Number(s).toLocaleString() : '?'; }
function safeMil(m)   { return m || 0; }

function generateWarCSV(wars, isDefensive) {
  const headers = isDefensive
    ? ['Our Member','Member ID','Our Score','Attacker','Attacker ID','Attacker Alliance','Attacker Score','Aircraft','Tanks','Missiles','Nukes','War Link']
    : ['Our Attacker','Attacker ID','Our Score','Target','Target ID','Target Alliance','Target Score','Aircraft','Tanks','Turns Left','War Link'];
  const rows = wars.map(w => isDefensive ? [
    safeName(w.defender?.nation_name), w.defender?.id||'', w.defender?.score||'',
    safeName(w.attacker?.nation_name), w.attacker?.id||'', safeName(w.attacker?.alliance?.name), w.attacker?.score||'',
    safeMil(w.attacker?.aircraft), safeMil(w.attacker?.tanks), safeMil(w.attacker?.missiles), safeMil(w.attacker?.nukes),
    `https://politicsandwar.com/nation/war/timeline/war=${w.id}`,
  ] : [
    safeName(w.attacker?.nation_name), w.attacker?.id||'', w.attacker?.score||'',
    safeName(w.defender?.nation_name), w.defender?.id||'', safeName(w.defender?.alliance?.name), w.defender?.score||'',
    safeMil(w.defender?.aircraft), safeMil(w.defender?.tanks), w.turnsleft||'',
    `https://politicsandwar.com/nation/war/timeline/war=${w.id}`,
  ]);
  return [headers,...rows].map(r=>r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('war')
    .setDescription('View and manage active wars involving your alliance')
    .addSubcommand(sub => sub.setName('status').setDescription('Overview of all active wars'))
    .addSubcommand(sub => sub.setName('defensive').setDescription('Full list of defensive wars as CSV'))
    .addSubcommand(sub => sub.setName('offensive').setDescription('Full list of offensive wars as CSV'))
    .addSubcommand(sub =>
      sub.setName('check')
        .setDescription('Check the war status of a specific nation')
        .addStringOption(opt => opt.setName('nation').setDescription('Nation name, ID, or P&W link').setRequired(true))
    ),

  requiredRole: 'military',

  async execute(interaction) {
    const sub      = interaction.options.getSubcommand();
    const guildRow = queryOne('SELECT alliance_id FROM guilds WHERE guild_id = ?', [interaction.guildId]);
    if (!guildRow?.alliance_id) return interaction.reply({ content: '❌ No alliance configured. Use `/config alliance` first.', flags: 64 });

    const allianceIdStr = String(guildRow.alliance_id);

    async function fetchAll() {
      const data = await pwQuery(`
        query GetAllianceWars($id:[Int]){wars(alliance_id:$id,active:true,first:100){data{
          id att_alliance_id def_alliance_id attid defid
          attacker{id nation_name score soldiers tanks aircraft ships missiles nukes alliance{name}}
          defender{id nation_name score soldiers tanks aircraft ships missiles nukes alliance{name}}
          turnsleft
        }}}
      `, { id: [parseInt(guildRow.alliance_id)] });
      return data?.wars?.data || [];
    }

    if (sub === 'status') {
      await interaction.deferReply();
      const all  = await fetchAll();
      const off  = all.filter(w => String(w.att_alliance_id) === allianceIdStr);
      const def  = all.filter(w => String(w.def_alliance_id) === allianceIdStr);
      const shortList = (wars, isOff) => wars.length === 0 ? '✅ None'
        : wars.slice(0,5).map(w => isOff
            ? `• [${safeName(w.attacker?.nation_name)}](https://politicsandwar.com/nation/id=${w.attacker?.id}) → [${safeName(w.defender?.nation_name)}](https://politicsandwar.com/nation/id=${w.defender?.id})`
            : `• [${safeName(w.defender?.nation_name)}](https://politicsandwar.com/nation/id=${w.defender?.id}) ← [${safeName(w.attacker?.nation_name)}](https://politicsandwar.com/nation/id=${w.attacker?.id})`
          ).join('\n') + (wars.length > 5 ? `\n_+${wars.length-5} more_` : '');
      return interaction.editReply({ content: '', embeds: [new EmbedBuilder().setTitle('⚔️ Alliance War Status').setColor(0xe74c3c)
        .addFields(
          { name: `⚔️ Offensive — ${off.length}`, value: shortList(off,true) },
          { name: `🛡️ Defensive — ${def.length}`, value: shortList(def,false) },
          { name: '📊 Summary', value: `Total: **${all.length}** | Attacking: **${off.length}** | Defending: **${def.length}**` },
        ).setFooter({ text: 'Use /war defensive or /war offensive for full CSV' }).setTimestamp()] });
    }

    if (sub === 'defensive') {
      await interaction.deferReply();
      const all = await fetchAll();
      const def = all.filter(w => String(w.def_alliance_id) === allianceIdStr);
      if (def.length === 0) return interaction.editReply({ embeds: [new EmbedBuilder().setTitle('🛡️ Defensive Wars').setColor(0x2ecc71).setDescription('✅ No members under attack.').setTimestamp()] });
      const attackerAlliances = [...new Set(def.map(w => w.attacker?.alliance?.name||'None'))];
      const summaryEmbed = new EmbedBuilder().setTitle(`🛡️ Defensive Wars — ${def.length}`).setColor(0xe74c3c)
        .addFields(
          { name: '⚔️ Enemy Alliances', value: attackerAlliances.slice(0,10).join(', ')||'None' },
          { name: '🚀 Wars with Missiles', value: `${def.filter(w=>(w.attacker?.missiles||0)>0).length}`, inline: true },
          { name: '☢️ Wars with Nukes', value: `${def.filter(w=>(w.attacker?.nukes||0)>0).length}`, inline: true },
          { name: '📄 Full Report', value: 'CSV attached below — open in Excel or Google Sheets.' },
        ).setTimestamp();
      const csv = generateWarCSV(def, true);
      const tmp = path.join(os.tmpdir(), `def_wars_${Date.now()}.csv`);
      fs.writeFileSync(tmp, csv, 'utf8');
      await interaction.editReply({ content: '', embeds: [summaryEmbed], files: [new AttachmentBuilder(tmp, { name: 'defensive_wars.csv' })] });
      setTimeout(() => { try { fs.unlinkSync(tmp); } catch {} }, 10000);
      return;
    }

    if (sub === 'offensive') {
      await interaction.deferReply();
      const all = await fetchAll();
      const off = all.filter(w => String(w.att_alliance_id) === allianceIdStr);
      if (off.length === 0) return interaction.editReply({ embeds: [new EmbedBuilder().setTitle('⚔️ Offensive Wars').setColor(0x2ecc71).setDescription('No active offensive wars.').setTimestamp()] });
      const targetAlliances = [...new Set(off.map(w => w.defender?.alliance?.name||'None'))];
      const summaryEmbed = new EmbedBuilder().setTitle(`⚔️ Offensive Wars — ${off.length}`).setColor(0x3498db)
        .addFields(
          { name: '🏛️ Alliances Being Hit', value: targetAlliances.slice(0,10).join(', ')||'None' },
          { name: '📄 Full Report', value: 'CSV attached — open in Excel or Google Sheets.' },
        ).setTimestamp();
      const csv = generateWarCSV(off, false);
      const tmp = path.join(os.tmpdir(), `off_wars_${Date.now()}.csv`);
      fs.writeFileSync(tmp, csv, 'utf8');
      await interaction.editReply({ content: '', embeds: [summaryEmbed], files: [new AttachmentBuilder(tmp, { name: 'offensive_wars.csv' })] });
      setTimeout(() => { try { fs.unlinkSync(tmp); } catch {} }, 10000);
      return;
    }

    if (sub === 'check') {
      await interaction.deferReply();
      const input  = interaction.options.getString('nation');
      const nation = await resolveNation(input);
      if (!nation) return interaction.editReply(`❌ Could not find **"${input}"**.`);
      const data = await pwQuery(`query GetNationWars($id:[Int]){wars(nation_id:$id,active:true,first:10){data{id attid defid attacker{id nation_name score alliance{name}} defender{id nation_name score alliance{name}} turnsleft}}}`, { id: [parseInt(nation.id)] });
      const wars = data?.wars?.data || [];
      if (wars.length === 0) return interaction.editReply({ embeds: [new EmbedBuilder().setTitle(`⚔️ ${safeName(nation.nation_name)}`).setColor(0x2ecc71).setDescription('✅ No active wars.').setTimestamp()] });
      const nIdStr = String(nation.id);
      const lines  = wars.map(w => {
        const isAtt = String(w.attid) === nIdStr;
        const opp   = isAtt ? w.defender : w.attacker;
        return `${isAtt?'⚔️':'🛡️'} **[${safeName(opp?.nation_name)}](https://politicsandwar.com/nation/id=${opp?.id})** — ${safeName(opp?.alliance?.name)} | Score: ${safeScore(opp?.score)}\n└ Turns: ${w.turnsleft||'?'} | [View](https://politicsandwar.com/nation/war/timeline/war=${w.id})`;
      });
      return interaction.editReply({ content: '', embeds: [new EmbedBuilder().setTitle(`⚔️ War Status — ${safeName(nation.nation_name)}`).setColor(0xe74c3c).setDescription(lines.join('\n\n').slice(0,3900)).addFields({ name: '🪖 Military', value: `✈️ ${safeMil(nation.aircraft)} | 🚗 ${safeMil(nation.tanks)} | 👮 ${(nation.soldiers||0).toLocaleString()} | 🚢 ${safeMil(nation.ships)} | 🚀 ${safeMil(nation.missiles)} | ☢️ ${safeMil(nation.nukes)}` }).setFooter({ text: `Nation ID: ${nation.id}` }).setTimestamp()] });
    }
  },
};
