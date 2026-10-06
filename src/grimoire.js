const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { getGuild, save } = require('./store');
const { mention, COLORS } = require('./game');
const { rolesById, editions, TEAM_LABEL } = require('./data/scripts');
const { renderGrimoire } = require('./render');

const TEAM_EMOJI = {
  townsfolk: '🔵',
  outsider: '🟦',
  minion: '🔴',
  demon: '👹',
  traveler: '🟣',
  fabled: '⭐',
};

/**
 * A player's reminder tokens as an indented subline, or '' if they have none.
 * Each names the character the token belongs to — a shared 🔖 on every one left
 * "Wrong" and "Red herring" indistinguishable as to whose token they were.
 *
 * Small text on its own line, and italic rather than inline code: the player's
 * own line then never wraps no matter how many tokens they are carrying.
 */
function reminderSuffix(player) {
  if (!player.reminders?.length) return '';
  const tokens = player.reminders.map((rem) => {
    const src = rolesById.get(rem.role);
    const emoji = src ? (TEAM_EMOJI[src.team] ?? '🔖') : '🔖';
    return `${emoji} *${src?.name ?? rem.role}: ${rem.text}*`;
  });
  return `\n-# ↳ ${tokens.join(' · ')}`;
}

/** The at-a-glance town board: who is alive, who they are, current phase. */
function boardEmbed(game) {
  const script = editions.find((e) => e.id === game.script);
  const entries = Object.entries(game.players);
  const alive = entries.filter(([, p]) => p.alive).length;
  const needed = Math.ceil(alive / 2);

  const lines = entries.map(([id, p]) => {
    const role = p.character && rolesById.get(p.character);
    const who = mention(game, id);
    const what = role ? `${TEAM_EMOJI[role.team] ?? ''} **${role.name}**` : '*unassigned*';
    const rems = reminderSuffix(p);
    if (p.alive) return `🟢 ${who} — ${what}${rems}`;
    return `💀 ~~${who}~~ — ${what}${p.deadVoteUsed ? ' · *dead vote spent*' : ' · *dead vote available*'}${rems}`;
  });

  const phase =
    game.status === 'lobby'
      ? 'Lobby'
      : `${game.phase === 'night' ? '🌙 Night' : '☀️ Day'} ${game.day}`;

  return new EmbedBuilder()
    .setTitle('📖 Grimoire')
    .setColor(game.phase === 'night' ? COLORS.night : COLORS.day)
    .setDescription(lines.join('\n') || '*No players seated.*')
    .addFields(
      { name: 'Phase', value: phase, inline: true },
      { name: 'Alive', value: `${alive} / ${entries.length}`, inline: true },
      { name: 'Votes to execute', value: `${needed}`, inline: true }
    )
    .setFooter({ text: `${script?.name ?? game.script} · updates automatically` })
    .setTimestamp(new Date());
}

/** Post the board, or edit the existing one in place. Safe to call on every change. */
async function updateBoard(guild) {
  const cfg = getGuild(guild.id);
  const game = cfg.game;
  if (!game || !cfg.channels.grimoire) return null;
  const channel = await guild.channels.fetch(cfg.channels.grimoire).catch(() => null);
  if (!channel) return null;

  const embed = boardEmbed(game);
  if (cfg.channels.boardMessageId) {
    const existing = await channel.messages.fetch(cfg.channels.boardMessageId).catch(() => null);
    if (existing) {
      await existing.edit({ embeds: [embed] }).catch(() => null);
      return existing;
    }
  }
  const msg = await channel.send({ embeds: [embed] }).catch(() => null);
  if (msg) {
    await msg.pin().catch(() => null);
    cfg.channels.boardMessageId = msg.id;
    save();
  }
  return msg;
}

/**
 * The Storyteller's full private view: every player with their character and
 * reminder tokens, plus the rendered board with alignments revealed. Shared by
 * `/st grimoire` and the 📖 button on the wake list, so the two cannot drift.
 *
 * Hidden information from end to end — only ever send this as an ephemeral
 * reply, never into a channel a player can read.
 *
 * Rendering fetches character art on a cold cache, so defer before calling.
 */
async function grimoireView(game) {
  const lines = Object.entries(game.players).map(([id, p]) => {
    const role = p.character && rolesById.get(p.character);
    return `${p.alive ? '🙂' : '💀'} ${mention(game, id)} — **${role?.name ?? 'unassigned'}**${reminderSuffix(p)}`;
  });
  const embed = new EmbedBuilder()
    .setTitle('📖 Grimoire')
    .setColor(COLORS.vote)
    .setDescription(lines.join('\n') || '*No players.*');

  // The board picture is a bonus — if it fails, still send the text.
  const png = await renderGrimoire(game, { reveal: true }).catch(() => null);
  if (!png) return { embeds: [embed], files: [] };
  embed.setImage('attachment://grimoire.png');
  return { embeds: [embed], files: [new AttachmentBuilder(png, { name: 'grimoire.png' })] };
}

/**
 * Whether a message is one panel of the old character-reference wall.
 *
 * The wall was a header (`📜 Trouble Brewing — character reference`) followed
 * by one embed per team (`🔵 Townsfolk`, `👹 Demon`, with a `(1–25)` suffix on
 * the teams too long for a single embed). Recognising it by title is what lets
 * the sweep below find a wall whose message ids were never recorded.
 */
const WALL_TITLE = new RegExp(
  '^(?:📜\\s*.+—\\s*character reference' +
    `|.\\s*(?:${Object.values(TEAM_LABEL).join('|')})(?:\\s*\\(\\d+–\\d+\\))?)$`,
  'u'
);

function isWall(msg, meId) {
  if (msg.author?.id !== meId || msg.embeds.length !== 1) return false;
  const title = msg.embeds[0].title ?? '';
  // The pinned board is a single embed by the bot too, and losing it would cost
  // the Storyteller the one thing #grimoire exists for.
  if (title === '📖 Grimoire') return false;
  return WALL_TITLE.test(title);
}

/**
 * Take down the per-team character reference in #grimoire.
 *
 * That reference used to be posted at the start of every game: a header plus
 * one embed per team, every character on the script with its full ability
 * text. It was five screens of wall in the one channel the Storyteller needs to
 * be able to read at a glance, and everything it said is on the sheets now
 * pinned in the town square — where the players who actually need it are.
 *
 * Deleting only the ids we stored was not enough. `/setup`, a channel recycle
 * and every reset clear `scriptMessageIds`, and on the servers that have been
 * running longest the wall predates the field entirely — so the ids are gone
 * while the wall is still sitting there, and no future game would ever remove
 * it. The stored ids are a fast path now; the sweep below is what actually
 * guarantees the channel comes back to just the board.
 */
async function clearScriptReference(guild) {
  const cfg = getGuild(guild.id);
  if (!cfg.channels.grimoire) return 0;
  const channel = await guild.channels.fetch(cfg.channels.grimoire).catch(() => null);
  if (!channel) return 0;

  // Keyed by id: a message can be both stored and swept, and deleting it twice
  // would log a 404 for something that worked.
  const doomed = new Map();
  for (const id of cfg.channels.scriptMessageIds ?? []) {
    const old = await channel.messages.fetch(id).catch(() => null);
    if (old) doomed.set(old.id, old);
  }

  // The wall is at most a dozen messages, in a channel that only ever holds the
  // board and the panels, so one page reaches back further than it ever needs to.
  const meId = guild.client.user.id;
  const recent = await channel.messages.fetch({ limit: 100 }).catch((err) => {
    console.error('Could not read #grimoire to clear the old character reference:', err);
    return null;
  });
  for (const msg of recent?.values() ?? []) {
    if (isWall(msg, meId)) doomed.set(msg.id, msg);
  }

  let removed = 0;
  for (const msg of doomed.values()) {
    if (await msg.delete().catch(() => null)) removed++;
  }
  cfg.channels.scriptMessageIds = [];
  save();
  return removed;
}

module.exports = { updateBoard, clearScriptReference, boardEmbed, reminderSuffix, grimoireView, isWall };
