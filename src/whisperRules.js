/**
 * The whisper rules: how many private conversations a player gets per day, how
 * many people fit in one, and how much of it the town gets to see.
 *
 * Off by default. A server that updates the bot should not find its next game
 * silently playing under new rules — the Storyteller turns this on deliberately,
 * per game, and with it off the whisper code runs exactly as it always did.
 *
 * The rules are fixed once the game starts. Changing the information economy
 * mid-game would rewrite the terms a day was already played under, so `/game
 * new` and the lobby panel are the only places they can be set.
 */
const DEFAULTS = { enabled: false, budget: 3, size: 2, log: 'summary' };

const LOG_MODES = {
  // A single message edited in place, showing only who is talking *right now* —
  // the equivalent of glancing across a crowded room. No history, nothing to
  // scroll back through.
  live: 'Live — a running panel of who is talking right now',
  // Silence until the town is called in, then one post listing the day's rooms.
  // Recollection rather than observation.
  summary: 'Summary — one post when the town gathers',
  both: 'Both — live panel during the day, summary at the gather',
};

const BUDGET_RANGE = [1, 5];
const SIZE_RANGE = [2, 3];

const clamp = (n, [lo, hi]) => Math.min(Math.max(n, lo), hi);

/** The rules in force, with every field filled in. Never returns undefined. */
function whisperRules(game) {
  const saved = game?.whisperRules ?? {};
  return {
    enabled: Boolean(saved.enabled),
    budget: clamp(Number(saved.budget) || DEFAULTS.budget, BUDGET_RANGE),
    size: clamp(Number(saved.size) || DEFAULTS.size, SIZE_RANGE),
    log: saved.log in LOG_MODES ? saved.log : DEFAULTS.log,
  };
}

/** Whether the extra whisper machinery applies at all. */
function whispersMonitored(game) {
  return whisperRules(game).enabled;
}

/** One line for the lobby panel and the game log. */
function describeRules(game) {
  const r = whisperRules(game);
  if (!r.enabled) return '🤫 **Whispers:** unmonitored — unlimited, private, unrecorded.';
  return (
    `🤫 **Whispers:** **${r.budget}** per player per day · up to **${r.size}** people per room · ` +
    `log: **${r.log}**`
  );
}

module.exports = { whisperRules, whispersMonitored, describeRules, DEFAULTS, LOG_MODES, BUDGET_RANGE, SIZE_RANGE };
