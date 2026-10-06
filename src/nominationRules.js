const { rolesById } = require('./data/scripts');

/**
 * The Virgin: the one ability that fires on a nomination rather than at night.
 *
 * "The first time you are nominated, if the nominator is a Townsfolk, they are
 * executed immediately." Two things about that sentence keep tripping tables
 * up, so they are worth writing down where the code lives:
 *
 *   1. It is the *nominator* who dies, not the Virgin. A Slayer who nominates
 *      the Virgin has just executed themselves.
 *   2. It fires on the *first* nomination, whether or not anyone dies. A Minion
 *      nominating the Virgin burns the ability for nothing.
 *
 * The bot cannot decide this on its own, and deliberately does not try. Whether
 * the nominator registers as a Townsfolk is a Storyteller call every time: the
 * Drunk is holding a Townsfolk token in this grimoire and is not one, the Spy
 * may register as one, and a poisoned Virgin has no ability at all. So this
 * works out what is *probably* true, says out loud everything it cannot know,
 * and hands the decision to the Storyteller.
 */

/** Is the Virgin's ability already spent? The token is the record, as at a table. */
function virginSpent(player) {
  return !!player.reminders?.some((r) => r.role === 'virgin' && /no ability/i.test(r.text));
}

/** Is this player's ability switched off — poisoned, or dead? */
function abilityOff(player) {
  return !player.alive || !!player.reminders?.some((r) => /poison/i.test(r.text));
}

/**
 * Does this nomination wake the Virgin up? Returns null when it does not, or
 * the Storyteller's decision, pre-argued.
 *
 * `fires` is the suggestion — what the grimoire says, taken at face value. It is
 * never acted on without a press, because every one of the caveats below is a
 * case where the grimoire lies on purpose.
 */
function virginTrigger(game, nominatorId, nomineeId) {
  const virgin = game.players[nomineeId];
  const nominator = game.players[nominatorId];
  if (!virgin || !nominator) return null;
  if (virgin.character !== 'virgin') return null;
  // A dead Virgin has no ability and a spent one has nothing left, so neither is
  // a decision worth interrupting the Storyteller for.
  if (!virgin.alive || virginSpent(virgin)) return null;

  const role = rolesById.get(nominator.character);
  const team = role?.team;
  const poisoned = abilityOff(virgin);
  const fires = team === 'townsfolk' && !poisoned;

  const caveats = [];
  if (poisoned) {
    caveats.push(
      `**${virgin.name} is poisoned** — the Virgin has no ability tonight, so nothing should happen. Your call.`
    );
  }
  if (team === 'townsfolk') {
    // The one case the grimoire cannot answer: the Drunk is holding a Townsfolk
    // token in this very grimoire and is an Outsider.
    caveats.push(
      `**${nominator.name} holds the ${role.name} token.** If they are your **Drunk**, they are an Outsider — ` +
        'nothing happens, and only you know why.'
    );
  }
  if (nominator.character === 'spy') {
    caveats.push(
      `**${nominator.name} is the Spy** — they may register as a Townsfolk. Executing them is legal and completely ` +
        'up to you; it is also the single best cover a Spy will ever get.'
    );
  }
  if (nominator.character === 'recluse') {
    caveats.push(
      `**${nominator.name} is the Recluse** — they misregister as *evil*, never as a Townsfolk, so this normally ` +
        'does nothing. Registering them as a Townsfolk is not one of the options the Recluse gives you.'
    );
  }
  if (team === 'minion' || team === 'demon') {
    caveats.push(
      `**${nominator.name} is evil** (${role.name}) — no execution, but the Virgin's ability is spent all the same.`
    );
  }
  if (team === 'outsider' && nominator.character !== 'recluse') {
    caveats.push(`**${nominator.name} is an Outsider** (${role.name}), not a Townsfolk — no execution, but the ability is spent.`);
  }
  if (team === 'traveler') {
    caveats.push(`**${nominator.name} is a Traveler**, not a Townsfolk — the Virgin does not trigger.`);
  }

  return { virginId: nomineeId, nominatorId, fires, caveats };
}

module.exports = { virginTrigger, virginSpent };
