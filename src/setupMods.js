const { rolesById, SETUP_TABLE } = require('./data/scripts');

/**
 * Characters that change the setup — the ones whose text carries a bracketed
 * note like "[+2 Outsiders]".
 *
 * The bot deals straight from the official table, which is the *unmodified*
 * distribution. A Baron in play means that table is wrong, and nothing in the
 * deal knows it. This is the single easiest way to run a broken game, and the
 * damage is done the moment characters are published — so every one of these
 * gets said out loud, on the panel and again in the publish review.
 *
 * `roles.json` already flags them with `setup: true`, so the *detection* is
 * data-driven and picks up any character added later. What is spelled out here
 * is the fix: how the counts move, and what the Storyteller has to do by hand.
 * `delta` is in bag terms — Townsfolk seats give way to Outsiders and so on —
 * and is left out entirely where the change is not a simple count.
 *
 * Three states, and the middle one is easy to lose: a `delta` means the counts
 * move by exactly that much; `NO_COUNT_CHANGE` means they provably do not move,
 * but the Storyteller still has work to do; and no `delta` at all means the
 * right counts are a judgement call. Omitting a `delta` to mean "no change"
 * would report a Drunk as though the split were up for debate.
 */
const NO_COUNT_CHANGE = Object.freeze({});

const GUIDANCE = {
  baron: {
    delta: { townsfolk: -2, outsider: +2 },
    action: 'Swap **2 Townsfolk for 2 Outsiders**.',
  },
  drunk: {
    // No count change. The Drunk *is* one of the Outsiders the table already
    // called for — it fills that slot, it does not create one. Giving it
    // `townsfolk: -1, outsider: +1` double-counted against a Baron, whose +2
    // had already made the slots the Drunk then sits in: 8 players with both
    // came out as 2/4/1/1 when the right answer is the Baron's 3/3/1/1, with
    // the Drunk as one of those three Outsiders.
    //
    // The Townsfolk token the Drunk is shown is a *fake* — that character is
    // not in play, and no seat is spent on it. The town believes it is looking
    // at one more Townsfolk and one fewer Outsider than the bag holds, which is
    // the whole point of the character and none of the Storyteller's arithmetic.
    delta: NO_COUNT_CHANGE,
    action:
      'The Drunk fills an Outsider slot but **must be told a Townsfolk character** — publishing the Drunk card itself ' +
      'tells them they are the Drunk, which is the one thing they may never know. Assign them the Townsfolk they think ' +
      'they are, and remember which seat it is. The counts do not move: the Drunk is one of your Outsiders.',
  },
  godfather: {
    ambiguous: true,
    action: 'Add **or** remove **1 Outsider** — your call, then swap a Townsfolk the other way.',
  },
  fanggu: {
    delta: { townsfolk: -1, outsider: +1 },
    action: 'Swap **1 Townsfolk for 1 Outsider**.',
  },
  vigormortis: {
    delta: { townsfolk: +1, outsider: -1 },
    action: 'Swap **1 Outsider for 1 Townsfolk**.',
  },
  balloonist: {
    delta: { townsfolk: -1, outsider: +1 },
    action: 'Swap **1 Townsfolk for 1 Outsider**.',
  },
  huntsman: {
    delta: { townsfolk: -1, outsider: +1 },
    action: 'The **Damsel** must be in play — add her in place of a Townsfolk.',
  },
  choirboy: {
    action: 'The **King** must be in play — make sure one of your Townsfolk is the King.',
  },
  lilmonsta: {
    delta: { minion: +1, demon: -1 },
    action: 'No Demon is dealt — add **1 extra Minion** instead, and hand Lil’ Monsta’s token to the Minions at night.',
  },
  marionette: {
    action:
      'The Marionette must **neighbour the Demon**, and that player must be told they are a **good character** — ' +
      'publishing the Marionette card spoils it. Seat them next to the Demon first.',
  },
  atheist: {
    action: 'There are **no evil characters at all** — the whole town is good, and you break the rules instead.',
  },
  bountyhunter: {
    action: '**1 Townsfolk is evil.** Pick which one, and tell them privately.',
  },
  legion: {
    action: '**Most players are Legion.** The setup table does not apply — deal this one by hand.',
  },
  riot: {
    action: '**All Minions are Riot.** The setup table does not apply — deal this one by hand.',
  },
};

/** The "[+2 Outsiders]" tail of a character's ability, if it has one. */
function bracketNote(role) {
  return role?.ability?.match(/\[([^\]]+)\]\s*$/)?.[1] ?? null;
}

/**
 * Every setup-modifying character currently staged, with what to do about it.
 * Staged, not delivered: the point is to catch these while they can still be fixed.
 */
function stagedSetupMods(game) {
  if (!game?.players) return [];
  const seen = new Set();
  const mods = [];
  for (const [playerId, p] of Object.entries(game.players)) {
    const role = p.character && rolesById.get(p.character);
    if (!role?.setup || seen.has(role.id)) continue;
    seen.add(role.id);
    const guide = GUIDANCE[role.id] ?? {};
    mods.push({
      playerId,
      role,
      note: bracketNote(role),
      action: guide.action ?? 'Adjust the setup by hand before publishing.',
      delta: guide.delta ?? null,
      ambiguous: Boolean(guide.ambiguous) || !guide.delta,
    });
  }
  return mods;
}

/** The team split currently staged, as [townsfolk, outsiders, minions, demons]. */
function stagedCounts(game) {
  const tally = { townsfolk: 0, outsider: 0, minion: 0, demon: 0 };
  for (const p of Object.values(game.players ?? {})) {
    const team = p.character && rolesById.get(p.character)?.team;
    if (team in tally) tally[team] += 1;
  }
  return [tally.townsfolk, tally.outsider, tally.minion, tally.demon];
}

/**
 * What the split *should* be: the official table for this player count, plus
 * every deterministic modifier in play. Returns null past 15 players, and flags
 * `ambiguous` when something in play (a Godfather, a Legion) means no single
 * target is correct.
 */
function targetCounts(game, mods = stagedSetupMods(game)) {
  const seated = Object.keys(game.players ?? {}).length;
  const base = SETUP_TABLE[Math.min(Math.max(seated, 5), 15)];
  if (!base) return null;
  const target = [...base];
  const order = ['townsfolk', 'outsider', 'minion', 'demon'];
  let ambiguous = false;
  for (const mod of mods) {
    if (!mod.delta) {
      ambiguous = true;
      continue;
    }
    order.forEach((team, i) => {
      target[i] += mod.delta[team] ?? 0;
    });
  }
  return { base, target, ambiguous, changed: base.join('/') !== target.join('/') };
}

/**
 * The warning block, or null when there is nothing to warn about. Shared by the
 * panel and the publish review so the Storyteller reads the same thing twice
 * rather than two half-versions of it.
 *
 * `counts: false` drops the base→target line for callers that already show the
 * numbers themselves — the assignment panel does, in its own field.
 */
function setupWarning(game, { heading = '⚠️ **Setup-modifying characters in play**', counts: showCounts = true } = {}) {
  const mods = stagedSetupMods(game);
  if (!mods.length) return null;
  const counts = showCounts ? targetCounts(game, mods) : null;
  const actual = stagedCounts(game);

  // The heading is dropped when the surrounding UI already provides one.
  const lines = heading ? [heading] : [];
  for (const mod of mods) {
    lines.push(`• **${mod.role.name}**${mod.note ? ` *[${mod.note}]*` : ''} — ${mod.action}`);
  }
  if (counts) {
    const matches = counts.target.join('/') === actual.join('/');
    lines.push(
      `Table for ${Object.keys(game.players).length}: **${counts.base.join('/')}** → should be ` +
        `**${counts.target.join('/')}**${counts.ambiguous ? ' *(at least — some of the above is your call)*' : ''}. ` +
        `You have staged **${actual.join('/')}** ${matches && !counts.ambiguous ? '✅' : '⚠️'}`
    );
  }
  lines.push('*The random deal never applies these — fix the spread before you publish.*');
  return lines.join('\n');
}

module.exports = { stagedSetupMods, stagedCounts, targetCounts, setupWarning, bracketNote, GUIDANCE };
