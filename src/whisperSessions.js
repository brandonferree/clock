const { save } = require('./store');
const { mention, daySegment } = require('./game');
const { whisperRules, whispersMonitored } = require('./whisperRules');

/**
 * Room identity and the day's ledger.
 *
 * A room is identified by the *set* of people in it, never by who opened it. So
 * {A,B} and {A,B,C} are different rooms with different threads, and a pair can
 * never quietly grow into a trio by someone being added later — the thread a
 * pair built its trust in is not the thread a third person walks into.
 *
 * Every key in the bot comes from `whisperKey`. Building one inline anywhere
 * else is how a sorted key and an unsorted one end up pointing at two threads
 * for the same two people, which is the kind of bug that only shows up in a
 * real game.
 */
function whisperKey(ids) {
  return [...new Set(ids)].sort().join(':');
}

function membersOf(key) {
  return key ? key.split(':') : [];
}

/**
 * Today's ledger, built on demand.
 *
 * Keyed on the day number rather than wiped by a dawn hook. A ledger that
 * rebuilds itself the first time it is asked about a new day cannot be left
 * stale by a code path that forgot to call the reset, by a game restored from
 * disk mid-night, or by a Storyteller who moved the day along with `/st`
 * instead of the panel.
 */
function ledger(game) {
  if (!game.whisperDay || game.whisperDay.day !== game.day) {
    game.whisperDay = { day: game.day, spent: {}, sessions: [], closed: false };
  }
  return game.whisperDay;
}

/** The rooms opened today, in the order they opened. */
function sessionsToday(game) {
  return ledger(game).sessions;
}

/**
 * Every room this game has ever opened, keyed the same way the threads are.
 *
 * The day's ledger is deliberately forgetful — it rebuilds itself each dawn,
 * because its job is accounting for today's budget. The record is the opposite:
 * it only ever grows, so the town can be shown the whole game's worth of rooms
 * in one place instead of scrolling back through the log for a list that was
 * only ever posted a day at a time.
 */
function roomRecord(game) {
  game.whisperRecord ??= {};
  return game.whisperRecord;
}

/**
 * The record as a list: one entry per room, first meeting first, each carrying
 * the days it met on. Sorted by first day so it reads as the game happened.
 */
function recordedRooms(game) {
  return Object.entries(roomRecord(game))
    .map(([key, entry]) => ({ key, members: membersOf(key), ...entry }))
    .sort((a, b) => (a.days[0] ?? 0) - (b.days[0] ?? 0) || a.key.localeCompare(b.key));
}

/**
 * How many people fit in one room. Two when the feature is off, so the
 * unmonitored path keeps behaving exactly as it always did: pairs, no ledger,
 * no ceremony.
 */
function roomSize(game) {
  return whispersMonitored(game) ? whisperRules(game).size : 2;
}

/** Whispers this player has left today. `Infinity` when nothing is being counted. */
function remaining(game, id) {
  if (!whispersMonitored(game)) return Infinity;
  return Math.max(0, whisperRules(game).budget - (ledger(game).spent[id] ?? 0));
}

/**
 * Whether these people may open a room together right now.
 *
 * Returns `{ ok: true }` or `{ error }` — every refusal is a sentence a player
 * can act on, because all of them are reachable by ordinary play: pressing the
 * button at night, inviting someone who has already talked their fill, or being
 * a beat too late when the town is called in.
 */
function canOpen(game, ids) {
  const size = roomSize(game);
  if (ids.length < 2) return { error: 'A room needs at least two people in it.' };
  if (ids.length > size) {
    return { error: `Rooms hold **${size}** people at most in this game.` };
  }
  for (const id of ids) {
    if (!game.players[id]) return { error: 'Everyone in a room has to be seated in this game.' };
  }
  if (!whispersMonitored(game)) return { ok: true };

  if (game.phase !== 'day') return { error: '🌙 There is no whispering at night.' };
  if (daySegment(game) === 'town') {
    return { error: '📢 The town is gathered — the whispering is over for today.' };
  }
  const broke = ids.filter((id) => remaining(game, id) < 1);
  if (broke.length) {
    return {
      error:
        broke.length === 1
          ? `${mention(game, broke[0])} has no whispers left today.`
          : `${broke.map((id) => mention(game, id)).join(' and ')} have no whispers left today.`,
    };
  }
  return { ok: true };
}

/**
 * Debit everyone and write the room into today's record.
 *
 * Reopening a room that already met today is free. Rooms only close when the
 * town is called in, so a second `recordSession` for the same key on the same
 * day is the same conversation being walked back into — not a new one. Charging
 * for it would mean a pair that opened a room in the morning could be billed
 * again for clicking through to it in the afternoon.
 *
 * `threadId` is kept on the session so the teardown at the gather can reach
 * every room it needs to close without re-deriving keys.
 */
function recordSession(game, ids, threadId) {
  const key = whisperKey(ids);
  const today = ledger(game);

  // The permanent record is written first and unconditionally. Walking back
  // into a room is free and returns early below, but the record still wants to
  // know the thread is alive today — and on the day a room is reopened after
  // the bot restarted, this is the only line that hears about it.
  const entry = (roomRecord(game)[key] ??= { threadId, days: [] });
  entry.threadId = threadId ?? entry.threadId;
  if (!entry.days.includes(game.day)) entry.days.push(game.day);

  const already = today.sessions.find((s) => s.key === key);
  if (already) {
    save();
    return already;
  }

  if (whispersMonitored(game)) {
    for (const id of new Set(ids)) today.spent[id] = (today.spent[id] ?? 0) + 1;
  }
  const session = { key, members: membersOf(key), openedAt: Date.now(), threadId };
  today.sessions.push(session);
  save();
  return session;
}

module.exports = {
  whisperKey,
  membersOf,
  ledger,
  sessionsToday,
  roomRecord,
  recordedRooms,
  roomSize,
  remaining,
  canOpen,
  recordSession,
};
