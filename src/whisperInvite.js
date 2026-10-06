const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, MessageFlags } = require('discord.js');
const { getGuild, save } = require('./store');
const { mention, daySegment } = require('./game');
const { whispersMonitored } = require('./whisperRules');
const { canOpen, recordSession, remaining, roomSize } = require('./whisperSessions');
const { openWhisper } = require('./whisper');
const { refreshLiveLog, refreshWhisperRecord } = require('./whisperLog');
const { updateWhisperPanel } = require('./whisperPanel');

/**
 * Invitations: the consent half of the whisper economy.
 *
 * Nobody is dragged into a room. An invitation goes out, everyone named has to
 * accept, and only then does the room open and everyone pay. A trio is
 * all-or-nothing — two out of three acceptances opens nothing, because the
 * conversation two of them agreed to is not the one on offer.
 *
 * Nothing is reserved while an invitation is outstanding. A player may have
 * more invitations in flight than whispers left, and whoever accepts first
 * wins; the losers' invitations simply lapse. Reserving would have been tidier
 * to implement and much worse to play: an invitation someone never answers
 * would silently freeze a whisper you could not spend elsewhere.
 *
 * **Where the buttons land.** Discord will only deliver an ephemeral message in
 * reply to that user's own interaction, so a target cannot simply be handed
 * one. The bot does already own a private, always-reachable line to every
 * seated player — their Storyteller thread — so that is where the Accept /
 * Decline goes. The Storyteller can see it, which costs nothing: Storyteller
 * rooms are free and unlogged precisely because the Storyteller already sees
 * everything.
 */
const inviteId = () => Math.random().toString(36).slice(2, 10);

const invitesOf = (game) => (game.whisperInvites ??= {});

function inviteRow(id) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`botc_wi_ok:${id}`).setLabel('Accept').setStyle(ButtonStyle.Success).setEmoji('🤫'),
    new ButtonBuilder().setCustomId(`botc_wi_no:${id}`).setLabel('Decline').setStyle(ButtonStyle.Secondary)
  );
}

/**
 * The picker behind the 🤫 button: a select of seated players.
 *
 * A string select of the game's own roster rather than Discord's user picker.
 * Simulated players from `/test add-bots` are not Discord users and cannot
 * appear in a user picker at all, which would make every whisper path
 * untestable without fifteen humans. It also means the roster is the roster —
 * nobody can pick someone who is not in the game.
 *
 * Returns `{ error }` or an ephemeral message payload.
 */
function pickerPayload(game, userId) {
  if (!game || game.status !== 'running') return { error: 'No game is running.' };
  if (!game.players[userId]) return { error: 'Only seated players can open a private room.' };

  const monitored = whispersMonitored(game);
  if (monitored) {
    if (game.phase !== 'day') return { error: '🌙 There is no whispering at night.' };
    if (daySegment(game) === 'town') {
      return { error: '📢 The town is gathered — the whispering is over for today.' };
    }
    if (remaining(game, userId) < 1) {
      return { error: `You have used all your whispers for Day ${game.day}. They come back at dawn.` };
    }
  }

  const options = Object.entries(game.players)
    .filter(([id]) => id !== userId)
    .slice(0, 25)
    .map(([id, p]) => ({
      label: p.name.slice(0, 100),
      value: id,
      description: monitored
        ? `${remaining(game, id)} whisper${remaining(game, id) === 1 ? '' : 's'} left${p.alive ? '' : ' · dead'}`
        : p.alive
          ? undefined
          : 'dead',
    }));
  if (!options.length) return { error: 'There is nobody else seated.' };

  const max = Math.min(roomSize(game) - 1, options.length);
  return {
    content: monitored
      ? `You have **${remaining(game, userId)}** whisper${remaining(game, userId) === 1 ? '' : 's'} left today. ` +
        `Pick up to **${max}** ${max === 1 ? 'person' : 'people'} — everyone you pick has to accept, and each of ` +
        'you pays one when the room opens.'
      : 'Who do you want to open a private room with?',
    components: [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('botc_whisper_select')
          .setPlaceholder(max === 1 ? 'Choose who to talk to privately' : `Choose 1–${max} people`)
          .setMinValues(1)
          .setMaxValues(max)
          .addOptions(options)
      ),
    ],
  };
}

/** Post the Accept / Decline to everyone who has not already agreed. */
async function deliver(guild, game, id, invite) {
  for (const targetId of invite.targets) {
    if (invite.accepted.includes(targetId)) continue;
    const player = game.players[targetId];
    const thread = player?.stThreadId && (await guild.channels.fetch(player.stThreadId).catch(() => null));
    if (!thread) return { error: `I could not reach ${mention(game, targetId)}'s Storyteller thread to ask them.` };
    if (thread.archived) await thread.setArchived(false).catch(() => null);

    const others = invite.targets.filter((t) => t !== targetId);
    const msg = await thread
      .send({
        content: [
          `🤫 ${mention(game, invite.from)} wants a private word` +
            (others.length ? ` — with you and ${others.map((o) => mention(game, o)).join(', ')}.` : ' with you.'),
          others.length
            ? '**Everyone has to accept** or the room does not open.'
            : '',
          `It costs **one whisper each** if you accept. You have **${remaining(game, targetId)}** left today.`,
          '*Declining is silent — nobody is told, not even them.*',
        ]
          .filter(Boolean)
          .join('\n'),
        components: [inviteRow(id)],
      })
      .catch(() => null);
    if (!msg) return { error: `I could not ask ${mention(game, targetId)}.` };
    invite.messageIds[targetId] = `${thread.id}:${msg.id}`;
  }
  return { ok: true };
}

/** Delete the outstanding Accept / Decline messages an invitation left behind. */
async function clearInviteMessages(guild, invite, skipMessageId) {
  for (const ref of Object.values(invite.messageIds ?? {})) {
    const [channelId, messageId] = ref.split(':');
    if (messageId === skipMessageId) continue;
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    const msg = channel && (await channel.messages.fetch(messageId).catch(() => null));
    await msg?.delete().catch(() => null);
  }
}

/**
 * Drop invitations and sweep up after them. `filter` picks which ones — all of
 * them at the gather and at nightfall, or just one player's once they have
 * nothing left to spend.
 */
async function voidInvites(guild, game, filter = () => true) {
  const invites = invitesOf(game);
  const doomed = Object.entries(invites).filter(([, inv]) => filter(inv));
  for (const [id, inv] of doomed) delete invites[id];
  save();
  for (const [, inv] of doomed) await clearInviteMessages(guild, inv);
  return doomed.length;
}

/** Open the room the invitation was for, now that everyone has said yes. */
async function finalise(guild, game, id, invite) {
  const ids = [invite.from, ...invite.targets];
  // Re-check from scratch. Nothing was reserved, so between the invitation and
  // the last acceptance any of these people may have spent their last whisper
  // in a room that opened faster. Nobody is charged for an invitation that dies
  // here — there is nothing to refund, because nothing was ever taken.
  const check = canOpen(game, ids);
  if (check.error) {
    delete invitesOf(game)[id];
    save();
    await clearInviteMessages(guild, invite);
    return { error: check.error };
  }

  const { thread, existed } = await openWhisper(guild, ids, game);
  recordSession(game, ids, thread.id);
  delete invitesOf(game)[id];
  save();
  await clearInviteMessages(guild, invite);

  if (existed) {
    await thread.send(`🤫 ${ids.map((p) => `<@${p}>`).join(' ')} — the room is open again.`).catch(() => null);
  }
  // Anyone who just spent their last whisper cannot honour the invitations they
  // still have out, so retire them rather than leave buttons that will only
  // ever refuse.
  for (const playerId of ids) {
    if (remaining(game, playerId) < 1) await voidInvites(guild, game, (inv) => inv.from === playerId);
  }
  await refreshLiveLog(guild);
  await refreshWhisperRecord(guild);
  await updateWhisperPanel(guild);
  return { thread };
}

/**
 * Ask for a room. Opens it outright when whispers are unmonitored — with the
 * feature off the bot behaves exactly as it always did, one click to a thread.
 *
 * Returns `{ error }` or `{ summary }`.
 */
async function startInvite(guild, game, fromId, targetIds) {
  if (!game || game.status !== 'running') return { error: 'No game is running.' };
  if (!game.players[fromId]) return { error: 'Only seated players can open a private room.' };
  const targets = [...new Set(targetIds)].filter((t) => t !== fromId);
  if (!targets.length) return { error: 'You cannot whisper to yourself.' };
  const ids = [fromId, ...targets];

  const check = canOpen(game, ids);
  if (check.error) return { error: check.error };

  if (!whispersMonitored(game)) {
    const { thread, existed } = await openWhisper(guild, ids, game);
    recordSession(game, ids, thread.id);
    return {
      summary: existed
        ? `You already have a room with ${targets.map((t) => `<@${t}>`).join(', ')}: <#${thread.id}>`
        : `🤫 Private room opened: <#${thread.id}>`,
    };
  }

  const id = inviteId();
  const invite = { from: fromId, targets, accepted: [], messageIds: {}, day: game.day };
  invitesOf(game)[id] = invite;

  // Simulated players cannot press buttons, so without this every whisper test
  // deadlocks on an invitation nobody can answer. They agree to everything, the
  // same way they vote in `/test vote`.
  for (const targetId of targets) {
    if (game.players[targetId]?.isBot) invite.accepted.push(targetId);
  }
  save();

  const sent = await deliver(guild, game, id, invite);
  if (sent.error) {
    delete invitesOf(game)[id];
    save();
    await clearInviteMessages(guild, invite);
    return { error: sent.error };
  }

  if (invite.accepted.length === targets.length) {
    const done = await finalise(guild, game, id, invite);
    if (done.error) return { error: done.error };
    return { summary: `🤫 Room open: <#${done.thread.id}>` };
  }

  save();
  return {
    summary:
      `🤫 Asked ${targets.map((t) => mention(game, t)).join(' and ')}. ` +
      `${targets.length > 1 ? 'They all have' : 'They have'} to accept before the room opens, and nothing is spent ` +
      'until it does. You will see the room appear if they say yes.',
  };
}

/** The Accept / Decline buttons. `customId` is `botc_wi_ok:<id>` or `botc_wi_no:<id>`. */
async function handleInviteButton(interaction) {
  const [action, id] = interaction.customId.replace('botc_wi_', '').split(':');
  const cfg = getGuild(interaction.guild.id);
  const game = cfg.game;
  const invite = game && invitesOf(game)[id];

  if (!invite || invite.day !== game.day) {
    return interaction.update({ content: '⌛ That invitation has lapsed.', components: [] });
  }
  // Checked before anything is deferred: this is the one answer that is a reply
  // to the presser rather than a rewrite of the invitation.
  if (!invite.targets.includes(interaction.user.id)) {
    return interaction.reply({ content: 'That invitation is not for you.', flags: MessageFlags.Ephemeral });
  }

  if (action === 'no') {
    // The whole invitation dies, not just this seat — a trio is all-or-nothing.
    // Nobody is told, including the inviter: a decline that announced itself
    // would be a public snub, and the information that A refused B is worth
    // more at this table than the courtesy is.
    delete invitesOf(game)[id];
    save();
    await clearInviteMessages(interaction.guild, invite, interaction.message.id);
    return interaction.update({ content: '🤐 Declined. Nobody is told.', components: [] });
  }

  if (!invite.accepted.includes(interaction.user.id)) invite.accepted.push(interaction.user.id);
  // This message is about to be rewritten by `interaction.update`, so drop it
  // from the sweep list — deleting it first would leave the update with nothing
  // to edit and the acceptance looking like it failed.
  delete invite.messageIds[interaction.user.id];
  save();

  if (invite.accepted.length < invite.targets.length) {
    return interaction.update({
      content: '🤫 Accepted — waiting on the others. The room opens when everyone has said yes.',
      components: [],
    });
  }

  // The last acceptance is the expensive one: a thread to create or reopen, a
  // member added per person, and the log and panel to redraw. Well past the
  // three seconds Discord allows an un-deferred button.
  await interaction.deferUpdate();
  const done = await finalise(interaction.guild, game, id, invite);
  return interaction.editReply({
    content: done.error ? `⌛ The invitation lapsed: ${done.error}` : `🤫 Room open: <#${done.thread.id}>`,
    components: [],
  });
}

module.exports = { pickerPayload, startInvite, handleInviteButton, voidInvites, clearInviteMessages };
