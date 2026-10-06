const {
  ActionRowBuilder,
  EmbedBuilder,
  StringSelectMenuBuilder,
} = require('discord.js');
const { COLORS } = require('./game');
const { rolesById, rolesForScript } = require('./data/scripts');

/**
 * Rules-aware night actions: what each character asks for, what it learns, and
 * what the truthful answer would be.
 *
 * `roles.json` describes a night step in prose ("Show the finger signal (0, 1,
 * 2)…") — enough for a human, nothing a picker can be built from. This table is
 * the machine-readable half, hand-written per character, and it is deliberately
 * Trouble Brewing only for now. Every character with no entry here falls
 * through to the old behaviour: read the reminder, tick the box. Nothing
 * regresses on a script that has not been mapped yet.
 *
 * A spec is:
 *   choose   — what the *player* picks, and whether it can be gathered up front
 *   answer   — what the *Storyteller* sends back
 *   truth    — the true answer, computed from the grimoire
 *   render   — how the answer reads in the player's thread
 *
 * `truth` is only ever a suggestion. It is preselected and marked, never
 * enforced: a poisoned or drunk player must be able to be lied to, and the
 * Recluse and Spy misregister by design.
 */

// --- Seating helpers -------------------------------------------------------

/** The circle, in seat order. Insertion order is seat order everywhere else. */
function seats(game) {
  return Object.entries(game.players).map(([id, player]) => ({ id, player }));
}

/** Does this player register as evil to a character reading alignments? */
function registersEvil(player) {
  const team = rolesById.get(player.character)?.team;
  return team === 'minion' || team === 'demon';
}

/**
 * Characters that can register as the opposite alignment. They are not folded
 * into the computed answer — which way a Recluse registers is the Storyteller's
 * call, every night, and quietly deciding it for them would be deciding it for
 * them. They are surfaced as a caveat on the step panel instead.
 */
const MISREGISTERS = { recluse: 'may register as evil', spy: 'may register as good' };

/** The two nearest living neighbours of a seat — the Empath's "alive neighbours". */
function aliveNeighbours(game, id) {
  const circle = seats(game);
  const i = circle.findIndex((s) => s.id === id);
  if (i < 0) return [];
  const out = [];
  for (const dir of [-1, 1]) {
    for (let step = 1; step < circle.length; step++) {
      const seat = circle[(i + dir * step + circle.length * circle.length) % circle.length];
      if (seat.id === id) break;
      if (seat.player.alive) {
        out.push(seat);
        break;
      }
    }
  }
  return out;
}

/** Whoever is carrying the Fortune Teller's Red herring token, if anyone. */
function redHerringId(game) {
  const found = seats(game).find(({ player }) =>
    player.reminders?.some((r) => r.role === 'fortuneteller' && /red herring/i.test(r.text))
  );
  return found?.id ?? null;
}

/** Seated players on a team — the pool the first-night info characters name from. */
function playersOnTeam(game, team) {
  return seats(game).filter(({ player }) => rolesById.get(player.character)?.team === team);
}

/** Characters of one team that are on this game's script. */
function scriptTeam(game, team) {
  return rolesForScript(game.script ?? 'tb').filter((r) => r.team === team);
}

/**
 * A decoy to sit beside the true player in a "one of these two is…" pair.
 *
 * Seeded off the step key rather than random, so re-rendering the panel does
 * not reshuffle the suggestion under the Storyteller mid-decision.
 */
function decoyFor(game, exceptId, seed = '') {
  const others = seats(game).filter(({ id }) => id !== exceptId);
  if (!others.length) return null;
  let h = 0;
  for (const ch of String(seed)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return others[h % others.length].id;
}

/**
 * The Demon whose death promotes the Scarlet Woman, if tonight is that night.
 *
 * The trigger is one night only. Executed in daylight, so she is told on the
 * night that follows; killed in the night, so she is told the same night.
 * Waking her again the next night would say it twice, and waking her on any
 * other night tells her the Demon is dead — exactly the thing she is not
 * supposed to know yet.
 */
function fallenDemon(game) {
  if (seats(game).filter(({ player }) => player.alive).length < 5) return null;
  return (
    seats(game).find(({ id, player }) => {
      if (player.alive || rolesById.get(player.character)?.team !== 'demon') return false;
      if (game.lastExecuted?.id === id) return game.lastExecuted.day === game.day - 1;
      return player.diedAt === game.day;
    }) ?? null
  );
}

// --- The table -------------------------------------------------------------

/**
 * `choose.parallel` is what makes the night fast. A choice that does not depend
 * on anything happening earlier in the order — the Fortune Teller's two
 * players, the Monk's protection, the Imp's kill — is asked for the moment
 * night falls, so every player is deciding at once while the Storyteller works.
 * Information still goes back *in* order, computed against the grimoire at the
 * moment the Storyteller reaches that step, so nothing resolves against stale
 * state.
 */
const ACTIONS = {
  washerwoman: {
    answer: { kind: 'pair', team: 'townsfolk' },
    truth: (game, entry) => {
      const who = playersOnTeam(game, 'townsfolk').find(({ id }) => id !== entry.id);
      if (!who) return null;
      return { players: [who.id, decoyFor(game, who.id, entry.key)].filter(Boolean), character: who.player.character };
    },
    render: (game, { players, character }) =>
      `One of ${players.map((id) => `**${game.players[id]?.name}**`).join(' or ')} is the **${rolesById.get(character)?.name}**.`,
  },
  librarian: {
    answer: { kind: 'pair', team: 'outsider', allowNone: true },
    truth: (game, entry) => {
      const who = playersOnTeam(game, 'outsider')[0];
      if (!who) return { players: [], character: null };
      return { players: [who.id, decoyFor(game, who.id, entry.key)].filter(Boolean), character: who.player.character };
    },
    render: (game, { players, character }) =>
      character
        ? `One of ${players.map((id) => `**${game.players[id]?.name}**`).join(' or ')} is the **${rolesById.get(character)?.name}**.`
        : 'There are **no Outsiders** in play.',
  },
  investigator: {
    answer: { kind: 'pair', team: 'minion' },
    truth: (game, entry) => {
      const who = playersOnTeam(game, 'minion')[0];
      if (!who) return null;
      return { players: [who.id, decoyFor(game, who.id, entry.key)].filter(Boolean), character: who.player.character };
    },
    render: (game, { players, character }) =>
      `One of ${players.map((id) => `**${game.players[id]?.name}**`).join(' or ')} is the **${rolesById.get(character)?.name}**.`,
  },
  chef: {
    answer: { kind: 'count', max: (game) => Math.max(2, Object.keys(game.players).length) },
    truth: (game) => {
      const circle = seats(game);
      if (circle.length < 2) return 0;
      let pairs = 0;
      for (let i = 0; i < circle.length; i++) {
        const next = circle[(i + 1) % circle.length];
        if (registersEvil(circle[i].player) && registersEvil(next.player)) pairs++;
      }
      // A two-seat circle would otherwise count the one adjacency from both ends.
      return circle.length === 2 ? Math.min(pairs, 1) : pairs;
    },
    render: (game, n) =>
      `You learn there ${n === 1 ? 'is' : 'are'} **${n}** pair${n === 1 ? '' : 's'} of neighbouring evil players.`,
  },
  empath: {
    answer: { kind: 'count', max: () => 2 },
    truth: (game, entry) => aliveNeighbours(game, entry.id).filter(({ player }) => registersEvil(player)).length,
    caveat: (game, entry) =>
      aliveNeighbours(game, entry.id)
        .filter(({ player }) => MISREGISTERS[player.character])
        .map(
          ({ player }) =>
            `**${player.name}** is the ${rolesById.get(player.character).name} — ${MISREGISTERS[player.character]}.`
        ),
    render: (game, n) => `You learn that **${n}** of your alive neighbours ${n === 1 ? 'is' : 'are'} evil.`,
  },
  fortuneteller: {
    choose: {
      count: 2,
      parallel: true,
      prompt: 'Choose **2 players**. You learn whether either of them is the Demon.',
    },
    answer: { kind: 'yesno' },
    truth: (game, entry) => {
      const picked = entry.choice?.targets ?? [];
      if (picked.length !== 2) return null;
      const herring = redHerringId(game);
      return picked.some(
        (id) => rolesById.get(game.players[id]?.character)?.team === 'demon' || id === herring
      );
    },
    caveat: (game, entry) => {
      const herring = redHerringId(game);
      if (!herring) return ['No **Red herring** token is placed — the Fortune Teller should have one.'];
      return (entry.choice?.targets ?? []).includes(herring)
        ? [`**${game.players[herring]?.name}** is the **Red herring** — they register as the Demon.`]
        : [];
    },
    render: (game, yes) =>
      yes ? '**Yes** — one of those two players is the Demon.' : '**No** — neither of those players is the Demon.',
  },
  undertaker: {
    wakesIf: (game, entry) => entry.player.alive && game.lastExecuted?.day === game.day - 1,
    skipNote: 'nobody was executed today',
    answer: { kind: 'character' },
    // "Today" is the day that just ended: night N follows day N-1. An execution
    // from any earlier day is not this Undertaker's business, so the day is
    // checked rather than just the presence of a record.
    truth: (game) => (game.lastExecuted?.day === game.day - 1 ? game.lastExecuted.character : null),
    caveat: (game) =>
      game.lastExecuted?.day === game.day - 1
        ? []
        : ['Nobody was executed today — the Undertaker does not normally wake.'],
    render: (game, roleId) => `The player executed today was the **${rolesById.get(roleId)?.name ?? roleId}**.`,
  },
  ravenkeeper: {
    // The only character here whose ability *is* dying, so it is the only one
    // that has to wake a corpse — and only on the night it happens.
    wakesIf: (game, entry) => !entry.player.alive && entry.player.diedAt === game.day,
    skipNote: 'only wakes on the night they die',
    choose: { count: 1, prompt: 'You died in the night. Choose **1 player** — you learn their character.' },
    answer: { kind: 'character' },
    truth: (game, entry) => game.players[entry.choice?.targets?.[0]]?.character ?? null,
    render: (game, roleId) => `They are the **${rolesById.get(roleId)?.name ?? roleId}**.`,
  },
  monk: {
    choose: {
      count: 1,
      excludeSelf: true,
      aliveOnly: true,
      parallel: true,
      prompt: 'Choose **1 player** other than yourself. They are safe from the Demon tonight.',
    },
    token: { role: 'monk', match: /protected/i },
  },
  poisoner: {
    choose: {
      count: 1,
      parallel: true,
      prompt: 'Choose **1 player**. They are poisoned tonight and tomorrow day.',
    },
    token: { role: 'poisoner', match: /poisoned/i },
  },
  butler: {
    choose: {
      count: 1,
      excludeSelf: true,
      parallel: true,
      prompt: 'Choose **1 player** other than yourself. Tomorrow you may only vote if they are voting too.',
    },
    token: { role: 'butler', match: /master/i },
  },
  imp: {
    choose: { count: 1, parallel: true, prompt: 'Choose **1 player**. They die.' },
    kill: true,
  },
  scarletwoman: {
    // She only wakes to be *told* she is now the Demon, which happens the night
    // after the Demon dies — or the same night, if the Imp killed themselves.
    // Waking her on any other night tells her the Demon is dead, which is
    // exactly the thing she is not supposed to know yet.
    wakesIf: (game, entry) => entry.player.alive && !!fallenDemon(game),
    skipNote: 'only wakes the night the Demon dies',
    // Waking her is only half of it: she *becomes* that Demon, which is a
    // character change in the grimoire and a second "You are" card in her
    // thread. Neither happens by ticking a box, so the step carries a button
    // that does both at once.
    become: {
      character: (game) => fallenDemon(game)?.player.character ?? null,
      label: (game, role) => `Promote to ${role.name} — tell them`,
      note: (game, role) =>
        `👹 **${game.players[fallenDemon(game)?.id]?.name ?? 'The Demon'} is dead** — the Scarlet Woman becomes the ${role.name}.` +
        '\n-# The button below changes their character in the grimoire and sends them the ' +
        `**You are the ${role.name}** card in their own thread. Show them the token in the room too, if you are at a table.`,
    },
  },
  spy: {
    // Nothing to pick and nothing to send: the Spy is shown the grimoire, which
    // happens in the room. The 📖 on the step panel is the whole interaction.
    grimoire: true,
  },
};

// --- The evil team meeting itself -----------------------------------------

/** A list of seated players, named, for a line of info. */
function nameList(list) {
  return list.map(({ player }) => `**${player.name}**`).join(', ');
}

/**
 * The two team-wide first-night steps, computed.
 *
 * Both are pure grimoire reads — who is on which team — so unlike every
 * information character there is nothing here for the Storyteller to decide and
 * nothing to lie about: the evil team genuinely does meet, and it meets before
 * anything else happens. That is why these are the only steps the bot sends by
 * itself, the moment the first night falls.
 *
 * What is deliberately *not* sent is the character. A Minion learns that Alice
 * is their Demon, not that Alice is the Imp; the Demon learns their Minions as
 * players, not as tokens. At a real table this is the Storyteller pointing at
 * people while holding up a team token, and pointing is all it is.
 */
const TEAM_INFO = {
  6: {
    name: 'Minion info',
    title: '😈 Your evil team',
    build(game, entry) {
      const fellows = playersOnTeam(game, 'minion').filter(({ id }) => id !== entry.id);
      const demons = playersOnTeam(game, 'demon');
      if (!demons.length && !fellows.length) return null;
      return {
        lines: [
          fellows.length
            ? `Your fellow Minion${fellows.length === 1 ? '' : 's'}: ${nameList(fellows)}`
            : 'You are the **only Minion**.',
          demons.length
            ? `Your Demon${demons.length === 1 ? '' : 's'}: ${nameList(demons)}`
            : '*No Demon is seated — tell the Storyteller.*',
        ],
        footer: 'You know who they are, not which characters they have.',
      };
    },
  },
  9: {
    name: 'Demon info',
    title: '👹 Your Minions',
    build(game, entry) {
      const minions = playersOnTeam(game, 'minion').filter(({ id }) => id !== entry.id);
      const bluffs = (game.bluffs ?? []).map((id) => rolesById.get(id)).filter(Boolean);
      if (!minions.length && !bluffs.length) return null;
      return {
        lines: [
          minions.length
            ? `Your Minion${minions.length === 1 ? '' : 's'}: ${nameList(minions)}`
            : 'There are **no Minions** in play.',
          bluffs.length === 3
            ? `Not in play — safe to claim: ${bluffs.map((r) => `**${r.name}**`).join(', ')}`
            : '*Your three bluffs come separately — the Storyteller is still choosing them.*',
        ],
        footer: 'You know who your Minions are, not which characters they have.',
      };
    },
  },
};

/** The team-info spec for a wake step, or null for a character step. */
function teamInfoFor(entry) {
  return TEAM_INFO[entry?.at] ?? null;
}

/** What this player is told, ready to post — or null if there is nothing to say. */
function teamInfoPayload(game, entry) {
  const spec = teamInfoFor(entry);
  const info = spec?.build(game, entry);
  if (!info) return null;
  return {
    text: info.lines.join(' · '),
    embeds: [
      new EmbedBuilder()
        .setColor(COLORS.evil)
        .setTitle(spec.title)
        .setDescription(info.lines.join('\n\n'))
        .setFooter({ text: `${info.footer} Keep this secret.` }),
    ],
  };
}

/** The spec for a wake step, or null for a character nobody has mapped yet. */
function actionFor(entry) {
  // The team-wide first-night steps carry a decorated role name and are worked
  // through the 🎭 bluffs control, not through a per-character picker.
  if (entry.at === 6 || entry.at === 9) return null;
  return ACTIONS[entry.role?.id ?? ''] ?? null;
}

// --- The player's picker, in their own Storyteller thread ------------------

/** Who this character is allowed to point at. */
function targetOptions(game, entry, choose) {
  return seats(game)
    .filter(({ id, player }) => {
      if (choose.excludeSelf && id === entry.id) return false;
      if (choose.aliveOnly && !player.alive) return false;
      return true;
    })
    .slice(0, 25)
    .map(({ id, player }) => ({
      label: player.name.slice(0, 100),
      value: id,
      description: player.alive ? undefined : 'dead',
    }));
}

/**
 * The picker that goes into the player's own thread.
 *
 * The menu *is* the rules: a Monk cannot pick themselves because they are not
 * in the list, so nothing has to be policed after the fact. The Storyteller can
 * always drive the same choice from their step panel — players go AFK, and in a
 * hybrid game the player is in the room pointing with a finger.
 */
function choicePayload(game, entry, { forStoryteller = false } = {}) {
  const spec = actionFor(entry);
  if (!spec?.choose) return null;
  const options = targetOptions(game, entry, spec.choose);
  if (options.length < spec.choose.count) return null;
  const chosen = entry.choice?.targets ?? [];

  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`botc_na_pick:${entry.key}`)
      .setPlaceholder(spec.choose.count === 2 ? 'Choose 2 players' : 'Choose a player')
      .setMinValues(spec.choose.count)
      .setMaxValues(spec.choose.count)
      .addOptions(options.map((o) => ({ ...o, default: chosen.includes(o.value) })))
  );

  if (forStoryteller) return { components: [row] };

  return {
    embeds: [
      new EmbedBuilder()
        .setColor(COLORS.night)
        .setTitle(`🌙 ${entry.role.name} — your choice`)
        .setDescription(
          `${spec.choose.prompt}\n\n` +
            (chosen.length
              ? `*You chose ${chosen
                  .map((id) => `**${game.players[id]?.name}**`)
                  .join(' and ')}. You can change this until the Storyteller reaches you.*`
              : '*Pick below. The Storyteller will come back to you with whatever you learn.*')
        ),
    ],
    components: [row],
  };
}

module.exports = {
  ACTIONS,
  TEAM_INFO,
  teamInfoFor,
  teamInfoPayload,
  MISREGISTERS,
  actionFor,
  aliveNeighbours,
  choicePayload,
  fallenDemon,
  playersOnTeam,
  redHerringId,
  registersEvil,
  scriptTeam,
  seats,
  targetOptions,
};
