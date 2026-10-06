const { ChannelType } = require('discord.js');
const { getGuild, save } = require('./store');
const { whisperKey } = require('./whisperSessions');

/** A player's name as the town knows it — display name, or the simulated one. */
async function roomName(guild, game, id) {
  const p = game?.players?.[id];
  if (p?.isBot) return p.name;
  const member = await guild.members.fetch(id).catch(() => null);
  return member?.displayName ?? p?.name ?? 'player';
}

/**
 * Open — or walk back into — a private thread in #whispers for 2–3 people.
 *
 * Rooms are reused for the whole game. The same pair meeting on Day 3 lands in
 * the thread they used on Day 1, so the history of what they told each other is
 * still there to be read back. That is the point: a conversation you have to
 * re-establish from scratch every day is not a relationship.
 *
 * Returns `{ thread, existed }`.
 */
async function openWhisper(guild, ids, game) {
  const cfg = getGuild(guild.id);
  if (!cfg.channels.whispers) throw new Error('Whispers channel not set up. Run /setup.');
  const whispers = await guild.channels.fetch(cfg.channels.whispers);

  const key = whisperKey(ids);
  const members = key.split(':');

  // The Storyteller is a member of every room, added the same way the per-player
  // threads in `startGame` do it. A private thread is visible only to the people
  // in it — Manage Threads lets a moderator dig one out of the thread browser,
  // but that is a moderation affordance, not a seat at the table: no new-message
  // badge, nothing in the sidebar, and nothing at all for a Storyteller who is
  // not a server admin. Both the room's opening line and the #whispers topic
  // promise the Storyteller can see these, so put them in the room.
  //
  // Not folded into `members`: that list is the room's roster — it names the
  // thread, spends whisper budget, and is what the day's log reports. The
  // Storyteller is an observer of the room, not a participant in it.
  const observers = game?.storytellerId && !members.includes(game.storytellerId)
    ? [game.storytellerId]
    : [];

  const existing = cfg.whisperThreads[key]
    ? await guild.channels.fetch(cfg.whisperThreads[key]).catch(() => null)
    : null;
  if (existing) {
    // Unarchive *and* unlock. The gather locks rooms shut, and a locked thread
    // stays shut for everyone but the bot — so clearing the archive flag alone
    // would hand back a room nobody can type in.
    const reopened = existing.archived || existing.locked;
    if (reopened) await existing.edit({ archived: false, locked: false }).catch(() => null);
    // Re-added on every reopen, not just at creation: a room made under a
    // previous Storyteller, or before this fix, would otherwise stay invisible
    // to them for the rest of the game.
    for (const id of [...members, ...observers]) await existing.members.add(id).catch(() => null);
    // A divider only when the room was actually shut. Yesterday's conversation
    // and today's would otherwise run together in one scroll, and half of what
    // makes a reused room useful is being able to see where you left off.
    if (reopened && game?.day) {
      await existing.send(`── **Day ${game.day}** ──`).catch(() => null);
    }
    return { thread: existing, existed: true };
  }

  const names = [];
  for (const id of members) names.push(await roomName(guild, game, id));
  const thread = await whispers.threads.create({
    name: `🤫-${names.join('-')}`.slice(0, 100),
    type: ChannelType.PrivateThread,
    invitable: false,
    // Discord's own idle timer would otherwise archive a quiet room after an
    // hour and close it behind the bot's back, mid-day, with whispers still
    // paid for. A day is the shortest setting that cannot do that.
    autoArchiveDuration: 1440,
    reason: 'BOTC private conversation',
  });
  for (const id of [...members, ...observers]) await thread.members.add(id).catch(() => null);
  await thread.send(
    `💬 Private room for ${members.map((id) => `<@${id}>`).join(', ')}. ` +
      'Only you (and the Storyteller) can see this. It will be archived when the game ends.'
  );
  cfg.whisperThreads[key] = thread.id;
  save();
  return { thread, existed: false };
}

/** The thread behind a recorded session, or null if it has gone. */
async function threadFor(guild, session) {
  const cfg = getGuild(guild.id);
  const id = session.threadId ?? cfg.whisperThreads[session.key];
  if (!id) return null;
  return guild.channels.fetch(id).catch(() => null);
}

/** Drop a line into every open room — the sixty-second warning before the gather. */
async function announceInRooms(guild, sessions, content) {
  for (const session of sessions) {
    const thread = await threadFor(guild, session);
    await thread?.send(content).catch(() => null);
  }
}

/**
 * Shut every room opened today: locked, but left out on the shelf.
 *
 * Locking is the part that matters. An archived thread that is not locked
 * silently unarchives itself the moment anyone types in it, so archiving alone
 * would leave the whispering to quietly resume during nominations. Players keep
 * full read access either way — the record of the day stays readable, it just
 * stops taking new lines.
 *
 * Archiving is what does *not* happen here any more. An archived thread drops
 * out of the channel list and out of the sidebar, and the only way back to it
 * is the thread browser behind the icon in the top right — which is exactly
 * where a record nobody reads goes to die. Left unarchived, every room a player
 * has been in stays listed under #whispers all game, one click from the channel
 * they are already looking at. Discord's own idle timer will eventually archive
 * a room that goes a full day without a word (`autoArchiveDuration`), and
 * `openWhisper` unarchives on the way back in, so nothing is lost either way.
 */
async function closeRooms(guild, sessions) {
  let closed = 0;
  for (const session of sessions) {
    const thread = await threadFor(guild, session);
    if (!thread) continue;
    const ok = await thread.edit({ locked: true }).catch(() => null);
    if (ok) closed += 1;
  }
  return closed;
}

module.exports = { openWhisper, closeRooms, announceInRooms, threadFor };
