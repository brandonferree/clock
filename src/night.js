const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require('discord.js');
const { getGuild, save } = require('./store');
const { mention, COLORS } = require('./game');
const { rolesById, rolesForScript, iconUrl } = require('./data/scripts');
const { renderTokenRow } = require('./render');
const { actionFor, choicePayload, teamInfoFor, teamInfoPayload } = require('./nightActions');

/**
 * The two first-night steps that belong to a team rather than a character, and
 * so have no entry in roles.json. Their slots (6 and 9) are the gaps the
 * character data leaves in the official first-night order — magician 5, snitch
 * 7, lunatic 8, king 10. Without these the whole evil team would go unpinged on
 * Night 1, which is when they most need waking.
 */
const TEAM_STEPS = [
  {
    team: 'minion',
    at: 6,
    name: 'Minion info',
    reminder:
      'Show the Minion tokens of the other Minions to this player, then show the Demon token and point to the Demon.' +
      '\n-# Sent automatically when night falls — players only, never characters.',
  },
  {
    team: 'demon',
    at: 9,
    name: 'Demon info & bluffs',
    reminder:
      'Show the Minion tokens and point to each Minion, then show three good character tokens that are not in play (the bluffs).' +
      '\n-# The Minions are sent automatically when night falls; the bluffs go with 🎭.',
  },
];

/**
 * The characters that act tonight, in official night order.
 *
 * Dead players are kept in the list rather than dropped: the Storyteller still
 * needs to see them to know they are being skipped on purpose (and a few
 * abilities, like the Ravenkeeper's, fire on death).
 */
function nightOrder(game) {
  if (!game) return { first: false, entries: [] };
  const first = game.day === 1 && game.phase === 'night';
  const key = first ? 'firstNight' : 'otherNight';

  // A character that changed hands *tonight* — the Scarlet Woman inheriting the
  // Demon — is read at the character they woke as, for tonight only. Otherwise
  // the step the Storyteller is standing in vanishes out from under them the
  // moment they press the button, and the freshly-minted Imp appears at a kill
  // step that has already been and gone.
  const seated = Object.entries(game.players).map(([id, player]) => {
    const tonight =
      player.becameAt === game.day && player.wasCharacter ? player.wasCharacter : player.character;
    return { id, player, role: tonight && rolesById.get(tonight) };
  });

  const acting = seated
    .filter(({ role }) => role && role[key] > 0)
    .map((e) => ({
      ...e,
      at: e.role[key],
      reminder: (first ? e.role.firstNightReminder : e.role.otherNightReminder) || '',
    }));

  // On the first night, splice in the team-wide info steps. Each evil player
  // gets their own entry so they each get their own thread ping and checkbox —
  // the Storyteller visits them one at a time either way. The label carries the
  // real character so the Grimoire list stays readable.
  const teamSteps = first
    ? TEAM_STEPS.flatMap((step) =>
        seated
          .filter(({ role }) => role?.team === step.team)
          .map(({ id, player, role }) => ({
            id,
            player,
            role: { ...role, name: `${step.name} · ${role.name}` },
            at: step.at,
            reminder: step.reminder,
          }))
      )
    : [];

  // `key` identifies the *step*, not the player: one player can act twice in a
  // night (a Poisoner gets Minion info at 6 and poisons at 17), and each step
  // needs its own checkbox and its own button custom id.
  const entries = [...acting, ...teamSteps]
    .sort((a, b) => a.at - b.at)
    .map((e, i) => ({ ...e, order: i + 1, key: `${e.id}-${e.at}` }));
  return { first, entries };
}

/**
 * Does this step actually happen tonight?
 *
 * Being alive is the usual answer, but several characters hold a slot in the
 * night order that only fires under a condition — the reminder text says so out
 * loud ("*If* the Ravenkeeper died tonight", "*If* a player was executed
 * today"). Waking them anyway is not just noise: pinging the Scarlet Woman on a
 * quiet night tells her the Demon is dead, which is the one thing she is not
 * supposed to know yet.
 */
function wakes(game, entry) {
  const spec = actionFor(entry);
  if (spec?.wakesIf) return !!spec.wakesIf(game, entry);
  return entry.player.alive;
}

/** Why a step is being skipped tonight, for the line that says so. */
function skipReason(game, entry) {
  if (!entry.player.alive) return 'dead — skip';
  return actionFor(entry)?.skipNote ?? 'not tonight';
}

/** Players who actually need waking tonight. */
function toWake(game) {
  const { first, entries } = nightOrder(game);
  return { first, entries, wake: entries.filter((e) => wakes(game, e)) };
}

/**
 * The good characters not in play — everything the Demon may be told they might
 * be. Step 4 of the first night is "show three good character tokens that are
 * not in play", and working out which those are means reading the whole
 * grimoire against the whole script, mid-night, without picking one somebody is
 * actually holding. This is that list, computed.
 */
function bluffPool(game) {
  const inPlay = new Set(Object.values(game.players).map((p) => p.character).filter(Boolean));
  return rolesForScript(game.script ?? 'tb').filter(
    (r) => (r.team === 'townsfolk' || r.team === 'outsider') && !inPlay.has(r.id)
  );
}

/** Everyone holding a Demon character — normally one, but scripts can seat more. */
function demonIds(game) {
  return Object.entries(game.players)
    .filter(([, p]) => rolesById.get(p.character)?.team === 'demon')
    .map(([id]) => id);
}

/**
 * Record the Demon's bluffs and deliver them into their Storyteller thread.
 *
 * The thread is the same private line the character was dealt down, so the
 * Demon can re-read their bluffs at 2am on Night 3 instead of asking the
 * Storyteller to show the tokens again. Returns `{ error }` or `{ roles, delivered }`.
 */
async function setBluffs(guild, game, roleIds) {
  const roles = roleIds.map((id) => rolesById.get(id)).filter(Boolean);
  if (roles.length !== 3) return { error: 'Pick exactly three characters.' };

  game.bluffs = roles.map((r) => r.id);
  save();

  // All three tokens in one image. An embed only holds a single thumbnail, so a
  // set of three characters would otherwise be illustrated by whichever one came
  // first — and the art is what the Demon has to recognise when someone else
  // claims it back at them.
  const png = await renderTokenRow(game.bluffs).catch(() => null);
  const files = png ? [new AttachmentBuilder(png, { name: 'bluffs.png' })] : [];

  const embed = new EmbedBuilder()
    .setTitle('🎭 Your bluffs')
    .setColor(COLORS.evil)
    .setDescription(
      ['**These three characters are _not_ in play.** Claim any of them safely.', '', ...roles.map((r) => `**${r.name}**\n${r.ability}`)].join('\n')
    )
    .setFooter({ text: 'Keep this secret. Your Minions do not automatically know these.' });
  if (png) embed.setImage('attachment://bluffs.png');
  else embed.setThumbnail(iconUrl(roles[0]));

  const targets = demonIds(game);
  let delivered = 0;
  for (const id of targets) {
    const player = game.players[id];
    const sent = await sendToThread(guild, player.stThreadId, {
      content: player.isBot ? undefined : `<@${id}>`,
      embeds: [embed],
      files,
    });
    if (sent) delivered += 1;
  }
  return { roles, delivered, targets: targets.length };
}

/**
 * Send one player their half of the evil team meeting.
 *
 * Unlike every other night step this needs no Storyteller decision — who is on
 * the evil team is not a judgement call — so it sends itself and ticks itself
 * off. The button on the step panel is only ever a re-send, for a thread that
 * was not reachable the first time.
 */
async function sendTeamInfo(guild, game, key) {
  const entry = nightOrder(game).entries.find((e) => e.key === key);
  const payload = entry && teamInfoPayload(game, entry);
  if (!payload) return null;
  const msg = await sendToThread(guild, entry.player.stThreadId, {
    // Simulated players sit in Storyteller-only threads, so there is nobody to
    // ping and nothing gained by pinging them.
    content: entry.player.isBot ? undefined : `<@${entry.id}>`,
    embeds: payload.embeds,
  });
  if (!msg) return null;
  game.nightAlert.sent ??= {};
  game.nightAlert.sent[key] = { text: payload.text };
  game.nightAlert.done ??= {};
  game.nightAlert.done[key] = true;
  save();
  return msg;
}

/**
 * The evil team meets, before anything else on the first night.
 *
 * Every Minion is told who the other Minions are and who the Demon is; the
 * Demon is told who the Minions are. Players, never characters — the token a
 * Storyteller holds up at the table says "Minion", not "Poisoner".
 */
async function deliverTeamInfo(guild) {
  const cfg = getGuild(guild.id);
  const game = cfg.game;
  if (!game?.nightAlert?.first) return 0;
  let sent = 0;
  for (const entry of toWake(game).wake) {
    if (!teamInfoFor(entry)) continue;
    // Already delivered tonight: the wave runs again after a re-deal, and the
    // evil team should not be woken twice.
    if (game.nightAlert.sent?.[entry.key]) continue;
    if (await sendTeamInfo(guild, game, entry.key)) sent += 1;
  }
  return sent;
}

/** The bluffs as one line for the wake list, or a nudge to pick them. */
function bluffsLine(game) {
  const roles = (game.bluffs ?? []).map((id) => rolesById.get(id)).filter(Boolean);
  if (!roles.length) return '*Not chosen yet — hit 🎭 Bluffs before you reach step 4.*';
  // A character assigned after the bluffs were picked can turn one of them into
  // a lie the Demon can be caught in. Flag it rather than let it pass.
  const inPlay = new Set(Object.values(game.players).map((p) => p.character).filter(Boolean));
  return roles.map((r) => `**${r.name}**${inPlay.has(r.id) ? ' ⚠️ *now in play*' : ''}`).join(' · ');
}

/**
 * The Storyteller's checklist, posted in #grimoire.
 *
 * This is the Storyteller-only half of the alert, so it carries the hidden
 * information: character names and the official night reminder text. Never post
 * this payload anywhere a player can read.
 */
function checklistPayload(game) {
  const alert = game.nightAlert ?? { done: {} };
  const { first, entries } = nightOrder(game);
  const wake = entries.filter((e) => wakes(game, e));
  const doneCount = wake.filter(({ key }) => alert.done?.[key]).length;

  const lines = entries.length
    ? entries.map((entry) => {
        const { id, key, at, player, role, order, reminder } = entry;
        const link = player.stThreadId ? `<#${player.stThreadId}>` : '*no thread*';
        if (!wakes(game, entry)) {
          const mark = player.alive ? '⏭️' : '💀';
          return `${mark} **${order}. ~~${role.name}~~** — ~~${player.name}~~ *(${skipReason(game, entry)})*\n*${reminder}*`;
        }
        const done = alert.done?.[key];
        // What the player picked, if their character picks anything: the whole
        // point of gathering choices in parallel is being able to see, at a
        // glance, which steps are ready to be worked and which are still out.
        const picked = alert.choices?.[key]?.targets ?? [];
        const status = picked.length
          ? `\n👉 chose ${picked.map((pid) => mention(game, pid)).join(' and ')}`
          : actionFor({ at, role, player: game.players[id] })?.choose
            ? '\n⏳ *waiting on their pick*'
            : '';
        const posted = alert.sent?.[key]?.text;
        return (
          `${done ? '✅' : '⬜'} **${order}. ${role.name}** — ${mention(game, id)}${player.alive ? '' : ' 💀 *(wakes on death)*'} · ${link}\n` +
          `${done ? `*${reminder}*` : reminder}${status}` +
          (posted && teamInfoFor(entry) ? `\n📨 sent: ${posted}` : '')
        );
      })
    : ['*No character in play acts tonight — or characters have not been assigned yet.*'];

  const embed = new EmbedBuilder()
    .setTitle(`🌙 ${first ? 'First night' : `Night ${game.day}`} — wake list`)
    .setColor(COLORS.night)
    .setDescription(lines.join('\n\n').slice(0, 4000))
    .setFooter({
      text: wake.length
        ? `${doneCount}/${wake.length} handled · tap a name once you have finished with them.`
        : 'Nobody to wake tonight.',
    })
    .setTimestamp(new Date());

  // Bluffs belong to the first night only, and they are the one piece of the
  // wake order the Storyteller has to invent rather than read off a token.
  if (first) embed.addFields({ name: '🎭 Demon bluffs', value: bluffsLine(game) });

  // The controls are built first because they compete with the player buttons
  // for the same 25-component budget: five rows of five, no more. Whatever the
  // controls do not take, the wake steps get — a 15-player first night runs to
  // about 20 steps, and anything past the cap is still listed in the text.
  const controls = [];
  // Working the night order means constantly checking the board — who the
  // Empath's neighbours are, who is poisoned — so keep it one tap from the
  // checklist rather than a `/st grimoire` round-trip between every wake.
  controls.push(
    new ButtonBuilder()
      .setCustomId('botc_night_grimoire')
      .setLabel('Grimoire')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('📖')
  );
  // Most night abilities leave a token behind — Poisoned, Protected, Red
  // herring — so placing them is part of working the wake order, not a separate
  // errand worth breaking out to a slash command for.
  controls.push(
    new ButtonBuilder()
      .setCustomId('botc_night_remind')
      .setLabel('Tokens')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('🔖')
  );
  // Step 4 asks for three good characters not in play. Picking them off a
  // computed list beats scanning the script by eye against the grimoire, and it
  // sends them to the Demon's thread so they can be re-read later.
  if (first) {
    controls.push(
      new ButtonBuilder()
        .setCustomId('botc_night_bluffs')
        .setLabel(game.bluffs?.length === 3 ? 'Bluffs ✓' : 'Bluffs')
        .setStyle(game.bluffs?.length === 3 ? ButtonStyle.Success : ButtonStyle.Primary)
        .setEmoji('🎭')
    );
  }
  // The night's deaths are recorded from here. The Demon kills on most nights
  // and the day panel is gone by then, so without this the Storyteller has to
  // leave the checklist for `/st kill` in the middle of the wake order.
  controls.push(
    new ButtonBuilder()
      .setCustomId('botc_night_kill')
      .setLabel('Kill')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('💀')
  );
  if (wake.length) {
    controls.push(
      new ButtonBuilder()
        .setCustomId('botc_night_reset')
        .setLabel('Reset')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('🔄')
    );
  }
  // Always offer the way out of the night — a Storyteller may need to move on
  // early — but it only lights up green once every wake step is ticked off.
  const allDone = wake.length > 0 && doneCount === wake.length;
  controls.push(
    new ButtonBuilder()
      .setCustomId('botc_start_day')
      .setLabel(allDone ? 'Start Day — all done' : 'Start Day')
      .setStyle(allDone ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setEmoji('☀️')
  );

  const buttons = [
    // Characters, not players. A button reading the character is the thing the
    // Storyteller is actually looking for in the night order, and it is unique:
    // player names are not, because one player can act twice in a night and used
    // to produce two identical buttons.
    ...wake.slice(0, 25 - controls.length).map(({ key, role, order }) =>
      new ButtonBuilder()
        .setCustomId(`botc_na_step:${key}`)
        .setLabel(`${order}. ${role.name}`.slice(0, 80))
        .setStyle(
          alert.done?.[key]
            ? ButtonStyle.Success
            : // Blue means the player has already pointed at somebody and is
              // waiting on you, so a glance sorts the ready from the pending.
              alert.choices?.[key]?.targets?.length
              ? ButtonStyle.Primary
              : ButtonStyle.Secondary
        )
    ),
    ...controls,
  ];
  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
  }

  return {
    content: game.storytellerId ? `<@${game.storytellerId}> — night has fallen.` : '',
    embeds: [embed],
    components: rows,
  };
}

/** Re-render the checklist message in place after a button press. */
async function updateChecklist(guild) {
  const cfg = getGuild(guild.id);
  const game = cfg.game;
  if (!game?.nightAlert?.messageId || !cfg.channels.grimoire) return null;
  const channel = await guild.channels.fetch(cfg.channels.grimoire).catch(() => null);
  const msg = channel && (await channel.messages.fetch(game.nightAlert.messageId).catch(() => null));
  if (!msg) return null;
  await msg.edit(checklistPayload(game)).catch(() => null);
  return msg;
}

/**
 * Send their picker to every player who owes tonight a choice and has not been
 * asked yet.
 *
 * This is the parallel wave: a choice that does not depend on anything earlier
 * in the order goes out the moment night falls, so the whole town is deciding
 * at once instead of waiting to be visited one at a time. What they *learn*
 * still comes back in night order, computed when the Storyteller reaches the
 * step — only the pointing happens up front.
 *
 * It is called again after a night death, because a character can be woken by
 * dying: the Ravenkeeper has nothing to be asked until the Imp reaches them.
 */
async function promptChoices(guild) {
  const cfg = getGuild(guild.id);
  const game = cfg.game;
  if (!game?.nightAlert) return 0;
  const { wake } = toWake(game);
  game.nightAlert.prompted ??= {};
  let sent = 0;
  for (const entry of wake) {
    const spec = actionFor(entry);
    if (!spec?.choose) continue;
    // Parallel choosers are asked the moment night falls. A conditional
    // character is only in `wake` at all on the night their condition fires —
    // a Ravenkeeper appears here when they die and not before — so being in
    // this list is itself the reason to ask them. Everything else is asked for
    // at its own step, by the Storyteller.
    if (!spec.choose.parallel && !spec.wakesIf) continue;
    if (game.nightAlert.prompted[entry.key]) continue;
    const payload = choicePayload(game, entry);
    if (!payload) continue;
    if (await sendToThread(guild, entry.player.stThreadId, payload)) {
      game.nightAlert.prompted[entry.key] = true;
      sent += 1;
    }
  }
  save();
  return sent;
}

/** Post a message into a player's Storyteller thread, un-archiving if needed. */
async function sendToThread(guild, threadId, payload) {
  const thread = threadId && (await guild.channels.fetch(threadId).catch(() => null));
  if (!thread) return null;
  if (thread.archived) await thread.setArchived(false).catch(() => null);
  return thread.send(payload).catch(() => null);
}

/**
 * Fire the night alert: ping every waking player's Storyteller thread, then post
 * the Storyteller's checklist in #grimoire.
 *
 * The thread ping is deliberately thin. Those threads are readable by the
 * player, so it says only that the Storyteller is coming — the character name
 * and the night reminder stay in #grimoire. Simulated players are the exception:
 * their threads are Storyteller-only, so those get the full detail.
 */
async function postNightAlert(guild) {
  const cfg = getGuild(guild.id);
  const game = cfg.game;
  if (!game || game.status !== 'running' || game.phase !== 'night') return null;

  const { first, wake } = toWake(game);
  // A fresh night keeps nothing from the last one: choices, staged answers and
  // everything already sent are all tonight's.
  game.nightAlert = { day: game.day, first, messageId: null, done: {}, choices: {}, staged: {}, sent: {} };

  // One ping per player, not per step — a player who acts twice (Minion info,
  // then their own ability) should not get their thread pinged twice.
  const byPlayer = new Map();
  for (const entry of wake) {
    if (!byPlayer.has(entry.id)) byPlayer.set(entry.id, { player: entry.player, steps: [] });
    byPlayer.get(entry.id).steps.push(entry);
  }

  for (const { player, steps } of byPlayer.values()) {
    await sendToThread(guild, player.stThreadId, {
      embeds: [
        new EmbedBuilder()
          .setColor(COLORS.night)
          .setTitle(`🌙 ${first ? 'Night 1' : `Night ${game.day}`} — you are needed`)
          .setDescription(
            player.isBot
              ? // Simulated players have Storyteller-only threads, so the hidden
                // detail is safe to include here.
                `*(simulated player — this thread is Storyteller-only)*\n\n` +
                  steps.map(({ order, role, reminder }) => `**${order}. ${role.name}**\n${reminder}`).join('\n\n')
              : 'Your character acts tonight. The Storyteller will be with you shortly — ' +
                'keep an eye on this thread and answer here.'
          ),
      ],
      ...(player.isBot || !game.storytellerId ? {} : { content: `<@${game.storytellerId}>` }),
    });
  }

  // The evil team meets first, and meets by itself — before any picker goes
  // out and before the Storyteller has even seen the checklist.
  const evil = await deliverTeamInfo(guild);
  await promptChoices(guild);

  // The checklist itself. Grimoire is Storyteller-only, so it may show everything.
  const channel = cfg.channels.grimoire && (await guild.channels.fetch(cfg.channels.grimoire).catch(() => null));
  const msg = channel && (await channel.send(checklistPayload(game)).catch(() => null));
  if (msg) game.nightAlert.messageId = msg.id;
  save();
  return { message: msg, waking: byPlayer.size, steps: wake.length, evil };
}

/**
 * The Storyteller's read-only night order, shown privately by `/st night-order`
 * and by the button on the night-controls panel. Hidden information, so it is
 * only ever sent as an ephemeral reply or into #grimoire.
 */
function nightOrderEmbed(game) {
  const { first, entries } = nightOrder(game);
  const lines = entries.length
    ? entries.map((entry) => {
        const { player, role, order, reminder } = entry;
        if (wakes(game, entry)) return `🟢 **${order}. ${role.name}** — ${player.name}\n${reminder}`;
        const mark = player.alive ? '⏭️' : '💀';
        return `${mark} **${order}. ~~${role.name}~~** — ~~${player.name}~~ *(${skipReason(game, entry)})*\n*${reminder}*`;
      })
    : ['*No characters in play act tonight (or no characters assigned yet).*'];
  const skipCount = entries.filter((e) => !wakes(game, e)).length;

  const embed = new EmbedBuilder()
    .setTitle(`🌙 ${first ? 'First night' : 'Night'} order`)
    .setColor(COLORS.night)
    .setDescription(lines.join('\n\n').slice(0, 4000));
  // This view is read-only by design — the buttons live on the wake list — but
  // step 4 is unreadable without knowing what the bluffs actually are.
  if (first) embed.addFields({ name: '🎭 Demon bluffs', value: bluffsLine(game) });
  return embed
    .setFooter({
      text: skipCount
        ? `🟢 wakes · ⏭️ skipped (${skipCount}) — dead players lose their ability, and some characters only wake under a condition.`
        : '🟢 every character in the night order wakes tonight.',
    });
}

/**
 * Fire the night alert and describe what happened, so `/st night-alert` and the
 * panel button give the Storyteller the same answer.
 */
async function nightAlertSummary(guild) {
  const cfg = getGuild(guild.id);
  const game = cfg.game;
  if (!game || game.status !== 'running') return 'No game is running.';
  if (game.phase !== 'night') {
    return `It is Day ${game.day} — there is nobody to wake. Call \`/phase night\` first.`;
  }
  const alert = await postNightAlert(guild);
  if (!alert?.waking) {
    return 'Nobody acts tonight — either no character in play has a night action, or characters have not been assigned yet.';
  }
  return (
    `🌙 Pinged **${alert.waking}** Storyteller thread${alert.waking === 1 ? '' : 's'}. ` +
    (alert.evil
      ? `The evil team has already met — **${alert.evil}** player${alert.evil === 1 ? '' : 's'} told who their team is (players only, no characters). `
      : '') +
    (alert.message
      ? `Wake checklist: ${alert.message.url}`
      : `Could not post the checklist in <#${cfg.channels.grimoire}> — is the channel still there?`)
  );
}

module.exports = {
  nightOrder,
  toWake,
  postNightAlert,
  updateChecklist,
  checklistPayload,
  nightOrderEmbed,
  nightAlertSummary,
  bluffPool,
  bluffsLine,
  sendToThread,
  promptChoices,
  setBluffs,
  sendTeamInfo,
  deliverTeamInfo,
};
