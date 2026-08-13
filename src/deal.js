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
 * This is the only place a character reaches a player, so every path that sets
 * `player.character` must call it — otherwise the grimoire knows something the
 * player does not. Returns false if there was no thread to deliver to, so the
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
 * Randomly deal the whole town from the official setup table, then deliver each
 * character to its player.
 *
 * Setup-modifying abilities (Baron, Drunk, Fang Gu…) are not applied — the
 * Storyteller adjusts with `/assign` afterwards, which re-delivers.
 */
async function dealCharacters(guild, game) {
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
  save();

  // Deliver only after every character is committed, so a mid-loop failure
  // cannot leave the town half-dealt.
  const undelivered = [];
  for (const { id } of dealt) {
    const ok = await deliverCharacter(guild, game, id);
    if (!ok) undelivered.push(id);
  }
  return { dist, dealt, undelivered };
}

module.exports = { shuffle, characterEmbed, deliverCharacter, dealCharacters };
