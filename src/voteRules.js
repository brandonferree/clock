/**
 * Who is allowed to put their hand up, and why not.
 *
 * Most of voting is arithmetic the bot already does. The Butler is the one
 * character whose ability is a *voting* rule rather than a piece of night
 * information — "you may only vote if your Master is voting" — and at a table
 * it enforces itself, because every hand goes up at the same moment and the
 * Storyteller can see both of them. Discord votes arrive one at a time, hours
 * apart, so the rule has to be enforced here or not at all.
 *
 * Everything in here is checked *before* a vote is recorded. Nothing is ever
 * retracted after the fact: a yes vote that vanishes from a public tally tells
 * the whole town that the player who cast it is the Butler, which is worse than
 * any miscount it would have fixed.
 */

/** Is this player's ability switched off tonight — poisoned, or dead? */
function abilityOff(player) {
  if (!player.alive) return true;
  return !!player.reminders?.some((r) => /poison/i.test(r.text));
}

/** Whoever the Butler pointed at, from the Master token in the grimoire. */
function masterOf(game, butlerId) {
  const butler = game.players[butlerId];
  if (!butler) return null;
  const found = Object.entries(game.players).find(([, p]) =>
    p.reminders?.some((r) => r.role === 'butler' && /master/i.test(r.text))
  );
  return found ? found[0] : null;
}

/**
 * Why this player may not cast this vote, or null if they may.
 *
 * `yes` is what they are trying to do: a Butler saying *no* is keeping their
 * hand down, which they are always free to do. Only the raised hand is
 * conditional.
 *
 * The Storyteller is never asked. A poisoned Butler has no ability, so the
 * restriction lifts by itself the moment the Poisoned token lands on them —
 * which is a thing the Storyteller is already doing in the grimoire, rather
 * than a second thing to remember at vote time.
 */
function voteBlock(game, voterId, yes) {
  const voter = game.players[voterId];
  if (!voter || !yes) return null;
  if (voter.character !== 'butler') return null;
  // A dead Butler is spending a dead vote, and a poisoned one has no ability:
  // in both cases there is no rule left to enforce.
  if (abilityOff(voter)) return null;

  const masterId = masterOf(game, voterId);
  // No Master token on the board means the choice was never recorded — the
  // first day before any night, or a Storyteller running the grimoire loosely.
  // Guessing at a rule from missing information would be worse than not
  // enforcing it.
  if (!masterId) return null;
  if (masterId === voterId) return null;

  const master = game.players[masterId];
  const theirVote = game.nomination?.votes?.[masterId];
  if (theirVote === true) return null;
  return theirVote === false
    ? `🧈 **${master?.name ?? 'Your Master'} voted no**, so your hand stays down — you may only vote when your Master votes.` +
        '\n-# Nobody else is told why. Vote **NO** to keep this quiet.'
    : `🧈 **${master?.name ?? 'Your Master'} has not voted yet.** You may only vote when your Master does — wait for their hand to go up, then vote.` +
        '\n-# Nobody else is told why. If the vote closes first, your hand stays down.';
}

/** Every Butler on the board, with whoever their Master is. */
function butlers(game) {
  return Object.entries(game.players)
    .filter(([, p]) => p.character === 'butler')
    .map(([id, player]) => ({ id, player, masterId: masterOf(game, id) }));
}

module.exports = { voteBlock, masterOf, butlers, abilityOff };
