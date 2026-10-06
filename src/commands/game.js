const {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
} = require('discord.js');
const { getGuild, save } = require('../store');
const { logAction, isStoryteller, mention, daySegment, COLORS } = require('../game');
const { editions } = require('../data/scripts');
const { startGame } = require('../gameFlow');
const { postLobbyPanel, postNewGamePanel, clearNewGamePanel } = require('../lobbyPanel');
const { clearDayPanels, deleteIn } = require('../dayPanel');
const { recycleChannels } = require('../channels');
const { DEFAULTS } = require('../whisperRules');

function joinPanel(game) {
  const script = editions.find((e) => e.id === game.script);
  const players = Object.entries(game.players);
  const embed = new EmbedBuilder()
    .setTitle('🕰️ A new game is forming!')
    .setColor(COLORS.info)
    .setDescription(
      [
        `**Script:** ${script?.name ?? game.script}`,
        '',
        // One player per line, numbered. Comma-joined mentions wrapped into a
        // dense block that was hard to count, and the numbering doubles as the
        // seat order — these are the seats in the order the town circle draws
        // them, so a player can find themselves on the board.
        players.length
          ? `**Players (${players.length}):**\n${players.map(([id], i) => `\`${i + 1}.\` ${mention(game, id)}`).join('\n')}`
          : '*No players yet — be the first to join!*',
      ].join('\n')
    );
  // Players get Join and Leave and nothing else. Changing the script is the
  // Storyteller's call, and its button lives on the lobby panel in #grimoire —
  // a control only they can use has no business on a panel the whole town sees,
  // where it is just a button that refuses everyone who presses it.
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('botc_join').setLabel('Join Game').setStyle(ButtonStyle.Success).setEmoji('🪑'),
    new ButtonBuilder().setCustomId('botc_leave').setLabel('Leave').setStyle(ButtonStyle.Secondary)
  );
  return { embeds: [embed], components: [row] };
}

/**
 * Open a lobby: the single implementation behind `/game new` and the 🎲 button,
 * so the two cannot drift the way `/phase` and its buttons would have.
 *
 * Everything starts at its default. The script and the whisper rules used to be
 * options on `/game new`, which meant a Storyteller met four questions before
 * they had seen a single screen — and had to answer them from memory, at the
 * one moment they knew least. They are controls on the lobby panel instead,
 * where they stay changeable until the game starts.
 *
 * Returns `{ error }` or `{ summary }`.
 */
async function openLobby(guild, storytellerId) {
  const cfg = getGuild(guild.id);
  if (!cfg.channels.townSquare) return { error: 'Run `/setup` first to create the game channels.' };
  if (cfg.game && cfg.game.status !== 'ended') {
    return { error: 'A game is already in progress. End it with `/game end` first.' };
  }

  cfg.game = {
    status: 'lobby',
    script: 'tb',
    day: 0,
    phase: 'day',
    // Settable from the ⚙️ button on the lobby panel; frozen from `/game start`
    // onwards. Off by default — a server that updates the bot should not find
    // its next game silently playing under monitored whispers.
    whisperRules: { ...DEFAULTS },
    players: {},
    nomination: null,
    joinMessageId: null,
    whisperPanelId: null,
    // Today's ledger builds itself on demand from the day number; these are
    // here so the shape of a game is readable in one place, and so the
    // saved file never has to be inspected to know what a field is called.
    whisperDay: null,
    whisperInvites: {},
    whisperLiveId: null,
    storytellerId,
  };
  const townSquare = await guild.channels.fetch(cfg.channels.townSquare);
  const msg = await townSquare.send(joinPanel(cfg.game));
  cfg.game.joinMessageId = msg.id;
  save();
  // The 🎲 button has done its job; the lobby panel takes its place in
  // #grimoire — seat people directly, change the script, set the whisper
  // rules, call @BOTC, start when ready.
  await clearNewGamePanel(guild);
  await postLobbyPanel(guild);
  await logAction(guild, {
    title: '📜 New game lobby opened',
    description: [
      `Script: **${editions.find((e) => e.id === cfg.game.script)?.name ?? cfg.game.script}**`,
      `Storyteller: <@${storytellerId}>`,
      // Neither the script nor the whisper rules are settled yet — both stay
      // editable from the lobby panel right up until the game starts, and a log
      // line is written once and never revisited. They are logged at start,
      // where they lock.
      '📜 Script and 🤫 whisper rules are set in the lobby and lock when the game starts.',
    ].join('\n'),
  });

  return {
    summary:
      `Lobby opened in <#${cfg.channels.townSquare}>. Your controls — **📜 Change script**, ` +
      `**⚙️ Whisper rules**, **➕ Add players** and **▶️ Start game** — are in <#${cfg.channels.grimoire}>.`,
  };
}

async function refreshJoinPanel(guild) {
  const cfg = getGuild(guild.id);
  const game = cfg.game;
  if (!game?.joinMessageId || !cfg.channels.townSquare) return;
  const channel = await guild.channels.fetch(cfg.channels.townSquare).catch(() => null);
  const msg = channel && (await channel.messages.fetch(game.joinMessageId).catch(() => null));
  if (msg) await msg.edit(joinPanel(game)).catch(() => null);
}

module.exports = {
  refreshJoinPanel,
  joinPanel,
  openLobby,

  data: new SlashCommandBuilder()
    .setName('game')
    .setDescription('Manage the Blood on the Clocktower game')
    // No options. The script and the whisper rules are buttons on the lobby
    // panel this opens — see `openLobby`.
    .addSubcommand((s) =>
      s.setName('new').setDescription('Open a new game lobby — configure it from the panel in #grimoire (Storyteller only)')
    )
    .addSubcommand((s) => s.setName('start').setDescription('Start the game: seats players, opens private Storyteller threads (Storyteller only)'))
    .addSubcommand((s) =>
      s
        .setName('end')
        .setDescription('End the game and wipe the channels for the next one (Storyteller only)')
        .addBooleanOption((o) =>
          o
            .setName('keep-history')
            .setDescription('Leave the channels as they are instead of wiping them (default: wipe)')
        )
    )
    .addSubcommand((s) => s.setName('status').setDescription('Show the current game status')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guild = interaction.guild;
    const cfg = getGuild(guild.id);

    if (sub === 'status') {
      const game = cfg.game;
      if (!game) return interaction.reply({ content: 'No game is active.', flags: MessageFlags.Ephemeral });
      const script = editions.find((e) => e.id === game.script);
      const players = Object.entries(game.players);
      const alive = players.filter(([, p]) => p.alive);
      return interaction.reply({
        flags: MessageFlags.Ephemeral,
        embeds: [
          new EmbedBuilder()
            .setTitle('Game Status')
            .setColor(COLORS.info)
            .addFields(
              { name: 'Script', value: script?.name ?? game.script, inline: true },
              {
                name: 'Phase',
                value:
                  game.status === 'lobby'
                    ? 'Lobby'
                    : game.phase === 'night'
                      ? `🌙 Night ${game.day}`
                      : `☀️ Day ${game.day} — ${daySegment(game) === 'town' ? 'gathered, nominations open' : 'talking'}`,
                inline: true,
              },
              { name: 'Players', value: `${alive.length} alive / ${players.length} total`, inline: true },
              {
                name: 'Town',
                value: players.length
                  ? players.map(([id, p]) => `${p.alive ? '🙂' : '💀'} ${mention(cfg.game, id)}`).join('\n')
                  : '*empty*',
              }
            ),
        ],
      });
    }

    if (!isStoryteller(interaction.member)) {
      return interaction.reply({ content: 'Only the Storyteller can do that.', flags: MessageFlags.Ephemeral });
    }
    if (!cfg.channels.townSquare) {
      return interaction.reply({ content: 'Run `/setup` first to create the game channels.', flags: MessageFlags.Ephemeral });
    }

    if (sub === 'new') {
      const { error, summary } = await openLobby(guild, interaction.user.id);
      return interaction.reply({ content: error ?? summary, flags: MessageFlags.Ephemeral });
    }

    if (sub === 'start') {
      // Seating N players is several round-trips each, so defer.
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const { error, summary } = await startGame(guild);
      return interaction.editReply(error ?? summary);
    }


    if (sub === 'end') {
      const game = cfg.game;
      if (!game) return interaction.reply({ content: 'No game to end.', flags: MessageFlags.Ephemeral });
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      // Default is a clean slate: the next game should not open on top of the
      // last one's chat, log and panels. Wiping is irreversible, so there is an
      // opt-out for the game you want to read back afterwards.
      const wipe = !(interaction.options.getBoolean('keep-history') ?? false);

      // Archive Storyteller + whisper threads. Older games kept their threads
      // under #grimoire, so sweep all three channels.
      const archive = async (channelId) => {
        const ch = channelId && (await guild.channels.fetch(channelId).catch(() => null));
        if (!ch) return;
        const active = await ch.threads.fetchActive().catch(() => null);
        for (const thread of active?.threads.values() ?? []) {
          await thread.setArchived(true, 'Game ended').catch(() => null);
        }
      };
      // Take down every panel this game posted. Their buttons all bail out once
      // the game is gone, so what is left behind is not dangerous — it is
      // misleading, which is nearly as bad: a lobby that still says "A new game
      // is forming!" and a Join button that answers "the lobby is closed" is a
      // worse answer than no button at all. The day panels already did this;
      // the rest were simply never swept.
      //
      // None of this is worth doing when the channels themselves are about to
      // be replaced — the panels and threads go with them.
      if (!wipe) {
        await clearDayPanels(guild);
        for (const [channelId, messageId] of [
          [cfg.channels.townSquare, game.joinMessageId],
          [cfg.channels.whispers, game.whisperPanelId],
          [cfg.channels.gameLog, game.whisperLiveId],
          [cfg.channels.grimoire, game.lobbyPanelId],
          [cfg.channels.grimoire, game.assignPanelId],
          [cfg.channels.grimoire, game.nightAlert?.messageId],
        ]) {
          await deleteIn(guild, channelId, messageId);
        }
        // The whisper record is the one panel that outlives its game: the rooms
        // it links to are about to be archived, not deleted, and reading back
        // what everyone told each other is half the fun of a post-mortem. It
        // only loses its pin, so the next game's record gets the slot.
        if (game.whisperRecordId) {
          const ch = cfg.channels.whispers && (await guild.channels.fetch(cfg.channels.whispers).catch(() => null));
          const msg = ch && (await ch.messages.fetch(game.whisperRecordId).catch(() => null));
          await msg?.unpin().catch(() => null);
        }
        await archive(cfg.channels.townSquare);
        await archive(cfg.channels.grimoire);
        await archive(cfg.channels.whispers);
      }

      // Remove Townsfolk role.
      if (cfg.roleIds.player) {
        for (const [id, p] of Object.entries(game.players)) {
          if (p.isBot) continue;
          const member = await guild.members.fetch(id).catch(() => null);
          await member?.roles.remove(cfg.roleIds.player).catch(() => null);
        }
      }

      cfg.game = null;
      cfg.whisperThreads = {};
      // Let the next game post a fresh board rather than editing a stale one.
      cfg.channels.boardMessageId = null;
      save();
      await logAction(guild, {
        title: '🏁 Game over',
        description: wipe
          ? 'The game has ended. These channels are about to be wiped for the next game. Thanks for playing!'
          : 'The game has ended. Threads archived. Thanks for playing!',
      });

      if (!wipe) {
        await postNewGamePanel(guild);
        return interaction.editReply(`Game ended and threads archived. 🎲 **New game** is waiting in <#${cfg.channels.grimoire}>.`);
      }

      // Answer before the wipe: this reply lives in whichever channel the
      // command was run from, and that channel may be one of the ones going
      // away — an edit afterwards would have nowhere to land.
      await interaction.editReply('Game ended. Wiping the channels for the next game…');
      const { refreshed, failed } = await recycleChannels(guild, 'Game ended — refreshing channels');
      // After the recycle, never before: the wipe replaces #grimoire with a
      // fresh copy, so anything posted first goes down with the old channel.
      // `cfg.channels.grimoire` is the new id by the time this runs.
      await postNewGamePanel(guild);
      return interaction
        .editReply(
          [
            `✅ Game ended and ${refreshed.length} channel${refreshed.length === 1 ? '' : 's'} wiped clean.`,
            failed.length ? `⚠️ Could not refresh: ${failed.map((n) => `#${n}`).join(', ')} — check my permissions.` : '',
            `Press 🎲 **New game** in <#${cfg.channels.grimoire}> when you are ready for the next one.`,
          ]
            .filter(Boolean)
            .join('\n')
        )
        .catch(() => null);
    }
  },
};
