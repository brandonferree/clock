const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  UserSelectMenuBuilder,
  StringSelectMenuBuilder,
  MessageFlags,
} = require('discord.js');
const { getGuild, save } = require('./store');
const { logAction, isStoryteller, mention } = require('./game');
const { pickerPayload, startInvite, handleInviteButton } = require('./whisperInvite');
const { refreshJoinPanel, openLobby } = require('./commands/game');
const { startGame, pingForPlayers } = require('./gameFlow');
const { updateLobbyPanel, removeSelectRow, whisperRulesPayload } = require('./lobbyPanel');
const { whisperRules } = require('./whisperRules');
const { voteEmbed, openNomination, bigCount, voterList } = require('./commands/nominate');
const { setPhase } = require('./phaseFlow');
const { playerSelect } = require('./dayPanel');
const {
  checklistPayload,
  updateChecklist,
  nightOrderEmbed,
  nightAlertSummary,
  bluffPool,
  setBluffs,
  sendToThread,
  promptChoices,
} = require('./night');
const { characterMenus, removeCharacterRow, updateAssignPanel } = require('./assignPanel');
const { tokenPanelPayload, tokensFor } = require('./reminderPanel');
const { updateBoard, grimoireView } = require('./grimoire');
const { dealCharacters, publishCharacters, pendingIds, shuffle } = require('./deal');
const { voteBlock } = require('./voteRules');
const { placeToken } = require('./tokens');
const { entryFor, stepPanel, recordChoice, stage, sendAnswer, askAgain, becomeDemon, resendTeamInfo } = require('./nightStep');
const { actionFor, choicePayload } = require('./nightActions');
const { setupWarning, targetCounts } = require('./setupMods');
const { rolesById, TEAM_LABEL, editions, SETUP_TABLE } = require('./data/scripts');

/** What the Storyteller is told after the bluffs are set, from either path. */
function bluffResult(roles, delivered, targets) {
  const named = roles.map((r) => `**${r.name}**`).join(', ');
  if (!targets) return `🎭 Bluffs set: ${named}. *No Demon is seated yet, so nothing was delivered — they will not be sent automatically later.*`;
  return delivered
    ? `🎭 Bluffs set: ${named} — sent to the Demon's Storyteller thread.`
    : `🎭 Bluffs set: ${named} — **but the Demon's thread could not be reached, so show them by hand.**`;
}

async function handleButton(interaction) {
  const id = interaction.customId;
  const cfg = getGuild(interaction.guild.id);
  const game = cfg.game;

  // --- 🎲 Open the next lobby, from #grimoire between games ---
  if (id === 'botc_new_game') {
    if (!isStoryteller(interaction.member)) {
      return interaction.reply({ content: 'Only the Storyteller can do that.', flags: MessageFlags.Ephemeral });
    }
    // Opening a lobby posts two panels and a log entry, so defer rather than
    // race the three-second interaction deadline.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const { error, summary } = await openLobby(interaction.guild, interaction.user.id);
    return interaction.editReply(error ?? summary);
  }

  // --- Lobby join/leave ---
  // Seat changes are deliberately not logged to #game-log: the join panel's
  // running roster already shows who is in, and a line per player turned the
  // log into a wall of pings before the game had even started. The final
  // roster is written once, at '🎭 The game begins!'.
  if (id === 'botc_join' || id === 'botc_leave') {
    if (!game || game.status !== 'lobby') {
      return interaction.reply({ content: 'The lobby is closed.', flags: MessageFlags.Ephemeral });
    }
    if (id === 'botc_join') {
      if (game.players[interaction.user.id]) {
        return interaction.reply({ content: 'You are already in the game.', flags: MessageFlags.Ephemeral });
      }
      game.players[interaction.user.id] = {
        name: interaction.member.displayName,
        character: null,
        alive: true,
        deadVoteUsed: false,
        stThreadId: null,
      };
      save();
      await refreshJoinPanel(interaction.guild);
      await updateLobbyPanel(interaction.guild);
      return interaction.reply({ content: 'You joined the game! 🪑', flags: MessageFlags.Ephemeral });
    } else {
      if (!game.players[interaction.user.id]) {
        return interaction.reply({ content: 'You are not in the game.', flags: MessageFlags.Ephemeral });
      }
      delete game.players[interaction.user.id];
      save();
      await refreshJoinPanel(interaction.guild);
      await updateLobbyPanel(interaction.guild);
      return interaction.reply({ content: 'You left the game.', flags: MessageFlags.Ephemeral });
    }
  }

  // --- Lobby controls (Storyteller only, live in #grimoire) ---
  if (id.startsWith('botc_lobby_')) {
    if (!isStoryteller(interaction.member)) {
      return interaction.reply({ content: 'Only the Storyteller can run the lobby.', flags: MessageFlags.Ephemeral });
    }
    if (!game || game.status !== 'lobby') {
      return interaction.reply({ content: 'There is no open lobby. Use `/game new`.', flags: MessageFlags.Ephemeral });
    }

    if (id === 'botc_lobby_add') {
      // Seat people who have not clicked Join themselves — the usual case is
      // somebody at the table who is not watching Discord.
      return interaction.reply({
        content: 'Who is playing? Everyone you pick is seated immediately, exactly as if they had pressed **Join Game**.',
        components: [
          new ActionRowBuilder().addComponents(
            new UserSelectMenuBuilder()
              .setCustomId('botc_lobby_add_select')
              .setPlaceholder('Pick players to seat')
              .setMinValues(1)
              .setMaxValues(15)
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (id === 'botc_lobby_remove') {
      const row = removeSelectRow(game);
      if (!row) return interaction.reply({ content: 'Nobody is seated.', flags: MessageFlags.Ephemeral });
      return interaction.reply({
        content: 'Who is out? They are unseated immediately, exactly as if they had pressed **Leave**.',
        components: [row],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (id === 'botc_lobby_ping') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const { error, summary } = await pingForPlayers(interaction.guild);
      return interaction.editReply(error ?? summary);
    }

    if (id === 'botc_lobby_start') {
      // Same work as `/game start`: a thread per player, so defer.
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const { error, summary } = await startGame(interaction.guild);
      return interaction.editReply(error ?? summary);
    }
  }

  // --- ⚙️ on the lobby controls: the whisper rules, while they can still change ---
  if (id === 'botc_whisper_rules') {
    if (!isStoryteller(interaction.member)) {
      return interaction.reply({ content: 'Only the Storyteller can set the whisper rules.', flags: MessageFlags.Ephemeral });
    }
    if (!game || game.status !== 'lobby') {
      return interaction.reply({
        content:
          'The whisper rules are fixed once the game starts — changing them mid-game would rewrite the terms a day was already played under.',
        flags: MessageFlags.Ephemeral,
      });
    }
    return interaction.reply({ ...whisperRulesPayload(game), flags: MessageFlags.Ephemeral });
  }

  // --- Night wake checklist: 🔄 Reset (Storyteller only, lives in #grimoire) ---
  if (id === 'botc_night_reset') {
    if (!isStoryteller(interaction.member)) {
      return interaction.reply({ content: 'Only the Storyteller can use the wake list.', flags: MessageFlags.Ephemeral });
    }
    if (!game?.nightAlert || interaction.message.id !== game.nightAlert.messageId) {
      return interaction.reply({ content: 'This wake list is from an earlier night. Run `/st night-alert` for the current one.', flags: MessageFlags.Ephemeral });
    }
    // Only the ticks. What players chose and what they have already been told
    // are facts about tonight, not progress marks — un-ticking a step is for
    // re-visiting it, and re-visiting it needs their choice still there.
    game.nightAlert.done = {};
    save();
    return interaction.update(checklistPayload(game));
  }

  // --- One night step: the panel behind every character button on the wake
  //     list, and everything inside it (Storyteller only) ---
  if (id.startsWith('botc_na_')) {
    const [action, ...rest] = id.slice('botc_na_'.length).split(':');
    if (!isStoryteller(interaction.member)) {
      return interaction.reply({ content: 'Only the Storyteller can run the night.', flags: MessageFlags.Ephemeral });
    }
    if (!game?.nightAlert) {
      return interaction.reply({ content: 'No night is running. Use `/st night-alert`.', flags: MessageFlags.Ephemeral });
    }
    // `botc_na_val` carries its value first, so the key — which contains both a
    // player id and a step number — stays the unsplit remainder.
    const key = action === 'val' ? rest.slice(1).join(':') : rest.join(':');
    const entry = entryFor(game, key);
    if (!entry) {
      return interaction.reply({ content: 'That step is not part of tonight any more.', flags: MessageFlags.Ephemeral });
    }

    // Opening the panel is the only one of these that arrives from the wake
    // list itself, so it is the only one that opens a new ephemeral.
    if (action === 'step') {
      return interaction.reply({ ...stepPanel(game, key), flags: MessageFlags.Ephemeral });
    }

    if (action === 'done') {
      game.nightAlert.done ??= {};
      if (game.nightAlert.done[key]) delete game.nightAlert.done[key];
      else game.nightAlert.done[key] = true;
      save();
      await updateChecklist(interaction.guild);
      return interaction.update(stepPanel(game, key));
    }

    // The evil team meeting, again. It sends itself when night falls, so this
    // is the recovery path: a thread that was archived, or a player who lost
    // the message.
    if (action === 'info') {
      await interaction.deferUpdate();
      const { error, ok } = await resendTeamInfo(interaction.guild, game, key);
      await interaction.followUp({ content: error ? `⚠️ ${error}` : ok, flags: MessageFlags.Ephemeral });
      return interaction.editReply(stepPanel(game, key));
    }

    if (action === 'ask') {
      await interaction.deferUpdate();
      const { error, ok } = await askAgain(interaction.guild, game, key);
      await interaction.followUp({ content: error ?? ok, flags: MessageFlags.Ephemeral });
      return interaction.editReply(stepPanel(game, key));
    }

    if (action === 'val') {
      await interaction.deferUpdate();
      const { error, warning } = await sendAnswer(interaction.guild, game, key, rest[0]);
      if (error) return interaction.followUp({ content: error, flags: MessageFlags.Ephemeral });
      if (warning) await interaction.followUp({ content: `⚠️ ${warning}`, flags: MessageFlags.Ephemeral });
      return interaction.editReply(stepPanel(game, key));
    }

    // The Scarlet Woman inheriting the Demon: a character change in the
    // grimoire *and* the card that tells her, which is the half a tick box
    // could never do.
    if (action === 'become') {
      await interaction.deferUpdate();
      // Nothing is logged: #game-log is read by players, and "the Scarlet
      // Woman is now the Imp" is the single most game-deciding line the bot
      // could ever put in front of them. The grimoire board and their own
      // thread are the whole record.
      const { error, ok } = await becomeDemon(interaction.guild, game, key);
      await interaction.followUp({ content: error ? `⚠️ ${error}` : ok, flags: MessageFlags.Ephemeral });
      return interaction.editReply(stepPanel(game, key));
    }

    // Placing the token the ability leaves behind — Poisoned, Protected,
    // Master. The character and the token text both come from the spec, so this
    // is the same token the reminder panel would have placed by hand.
    if (action === 'token') {
      const spec = actionFor(entry);
      const targetId = entry.choice?.targets?.[0];
      const target = targetId && game.players[targetId];
      const text = (rolesById.get(spec?.token?.role)?.reminders ?? []).find((t) => spec.token.match.test(t));
      if (!target || !text) {
        return interaction.reply({ content: 'There is nobody to put that token on yet.', flags: MessageFlags.Ephemeral });
      }
      target.reminders ??= [];
      const at = target.reminders.findIndex((r) => r.role === spec.token.role && r.text === text);
      // The same button takes it off again. Placing it *moves* it: there is one
      // Poisoned token in the box, so putting it on tonight's target is the
      // same motion as taking it off last night's.
      let movedFrom = null;
      if (at >= 0) target.reminders.splice(at, 1);
      else movedFrom = placeToken(game, targetId, spec.token.role, text);
      save();
      await updateBoard(interaction.guild);
      await interaction.update(stepPanel(game, key));
      if (movedFrom) {
        await interaction.followUp({
          content: `🔖 Moved the **${text}** token off ${mention(game, movedFrom)} — only one is ever on the board.`,
          flags: MessageFlags.Ephemeral,
        });
      }
      return;
    }

    if (action === 'kill') {
      const targetId = entry.choice?.targets?.[0];
      const target = targetId && game.players[targetId];
      if (!target?.alive) {
        return interaction.reply({ content: 'There is nobody alive to kill there.', flags: MessageFlags.Ephemeral });
      }
      target.alive = false;
      // The Ravenkeeper wakes on the night they die, and only that night.
      target.diedAt = game.day;
      save();
      await logAction(interaction.guild, {
        title: '💀 Death',
        color: 'death',
        description:
          `${mention(game, targetId)} died in the night.` +
          '\n*Dead players may still talk, and have one final vote.*',
      });
      await updateBoard(interaction.guild);
      await updateChecklist(interaction.guild);
      // A death can wake somebody: the Ravenkeeper has nothing to be asked until
      // the moment they are killed, and now is that moment.
      await promptChoices(interaction.guild);
      return interaction.update(stepPanel(game, key));
    }
  }

  // --- Phase buttons: ☀️ on the wake list, 📢 and 🌙 on the day panel (ST only) ---
  if (id === 'botc_start_day' || id === 'botc_day_gather' || id === 'botc_day_night') {
    if (!isStoryteller(interaction.member)) {
      return interaction.reply({ content: 'Only the Storyteller can change the phase.', flags: MessageFlags.Ephemeral });
    }
    // Rendering the town picture fetches art on a cold cache, so defer.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const target = id === 'botc_start_day' ? 'day' : id === 'botc_day_gather' ? 'town' : 'night';
    const { error, summary } = await setPhase(interaction.guild, target);
    return interaction.editReply(error ?? summary);
  }

  // --- 📜 on the lobby controls in #grimoire: which script are we playing? ---
  if (id === 'botc_script') {
    if (!isStoryteller(interaction.member)) {
      return interaction.reply({ content: 'Only the Storyteller can choose the script.', flags: MessageFlags.Ephemeral });
    }
    // Lobby only. Swapping scripts under a running game would leave players
    // holding characters that are no longer on it.
    if (!game || game.status !== 'lobby') {
      return interaction.reply({
        content: 'The script can only be changed before the game starts.',
        flags: MessageFlags.Ephemeral,
      });
    }
    return interaction.reply({
      content: 'Which script are you running? This sets the character pool and the reminder tokens on offer.',
      components: [
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('botc_script_set')
            .setPlaceholder('Pick a script')
            .addOptions(
              editions.slice(0, 25).map((e) => ({
                label: e.name.slice(0, 100),
                value: e.id,
                default: e.id === game.script,
              }))
            )
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
  }

  // --- 🔖 on the wake list: place and remove reminder tokens ---
  if (id === 'botc_night_remind' || id === 'botc_rem_back') {
    if (!isStoryteller(interaction.member)) {
      return interaction.reply({ content: 'Only the Storyteller can move reminder tokens.', flags: MessageFlags.Ephemeral });
    }
    if (!game || game.status !== 'running') {
      return interaction.reply({ content: 'No game is running.', flags: MessageFlags.Ephemeral });
    }
    const payload = tokenPanelPayload(game);
    // `botc_rem_back` comes from inside the panel itself, so it edits in place;
    // the wake-list button has to open a new ephemeral.
    return id === 'botc_rem_back'
      ? interaction.update(payload)
      : interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
  }

  // --- 🎭 on the first-night wake list: the Demon's three bluffs ---
  if (id === 'botc_night_bluffs' || id === 'botc_night_bluffs_random') {
    if (!isStoryteller(interaction.member)) {
      return interaction.reply({ content: 'Only the Storyteller can choose the bluffs.', flags: MessageFlags.Ephemeral });
    }
    if (!game || game.status !== 'running') {
      return interaction.reply({ content: 'No game is running.', flags: MessageFlags.Ephemeral });
    }
    const pool = bluffPool(game);
    if (pool.length < 3) {
      return interaction.reply({
        content: 'Fewer than three good characters are out of play — there is nothing safe to bluff. Deal characters first.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (id === 'botc_night_bluffs_random') {
      const { roles, delivered, targets } = await setBluffs(interaction.guild, game, shuffle(pool).slice(0, 3).map((r) => r.id));
      await updateChecklist(interaction.guild);
      return interaction.update({ content: bluffResult(roles, delivered, targets), components: [] });
    }

    // The pool runs past 25 on a full script once nothing is in play, and a
    // select menu holds 25 — so offer a shuffled draw as well as the list.
    return interaction.reply({
      content:
        'Pick the **three good characters not in play** to show the Demon. ' +
        'They go straight into the Demon’s Storyteller thread, so they can re-read them later.',
      components: [
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('botc_night_bluffs_set')
            .setPlaceholder('Choose exactly three')
            .setMinValues(3)
            .setMaxValues(3)
            .addOptions(
              pool.slice(0, 25).map((r) => ({
                label: r.name.slice(0, 100),
                value: r.id,
                description: (`${TEAM_LABEL[r.team] ?? r.team} — ${r.ability ?? ''}`).slice(0, 100),
                default: game.bluffs?.includes(r.id),
              }))
            )
        ),
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('botc_night_bluffs_random')
            .setLabel('Pick three at random')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('🎲')
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
  }

  // --- 📖 on the wake list: the private grimoire, same view as `/st grimoire` ---
  if (id === 'botc_night_grimoire') {
    if (!isStoryteller(interaction.member)) {
      return interaction.reply({ content: 'Only the Storyteller can see the grimoire.', flags: MessageFlags.Ephemeral });
    }
    if (!game || game.status !== 'running') {
      return interaction.reply({ content: 'No game is running.', flags: MessageFlags.Ephemeral });
    }
    // Rendering the board fetches character art on a cold cache, so defer.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    return interaction.editReply(await grimoireView(game));
  }

  // --- Kill / nominate-on-behalf: 💀 on both the day panel and the wake list,
  //     ⚖️ on the day panel (Storyteller only, both live in #grimoire) ---
  if (id === 'botc_day_kill' || id === 'botc_night_kill' || id === 'botc_day_nominate') {
    if (!isStoryteller(interaction.member)) {
      return interaction.reply({ content: 'Only the Storyteller can use these.', flags: MessageFlags.Ephemeral });
    }
    if (!game || game.status !== 'running') {
      return interaction.reply({ content: 'No game is running.', flags: MessageFlags.Ephemeral });
    }
    const killing = id !== 'botc_day_nominate';
    const row = playerSelect(
      game,
      killing ? 'botc_kill_select' : 'botc_nom_by',
      killing ? 'Who dies?' : 'Who is nominating?',
      { aliveOnly: true }
    );
    if (!row) return interaction.reply({ content: 'Nobody is still alive.', flags: MessageFlags.Ephemeral });
    return interaction.reply({
      content: killing
        ? 'Pick the player who dies. During the day this is logged as an execution; at night, as a night death.'
        : 'Pick the player who is nominating — you will choose their target next.',
      components: [row],
      flags: MessageFlags.Ephemeral,
    });
  }

  // --- Nomination button in #game-log: seated, living players only ---
  if (id === 'botc_nom_open') {
    if (!game || game.status !== 'running') {
      return interaction.reply({ content: 'No game is running.', flags: MessageFlags.Ephemeral });
    }
    const player = game.players[interaction.user.id];
    if (!player) {
      return interaction.reply({ content: 'Only seated players can nominate.', flags: MessageFlags.Ephemeral });
    }
    if (!player.alive) {
      return interaction.reply({ content: 'Dead players cannot nominate.', flags: MessageFlags.Ephemeral });
    }
    if (game.phase !== 'day') {
      return interaction.reply({ content: 'Nominations only happen during the day.', flags: MessageFlags.Ephemeral });
    }
    if (player.nominatedToday === game.day) {
      return interaction.reply({ content: 'You have already nominated today.', flags: MessageFlags.Ephemeral });
    }
    if (game.nomination?.open) {
      return interaction.reply({
        content: 'A nomination is already being voted on. Wait for the Storyteller to close it.',
        flags: MessageFlags.Ephemeral,
      });
    }
    const row = playerSelect(game, `botc_nom_for:${interaction.user.id}`, 'Who do you nominate?');
    return interaction.reply({
      content: 'Who are you putting up for execution? **This is your one nomination today.**',
      components: [row],
      flags: MessageFlags.Ephemeral,
    });
  }

  // --- Night controls, posted once the town is fully dealt (Storyteller only) ---
  if (id === 'botc_night_order' || id === 'botc_night_alert') {
    if (!isStoryteller(interaction.member)) {
      return interaction.reply({ content: 'Only the Storyteller can use these.', flags: MessageFlags.Ephemeral });
    }
    if (!game || game.status !== 'running') {
      return interaction.reply({ content: 'No game is running.', flags: MessageFlags.Ephemeral });
    }
    if (id === 'botc_night_order') {
      return interaction.reply({ embeds: [nightOrderEmbed(game)], flags: MessageFlags.Ephemeral });
    }
    // Pinging N threads is N round-trips, so defer.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    return interaction.editReply(await nightAlertSummary(interaction.guild));
  }

  // --- Character assignment panel (Storyteller only, lives in #grimoire) ---
  if (id.startsWith('botc_assign_')) {
    if (!isStoryteller(interaction.member)) {
      return interaction.reply({ content: 'Only the Storyteller can assign characters.', flags: MessageFlags.Ephemeral });
    }
    if (!game || game.status !== 'running') {
      return interaction.reply({ content: 'No game is running.', flags: MessageFlags.Ephemeral });
    }

    // Pick a character for one player: show a menu per team.
    if (id.startsWith('botc_assign_pick:')) {
      const playerId = id.slice('botc_assign_pick:'.length);
      const player = game.players[playerId];
      if (!player) {
        return interaction.reply({ content: 'That player has left the game. Re-post the panel with `/st assign-panel`.', flags: MessageFlags.Ephemeral });
      }
      const current = player.character && rolesById.get(player.character);
      return interaction.reply({
        content:
          `**${player.name}** — pick a character.` +
          (current ? ` Currently staged as the **${current.name}**; picking again replaces it.` : '') +
          (player.delivered
            ? ` They have already been told they are the **${rolesById.get(player.delivered)?.name}** — a change means publishing again.`
            : ' Nothing is sent until you publish.'),
        components: characterMenus(game, playerId),
        flags: MessageFlags.Ephemeral,
      });
    }

    // ➖ Remove one: take a character back off a seat without touching the rest.
    if (id === 'botc_assign_remove') {
      const row = removeCharacterRow(game);
      if (!row) return interaction.reply({ content: 'Nobody has a character yet.', flags: MessageFlags.Ephemeral });
      return interaction.reply({
        content:
          'Whose character comes off? They go back to unassigned and can be re-picked. ' +
          'Anyone already told keeps believing what they were sent — there is no un-sending.',
        components: [row],
        flags: MessageFlags.Ephemeral,
      });
    }

    // 📨 Publish: the review, then the send.
    if (id === 'botc_assign_publish' || id === 'botc_assign_publish_confirm') {
      const players = Object.entries(game.players);
      const pending = pendingIds(game);
      if (!players.length) return interaction.reply({ content: 'Nobody is seated.', flags: MessageFlags.Ephemeral });
      const unassigned = players.filter(([, p]) => !p.character);
      if (unassigned.length) {
        return interaction.reply({
          content: `Still unassigned: ${unassigned.map(([pid]) => mention(game, pid)).join(', ')}. Fill every seat before publishing.`,
          flags: MessageFlags.Ephemeral,
        });
      }
      if (!pending.length) {
        return interaction.reply({ content: 'Everyone already has what is on the board — nothing to send.', flags: MessageFlags.Ephemeral });
      }

      // The review. This is the last look before the town knows anything, so it
      // shows the whole spread — not just what is about to move — along with
      // the two mistakes that survive a casual read: a duplicated character and
      // a team split that does not match the setup table.
      if (id === 'botc_assign_publish') {
        const counts = {};
        for (const [, p] of players) counts[p.character] = (counts[p.character] ?? 0) + 1;
        const dupes = Object.entries(counts).filter(([, n]) => n > 1).map(([rid]) => rolesById.get(rid)?.name ?? rid);
        const tally = { townsfolk: 0, outsider: 0, minion: 0, demon: 0, traveler: 0 };
        for (const [, p] of players) {
          const team = rolesById.get(p.character)?.team;
          if (team in tally) tally[team] += 1;
        }
        const actual = [tally.townsfolk, tally.outsider, tally.minion, tally.demon];
        // With a Baron (or any other setup-modifier) staged, the plain table is
        // the wrong yardstick — the split *should* be off it, by a known amount.
        // Check against the adjusted target instead, and print the working.
        const setupTarget = targetCounts(game);
        const expected = setupTarget?.target ?? SETUP_TABLE[Math.min(players.length, 15)];
        const offTable = expected && expected.join('/') !== actual.join('/');
        const warning = setupWarning(game);

        return interaction.reply({
          content: [
            `📨 **Publishing to ${pending.length} of ${players.length} players.** Last look:`,
            '',
            players
              .map(([pid, p]) => {
                const role = rolesById.get(p.character);
                const moving = pending.includes(pid);
                return `${moving ? '📨' : '✅'} ${mention(game, pid)} → **${role?.name ?? p.character}**${moving ? '' : ' *(already told)*'}`;
              })
              .join('\n'),
            '',
            `Setup: **${actual.join('/')}** townsfolk/outsiders/minions/demon` +
              (offTable
                ? ` ⚠️ *${setupTarget?.changed ? 'with the modifiers below it should be' : 'the table says'} ${expected.join('/')} for ${players.length} players.*`
                : ' ✅'),
            warning ?? '',
            dupes.length ? `⚠️ **Assigned twice:** ${dupes.join(', ')}` : '',
            '',
            'Everyone pending is told at the same moment. There is no taking it back.',
          ]
            .filter((l) => l !== '')
            .join('\n')
            .slice(0, 1900),
          components: [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId('botc_assign_publish_confirm')
                .setLabel(warning ? `Send to ${pending.length} anyway` : `Send to ${pending.length}`)
                .setStyle(warning ? ButtonStyle.Danger : ButtonStyle.Success)
                .setEmoji('📨')
            ),
          ],
          flags: MessageFlags.Ephemeral,
        });
      }

      await interaction.update({ content: '📨 Sending…', components: [] });
      const { sent, failed } = await publishCharacters(interaction.guild, game);
      if (sent.length) {
        await logAction(interaction.guild, {
          title: '🎭 Characters have been handed out',
          description:
            `**${sent.length}** player${sent.length === 1 ? ' has' : 's have'} been told who they are, privately and all at once. ` +
            'Check your Storyteller thread — and say nothing.',
        });
      }
      await updateBoard(interaction.guild);
      await updateChecklist(interaction.guild);
      await updateAssignPanel(interaction.guild);
      return interaction.editReply({
        content: [
          sent.length ? `📨 Delivered to **${sent.length}** player${sent.length === 1 ? '' : 's'} simultaneously.` : '',
          failed.length
            ? `⚠️ Could not reach the Storyteller thread for ${failed.map((pid) => mention(game, pid)).join(', ')} — ` +
              'tell them directly. They are still marked as pending, so Publish will retry them.'
            : '',
        ]
          .filter(Boolean)
          .join('\n')
          .slice(0, 2000),
        components: [],
      });
    }

    // Random deal and clear both throw away existing characters, so ask first.
    const anyAssigned = Object.values(game.players).some((p) => p.character);
    if ((id === 'botc_assign_deal' || id === 'botc_assign_clear') && anyAssigned) {
      const clearing = id === 'botc_assign_clear';
      const anyTold = Object.values(game.players).some((p) => p.delivered);
      return interaction.reply({
        content:
          (clearing
            ? '🧹 Clear **every** staged character?'
            : '🎲 Some players already have characters staged. Re-dealing replaces all of them.') +
          (anyTold
            ? ' ⚠️ Some players have already been **told** their character — nothing can un-tell them, and they will keep believing it.'
            : ' Nothing has been sent yet, so this costs nothing.'),
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(clearing ? 'botc_assign_clear_confirm' : 'botc_assign_deal_confirm')
              .setLabel(clearing ? 'Yes, clear all' : 'Yes, re-deal')
              .setStyle(ButtonStyle.Danger)
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (id === 'botc_assign_clear' || id === 'botc_assign_clear_confirm') {
      for (const p of Object.values(game.players)) p.character = null;
      game.bluffs = null;
      save();
      await updateBoard(interaction.guild);
      await updateChecklist(interaction.guild);
      await updateAssignPanel(interaction.guild);
      const payload = { content: '🧹 All staged characters cleared.', components: [] };
      return id === 'botc_assign_clear_confirm' ? interaction.update(payload) : interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
    }

    if (id === 'botc_assign_deal' || id === 'botc_assign_deal_confirm') {
      const result = dealCharacters(game);
      const payload = result.error
        ? { content: result.error, components: [] }
        : {
            content: [
              `🎲 Staged **${result.dealt.length}** characters (${result.dist.join('/')} townsfolk/outsiders/minions/demon):`,
              result.dealt.map(({ id: pid, role }) => `${mention(game, pid)} → **${role.name}**`).join('\n'),
              '',
              '**Nothing has been sent.** Adjust with the player buttons or ➖ Remove one, then hit 📨 **Publish** to tell everyone at once.',
              // Named, not hinted at: the deal just put these on the board and
              // did not apply a single one of them.
              setupWarning(game) ?? '*No setup-modifying characters were dealt — the table split stands.*',
            ]
              .join('\n')
              .slice(0, 2000),
            components: [],
          };

      if (!result.error) {
        await updateBoard(interaction.guild);
        await updateChecklist(interaction.guild);
        await updateAssignPanel(interaction.guild);
      }
      return id === 'botc_assign_deal_confirm'
        ? interaction.update(payload)
        : interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
    }
  }

  // --- Whisper: show the picker, bounded by the room size and today's budget ---
  if (id === 'botc_whisper') {
    const payload = pickerPayload(game, interaction.user.id);
    return interaction.reply(
      payload.error
        ? { content: payload.error, flags: MessageFlags.Ephemeral }
        : { ...payload, flags: MessageFlags.Ephemeral }
    );
  }

  // --- Whisper: Accept / Decline on an invitation ---
  if (id.startsWith('botc_wi_')) return handleInviteButton(interaction);

  // --- The Virgin: the Storyteller's call on a nomination that fired ---
  if (id.startsWith('botc_virgin_')) {
    if (!isStoryteller(interaction.member)) {
      return interaction.reply({ content: 'Only the Storyteller can rule on the Virgin.', flags: MessageFlags.Ephemeral });
    }
    if (!game) return interaction.reply({ content: 'No game is running.', flags: MessageFlags.Ephemeral });

    if (id === 'botc_virgin_no') {
      // The ability is still spent — the token went on when the nomination was
      // made — so all that is left is to close the prompt.
      return interaction.update({
        content: '🤐 Nothing happens. The nomination stands and the vote goes ahead as normal.',
        embeds: [],
        components: [],
      });
    }

    const targetId = id.slice('botc_virgin_go:'.length);
    const target = game.players[targetId];
    if (!target) return interaction.update({ content: 'That player is not in the game.', components: [] });
    if (!target.alive) {
      return interaction.update({ content: `${target.name} is already dead.`, embeds: [], components: [] });
    }

    target.alive = false;
    target.diedAt = game.day;
    // An immediate execution is still an execution: the Undertaker learns this
    // character tonight, and forgetting to record it here is a wrong answer
    // hours later with nothing left to trace it to.
    game.lastExecuted = { id: targetId, character: target.character, day: game.day };
    save();

    // Public, and it should be: the town watches somebody drop dead the instant
    // they finish speaking. What is *not* said is why — the log names no
    // character, so the Virgin is only as revealed as the table works out.
    await logAction(interaction.guild, {
      title: '⚖️ Executed immediately',
      color: 'death',
      description:
        `${mention(game, targetId)} nominated ${mention(game, game.nomination?.nominee ?? targetId)} and ` +
        'was **executed on the spot**.' +
        '\n*This is today\'s execution — the town does not get another one.*' +
        '\n*Dead players may still talk, and have one final vote.*',
    });
    await updateBoard(interaction.guild);
    // A death changes the alive count, and the alive count is the majority the
    // open vote is being measured against.
    if (game.nomination?.open && game.nomination.messageId) {
      const square = await interaction.guild.channels.fetch(cfg.channels.townSquare).catch(() => null);
      const voteMsg = square && (await square.messages.fetch(game.nomination.messageId).catch(() => null));
      await voteMsg?.edit({ embeds: [voteEmbed(game)] }).catch(() => null);
    }
    return interaction.update({
      content:
        `⚖️ **${target.name} is executed immediately.** Logged, board updated, and the vote's majority has moved.` +
        ' They are dead for tonight\'s Undertaker.',
      embeds: [],
      components: [],
    });
  }

  // --- Voting ---
  if (id === 'botc_vote_yes' || id === 'botc_vote_no' || id === 'botc_vote_close') {
    if (!game?.nomination?.open || interaction.message.id !== game.nomination.messageId) {
      return interaction.reply({ content: 'This vote is closed.', flags: MessageFlags.Ephemeral });
    }
    const nom = game.nomination;

    if (id === 'botc_vote_close') {
      if (!isStoryteller(interaction.member)) {
        return interaction.reply({ content: 'Only the Storyteller can close the vote.', flags: MessageFlags.Ephemeral });
      }
      nom.open = false;
      const yes = Object.entries(nom.votes).filter(([, v]) => v).map(([id]) => id);
      const alive = Object.values(game.players).filter((p) => p.alive).length;
      const needed = Math.ceil(alive / 2);
      const passed = yes.length >= needed;
      // Spend dead votes for dead players who voted yes.
      for (const voterId of yes) {
        const p = game.players[voterId];
        if (p && !p.alive) p.deadVoteUsed = true;
      }
      save();
      await interaction.update({ embeds: [voteEmbed(game)], components: [] });
      await logAction(interaction.guild, {
        title: passed ? '🗳️ Vote passed' : '🗳️ Vote failed',
        color: 'vote',
        description: [
          `${mention(game, nom.nominator)} nominated ${mention(game, nom.nominee)}.`,
          '',
          bigCount(yes.length, needed, passed ? '**majority reached**' : `${needed - yes.length} short`),
          '',
          passed
            ? `**${mention(game, nom.nominee)} is about to be executed** — unless a later nomination gets more votes today.`
            : 'The nomination does not reach a majority.',
        ].join('\n'),
        // A field, not another paragraph: the roll call is a list and needs its
        // own heading, otherwise fourteen names reflow into a wall of text.
        fields: [{ name: `Voted yes (${yes.length})`, value: voterList(game, yes, '*Nobody voted.*').slice(0, 1024) }],
      });
      return;
    }

    const voter = game.players[interaction.user.id];
    if (!voter) {
      return interaction.reply({ content: 'Only seated players can vote.', flags: MessageFlags.Ephemeral });
    }
    // Votes are final: a hand goes up or it does not, and it stays that way.
    if (interaction.user.id in nom.votes) {
      return interaction.reply({
        content: `🔒 You already voted **${nom.votes[interaction.user.id] ? 'YES' : 'NO'}** on this nomination. Votes are final — you cannot change or retract them.`,
        flags: MessageFlags.Ephemeral,
      });
    }
    if (id === 'botc_vote_yes' && !voter.alive && voter.deadVoteUsed) {
      return interaction.reply({
        content: 'You are dead and have already spent your dead vote.',
        flags: MessageFlags.Ephemeral,
      });
    }
    // The Butler may only vote when their Master does. Refused privately and
    // with nothing recorded: a blocked hand has to look exactly like a hand
    // that was never raised, or the tally itself outs them.
    const blocked = voteBlock(game, interaction.user.id, id === 'botc_vote_yes');
    if (blocked) {
      return interaction.reply({ content: blocked, flags: MessageFlags.Ephemeral });
    }
    nom.votes[interaction.user.id] = id === 'botc_vote_yes';
    save();
    await interaction.update({ embeds: [voteEmbed(game)] });
    await interaction.followUp({
      content:
        id === 'botc_vote_yes'
          ? '🗳️ Your **YES** vote is locked in. Votes are final — you cannot retract it.'
          : 'Your **NO** vote is locked in. Votes are final — you cannot change it.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
}

async function handleSelect(interaction) {
  const selId = interaction.customId;

  // --- Script chosen from the lobby panel ---
  if (selId === 'botc_script_set') {
    if (!isStoryteller(interaction.member)) {
      return interaction.update({ content: 'Only the Storyteller can choose the script.', components: [] });
    }
    const cfg = getGuild(interaction.guild.id);
    const game = cfg.game;
    if (!game || game.status !== 'lobby') {
      return interaction.update({ content: 'The script can only be changed before the game starts.', components: [] });
    }
    const script = editions.find((e) => e.id === interaction.values[0]);
    if (!script) return interaction.update({ content: 'Unknown script.', components: [] });
    game.script = script.id;
    save();
    await refreshJoinPanel(interaction.guild);
    await updateLobbyPanel(interaction.guild);
    return interaction.update({ content: `📜 Script set to **${script.name}**.`, components: [] });
  }

  // --- ⚙️ Whisper rules: three menus on one message, each re-rendering it ---
  if (selId === 'botc_wr_budget' || selId === 'botc_wr_size' || selId === 'botc_wr_log') {
    if (!isStoryteller(interaction.member)) {
      return interaction.update({ content: 'Only the Storyteller can set the whisper rules.', components: [] });
    }
    const cfg = getGuild(interaction.guild.id);
    const game = cfg.game;
    if (!game || game.status !== 'lobby') {
      return interaction.update({ content: 'The whisper rules are fixed once the game starts.', components: [] });
    }
    const value = interaction.values[0];
    // Read through `whisperRules` first: a game created before this existed has
    // no rules object at all, and the menus must not write a half-filled one.
    const rules = whisperRules(game);
    if (selId === 'botc_wr_budget') {
      // "Off" and a budget are the same menu — a Storyteller thinking about how
      // many whispers to allow is choosing between none and a number, not
      // flipping a switch and then picking.
      rules.enabled = value !== '0';
      if (rules.enabled) rules.budget = Number(value);
    } else if (selId === 'botc_wr_size') {
      rules.size = Number(value);
    } else {
      rules.log = value;
    }
    game.whisperRules = rules;
    save();
    await updateLobbyPanel(interaction.guild);
    return interaction.update(whisperRulesPayload(game));
  }

  // --- Lobby controls: the Storyteller picked who to seat ---
  if (selId === 'botc_lobby_add_select') {
    if (!isStoryteller(interaction.member)) {
      return interaction.update({ content: 'Only the Storyteller can seat players.', components: [] });
    }
    const cfg = getGuild(interaction.guild.id);
    const game = cfg.game;
    if (!game || game.status !== 'lobby') {
      return interaction.update({ content: 'The lobby is closed.', components: [] });
    }

    const added = [];
    const already = [];
    const bots = [];
    for (const userId of interaction.values) {
      const user = interaction.users?.get(userId);
      // Real Discord bots have no thread to read their character in. Simulated
      // players are what `/test add-bots` is for.
      if (user?.bot) {
        bots.push(userId);
        continue;
      }
      if (game.players[userId]) {
        already.push(userId);
        continue;
      }
      const member = interaction.members?.get(userId) ?? (await interaction.guild.members.fetch(userId).catch(() => null));
      game.players[userId] = {
        name: member?.displayName ?? user?.username ?? 'Player',
        character: null,
        alive: true,
        deadVoteUsed: false,
        stThreadId: null,
      };
      added.push(userId);
    }
    save();
    await refreshJoinPanel(interaction.guild);
    await updateLobbyPanel(interaction.guild);
    return interaction.update({
      content: [
        added.length ? `🪑 Seated ${added.map((uid) => `<@${uid}>`).join(', ')}.` : 'Nobody new was seated.',
        already.length ? `Already in the game: ${already.map((uid) => `<@${uid}>`).join(', ')}.` : '',
        bots.length ? `Skipped bots (use \`/test add-bots\` for simulated players): ${bots.map((uid) => `<@${uid}>`).join(', ')}.` : '',
      ]
        .filter(Boolean)
        .join('\n')
        .slice(0, 2000),
      components: [],
    });
  }

  // --- Lobby controls: the Storyteller picked who to unseat ---
  if (selId === 'botc_lobby_remove_select') {
    if (!isStoryteller(interaction.member)) {
      return interaction.update({ content: 'Only the Storyteller can unseat players.', components: [] });
    }
    const cfg = getGuild(interaction.guild.id);
    const game = cfg.game;
    if (!game || game.status !== 'lobby') {
      return interaction.update({ content: 'The lobby is closed.', components: [] });
    }

    // Names are captured before the delete: once the entry is gone `mention`
    // has nothing to render a simulated player from.
    const removed = interaction.values
      .filter((pid) => game.players[pid])
      .map((pid) => {
        const label = mention(game, pid);
        delete game.players[pid];
        return label;
      });
    if (!removed.length) {
      return interaction.update({ content: 'Those players are no longer seated.', components: [] });
    }
    save();
    await refreshJoinPanel(interaction.guild);
    await updateLobbyPanel(interaction.guild);
    return interaction.update({
      content: `🚪 Unseated ${removed.join(', ')}.`.slice(0, 2000),
      components: [],
    });
  }

  // --- The Storyteller picked the Demon's three bluffs ---
  if (selId === 'botc_night_bluffs_set') {
    if (!isStoryteller(interaction.member)) {
      return interaction.update({ content: 'Only the Storyteller can choose the bluffs.', components: [] });
    }
    const cfg = getGuild(interaction.guild.id);
    const game = cfg.game;
    if (!game || game.status !== 'running') {
      return interaction.update({ content: 'No game is running.', components: [] });
    }
    const { error, roles, delivered, targets } = await setBluffs(interaction.guild, game, interaction.values);
    if (error) return interaction.update({ content: error, components: [] });
    await updateChecklist(interaction.guild);
    return interaction.update({ content: bluffResult(roles, delivered, targets), components: [] });
  }

  // --- Night actions: a player pointing at somebody in their own thread, and
  //     the Storyteller's half of the same step ---
  if (selId.startsWith('botc_na_')) {
    const [action, ...rest] = selId.slice('botc_na_'.length).split(':');
    const key = rest.join(':');
    const cfg = getGuild(interaction.guild.id);
    const game = cfg.game;
    if (!game?.nightAlert) {
      return interaction.update({ content: 'The night is over.', components: [] });
    }
    const entry = entryFor(game, key);
    if (!entry) {
      return interaction.update({ content: 'That step is not part of tonight any more.', components: [] });
    }

    // `pick` is the one control in the whole night that a player drives, and it
    // lives in their own thread — so it is theirs alone. Everything else here is
    // the Storyteller's side of the same step.
    if (action === 'pick') {
      // A simulated player has nobody behind it, so its picker is really the
      // Storyteller's — which is the point of putting one in a sim's
      // Storyteller-only thread at all.
      const mine = interaction.user.id === entry.id;
      const forSim = entry.player.isBot && isStoryteller(interaction.member);
      if (!mine && !forSim) {
        return interaction.reply({ content: 'That is not your choice to make.', flags: MessageFlags.Ephemeral });
      }
      recordChoice(game, key, interaction.values, forSim ? 'st' : 'player');
      await updateChecklist(interaction.guild);
      return interaction.update(choicePayload(game, entryFor(game, key)));
    }

    if (!isStoryteller(interaction.member)) {
      return interaction.reply({ content: 'Only the Storyteller can run the night.', flags: MessageFlags.Ephemeral });
    }

    if (action === 'stpick') {
      recordChoice(game, key, interaction.values, 'st');
      await updateChecklist(interaction.guild);
      // Tell the player what was recorded for them, so a choice made on their
      // behalf is never a thing that happened to them silently.
      await sendToThread(interaction.guild, entry.player.stThreadId, {
        content: `🌙 The Storyteller recorded your **${entry.role.name}** choice: ${interaction.values
          .map((pid) => `**${game.players[pid]?.name}**`)
          .join(' and ')}.`,
      }).catch(() => null);
      return interaction.update(stepPanel(game, key));
    }

    // The two halves of an info character's answer, staged until both are in.
    if (action === 'players') stage(game, key, { players: interaction.values });
    if (action === 'char') stage(game, key, { character: interaction.values[0] });
    return interaction.update(stepPanel(game, key));
  }

  // --- Reminder token panel: pick character, pick token, pick who holds it ---
  if (selId.startsWith('botc_rem_')) {
    if (!isStoryteller(interaction.member)) {
      return interaction.update({ content: 'Only the Storyteller can move reminder tokens.', components: [] });
    }
    const cfg = getGuild(interaction.guild.id);
    const game = cfg.game;
    if (!game) return interaction.update({ content: 'No game is running.', components: [] });
    // `botc_rem_<step>[:<roleId>[:<tokenIndex>]]` — the panel carries its own
    // progress in the custom ids, so it needs no state between clicks.
    const [step, roleId, tokenIndex] = selId.split(':');

    // The first two steps only narrow the menus below them; nothing is placed
    // until a player is picked.
    if (step === 'botc_rem_char') return interaction.update(tokenPanelPayload(game, interaction.values[0]));
    if (step === 'botc_rem_tok') {
      return interaction.update(tokenPanelPayload(game, roleId, Number(interaction.values[0])));
    }

    if (step === 'botc_rem_put') {
      const role = rolesById.get(roleId);
      const text = tokensFor(role)[Number(tokenIndex)];
      const player = game.players[interaction.values[0]];
      if (!player || !text) {
        return interaction.update({ content: 'That token or player is gone.', components: [] });
      }
      // The same one-of-each rule the night panel follows: this is the board,
      // not a supply of duplicates.
      placeToken(game, interaction.values[0], roleId, text);
    } else if (step === 'botc_rem_del') {
      const [playerId, i] = String(interaction.values[0]).split('|');
      const player = game.players[playerId];
      if (!player?.reminders?.[Number(i)]) return interaction.update(tokenPanelPayload(game));
      player.reminders.splice(Number(i), 1);
    }
    save();
    await updateBoard(interaction.guild);
    // Back to the same panel with the character still selected, so placing a run
    // of one character's tokens is a run of clicks rather than a restart.
    return interaction.update(tokenPanelPayload(game, step === 'botc_rem_put' ? roleId : null));
  }

  // --- The Storyteller picked who dies, from the day panel or the wake list ---
  if (selId === 'botc_kill_select') {
    if (!isStoryteller(interaction.member)) {
      return interaction.update({ content: 'Only the Storyteller can do that.', components: [] });
    }
    const cfg = getGuild(interaction.guild.id);
    const game = cfg.game;
    const playerId = interaction.values[0];
    const player = game?.players?.[playerId];
    if (!player) return interaction.update({ content: 'That player is not in the game.', components: [] });
    if (!player.alive) return interaction.update({ content: 'They are already dead.', components: [] });

    player.alive = false;
    player.diedAt = game.day;
    save();
    // The phase tells us how they died — it is an execution by day, a night kill
    // by night — which is what `/st kill` asks for with its `cause` option.
    const byDay = game.phase === 'day';
    // The Undertaker learns which character was executed today, so the execution
    // has to be remembered at the moment it happens: by the time they wake, the
    // day is over and only the grimoire is left.
    if (byDay) game.lastExecuted = { id: playerId, character: player.character, day: game.day };
    await logAction(interaction.guild, {
      title: '💀 Death',
      color: 'death',
      description:
        `${mention(game, playerId)} ${byDay ? `was executed by the town on Day ${game.day}.` : 'died in the night.'}` +
        '\n*Dead players may still talk, and have one final vote.*',
    });
    await updateBoard(interaction.guild);
    await updateChecklist(interaction.guild);
    return interaction.update({
      content: `💀 ${mention(game, playerId)} is dead — logged and board updated.`,
      components: [],
    });
  }

  // --- Day panel: the Storyteller picked who is nominating ---
  if (selId === 'botc_nom_by') {
    if (!isStoryteller(interaction.member)) {
      return interaction.update({ content: 'Only the Storyteller can do that.', components: [] });
    }
    const cfg = getGuild(interaction.guild.id);
    const nominatorId = interaction.values[0];
    const nominator = cfg.game?.players?.[nominatorId];
    if (!nominator) return interaction.update({ content: 'That player is not in the game.', components: [] });
    return interaction.update({
      content: `**${nominator.name}** nominates whom?`,
      components: [playerSelect(cfg.game, `botc_nom_for:${nominatorId}`, `Who does ${nominator.name} nominate?`)],
    });
  }

  // --- Nominee chosen, from either the player button or the Storyteller panel ---
  if (selId.startsWith('botc_nom_for:')) {
    const nominatorId = selId.slice('botc_nom_for:'.length);
    // The nominator is baked into the custom id, so check the presser owns it —
    // an ephemeral message is private, but the id must not be a way to nominate
    // as somebody else.
    if (nominatorId !== interaction.user.id && !isStoryteller(interaction.member)) {
      return interaction.update({ content: 'You can only nominate as yourself.', components: [] });
    }
    const cfg = getGuild(interaction.guild.id);
    const { error } = await openNomination(interaction.guild, nominatorId, interaction.values[0]);
    return interaction.update({
      content: error ?? `⚖️ Nomination posted in <#${cfg.channels.townSquare}> — go and vote.`,
      components: [],
    });
  }

  // --- Character chosen from the assignment panel ---
  if (interaction.customId.startsWith('botc_assign_set:')) {
    if (!isStoryteller(interaction.member)) {
      return interaction.update({ content: 'Only the Storyteller can assign characters.', components: [] });
    }
    const cfg = getGuild(interaction.guild.id);
    const game = cfg.game;
    // `botc_assign_set:<playerId>:<team>` — the team only keeps the ids unique.
    const playerId = interaction.customId.split(':')[1];
    const player = game?.players?.[playerId];
    const role = rolesById.get(interaction.values[0]);
    if (!player || !role) {
      return interaction.update({ content: 'That player or character is no longer available.', components: [] });
    }

    const wasTold = player.delivered && rolesById.get(player.delivered);
    player.character = role.id;
    save();

    // Staged, not sent. Nothing reaches the player until 📨 Publish.
    await updateBoard(interaction.guild);
    await updateChecklist(interaction.guild);
    await updateAssignPanel(interaction.guild);

    const dupes = Object.entries(game.players)
      .filter(([id, p]) => id !== playerId && p.character === role.id)
      .map(([id]) => mention(game, id));
    const stillPending = pendingIds(game).length;
    return interaction.update({
      content: [
        `🟡 **${player.name}** is staged as the **${role.name}** *(${TEAM_LABEL[role.team] ?? role.team})* — not sent yet.`,
        wasTold && wasTold.id !== role.id
          ? `⚠️ They were already told they are the **${wasTold.name}**. Publishing again sends the correction; they were never un-told the first one.`
          : '',
        dupes.length ? `⚠️ Also staged on ${dupes.join(', ')}.` : '',
        // Said at the moment of the pick, while the rest of the spread is still
        // in front of them — this is the cheapest possible time to fix it.
        role.setup ? `\n${setupWarning(game, { heading: '⚠️ **This changes the setup:**' })}\n` : '',
        `📨 **${stillPending}** waiting to be sent — hit Publish on the panel when the spread is right.`,
      ]
        .filter(Boolean)
        .join('\n'),
      components: [],
    });
  }

  // --- ➖ Remove one: take characters back off seats ---
  if (interaction.customId === 'botc_assign_remove_select') {
    if (!isStoryteller(interaction.member)) {
      return interaction.update({ content: 'Only the Storyteller can assign characters.', components: [] });
    }
    const cfg = getGuild(interaction.guild.id);
    const game = cfg.game;
    if (!game || game.status !== 'running') {
      return interaction.update({ content: 'No game is running.', components: [] });
    }

    const cleared = [];
    const told = [];
    for (const playerId of interaction.values) {
      const player = game.players[playerId];
      if (!player?.character) continue;
      const role = rolesById.get(player.character);
      player.character = null;
      cleared.push(`${mention(game, playerId)} *(was ${role?.name ?? 'assigned'})*`);
      if (player.delivered) told.push(mention(game, playerId));
    }
    if (!cleared.length) return interaction.update({ content: 'Those players no longer have a character.', components: [] });
    save();
    await updateBoard(interaction.guild);
    await updateChecklist(interaction.guild);
    await updateAssignPanel(interaction.guild);

    return interaction.update({
      content: [
        `➖ Removed: ${cleared.join(', ')}. They are unassigned again.`,
        told.length
          ? `⚠️ ${told.join(', ')} had already been told — they still believe it. Give them a new character and publish, or say so in their thread.`
          : '',
      ]
        .filter(Boolean)
        .join('\n')
        .slice(0, 2000),
      components: [],
    });
  }

  if (interaction.customId === 'botc_whisper_select') {
    const game = getGuild(interaction.guild.id).game;
    // Asking two or three people can be several round-trips — a thread to
    // create, or a message into each of their Storyteller threads.
    await interaction.deferUpdate();
    const { error, summary } = await startInvite(
      interaction.guild,
      game,
      interaction.user.id,
      interaction.values
    );
    return interaction.editReply({ content: error ?? summary, components: [] });
  }
}

module.exports = { handleButton, handleSelect };
