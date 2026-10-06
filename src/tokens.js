/**
 * Reminder tokens, moved the way they move at a table.
 *
 * A physical grimoire holds exactly one of each printed token: one **Poisoned**,
 * one **Protected**, one **Master**, one **Executed**. When the Poisoner points
 * at somebody new on the second night, the Storyteller does not find a second
 * Poisoned token in the box — they pick the one that is already on the board up
 * and put it down somewhere else.
 *
 * The bot used to push a new copy every time, which left last night's poison
 * sitting on a player who was long since clean: two Poisoned tokens on the
 * board, and a grimoire that no longer said what was true.
 */

/** Take one specific token off whoever is holding it. Returns their id, if any. */
function liftToken(game, role, text) {
  for (const [id, player] of Object.entries(game.players ?? {})) {
    const at = player.reminders?.findIndex((r) => r.role === role && r.text === text) ?? -1;
    if (at >= 0) {
      player.reminders.splice(at, 1);
      return id;
    }
  }
  return null;
}

/**
 * Put a token on a player, taking it off whoever had it first.
 *
 * Returns the id of the player it came from — the caller uses it to say so out
 * loud, because a token silently leaving a player is exactly the kind of change
 * a Storyteller needs to see happen.
 */
function placeToken(game, targetId, role, text) {
  const target = game.players?.[targetId];
  if (!target) return null;
  const from = liftToken(game, role, text);
  target.reminders ??= [];
  target.reminders.push({ role, text });
  return from === targetId ? null : from;
}

/**
 * How long a token stays on the board.
 *
 * Most reminder tokens are a permanent record — the Washerwoman's pair, the Red
 * herring, a Virgin's spent ability — and stay where they were put for the rest
 * of the game. These are the ones that are *temporary*, and every one of them
 * used to sit there until somebody remembered to take it off: poison that had
 * worn off two days ago still reading as poison, a Monk protection still
 * standing at noon.
 *
 *   dawn — the ability lasted the night. Gone when the town wakes.
 *   dusk — the ability lasted through today. Gone when night falls, *before*
 *          the character that placed it gets to choose again.
 *
 * The Poisoner is the reason `dusk` is a separate case from `dawn`: poison
 * lasts "tonight and tomorrow day", so it has to survive the dawn it was placed
 * before and expire at the next one. Clearing it at nightfall also means a
 * Poisoner who is dead, drunk or simply not woken leaves nothing behind.
 */
const TEMPORARY = [
  { role: 'poisoner', text: 'Poisoned', until: 'dusk', why: 'poison wears off at dusk' },
  { role: 'butler', text: 'Master', until: 'dusk', why: 'the Butler chooses again tonight' },
  { role: 'bureaucrat', text: '3 votes', until: 'dusk', why: 'the Bureaucrat chooses again tonight' },
  { role: 'thief', text: 'Negative vote', until: 'dusk', why: 'the Thief chooses again tonight' },
  { role: 'monk', text: 'Protected', until: 'dawn', why: 'protection only lasted the night' },
  { role: 'undertaker', text: 'Executed', until: 'dawn', why: 'the Undertaker has already read it' },
];

/**
 * Sweep the board of tokens whose time is up.
 *
 * `when` is the moment being entered: `dawn` as the town wakes, `dusk` as night
 * falls. Returns what came off and why, so the Storyteller can be told — this
 * is their grimoire changing without them touching it, and that is not
 * something to do silently.
 */
function expireTokens(game, when) {
  const gone = [];
  for (const spec of TEMPORARY.filter((t) => t.until === when)) {
    for (const [id, player] of Object.entries(game.players ?? {})) {
      const at = player.reminders?.findIndex((r) => r.role === spec.role && r.text === spec.text) ?? -1;
      if (at < 0) continue;
      player.reminders.splice(at, 1);
      gone.push({ id, name: player.name, text: spec.text, why: spec.why });
    }
  }
  return gone;
}

module.exports = { placeToken, liftToken, expireTokens, TEMPORARY };
