const { AttachmentBuilder } = require('discord.js');
const { getGuild, save } = require('./store');
const { logAction, daySegment } = require('./game');
const { updateBoard } = require('./grimoire');
const { expireTokens } = require('./tokens');
const { renderGrimoire } = require('./render');
const { postNightAlert } = require('./night');
const { postDayPanels, clearDayPanels } = require('./dayPanel');
const { whispersMonitored } = require('./whisperRules');
const { ledger } = require('./whisperSessions');
const { announceInRooms, closeRooms } = require('./whisper');
const { voidInvites } = require('./whisperInvite');
const { postSummary, clearLiveLog, refreshLiveLog, refreshWhisperRecord } = require('./whisperLog');
const { updateWhisperPanel } = require('./whisperPanel');

// Long enough to finish a sentence, short enough that the town is not kept
// waiting on it. Nobody is cut off mid-word; nobody gets another conversation.
const WHISPER_GRACE_MS = 60_000;

/**
 * End the day's whispering.
 *
 * The order is deliberate. The segment has already moved on by the time this
 * runs, so no new room can open while the old ones are being shut — otherwise a
 * fast player could open one during the teardown and keep it past the gather.
 * Then the rooms are warned, the outstanding invitations are dropped, and the
 * day's record is posted.
 *
 * The summary goes out *before* the sixty seconds are up rather than after.
 * Nothing said in the grace period can change it — no room can be opened or
 * joined once the warning has gone out, so the list of rooms is already final —
 * and its whole value is landing in the beat before nominations open, not a
 * minute into them.
 *
 * The grace period is a plain timer, so a bot restarted inside that minute
 * leaves the rooms open. They will be shut by the next gather, and an unlocked
 * room during one night is a smaller problem than blocking the interaction for
 * a minute would be.
 */
async function closeWhispers(guild, game, warning) {
  if (!whispersMonitored(game)) return null;
  const today = ledger(game);
  if (today.closed) return null;
  today.closed = true;
  save();

  const rooms = [...today.sessions];
  await announceInRooms(guild, rooms, warning);
  await voidInvites(guild, game);
  await postSummary(guild);
  await clearLiveLog(guild);
  // The record outlives the day. Refreshed here so the pinned list is right
  // the moment the live panel comes down and it becomes the only standing
  // index of who has talked to whom.
  await refreshWhisperRecord(guild);
  await updateWhisperPanel(guild);
  if (rooms.length) {
    setTimeout(() => {
      closeRooms(guild, rooms).catch((err) => console.error('Could not close whisper rooms:', err));
    }, WHISPER_GRACE_MS);
  }
  return { rooms: rooms.length };
}

/**
 * Call everyone back to the town square: the second half of the day, and the
 * moment nominations open.
 *
 * A one-way move, like night. The Storyteller decides when the talking is done,
 * which is the whole point — the town cannot nominate while people are still
 * scattered in private conversations.
 */
async function gatherTown(guild, cfg, game) {
  if (game.phase !== 'day') return { error: 'The town can only be called in during the day.' };
  if (daySegment(game) === 'town') {
    return { error: `The town is already gathered — nominations are open on Day ${game.day}.` };
  }

  game.daySegment = 'town';
  save();
  const whispers = await closeWhispers(
    guild,
    game,
    `📢 **The town is gathering** — this room closes in ${WHISPER_GRACE_MS / 1000} seconds.`
  );

  await logAction(guild, {
    title: '📢 The town gathers',
    color: 'day',
    description: `Day ${game.day}: everyone is called back to the square. **Nominations are open.**`,
  });
  await postDayPanels(guild);

  const townSquare = await guild.channels.fetch(cfg.channels.townSquare).catch(() => null);
  await townSquare
    ?.send('📢 **The town is gathering.** Nominations are open — the button is in the game log.')
    .catch(() => null);

  return {
    summary:
      `📢 **The town is gathered on Day ${game.day}.** Nominations are open; players can nominate from ` +
      `<#${cfg.channels.gameLog}>.` +
      (whispers?.rooms
        ? ` ${whispers.rooms} whisper room${whispers.rooms === 1 ? '' : 's'} met today — they close in ` +
          `${WHISPER_GRACE_MS / 1000}s and the day's record is in the log.`
        : ''),
  };
}

/**
 * What the phase change took off the board, for the Storyteller's eyes only.
 *
 * Never logged and never posted publicly: which tokens are on the board is the
 * grimoire, and "the Poisoned token came off Alice" is the whole game.
 */
function expiredNote(expired) {
  if (!expired.length) return '';
  return (
    '\n🔖 Taken off the board: ' +
    expired.map(({ name, text, why }) => `**${text}** from ${name} *(${why})*`).join(', ') +
    '.'
  );
}

/**
 * Move the game to day, town or night: the single implementation behind
 * `/phase`, the ☀️ Start Day button on the wake list, and 📢 Call the town in
 * and 🌙 Night falls on the day panel.
 *
 * Returns `{ error }` for a refusal the caller should show as-is, otherwise
 * `{ summary }` describing what happened.
 */
async function setPhase(guild, target) {
  const cfg = getGuild(guild.id);
  const game = cfg.game;
  if (!game || game.status !== 'running') return { error: 'No game is running.' };
  // Not a phase of its own — it is the second half of the day, so it has its
  // own path rather than being squeezed through the day/night switch below.
  if (target === 'town') return gatherTown(guild, cfg, game);

  const day = target === 'day';
  if (game.phase === target) return { error: `It is already ${day ? 'Day' : 'Night'} ${game.day}.` };

  // Tokens that only lasted the phase being left come off before anything
  // else. At dusk this runs *before* the Poisoner is woken, so tonight's poison
  // lands on a clean board; at dawn it takes down the Monk's protection the
  // night just spent.
  const expired = expireTokens(game, day ? 'dawn' : 'dusk');

  if (day) {
    game.phase = 'day';
    // Every day opens with the town scattered and talking. Nominations wait
    // for the Storyteller to call everyone in.
    game.daySegment = 'discussion';
  } else {
    // A day that went straight to night without ever gathering still had
    // whispering in it, and still owes the town its record. Run the teardown
    // before the day number moves on, or the summary would be filed under
    // tomorrow.
    await closeWhispers(guild, game, '🌙 **Night is falling** — this room closes in 60 seconds.');
    // Close any open nomination when night falls.
    game.nomination = null;
    game.phase = 'night';
    game.day += 1;
    game.nightAlert = null;
  }
  save();

  // Post a fresh town status on every phase change. Going into night this picks
  // up whoever was executed during the day, which is the whole point.
  // reveal:false — the game log is public, so no characters or alignments may
  // appear here. Fails soft to a text-only log.
  const label = day ? `day-${game.day}` : `night-${game.day}`;
  const png = await renderGrimoire(game).catch(() => null);
  await logAction(guild, {
    title: day ? `☀️ Day ${game.day} begins` : `🌙 Night ${game.day} falls`,
    color: day ? 'day' : 'night',
    description: day
      ? 'The town wakes and scatters to talk. **Nominations open when the Storyteller calls everyone back in.**'
      : 'Everyone close your eyes. The Storyteller will wake you if needed.',
    ...(png
      ? { files: [new AttachmentBuilder(png, { name: `${label}.png` })], image: `attachment://${label}.png` }
      : {}),
  });
  await updateBoard(guild);

  // Day: put up the Storyteller's controls and the players' nomination button.
  // Night: take them down first, then ping everyone who acts and post the wake
  // list in the Grimoire.
  if (day) {
    await postDayPanels(guild);
    // Dawn: everyone's whispers are back. The ledger rebuilds itself on demand,
    // so all that is needed here is to show the new numbers and put up an empty
    // live panel for the day's first room to appear in.
    await updateWhisperPanel(guild);
    await refreshLiveLog(guild);
    return {
      summary:
        `☀️ **Day ${game.day}** begun, town status posted, and board refreshed. ` +
        `Day controls are in <#${cfg.channels.grimoire}> — press **📢 Call the town in** to open nominations.` +
        expiredNote(expired),
    };
  }

  await clearDayPanels(guild);
  await updateWhisperPanel(guild);
  const alert = await postNightAlert(guild);
  return {
    summary:
      `🌙 **Night ${game.day}** begun, town status posted, and board refreshed.` +
      (alert?.waking
        ? ` Pinged **${alert.waking}** Storyteller thread${alert.waking === 1 ? '' : 's'} — wake list posted in <#${cfg.channels.grimoire}>.`
        : ' Nobody acts tonight.') +
      expiredNote(expired),
  };
}

module.exports = { setPhase };
