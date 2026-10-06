const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
} = require('discord.js');
const { save } = require('./store');
const { mention, COLORS } = require('./game');
const { rolesById } = require('./data/scripts');
const { nightOrder, sendToThread, updateChecklist, sendTeamInfo } = require('./night');
const { actionFor, choicePayload, scriptTeam, seats, teamInfoFor, teamInfoPayload } = require('./nightActions');
const { deliverCharacter } = require('./deal');
const { updateBoard } = require('./grimoire');

/**
 * One wake step, opened from its button on the checklist.
 *
 * This is where the night is actually run: the character's reminder, what the
 * player picked (or a way to pick for them), the truthful answer computed from
 * the grimoire and preselected, and one tap to send it down their thread.
 *
 * The Storyteller never types, and never has to work out who a name belongs to
 * — but every computed answer is a suggestion sitting next to all the others,
 * because lying to a poisoned player is not an edge case, it is the job.
 */

/** Everything about one step, with the night's recorded choice folded in. */
function entryFor(game, key) {
  const { first, entries } = nightOrder(game);
  const entry = entries.find((e) => e.key === key);
  if (!entry) return null;
  return {
    ...entry,
    first,
    choice: game.nightAlert?.choices?.[key] ?? null,
    staged: game.nightAlert?.staged?.[key] ?? null,
    sent: game.nightAlert?.sent?.[key] ?? null,
  };
}

/** Read `truth` without letting a half-filled grimoire take the night down. */
function truthOf(game, entry, spec) {
  if (!spec?.truth) return null;
  try {
    return spec.truth(game, entry);
  } catch {
    return null;
  }
}

function caveatsOf(game, entry, spec) {
  if (!spec?.caveat) return [];
  try {
    return spec.caveat(game, entry) ?? [];
  } catch {
    return [];
  }
}

/** How an answer reads once it is decided — the same text the player receives. */
function renderAnswer(game, entry, spec, value) {
  if (!spec?.render || value === null || value === undefined) return null;
  try {
    return spec.render(game, value, entry);
  } catch {
    return null;
  }
}

/** The players a step's choice landed on, named. */
function targetNames(game, ids) {
  return (ids ?? []).map((id) => `**${game.players[id]?.name ?? 'someone'}**`).join(' and ');
}

// --- Answer controls -------------------------------------------------------

/**
 * The answer half of the panel, shaped by the character.
 *
 * Single-value answers (a count, a yes/no) are buttons: they send on one tap,
 * which is the whole point. Answers that need two parts — the info characters
 * name two players *and* a character — stage in the panel first and send from a
 * button, because a select menu cannot commit two menus at once.
 */
function answerRows(game, entry, spec) {
  const kind = spec.answer?.kind;
  const truth = truthOf(game, entry, spec);
  const rows = [];

  if (kind === 'count') {
    const max = Math.min(spec.answer.max(game), 8);
    const buttons = [];
    for (let n = 0; n <= max; n++) {
      buttons.push(
        new ButtonBuilder()
          .setCustomId(`botc_na_val:${n}:${entry.key}`)
          .setLabel(n === truth ? `${n} ✓` : String(n))
          .setStyle(n === truth ? ButtonStyle.Success : ButtonStyle.Secondary)
      );
    }
    for (let i = 0; i < buttons.length; i += 5) {
      rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
    }
    return rows;
  }

  if (kind === 'yesno') {
    // Nothing is preselected until the player has actually pointed at somebody:
    // a yes/no computed from no choice at all would be a guess wearing a tick.
    const ready = (entry.choice?.targets?.length ?? 0) === spec.choose.count;
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`botc_na_val:y:${entry.key}`)
          .setLabel(ready && truth === true ? 'Yes ✓' : 'Yes')
          .setStyle(ready && truth === true ? ButtonStyle.Success : ButtonStyle.Secondary)
          .setEmoji('👍'),
        new ButtonBuilder()
          .setCustomId(`botc_na_val:n:${entry.key}`)
          .setLabel(ready && truth === false ? 'No ✓' : 'No')
          .setStyle(ready && truth === false ? ButtonStyle.Success : ButtonStyle.Secondary)
          .setEmoji('👎')
      )
    );
    return rows;
  }

  if (kind === 'character' || kind === 'pair') {
    const staged = entry.staged ?? {};
    const pool =
      kind === 'pair'
        ? scriptTeam(game, spec.answer.team)
        : // The Undertaker and the Ravenkeeper can legitimately be told any
          // character on the script, in play or not.
          scriptTeam(game, 'townsfolk')
            .concat(scriptTeam(game, 'outsider'), scriptTeam(game, 'minion'), scriptTeam(game, 'demon'));
    const suggestedChar = kind === 'pair' ? truth?.character : truth;
    const char = staged.character ?? suggestedChar ?? null;

    if (kind === 'pair') {
      const players = staged.players ?? truth?.players ?? [];
      rows.push(
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`botc_na_players:${entry.key}`)
            .setPlaceholder('1️⃣ Which two players?')
            .setMinValues(2)
            .setMaxValues(2)
            .addOptions(
              seats(game)
                .slice(0, 25)
                .map(({ id, player }) => ({
                  label: player.name.slice(0, 100),
                  value: id,
                  default: players.includes(id),
                }))
            )
        )
      );
    }

    rows.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`botc_na_char:${entry.key}`)
          .setPlaceholder(kind === 'pair' ? '2️⃣ Which character?' : 'Which character?')
          .addOptions(
            pool.slice(0, 25).map((r) => ({
              label: `${r.id === suggestedChar ? '✓ ' : ''}${r.name}`.slice(0, 100),
              value: r.id,
              default: r.id === char,
            }))
          )
      )
    );

    const players = staged.players ?? (kind === 'pair' ? truth?.players ?? [] : []);
    const ready = kind === 'pair' ? players.length === 2 && !!char : !!char;
    const send = [
      new ButtonBuilder()
        .setCustomId(`botc_na_val:staged:${entry.key}`)
        .setLabel('Send it')
        .setStyle(ready ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setDisabled(!ready)
        .setEmoji('📨'),
    ];
    // The Librarian is the one info character whose true answer can be "nobody".
    if (spec.answer.allowNone) {
      send.push(
        new ButtonBuilder()
          .setCustomId(`botc_na_val:none:${entry.key}`)
          .setLabel('No Outsiders in play')
          .setStyle(truth && !truth.character ? ButtonStyle.Success : ButtonStyle.Secondary)
      );
    }
    rows.push(new ActionRowBuilder().addComponents(send));
    return rows;
  }

  return rows;
}

/** The act-on-the-choice controls: place the token, take the kill. */
function consequenceRow(game, entry, spec) {
  const target = entry.choice?.targets?.[0];
  const buttons = [];
  if (spec.token && target) {
    const role = rolesById.get(spec.token.role);
    const text = (role?.reminders ?? []).find((t) => spec.token.match.test(t));
    const already = game.players[target]?.reminders?.some(
      (r) => r.role === spec.token.role && r.text === text
    );
    if (text) {
      buttons.push(
        new ButtonBuilder()
          .setCustomId(`botc_na_token:${entry.key}`)
          .setLabel(`${already ? '✓ ' : ''}${text} → ${game.players[target]?.name}`.slice(0, 80))
          .setStyle(already ? ButtonStyle.Success : ButtonStyle.Primary)
          .setEmoji('🔖')
      );
    }
  }
  if (spec.kill && target) {
    const dead = !game.players[target]?.alive;
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`botc_na_kill:${entry.key}`)
        .setLabel(dead ? `${game.players[target]?.name} is dead` : `Kill ${game.players[target]?.name}`.slice(0, 80))
        .setStyle(ButtonStyle.Danger)
        .setDisabled(dead)
        .setEmoji('💀')
    );
  }
  return buttons.length ? new ActionRowBuilder().addComponents(buttons) : null;
}

// --- The panel -------------------------------------------------------------

/** The ephemeral panel behind a character button on the wake list. */
function stepPanel(game, key) {
  const entry = entryFor(game, key);
  if (!entry) {
    return { content: 'That step is not part of tonight any more — the wake list has moved on.', components: [] };
  }
  const spec = actionFor(entry);
  const done = !!game.nightAlert?.done?.[key];
  const rows = [];
  const lines = [`*${entry.reminder}*`];

  if (!entry.player.alive) lines.push('💀 **This player is dead** — they normally do not act.');

  // The evil team meeting. It has already been sent by the time the
  // Storyteller can open this panel, so what is left is proof of what went out
  // and a way to send it again — a Minion whose thread was asleep still has to
  // learn who their Demon is.
  const team = teamInfoFor(entry) && teamInfoPayload(game, entry);
  if (teamInfoFor(entry)) {
    lines.push(
      team
        ? `🤫 **They are told:** ${team.text}\n-# Players only — no characters. Sent automatically when night fell.`
        : '⚠️ There is nothing to tell them — the evil team is not seated yet. Assign characters, then re-send.'
    );
    if (team) {
      rows.push(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`botc_na_info:${entry.key}`)
            .setLabel(entry.sent ? 'Send it again' : 'Send it now')
            .setStyle(entry.sent ? ButtonStyle.Secondary : ButtonStyle.Primary)
            .setEmoji('📨')
        )
      );
    }
  }

  // What the player picked, or how to get it.
  if (spec?.choose) {
    const picked = entry.choice?.targets ?? [];
    if (picked.length) {
      lines.push(
        `👉 They chose ${targetNames(game, picked)}` +
          (entry.choice.by === 'st' ? ' *(you picked, on their behalf)*' : ' *(they picked, in their thread)*') +
          '.'
      );
    } else {
      lines.push(
        entry.player.isBot
          ? '⏳ **Simulated player** — pick for them below.'
          : '⏳ **Waiting on them** — the picker is in their thread. Pick for them below if they have gone quiet.'
      );
    }
    const picker = choicePayload(game, entry, { forStoryteller: true });
    if (picker) {
      // Same menu the player sees, so the rules it enforces are the same rules.
      picker.components[0].components[0].setCustomId(`botc_na_stpick:${entry.key}`);
      rows.push(...picker.components);
    }
    // Re-send their picker on demand. The night alert fires once, so without
    // this a restart mid-night, a delivery that failed, or a player who
    // dismissed the message leaves the step with no way forward but picking for
    // them.
    if (!entry.player.isBot) {
      rows.push(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`botc_na_ask:${entry.key}`)
            .setLabel(picked.length ? 'Ask them again' : 'Send them the picker')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('📩')
        )
      );
    }
  }

  // The caveats: what the grimoire says that the computed answer deliberately
  // does not decide — a Recluse next door, a missing Red herring token.
  const caveats = spec ? caveatsOf(game, entry, spec) : [];
  if (caveats.length) lines.push(...caveats.map((c) => `⚠️ ${c}`));

  if (spec?.answer) {
    const truth = truthOf(game, entry, spec);
    const truthText = renderAnswer(game, entry, spec, truth);
    lines.push(
      truthText
        ? `✅ **True answer:** ${truthText}\n-# Preselected below. Tap anything else to lie — poison, drunkenness and misregistration are yours to run, not the bot's.`
        : '❓ The true answer cannot be computed yet — pick it yourself below.'
    );
    rows.push(...answerRows(game, entry, spec));
  }

  const consequence = spec ? consequenceRow(game, entry, spec) : null;
  if (consequence) rows.push(consequence);

  // Becoming the Demon. The Scarlet Woman's whole ability is a character
  // change, so the step is not finished when the box is ticked — it is
  // finished when she has been *told*, in her own thread, that she is the Imp.
  const becoming = spec?.become && rolesById.get(spec.become.character(game));
  if (becoming) {
    const already = entry.player.character === becoming.id;
    lines.push(already
      ? `👹 **They are now the ${becoming.name}** — the card has been sent to their thread.`
      : spec.become.note(game, becoming));
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`botc_na_become:${entry.key}`)
          .setLabel((already ? `Re-send the ${becoming.name} card` : spec.become.label(game, becoming)).slice(0, 80))
          .setStyle(already ? ButtonStyle.Secondary : ButtonStyle.Danger)
          .setEmoji('👹')
      )
    );
  }

  if (spec?.grimoire) lines.push('📖 This character is shown the grimoire — open it from the wake list.');

  if (entry.sent) lines.push(`📨 **Sent:** ${entry.sent.text}`);

  // Always last, and always present: a step with no mapped action is still a
  // step, and this is the tick that used to be the whole button.
  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`botc_na_done:${entry.key}`)
        .setLabel(done ? 'Handled ✓ — tap to un-tick' : 'Mark handled')
        .setStyle(done ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setEmoji(done ? '✅' : '⬜')
    )
  );

  return {
    embeds: [
      new EmbedBuilder()
        .setColor(COLORS.night)
        .setTitle(`${entry.order}. ${entry.role.name}`)
        .setDescription(
          `${mention(game, entry.id)}${entry.player.stThreadId ? ` · <#${entry.player.stThreadId}>` : ''}\n\n` +
            lines.join('\n\n').slice(0, 3800)
        ),
    ],
    // Discord holds five rows. If a character ever needs more, the tick is the
    // one that has to survive — a step you cannot mark handled is a step that
    // blocks the night.
    components: rows.length > 5 ? [...rows.slice(0, 4), rows[rows.length - 1]] : rows,
  };
}

// --- Committing -----------------------------------------------------------

/** Record who a character pointed at, from either side of the table. */
function recordChoice(game, key, targets, by) {
  game.nightAlert.choices ??= {};
  game.nightAlert.choices[key] = { targets, by, at: Date.now() };
  save();
}

/** Hold half of a two-part answer while the other half is being picked. */
function stage(game, key, patch) {
  game.nightAlert.staged ??= {};
  game.nightAlert.staged[key] = { ...(game.nightAlert.staged[key] ?? {}), ...patch };
  save();
}

/**
 * Turn a button press into the value the character learns.
 *
 * `raw` is what the custom id carried: a number, `y`/`n`, `none`, or `staged`
 * meaning "whatever is sitting in the panel right now".
 */
function valueFrom(game, entry, spec, raw) {
  const kind = spec.answer?.kind;
  if (kind === 'count') return Number(raw);
  if (kind === 'yesno') return raw === 'y';
  if (raw === 'none') return { players: [], character: null };
  const truth = truthOf(game, entry, spec);
  const staged = entry.staged ?? {};
  if (kind === 'character') return staged.character ?? truth ?? null;
  return {
    players: staged.players ?? truth?.players ?? [],
    character: staged.character ?? truth?.character ?? null,
  };
}

/**
 * Send a character's information down their own Storyteller thread and tick the
 * step off.
 *
 * The information never touches #game-log. Those channels are read by players,
 * and this is the one kind of message in the whole bot that would decide a game
 * if it landed in the wrong one.
 */
async function sendAnswer(guild, game, key, raw) {
  const entry = entryFor(game, key);
  if (!entry) return { error: 'That step is not part of tonight any more.' };
  const spec = actionFor(entry);
  if (!spec?.answer) return { error: 'That character has nothing to send.' };

  const value = valueFrom(game, entry, spec, raw);
  const text = renderAnswer(game, entry, spec, value);
  if (!text) return { error: 'That answer is not complete yet — finish picking it first.' };

  const sent = await sendToThread(guild, entry.player.stThreadId, {
    embeds: [
      new EmbedBuilder()
        .setColor(COLORS.night)
        .setTitle(`🌙 ${entry.role.name} — what you learn`)
        .setDescription(text)
        .setFooter({ text: 'From the Storyteller. Say nothing about this in public.' }),
    ],
  });

  game.nightAlert.sent ??= {};
  game.nightAlert.sent[key] = { value, text };
  game.nightAlert.done ??= {};
  game.nightAlert.done[key] = true;
  save();
  await updateChecklist(guild);

  return {
    text,
    delivered: !!sent,
    warning: sent ? null : `Could not reach ${entry.player.name}'s thread — tell them directly.`,
  };
}

/**
 * Re-send the evil team meeting to one player, from the step panel.
 */
async function resendTeamInfo(guild, game, key) {
  const entry = entryFor(game, key);
  if (!entry || !teamInfoFor(entry)) return { error: 'That step is not evil team info.' };
  const sent = await sendTeamInfo(guild, game, key);
  if (!sent) {
    return { error: `Could not reach ${entry.player.name}'s thread — tell them by hand.` };
  }
  await updateChecklist(guild);
  return { ok: `📨 Sent ${entry.player.name} their evil team info.` };
}

/**
 * Put a character's picker back in their thread, on demand.
 *
 * Delivery is recorded so the automatic wave does not send it twice, but this
 * clears that mark first: the whole point of the button is to send it again.
 */
async function askAgain(guild, game, key) {
  const entry = entryFor(game, key);
  if (!entry) return { error: 'That step is not part of tonight any more.' };
  const payload = choicePayload(game, entry);
  if (!payload) return { error: 'That character has nothing to choose.' };
  const sent = await sendToThread(guild, entry.player.stThreadId, payload);
  if (!sent) return { error: `Could not reach ${entry.player.name}'s thread — pick for them instead.` };
  game.nightAlert.prompted ??= {};
  game.nightAlert.prompted[key] = true;
  save();
  return { ok: `📩 Sent the picker to ${entry.player.name}'s thread.` };
}

/**
 * Hand the Demon over: change the character in the grimoire and send the new
 * "You are" card down the player's own thread.
 *
 * `delivered` is moved with it, so the next `/st deal`-style publish does not
 * treat this as an undelivered change and send the card a second time. The
 * button stays live afterwards for a re-send, because a card that did not
 * arrive is worse than one that arrived twice.
 */
async function becomeDemon(guild, game, key) {
  const entry = entryFor(game, key);
  if (!entry) return { error: 'That step is not part of tonight any more.' };
  const spec = actionFor(entry);
  const roleId = spec?.become?.character(game);
  const role = roleId && rolesById.get(roleId);
  if (!role) return { error: 'There is no dead Demon for them to become tonight.' };

  const player = game.players[entry.id];
  // Tonight's wake list is read against `wasCharacter`, so the step the
  // Storyteller is standing in survives the press instead of disappearing the
  // instant she stops being the Scarlet Woman.
  player.wasCharacter ??= player.character;
  player.becameAt = game.day;
  player.character = role.id;
  save();

  const sent = await deliverCharacter(guild, game, entry.id);
  if (sent) player.delivered = role.id;
  game.nightAlert.done ??= {};
  game.nightAlert.done[key] = true;
  save();
  await updateBoard(guild);
  await updateChecklist(guild);

  return {
    ok: sent
      ? `👹 ${player.name} is now the ${role.name}, and the card is in their thread.`
      : null,
    error: sent
      ? null
      : `${player.name} is now the ${role.name} in the grimoire, but their thread could not be reached — tell them by hand.`,
  };
}

module.exports = { entryFor, stepPanel, resendTeamInfo, recordChoice, stage, sendAnswer, askAgain, becomeDemon, truthOf };
