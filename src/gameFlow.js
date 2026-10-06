const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { getGuild, save } = require('./store');
const { logAction, mention } = require('./game');
const { SETUP_TABLE } = require('./data/scripts');
const { updateBoard, clearScriptReference } = require('./grimoire');
const { postScriptSheets, sheetStatus } = require('./scriptSheets');
const { postNightAlert } = require('./night');
const { postAssignPanel } = require('./assignPanel');
const { deleteIn } = require('./dayPanel');
const { postWhisperPanel } = require('./whisperPanel');
const { describeRules } = require('./whisperRules');

/**
 * Seat the lobby and open the game: the single implementation behind
 * `/game start` and the ▶️ button on the lobby controls, so the two cannot
 * drift the way `/phase` and its buttons would have without `setPhase`.
 *
 * Returns `{ error }` for a refusal the caller should show as-is, otherwise
 * `{ summary, seated }`. Does several round-trips per player, so defer first.
 */
async function startGame(guild) {
  const cfg = getGuild(guild.id);
  const game = cfg.game;
  if (!game || game.status !== 'lobby') {
    return { error: 'There is no lobby to start. Use `/game new` first.' };
  }
  const ids = Object.keys(game.players);
  if (ids.length < 5) {
    return { error: `Need at least 5 players (currently ${ids.length}).` };
  }

  // Assign Townsfolk role and create a private Storyteller thread per player.
  // Threads live under #town-square: players must be able to view the parent
  // channel to see their thread, and #grimoire is hidden from them.
  const townSquare = await guild.channels.fetch(cfg.channels.townSquare);
  if (!townSquare.permissionsFor(guild.members.me).has(PermissionFlagsBits.CreatePrivateThreads)) {
    return {
      error: `⚠️ I can't create private threads in <#${townSquare.id}>. Re-run \`/setup\` to repair the channel permissions, then try again.`,
    };
  }
  for (const id of ids) {
    const player = game.players[id];
    const member = player.isBot ? null : await guild.members.fetch(id).catch(() => null);
    if (member && cfg.roleIds.player) await member.roles.add(cfg.roleIds.player).catch(() => null);
    const name = member?.displayName ?? player.name;

    // A previous failed start may have already made this player's thread.
    const existing = player.stThreadId && (await guild.channels.fetch(player.stThreadId).catch(() => null));
    if (existing) {
      if (existing.archived) await existing.setArchived(false).catch(() => null);
      continue;
    }

    const thread = await townSquare.threads.create({
      name: `st-${name}`.slice(0, 100),
      type: ChannelType.PrivateThread,
      invitable: false,
      reason: 'BOTC storyteller thread',
    });
    if (!player.isBot) await thread.members.add(id).catch(() => null);
    if (game.storytellerId) await thread.members.add(game.storytellerId).catch(() => null);
    await thread.send(
      player.isBot
        ? `🤖 Simulated player **${name}** — this thread stands in for their private Storyteller line.`
        : `🔮 This is your private line to the Storyteller, <@${id}>. ` +
            `Ask questions, receive your character and night info here. No one else can see this thread.`
    );
    player.stThreadId = thread.id;
  }

  game.status = 'running';
  game.day = 1;
  game.phase = 'night';
  save();

  // The whisper panel goes up after the game is marked running: it reads the
  // rules and the day off the game to draw the budget board, and a panel built
  // from a lobby would show Day 0 and nobody's whispers.
  await postWhisperPanel(guild);

  // The lobby controls were about filling seats; the seats are full. Take them
  // down rather than leave an Add/Start panel that now refuses every press.
  await deleteIn(guild, cfg.channels.grimoire, game.lobbyPanelId);
  game.lobbyPanelId = null;
  save();

  // Any character-reference wall left in #grimoire by an older game goes now:
  // the sheets pinned in the town square are the reference, and #grimoire is
  // for the board.
  await clearScriptReference(guild);
  // The players' copy: the reference sheets, pinned in the town square.
  const sheets = await postScriptSheets(guild, game.script);
  await updateBoard(guild);
  // Characters are handed out right after the game starts, so the
  // assignment panel goes up now, ready to click.
  await postAssignPanel(guild);

  const dist = SETUP_TABLE[Math.min(ids.length, 15)];
  await logAction(guild, {
    title: '🎭 The game begins!',
    color: 'night',
    description: [
      // One player per line rather than a comma-run: at ten or more names the
      // inline form wraps mid-mention and stops being readable. Numbered,
      // because the join order is the seating order, so the list doubles as the
      // seating chart everyone is about to need.
      `**${ids.length} players** take their seats:`,
      ...ids.map((id, i) => `\`${String(i + 1).padStart(2, ' ')}.\` ${mention(game, id)}`),
      '',
      dist ? `Suggested setup: ${dist[0]} Townsfolk / ${dist[1]} Outsiders / ${dist[2]} Minions / ${dist[3]} Demon` : null,
      // Point at the pinned sheets rather than attaching them again: the town
      // square is where players are, and one canonical copy cannot go stale.
      // Nothing is said to the town when they failed to post — that is the
      // Storyteller's problem to fix, and it goes in their start summary below.
      sheets.ok ? sheetStatus(sheets, cfg.channels.townSquare, { public: true }) : null,
      // The rules are frozen from here on, so this is the first and only point
      // at which the town can be told them without the risk of being told wrong.
      describeRules(game),
      '',
      '🌙 **Night 1 falls.** Close your eyes...',
    ]
      // Only the absent lines are dropped — a bare '' is a deliberate blank
      // line, and `.filter(Boolean)` would have swallowed it.
      .filter((line) => line != null)
      .join('\n'),
  });
  // Night 1 has begun, but characters are normally staged and published after
  // this point, so only alert if the town has already been told. Publishing
  // fires the wake list itself.
  const told = Object.values(game.players).some((p) => p.delivered);
  if (told) await postNightAlert(guild);

  return {
    seated: ids.length,
    summary:
      // The sheets line comes first when it went wrong: a silent no-op is how
      // this went unnoticed for whole games, and the fix is always a command
      // the Storyteller has to run before the town needs the reference.
      // "Pinned, but no page images" counts as wrong: the message is there and
      // previews nothing, which is the failure that looks most like success.
      (sheets.ok && sheets.pinned && sheets.images && !sheets.lost
        ? ''
        : `${sheetStatus(sheets, cfg.channels.townSquare)}\n\n`) +
      `Game started with ${ids.length} players. Private Storyteller threads created under <#${cfg.channels.townSquare}>. ` +
      `Build the spread on the **🎭 Character assignment** panel in <#${cfg.channels.grimoire}> — tap a player to pick, ` +
      'or hit **🎲 Random deal** to stage the whole town. Nothing reaches anyone until you press **📨 Publish**, ' +
      'which delivers every character at once and puts up the first-night wake list.',
  };
}

// A role ping reaches everyone who plays, so it must not be a button anyone can
// lean on. One call a minute is plenty to gather a town.
const PING_COOLDOWN_MS = 60_000;

/**
 * Call for more players: pings @BOTC in the town square with the current seat
 * count. Returns `{ error }` or `{ summary }`.
 */
async function pingForPlayers(guild) {
  const cfg = getGuild(guild.id);
  const game = cfg.game;
  if (!game || game.status !== 'lobby') return { error: 'There is no open lobby to call players to.' };
  if (!cfg.roleIds.botc) return { error: 'No **@BOTC** role is configured. Run `/setup` first.' };

  const waited = Date.now() - (game.lastPingAt ?? 0);
  if (waited < PING_COOLDOWN_MS) {
    return { error: `⏳ Just pinged. Give it ${Math.ceil((PING_COOLDOWN_MS - waited) / 1000)}s before calling again.` };
  }

  const channel = await guild.channels.fetch(cfg.channels.townSquare).catch(() => null);
  if (!channel) return { error: 'The town square channel is missing. Run `/setup`.' };

  const seated = Object.keys(game.players).length;
  const short = Math.max(0, 5 - seated);
  const msg = await channel
    .send({
      content:
        `<@&${cfg.roleIds.botc}> 🕰️ **A game is forming!** ` +
        (short
          ? `${seated} seated — **${short} more** needed to start.`
          : `${seated} seated and ready to go — room for more.`) +
        '\nHit **Join Game** on the lobby panel above to take a seat.',
      allowedMentions: { roles: [cfg.roleIds.botc] },
    })
    .catch(() => null);
  if (!msg) return { error: `I could not post in <#${cfg.channels.townSquare}>.` };

  game.lastPingAt = Date.now();
  save();
  return { summary: `📣 Called **@BOTC** in <#${cfg.channels.townSquare}> — ${seated} seated so far.` };
}

module.exports = { startGame, pingForPlayers };
