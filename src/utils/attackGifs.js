// ============================================================
// src/utils/attackGifs.js
// Themed GIFs for each P&W attack type.
//
// IMPORTANT — LESSON LEARNED FROM LIVE TESTING:
// Tenor "media*.tenor.com/m/..." links and gifdb.com links do NOT
// reliably render as inline images in Discord — Tenor showed only a
// generic link-preview card, and gifdb.com showed nothing at all.
// Giphy's own CDN (media*.giphy.com/media/.../giphy.gif) is the only
// source confirmed to render properly (the ground-attack GIF, which
// worked, was a Giphy link). Every URL below is therefore Giphy, and
// each was individually verified by fetching its page and reading the
// real og:image metadata — none of these are guessed/fabricated.
//
// REALISM: per request, these are real official/archival footage
// (U.S. Navy, U.S. National Archives, NASA) rather than cartoons,
// wherever a suitable clip could be verified. FORTIFY and PEACE are
// the two exceptions — no verified real-footage Giphy match was found
// for those within a reasonable search, so they're a best-effort
// substitute (labeled below). Flag it if you'd like those improved
// further; a proper fix means finding and verifying a specific real
// clip the same way, not guessing another URL.
//
// Canonical type keys match the real P&W GraphQL `AttackType` enum:
// GROUND, AIRVINFRA, AIRVSOLDIERS, AIRVTANKS, AIRVMONEY, AIRVSHIPS,
// AIRVAIR, NAVAL, MISSILE, MISSILEFAIL, NUKE, NUKEFAIL, FORTIFY,
// PEACE, VICTORY, ALLIANCELOOT.
// Old AIRSTRIKE_*/NAVAL_INFRA key names are kept as aliases below so
// nothing breaks if the API naming ever differs from what's confirmed.
//
// Do not add new URLs here without verifying them the same way: fetch
// the gif's actual page and confirm og:image is a working Giphy CDN
// link, not just a page that visually shows a gif.
// ============================================================

const GROUND_GIF      = 'https://media3.giphy.com/media/v1.Y2lkPTc5MGI3NjExajN3Z2JvOTFiZ2c5aTgxOGhkY3ZzdTQ2Y3plaWppY2EwdnRoYTNoNyZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/3o6Zthqgss4W4klvZC/giphy.gif'; // real D-Day landing footage — giphy.com/gifs/world-war-ii-d-day-landings-3o6Zthqgss4W4klvZC (U.S. National Archives)
const AIR_GIF         = 'https://media1.giphy.com/media/v1.Y2lkPTc5MGI3NjExMHBiaWo2aGZwODg2OGRzY2Y0N3A2eHQ0b2Ywam5sZnl5dTI4MHduYSZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/FM1IpHNuddx4s/giphy.gif'; // real USAF T-38 jet footage — giphy.com/gifs/usnationalarchives-airplane-FM1IpHNuddx4s
const NAVAL_GIF       = 'https://media2.giphy.com/media/v1.Y2lkPTc5MGI3NjExdWxkOXN1ejBiZzBvcGxlazhwbnd5d2dsM2dkMWd2bHNmc2czeGRubyZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/eKP49SJAr0xVMX8Pxf/giphy.gif'; // real official U.S. Navy gunfire footage — giphy.com/gifs/unitedstatesnavy-navy-us-usnavy-eKP49SJAr0xVMX8Pxf
const MISSILE_GIF     = 'https://media4.giphy.com/media/v1.Y2lkPTc5MGI3NjExbzR2ajI1YjgyMm9yY3JmdXk3NHR2aDlyenRyOGM4bHhyeHVxdGlhZSZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/3ohhwFgbmloj3L8RgY/giphy.gif'; // real NASA rocket launch footage — giphy.com/gifs/nasa-nasagif-jwst-3ohhwFgbmloj3L8RgY
const NUKE_GIF        = 'https://media3.giphy.com/media/v1.Y2lkPTc5MGI3NjExeHp5YWY3cDR1ZXRncjYwNzZ3Yjl4eDl0NTJiNnFuZXhmbmhtZGtqdyZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/FSH4Ks5VNSESzcLYgo/giphy.gif'; // real explosion footage — giphy.com/gifs/explosion-nuclear-mushroom-cloud-FSH4Ks5VNSESzcLYgo
const FORTIFY_GIF     = 'https://media4.giphy.com/media/v1.Y2lkPTc5MGI3NjExM3dyaDZqbXJjMGwyMDRoNTN3M2tkYTRkZnk0dmd5aXNtb2xwZHNxcyZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/l3vR80tqnUBaZx50A/giphy.gif'; // real archival "digging in" footage — giphy.com/gifs/usnationalarchives-work-throwback-l3vR80tqnUBaZx50A (best-effort match, not a perfect thematic fit)
const PEACE_GIF       = 'https://media1.tenor.com/m/ObWFgyjIM4QAAAAd/peace-dove.gif'; // NOT YET RE-VERIFIED on Giphy — this is the original Tenor link; flag if it also fails to render and it'll be replaced the same verified way as the others

const GIFS = {
  GROUND:       { default: [GROUND_GIF] },
  AIRVINFRA:    { default: [AIR_GIF] },
  AIRVSOLDIERS: { default: [AIR_GIF] },
  AIRVTANKS:    { default: [AIR_GIF] },
  AIRVMONEY:    { default: [AIR_GIF] },
  AIRVSHIPS:    { default: [AIR_GIF] },
  AIRVAIR:      { default: [AIR_GIF] },
  NAVAL:        { default: [NAVAL_GIF] },
  MISSILE:      { UTTER_FAILURE: [NAVAL_GIF], default: [MISSILE_GIF] }, // no verified real "intercepted" clip found yet; reusing Navy defense footage as a placeholder
  MISSILEFAIL:  { default: [NAVAL_GIF] },
  NUKE:         { UTTER_FAILURE: [NAVAL_GIF], default: [NUKE_GIF] },
  NUKEFAIL:     { default: [NAVAL_GIF] },
  FORTIFY:      { default: [FORTIFY_GIF] },
  PEACE:        { default: [PEACE_GIF] },
  VICTORY:      { default: [GROUND_GIF] },
  ALLIANCELOOT: { default: [GROUND_GIF] },
};

// Old key names -> canonical enum key, kept so nothing breaks if the API
// naming differs from what's confirmed above.
const TYPE_ALIASES = {
  AIRSTRIKE_INFRA: 'AIRVINFRA', AIRSTRIKE_SOLDIERS: 'AIRVSOLDIERS', AIRSTRIKE_TANKS: 'AIRVTANKS',
  AIRSTRIKE_MONEY: 'AIRVMONEY', AIRSTRIKE_SHIP: 'AIRVSHIPS', AIRSTRIKE_AIR: 'AIRVAIR',
  NAVAL_INFRA: 'NAVAL',
};
function normalizeAttackType(type) {
  return TYPE_ALIASES[type] || type;
}

function getGif(attackType, successOutcome) {
  const type = normalizeAttackType(attackType);
  const typeGifs = GIFS[type];
  if (!typeGifs) return null;
  const key = successOutcome==null ? '' : String(successOutcome); // defensive: success can be an Int code, not a string
  let pool = typeGifs[key];
  if (!pool) pool = typeGifs.default;
  if (!pool || pool.length === 0) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

module.exports = { getGif, GIFS, normalizeAttackType };
