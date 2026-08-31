// ============================================================
// src/commands/admin/help.js
// /help — Split across multiple messages to stay under Discord's
// 6000 char total embed limit per message
// ============================================================

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

// Each category is its own message — never combined
const CATEGORIES = {
  setup: {
    name: '⚙️ Setup & Configuration',
    role: '🔒 Admin only',
    color: 0x95a5a6,
    commands: [
      { cmd: '/config alliance',        desc: 'Set your P&W alliance ID' },
      { cmd: '/config channel beige',   desc: 'Set the channel for beige exit alerts' },
      { cmd: '/config channel wars',    desc: 'Set the channel for war/defense alerts' },
      { cmd: '/config channel intel',   desc: 'Set the intel channel (military alerts, daily reports)' },
      { cmd: '/config role military',   desc: 'Set which Discord role = Military Officer' },
      { cmd: '/config role government', desc: 'Set which Discord role = Government' },
      { cmd: '/config view',            desc: 'View all current bot settings' },
      { cmd: '/alerts intervals',       desc: 'Set beige alert timing e.g. 60,30,15,5 minutes' },
      { cmd: '/backup export',  desc: 'Export all bot config (DNR, treaties, watchlists, links, settings) to a JSON file' },
{ cmd: '/backup import',  desc: 'Restore a previously exported backup — attach the JSON file' },
{ cmd: '/backup status',  desc: 'Show a summary of all current configuration in the bot' },
    ],
  },
  beige: {
    name: '🟡 Beige Tracking',
    role: '🔒 Military+',
    color: 0xf1c40f,
    commands: [
      { cmd: '/beige',            desc: 'All enemy nations in beige, sorted by expiry time' },
      { cmd: '/alerts beige on',  desc: 'Enable personal DM alerts when beige targets expire' },
      { cmd: '/alerts beige off', desc: 'Disable personal beige DM alerts' },
      { cmd: '/alerts view',      desc: 'View your current alert settings' },
    ],
  },
  intel: {
    name: '🕵️ Intelligence & Watchlists',
    role: '🔒 Military+ (coalition/treaty requires Government+)',
    color: 0x3498db,
    commands: [
      { cmd: '/intel',                    desc: 'Intelligence dashboard — enemy alliances, watched nations' },
      { cmd: '/nation',                   desc: 'Full intelligence profile of any nation' },
      { cmd: '/enemy',                    desc: 'Deep intelligence profile of any alliance' },
      { cmd: '/targets',                  desc: 'Recommended attack targets scored from watchlists' },
      { cmd: '/watch nation add',         desc: 'Watch a nation — name, ID, or P&W link (any case)' },
      { cmd: '/watch nation remove',      desc: 'Remove a nation from the watchlist' },
      { cmd: '/watch nation list',        desc: 'Show all watched nations' },
      { cmd: '/watch alliance add',       desc: 'Watch an alliance — name, ID, or P&W link (any case)' },
      { cmd: '/watch alliance remove',    desc: 'Remove an alliance from the watchlist' },
      { cmd: '/watch alliance list',      desc: 'Show all watched alliances' },
      { cmd: '/coalition add',            desc: 'Add an alliance to your friendly or enemy coalition' },
      { cmd: '/coalition remove',         desc: 'Remove an alliance from the coalition list' },
      { cmd: '/coalition list',           desc: 'Show all coalition members and enemies' },
      { cmd: '/coalition compare',        desc: 'Side-by-side military comparison vs enemy coalition' },
      { cmd: '/treaty add',               desc: 'Record a treaty (MDP/ODP/NAP/etc) with an alliance' },
      { cmd: '/treaty remove',            desc: 'Remove a treaty record' },
      { cmd: '/treaty list',              desc: 'Show your full treaty network grouped by type' },
      { cmd: '/treaty check',             desc: 'Check what treaties exist with a specific alliance' },
      { cmd: '/dnr add',                  desc: 'Add an alliance to the Do Not Raid list' },
      { cmd: '/dnr remove',               desc: 'Remove an alliance from the DNR list' },
      { cmd: '/dnr list',                 desc: 'Show the full DNR list with reasons' },
      { cmd: '/dnr check',                desc: 'Check if a specific alliance is on the DNR list' },
      { cmd: '/dnr settings',             desc: 'Configure the in-game and Discord DM messages sent to DNR violators' },
    ],
  },
  military1: {
    name: '⚔️ Military Operations (Part 1)',
    role: '🔒 Military+',
    color: 0xe74c3c,
    commands: [
      { cmd: '/assign create',       desc: 'Assign a target to a member — they get Accept/Decline buttons via DM' },
      { cmd: '/assign list',         desc: 'View all active target assignments' },
      { cmd: '/assign mine',         desc: 'View your own assignments with one-click buttons' },
      { cmd: '/assign complete',     desc: 'Mark your assignment as completed' },
      { cmd: '/assign cancel',       desc: 'Cancel an assignment — member is DM\'d with the reason' },
      { cmd: '/counter find',        desc: 'Find who can counter-attack a specific enemy nation' },
      { cmd: '/counter assign',      desc: 'Assign a member to counter a specific attacker' },
      { cmd: '/counter check',       desc: 'See which members are currently under attack' },
      { cmd: '/reserve add',         desc: 'Reserve a target to prevent double-attacks' },
      { cmd: '/reserve release',     desc: 'Release your reservation on a target' },
      { cmd: '/reserve list',        desc: 'See all currently reserved targets' },
      { cmd: '/war status',          desc: 'Overview of all active wars right now' },
      { cmd: '/war defensive',       desc: 'Full list of all members under attack (CSV download)' },
      { cmd: '/war offensive',       desc: 'Full list of all members attacking (CSV download)' },
      { cmd: '/war check',           desc: 'Check war status of any specific nation' },
    ],
  },
  military2: {
    name: '⚔️ Military Operations (Part 2)',
    role: '🔒 Military+',
    color: 0xc0392b,
    commands: [
      { cmd: '/blitzplan generate',  desc: 'Auto-pair your members with enemy targets by war range + threat level' },
      { cmd: '/blitzplan convert',   desc: 'Convert a generated plan into a real blitz operation' },
      { cmd: '/blitz create',        desc: 'Create a timed blitz with launch countdown' },
      { cmd: '/blitz list',          desc: 'View all active blitz operations' },
      { cmd: '/blitz view',          desc: 'View full details and readiness of a blitz' },
      { cmd: '/blitz ready',         desc: 'Mark yourself ready/not ready for a blitz' },
      { cmd: '/blitz ping',          desc: 'Ping all members about a blitz' },
      { cmd: '/blitz cancel',        desc: 'Cancel a blitz operation' },
      { cmd: '/operation create',    desc: 'Create a full war operation with objectives' },
      { cmd: '/operation list',      desc: 'View all operations filtered by status' },
      { cmd: '/operation view',      desc: 'View full details and target list of an operation' },
      { cmd: '/operation addtarget', desc: 'Add a target nation to an operation' },
      { cmd: '/operation status',    desc: 'Update an operation status (planning/active/completed)' },
      { cmd: '/operation report',    desc: 'Generate a completion report for an operation' },
      { cmd: '/operation warroom',   desc: 'Create private channels for an operation (main/assignments/intel/results)' },
      { cmd: '/operation archive',   desc: 'Lock war room channels but keep history' },
      { cmd: '/operation deleteroom',desc: 'Permanently delete war room channels' },
      { cmd: '/compliance set',      desc: 'Set minimum military standards' },
      { cmd: '/compliance view',     desc: 'View current compliance standards' },
      { cmd: '/compliance check',    desc: 'Check which members meet or fail compliance' },
      { cmd: '/compliance report',   desc: 'Full compliance report with pass rate' },
    ],
  },
  dashboards: {
    name: '📊 Dashboards & Reports',
    role: '🔒 Military+ (gov-dashboard requires Government+)',
    color: 0x9b59b6,
    commands: [
      { cmd: '/hq',                        desc: 'Military command dashboard — assignments, beige, reservations' },
      { cmd: '/readiness check',           desc: 'Full MMR-based alliance readiness report' },
      { cmd: '/readiness nation',          desc: 'Detailed MMR breakdown for a specific member' },
      { cmd: '/readiness weights',         desc: 'Configure how units/spies/missiles/nukes contribute to readiness score' },
      { cmd: '/health',                    desc: 'Alliance health score with grade and improvement suggestions' },
      { cmd: '/gov-dashboard',             desc: 'Government strategic overview — military, enemy comparison, ops' },
      { cmd: '/participation leaderboard', desc: 'Leaderboards — most wars, assignments, counters' },
      { cmd: '/participation snapshot',    desc: 'Pull a fresh war activity snapshot from P&W' },
      { cmd: '/participation inactive',    desc: 'Show members with zero offensive wars' },
      { cmd: '/report daily',              desc: 'Manually trigger the daily report now (Government+)' },
    ],
  },
  utility: {
    name: '🛠️ Utility',
    role: '✅ Everyone',
    color: 0x2ecc71,
    commands: [
      { cmd: '/link set',      desc: 'Link your Discord account to your P&W nation — enables mentions and auto-assignment' },
      { cmd: '/link remove',    desc: 'Unlink your nation from your Discord account' },
      { cmd: '/link check',     desc: 'Check which nation a Discord member has linked' },
      { cmd: '/link list',      desc: 'Show all linked members (Military+ only)' },
      { cmd: '/link admin_set', desc: 'Force-link a nation to a Discord member (Military+ only)' },
      { cmd: '/ping',           desc: 'Check if the bot is online and see response times' },
      { cmd: '/help',        desc: 'Show this help menu' },
      { cmd: '/help setup',  desc: 'Setup & Configuration commands' },
      { cmd: '/help beige',  desc: 'Beige Tracking commands' },
      { cmd: '/help intel',  desc: 'Intelligence & Watchlist commands' },
      { cmd: '/help military1', desc: 'Military Operations Part 1 (assign/counter/reserve/war)' },
      { cmd: '/help military2', desc: 'Military Operations Part 2 (blitz/operation/compliance)' },
      { cmd: '/help dashboards', desc: 'Dashboard & Report commands' },
    ],
  },
  auto: {
    name: '🤖 Automatic Background Features',
    role: '(runs automatically — no commands needed)',
    color: 0x1abc9c,
    commands: [
      { cmd: '🆘 Attack alerts',       desc: 'Bot checks every 60 seconds — pings wars channel instantly when a member is attacked' },
      { cmd: '🚨 Mass attack alert',   desc: 'If 3+ members are hit at once, sends an emergency alert' },
      { cmd: '🟡 Beige exit alerts',   desc: 'Fires at your configured intervals before enemy nations leave beige' },
      { cmd: '📈 Military alerts',     desc: 'Detects significant enemy military buildups every 15 minutes' },
      { cmd: '🏖️ Vacation alerts',    desc: 'Alerts when watched enemy nations enter or exit vacation mode' },
      { cmd: '⏰ War expiry alerts',   desc: 'Warns when your offensive wars are about to expire (12 and 6 turns)' },
      { cmd: '📅 Daily report',        desc: 'Automatic alliance status report sent to intel channel at 08:00 UTC' },
      { cmd: '💾  Auto backup', desc: 'Sends a full config backup to your backup channel every 6 hours automatically' },
    ],
  },
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show available bot commands')
    .addStringOption(opt =>
      opt.setName('category')
        .setDescription('Which section to show (leave blank for overview)')
        .addChoices(
          { name: '⚙️ Setup & Configuration', value: 'setup' },
          { name: '🟡 Beige Tracking', value: 'beige' },
          { name: '🕵️ Intelligence & Watchlists', value: 'intel' },
          { name: '⚔️ Military Operations Part 1', value: 'military1' },
          { name: '⚔️ Military Operations Part 2', value: 'military2' },
          { name: '📊 Dashboards & Reports', value: 'dashboards' },
          { name: '🤖 Automatic Features', value: 'auto' },
          { name: '🛠️ Utility', value: 'utility' },
        )
    ),

  requiredRole: null,

  async execute(interaction) {
    const categoryKey = interaction.options.getString('category');

    // ── SINGLE CATEGORY ──────────────────────────────────────
    if (categoryKey) {
      const cat = CATEGORIES[categoryKey];
      if (!cat) return interaction.reply({ content: '❌ Unknown category.', flags: 64 });

      const embed = new EmbedBuilder()
        .setTitle(cat.name)
        .setColor(cat.color)
        .setDescription(`**Permission:** ${cat.role}\n\u200b`)
        .addFields(cat.commands.map(c => ({ name: c.cmd, value: c.desc, inline: false })))
        .setFooter({ text: 'Use /help [category] to view other sections' })
        .setTimestamp();

      return interaction.reply({ embeds: [embed], flags: 64 });
    }

    // ── OVERVIEW — just an index, no big lists ────────────────
    // Send one small embed with navigation instructions,
    // then follow up with the auto features embed
    const indexEmbed = new EmbedBuilder()
      .setTitle('🛡️ PW Defense Bot — Command Reference')
      .setColor(0xe74c3c)
      .setDescription(
        'This bot has too many commands to show at once.\n' +
        'Use `/help [category]` to view each section:\n\u200b'
      )
      .addFields(
        { name: '⚙️ `/help setup`',      value: 'Bot configuration and channel setup', inline: true },
        { name: '🟡 `/help beige`',       value: 'Beige tracking and alerts', inline: true },
        { name: '🕵️ `/help intel`',       value: 'Intelligence, watchlists, coalition, treaties', inline: true },
        { name: '⚔️ `/help military1`',   value: 'Assign, counter, reserve, war commands', inline: true },
        { name: '⚔️ `/help military2`',   value: 'Blitz, operation, compliance commands', inline: true },
        { name: '📊 `/help dashboards`',  value: 'HQ, readiness, health, reports', inline: true },
        { name: '🤖 `/help auto`',        value: 'Automatic background features', inline: true },
        { name: '🛠️ `/help utility`',     value: 'Ping and other utilities', inline: true },
      )
      .addFields({
        name: '💡 Tips',
        value:
          '• Names, IDs, and P&W links all work in any nation/alliance field\n' +
          '• Spelling is case-insensitive — `rose`, `ROSE`, `Rose` all work\n' +
          '• Assignment DMs include Accept/Decline buttons — no typing required',
        inline: false,
      })
      .setFooter({ text: `${Object.values(CATEGORIES).reduce((s, c) => s + c.commands.length, 0)} commands total` })
      .setTimestamp();

    return interaction.reply({ embeds: [indexEmbed], flags: 64 });
  },
};
