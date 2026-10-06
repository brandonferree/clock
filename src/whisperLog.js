const { EmbedBuilder } = require('discord.js');
const { getGuild, save } = require('./store');
const { logAction, mention, daySegment, COLORS } = require('./game');
const { whisperRules, whispersMonitored } = require('./whisperRules');
const { sessionsToday, remaining, recordedRooms } = require('./whisperSessions');

/**
 * What the town gets to see of the whispering.
 *
 * The two modes answer different questions and neither replaces the other.
 * `live` is *observation*: a single message, edited in place, showing only who
 * is talking right now — no history, no timestamps, nothing to scroll back
 * through. It reads like glancing across a crowded room, which is exactly the
 * information you would have at a real table and no more. `summary` is
 * *recollection*: silence all day, then one post when the town is called in,
 * listing the rooms that met.
 *
 * The summary lands at the gather rather than at nightfall because that is when
 * the record is complete — whispering ends when the town is called in — and
 * because it is most useful in the sixty seconds before nominations open.
 */
const showsLive = (game) => whispersMonitored(game) && whisperRules(game).log !== 'summary';
const showsSummary = (game) => whispersMonitored(game) && whisperRules(game).log !== 'live';

/** `Alice · Bob · Carol` — the people in one room, in seat-independent order. */
function roomLine(game, session) {
  return session.members.map((id) => mention(game, id)).join(' · ');
}

/**
 * The same line, with the room itself hung off the end as a link.
 *
 * `<#id>` on a private thread renders as a normal channel jump for the people
 * in it and as an unclickable name for everyone else, so the link leaks
 * nothing the line beside it has not already said out loud.
 */
function roomLink(game, session) {
  const names = roomLine(game, session);
  return session.threadId ? `${names} — <#${session.threadId}>` : names;
}

/** `Day 1` / `Days 1, 3` — when a room met. */
function daysMet(days) {
  return `${days.length === 1 ? 'Day' : 'Days'} ${[...days].sort((a, b) => a - b).join(', ')}`;
}

/**
 * The standing record in #whispers: every room this game has opened, with a
 * link into each one.
 *
 * Rooms are locked at the gather but no longer archived, so they stay listed
 * under the channel — this is the index over the top of that, for finding the
 * conversation you had two days ago without scrolling the sidebar. It is one
 * message, edited in place, so the record never becomes a wall of its own.
 *
 * Only in the modes that already publish a summary. `live` is defined by having
 * no history — a pinned list of every room of the game is precisely the history
 * that mode exists to withhold, and adding it here would quietly repeal the
 * Storyteller's choice.
 */
function recordPayload(game) {
  const rooms = recordedRooms(game);
  const lines = rooms.map(
    (room) =>
      `• ${room.threadId ? `<#${room.threadId}>` : '*room gone*'} — ` +
      `${room.members.map((id) => mention(game, id)).join(' · ')} *(${daysMet(room.days)})*`
  );
  // Room count is bounded by who can pair off with whom, so this only bites in
  // a very long game — and a truncated tail is better than a message Discord
  // refuses to accept.
  let body = lines.join('\n');
  if (body.length > 3800) {
    body = `${body.slice(0, 3800).split('\n').slice(0, -1).join('\n')}\n*…older rooms are in the channel list.*`;
  }

  return {
    embeds: [
      new EmbedBuilder()
        .setTitle('📜 Every private room this game')
        .setColor(COLORS.vote)
        .setDescription(
          rooms.length
            ? `${body}\n\n*Locked rooms stay readable — click through to read back what was said.*`
            : '*Nobody has stepped aside yet this game.*'
        )
        .setFooter({ text: 'Updated as rooms open. Only the people in a room can read it.' }),
    ],
  };
}

/**
 * Post or update the record. Cheap to call after anything that opens a room.
 */
async function refreshWhisperRecord(guild) {
  const cfg = getGuild(guild.id);
  const game = cfg.game;
  if (!game || !showsSummary(game)) return;
  const channel = cfg.channels.whispers && (await guild.channels.fetch(cfg.channels.whispers).catch(() => null));
  if (!channel) return;

  const existing = game.whisperRecordId && (await channel.messages.fetch(game.whisperRecordId).catch(() => null));
  if (existing) {
    await existing.edit(recordPayload(game)).catch(() => null);
    return;
  }
  const msg = await channel.send(recordPayload(game)).catch(() => null);
  // Pinned so it is reachable from the channel header even after a day of
  // panels has pushed it up. A server that has not given the bot Manage
  // Messages just gets an unpinned one, which still works.
  await msg?.pin().catch(() => null);
  game.whisperRecordId = msg?.id ?? null;
  save();
}

function livePayload(game) {
  const rooms = sessionsToday(game);
  return {
    embeds: [
      new EmbedBuilder()
        .setTitle('🤫 Talking privately right now')
        .setColor(COLORS.vote)
        .setDescription(
          rooms.length
            ? rooms.map((s) => `• ${roomLine(game, s)}`).join('\n').slice(0, 4000)
            : '*Nobody has stepped aside yet.*'
        )
        .setFooter({ text: `Day ${game.day} · this panel is rewritten as rooms open, never added to.` }),
    ],
  };
}

/**
 * Rewrite the live panel in #game-log, posting it if it is not up yet.
 *
 * Cheap to call: it is a no-op in every mode and phase that does not show one,
 * so callers can fire it after anything that might have changed the picture
 * rather than working out whether it did.
 */
async function refreshLiveLog(guild) {
  const cfg = getGuild(guild.id);
  const game = cfg.game;
  if (!game || !showsLive(game)) return;
  if (game.phase !== 'day' || daySegment(game) !== 'discussion') return;
  const channel = cfg.channels.gameLog && (await guild.channels.fetch(cfg.channels.gameLog).catch(() => null));
  if (!channel) return;

  const existing = game.whisperLiveId && (await channel.messages.fetch(game.whisperLiveId).catch(() => null));
  if (existing) {
    await existing.edit(livePayload(game)).catch(() => null);
    return;
  }
  const msg = await channel.send(livePayload(game)).catch(() => null);
  game.whisperLiveId = msg?.id ?? null;
  save();
}

/**
 * Take the live panel down. It describes the present tense, and once the rooms
 * are locked there is no present tense left for it to describe — leaving it up
 * would show a town still whispering through the nominations.
 */
async function clearLiveLog(guild) {
  const cfg = getGuild(guild.id);
  const game = cfg.game;
  if (!game?.whisperLiveId) return;
  const channel = cfg.channels.gameLog && (await guild.channels.fetch(cfg.channels.gameLog).catch(() => null));
  const msg = channel && (await channel.messages.fetch(game.whisperLiveId).catch(() => null));
  await msg?.delete().catch(() => null);
  game.whisperLiveId = null;
  save();
}

/**
 * The day's record, posted once when the town gathers. Returns how many rooms
 * it listed, or null if this game does not post one.
 */
async function postSummary(guild) {
  const cfg = getGuild(guild.id);
  const game = cfg.game;
  if (!game || !showsSummary(game)) return null;

  const rooms = sessionsToday(game);
  const unspent = Object.keys(game.players)
    .map((id) => [id, remaining(game, id)])
    .filter(([, left]) => left > 0);

  await logAction(guild, {
    title: `🤫 Whispers — Day ${game.day}`,
    color: 'vote',
    description: rooms.length
      ? rooms.map((s, i) => `**${i + 1}.** ${roomLink(game, s)}`).join('\n').slice(0, 4000)
      : '*Nobody stepped aside today. Whatever was said, the whole town heard it.*',
    fields: unspent.length
      ? [
          {
            name: 'Whispers unspent',
            value: unspent
              .map(([id, left]) => `${mention(game, id)} — ${left}`)
              .join('\n')
              .slice(0, 1024),
          },
        ]
      : undefined,
  });
  return rooms.length;
}

module.exports = {
  refreshLiveLog,
  clearLiveLog,
  postSummary,
  refreshWhisperRecord,
  recordPayload,
  livePayload,
  showsLive,
  showsSummary,
  roomLine,
  roomLink,
};
