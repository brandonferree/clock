const roles = require('./roles.json');
const editions = require('./editions.json');

// Build a lookup of role id -> role, and per-script role lists.
const rolesById = new Map(roles.map((r) => [r.id, r]));

// Character token art, keyed by the same id as roles.json. This is the art the
// online grimoire at clocktower.online uses, served from the repo it is built
// from. Override with ICON_BASE_URL to serve the images yourself instead.
// `||` not `??`: dotenv turns a blank `ICON_BASE_URL=` line into an empty
// string, which would otherwise build broken URLs.
const ICON_BASE_URL =
  process.env.ICON_BASE_URL || 'https://raw.githubusercontent.com/bra1n/townsquare/main/src/assets/icons/';

/**
 * URL of a character's token image, or null if we do not know the character —
 * returning null keeps embeds clean instead of showing a broken image.
 * Accepts a role object or a role id.
 */
function iconUrl(role) {
  const id = typeof role === 'string' ? role : role?.id;
  if (!id || !rolesById.has(id)) return null;
  return `${ICON_BASE_URL}${id}.png`;
}

const TEAM_ORDER = ['townsfolk', 'outsider', 'minion', 'demon', 'traveler', 'fabled'];
const TEAM_LABEL = {
  townsfolk: 'Townsfolk',
  outsider: 'Outsider',
  minion: 'Minion',
  demon: 'Demon',
  traveler: 'Traveler',
  fabled: 'Fabled',
};

function rolesForScript(scriptId) {
  const edition = editions.find((e) => e.id === scriptId);
  if (!edition) return [];
  let list;
  if (edition.roles && edition.roles.length > 0) {
    list = edition.roles.map((id) => rolesById.get(id)).filter(Boolean);
  } else {
    list = roles.filter((r) => r.edition === scriptId);
  }
  return list.sort(
    (a, b) => TEAM_ORDER.indexOf(a.team) - TEAM_ORDER.indexOf(b.team) || a.name.localeCompare(b.name)
  );
}

function findRole(query) {
  const q = query.toLowerCase().trim();
  return (
    rolesById.get(q) ||
    roles.find((r) => r.name.toLowerCase() === q) ||
    roles.find((r) => r.name.toLowerCase().startsWith(q))
  );
}

// Official player counts: [players, townsfolk, outsiders, minions, demons]
const SETUP_TABLE = {
  5: [3, 0, 1, 1], 6: [3, 1, 1, 1], 7: [5, 0, 1, 1], 8: [5, 1, 1, 1],
  9: [5, 2, 1, 1], 10: [7, 0, 2, 1], 11: [7, 1, 2, 1], 12: [7, 2, 2, 1],
  13: [9, 0, 3, 1], 14: [9, 1, 3, 1], 15: [9, 2, 3, 1],
};

module.exports = { roles, editions, rolesById, rolesForScript, findRole, iconUrl, TEAM_LABEL, TEAM_ORDER, SETUP_TABLE };
