const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require('discord.js');
const { getGuild, save } = require('./store');
const { mention, COLORS } = require('./game');
const { rolesById } = require('./data/scripts');

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
      'Show the Minion tokens of the other Minions to this player, then show the Demon token and point to the Demon.',
  },
  {
    team: 'demon',
    at: 9,
    name: 'Demon info & bluffs',
    reminder:
      'Show the Minion tokens and point to each Minion, then show three good character tokens that are not in play (the bluffs).',
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

  const seated = Object.entries(game.players).map(([id, player]) => ({
    id,
    player,
    role: player.character && rolesById.get(player.character),
  }));

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
            role: { ...role, name: `${step.name} — ${role.name}` },
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

/** Players who actually need waking: acting characters that are still alive. */
function toWake(game) {
  const { first, entries } = nightOrder(game);
  return { first, entries, wake: entries.filter(({ player }) => player.alive) };
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
  const wake = entries.filter(({ player }) => player.alive);
  const doneCount = wake.filter(({ key }) => alert.done?.[key]).length;

  const lines = entries.length
    ? entries.map(({ id, key, player, role, order, reminder }) => {
        const link = player.stThreadId ? `<#${player.stThreadId}>` : '*no thread*';
        if (!player.alive) {
          return `💀 **${order}. ~~${role.name}~~** — ~~${player.name}~~ *(dead — skip)*\n*${reminder}*`;
        }
        const done = alert.done?.[key];
        return (
          `${done ? '✅' : '⬜'} **${order}. ${role.name}** — ${mention(game, id)} · ${link}\n` +
          `${done ? `*${reminder}*` : reminder}`
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

  // One button per step, five to a row, five rows — 25 components in all, one of
  // which is Reset. A 15-player first night tops out around 20 steps, so the cap
  // only bites in the extreme; anything past it is still listed in the text.
  const buttons = wake.slice(0, 24).map(({ key, player, order }) =>
    new ButtonBuilder()
      .setCustomId(`botc_night_done:${key}`)
      .setLabel(`${order}. ${player.name}`.slice(0, 80))
      .setStyle(alert.done?.[key] ? ButtonStyle.Success : ButtonStyle.Secondary)
  );
  if (buttons.length) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId('botc_night_reset')
        .setLabel('Reset')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('🔄')
    );
  }
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
  game.nightAlert = { day: game.day, first, messageId: null, done: {} };

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

  // The checklist itself. Grimoire is Storyteller-only, so it may show everything.
  const channel = cfg.channels.grimoire && (await guild.channels.fetch(cfg.channels.grimoire).catch(() => null));
  const msg = channel && (await channel.send(checklistPayload(game)).catch(() => null));
  if (msg) game.nightAlert.messageId = msg.id;
  save();
  return { message: msg, waking: byPlayer.size, steps: wake.length };
}

module.exports = { nightOrder, toWake, postNightAlert, updateChecklist, checklistPayload };
