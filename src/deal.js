const { EmbedBuilder } = require('discord.js');
const { save } = require('./store');
const { COLORS } = require('./game');
const { rolesById, rolesForScript, iconUrl, SETUP_TABLE, TEAM_LABEL } = require('./data/scripts');

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** The "you are the X" card, as sent to a player's private Storyteller thread. */
function characterEmbed(player, role) {
  const isEvil = role.team === 'minion' || role.team === 'demon';
  return new EmbedBuilder()
    .setTitle(`${player.isBot ? `${player.name}, you` : 'You'} are the ${role.name}`)
    .setColor(isEvil ? COLORS.evil : COLORS.good)
    .setThumbnail(iconUrl(role))
    .setDescription(`**${TEAM_LABEL[role.team] ?? role.team}**\n\n${role.ability}`)
    .setFooter({ text: 'Keep this secret. Ask the Storyteller here if you have questions.' });
}

/**
 * Deliver a player's character into their private Storyteller thread.
 *
 * This is the only place a character reaches a player. Nothing calls it at
 * assignment time: `player.character` is a *staged* choice the Storyteller can
 * still change, and `player.delivered` records what was actually sent. The two
 * are reconciled by `publishCharacters`, which is the single moment the town
 * learns anything. Returns false if there was no thread to deliver to, so the
 * caller can tell the Storyteller to pass it on by hand.
 */
async function deliverCharacter(guild, game, playerId) {
  const player = game.players[playerId];
  const role = player?.character && rolesById.get(player.character);
  if (!role) return false;
  const thread = player.stThreadId && (await guild.channels.fetch(player.stThreadId).catch(() => null));
  if (!thread) return false;
  if (thread.archived) await thread.setArchived(false).catch(() => null);
  const sent = await thread
    .send({
      content: player.isBot ? undefined : `<@${playerId}>`,
      embeds: [characterEmbed(player, role)],
    })
    .catch(() => null);
  return Boolean(sent);
}

/**
 * Randomly deal the whole town from the official setup table.
 *
 * This *stages* the deal and delivers nothing: the Storyteller reviews the
 * spread, swaps whatever the setup table got wrong, and publishes when it is
 * right. Setup-modifying abilities (Baron, Drunk, Fang Gu…) are not applied,
 * which is exactly the kind of thing that needs fixing before anyone is told.
 */
function dealCharacters(game) {
  const ids = shuffle(Object.keys(game.players));
  const dist = SETUP_TABLE[Math.min(Math.max(ids.length, 5), 15)];
  if (!dist) return { error: 'Player count is outside 5–15, so the setup table does not cover it. Deal by hand with `/assign`.' };

  const pool = rolesForScript(game.script);
  const byTeam = (team) => shuffle(pool.filter((r) => r.team === team));
  const deck = [
    ...byTeam('townsfolk').slice(0, dist[0]),
    ...byTeam('outsider').slice(0, dist[1]),
    ...byTeam('minion').slice(0, dist[2]),
    ...byTeam('demon').slice(0, dist[3]),
  ];
  if (deck.length < ids.length) {
    return { error: `This script only has ${deck.length} characters for the ${ids.length} required — deal by hand with \`/assign\`.` };
  }

  const dealt = [];
  for (let i = 0; i < ids.length; i++) {
    game.players[ids[i]].character = deck[i].id;
    dealt.push({ id: ids[i], role: deck[i] });
  }
  // A new deal is a new set of in-play characters, so bluffs picked against the
  // old one may now be sitting in front of somebody. Drop them and re-pick.
  game.bluffs = null;
  save();

  return { dist, dealt };
}

/** Players whose staged character has not reached them yet. */
function pendingIds(game) {
  return Object.entries(game.players)
    .filter(([, p]) => p.character && p.delivered !== p.character)
    .map(([id]) => id);
}

/**
 * Tell the town. Every staged character that has not been delivered goes out
 * at once — the sends are started together rather than awaited one after
 * another, so fifteen players learn who they are within a moment of each other
 * instead of over the fifteen seconds a serial loop would take. Nobody gets a
 * head start on reading their ability.
 *
 * A player whose character has not changed since the last publish is skipped,
 * so correcting one seat mid-game does not re-send the other fourteen.
 *
 * Returns `{ sent, failed }` as arrays of player ids.
 */
async function publishCharacters(guild, game) {
  const ids = pendingIds(game);
  const results = await Promise.all(ids.map((id) => deliverCharacter(guild, game, id)));

  const sent = [];
  const failed = [];
  ids.forEach((id, i) => {
    if (results[i]) {
      // Only a delivery that actually landed counts — a failed one stays
      // pending so the next publish retries it.
      game.players[id].delivered = game.players[id].character;
      sent.push(id);
    } else {
      failed.push(id);
    }
  });
  save();
  return { sent, failed };
}

module.exports = {
  shuffle,
  characterEmbed,
  deliverCharacter,
  dealCharacters,
  publishCharacters,
  pendingIds,
};
