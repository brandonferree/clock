const { getGuild, save } = require('./store');

/** The four game channels, in the order they were created by `/setup`. */
const GAME_CHANNELS = [
  ['townSquare', 'town-square'],
  ['gameLog', 'game-log'],
  ['grimoire', 'grimoire'],
  ['whispers', 'whispers'],
];

/**
 * Wipe the game channels by replacing each one with an identical empty copy.
 *
 * Discord has no "delete every message" API — bulk delete refuses anything over
 * two weeks old and caps at 100 — so the only way to hand the next game clean
 * channels is to clone and delete. The clone carries the name, topic, category
 * and every permission overwrite across, so the replacement is the same channel
 * in every way that matters; only its ID and its history change.
 *
 * Any message ID we persisted points into a channel that no longer exists, so
 * they are all cleared here rather than left to 404 on the next fetch.
 */
async function recycleChannels(guild, reason = 'Refreshing channels between games') {
  const cfg = getGuild(guild.id);
  const refreshed = [];
  const failed = [];

  for (const [key, label] of GAME_CHANNELS) {
    const id = cfg.channels[key];
    if (!id) continue;
    const old = await guild.channels.fetch(id).catch(() => null);
    if (!old) {
      cfg.channels[key] = null;
      continue;
    }
    try {
      // Clone first: if the copy fails we still have the original.
      const position = old.rawPosition;
      const fresh = await old.clone({ reason });
      await old.delete(reason);
      // A clone lands at the bottom of the category; put it back where it was.
      await fresh.setPosition(position).catch(() => null);
      cfg.channels[key] = fresh.id;
      refreshed.push(fresh);
    } catch (err) {
      console.error(`Could not refresh #${label}:`, err);
      failed.push(label);
    }
  }

  // Pinned-board and script-reference messages lived in the old channels.
  cfg.channels.boardMessageId = null;
  cfg.channels.scriptMessageIds = [];
  // The pinned reference sheets lived in the old #town-square.
  cfg.channels.sheetMessageIds = [];
  cfg.channels.sheetMessageId = null;
  cfg.whisperThreads = {};
  save();

  return { refreshed, failed };
}

module.exports = { recycleChannels, GAME_CHANNELS };
