const {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ChannelType,
  PermissionFlagsBits,
  MessageFlags,
} = require('discord.js');
const { getGuild, save } = require('../store');
const { logAction, isStoryteller, mention, COLORS } = require('../game');
const { editions, SETUP_TABLE } = require('../data/scripts');
const { updateBoard, postScriptReference } = require('../grimoire');
const { postNightAlert } = require('../night');

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
        players.length
          ? `**Players (${players.length}):**\n${players.map(([id]) => mention(game, id)).join(', ')}`
          : '*No players yet — be the first to join!*',
      ].join('\n')
    );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('botc_join').setLabel('Join Game').setStyle(ButtonStyle.Success).setEmoji('🪑'),
    new ButtonBuilder().setCustomId('botc_leave').setLabel('Leave').setStyle(ButtonStyle.Secondary)
  );
  return { embeds: [embed], components: [row] };
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

  data: new SlashCommandBuilder()
    .setName('game')
    .setDescription('Manage the Blood on the Clocktower game')
    .addSubcommand((s) =>
      s
        .setName('new')
        .setDescription('Open a new game lobby (Storyteller only)')
        .addStringOption((o) =>
          o
            .setName('script')
            .setDescription('Which script to play')
            .addChoices(...editions.map((e) => ({ name: e.name, value: e.id })))
        )
    )
    .addSubcommand((s) => s.setName('start').setDescription('Start the game: seats players, opens private Storyteller threads (Storyteller only)'))
    .addSubcommand((s) => s.setName('end').setDescription('End the game and archive threads (Storyteller only)'))
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
              { name: 'Phase', value: game.status === 'lobby' ? 'Lobby' : `${game.phase === 'night' ? '🌙 Night' : '☀️ Day'} ${game.day}`, inline: true },
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
      if (cfg.game && cfg.game.status !== 'ended') {
        return interaction.reply({
          content: 'A game is already in progress. End it with `/game end` first.',
          flags: MessageFlags.Ephemeral,
        });
      }
      const script = interaction.options.getString('script') ?? 'tb';
      cfg.game = {
        status: 'lobby',
        script,
        day: 0,
        phase: 'day',
        players: {},
        nomination: null,
        joinMessageId: null,
        whisperPanelId: null,
        storytellerId: interaction.user.id,
      };
      const townSquare = await guild.channels.fetch(cfg.channels.townSquare);
      const msg = await townSquare.send(joinPanel(cfg.game));
      cfg.game.joinMessageId = msg.id;
      save();
      await logAction(guild, {
        title: '📜 New game lobby opened',
        description: `Script: **${editions.find((e) => e.id === script)?.name ?? script}**\nStoryteller: <@${interaction.user.id}>`,
      });
      return interaction.reply({ content: `Lobby opened in <#${cfg.channels.townSquare}>.`, flags: MessageFlags.Ephemeral });
    }

    if (sub === 'start') {
      const game = cfg.game;
      if (!game || game.status !== 'lobby') {
        return interaction.reply({ content: 'There is no lobby to start. Use `/game new` first.', flags: MessageFlags.Ephemeral });
      }
      const ids = Object.keys(game.players);
      if (ids.length < 5) {
        return interaction.reply({
          content: `Need at least 5 players (currently ${ids.length}).`,
          flags: MessageFlags.Ephemeral,
        });
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      // Assign Townsfolk role and create a private Storyteller thread per player.
      // Threads live under #town-square: players must be able to view the parent
      // channel to see their thread, and #grimoire is hidden from them.
      const townSquare = await guild.channels.fetch(cfg.channels.townSquare);
      if (!townSquare.permissionsFor(guild.members.me).has(PermissionFlagsBits.CreatePrivateThreads)) {
        return interaction.editReply(
          `⚠️ I can't create private threads in <#${townSquare.id}>. Re-run \`/setup\` to repair the channel permissions, then try again.`
        );
      }
      for (const id of ids) {
        const player = game.players[id];
        const member = player.isBot ? null : await guild.members.fetch(id).catch(() => null);
        if (member && cfg.roleIds.player) await member.roles.add(cfg.roleIds.player).catch(() => null);
        const name = member?.displayName ?? player.name;

        // A previous failed /game start may have already made this player's thread.
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

      // Post the whisper panel in #whispers.
      const whispers = await guild.channels.fetch(cfg.channels.whispers);
      const panel = await whispers.send({
        embeds: [
          new EmbedBuilder()
            .setTitle('🤫 Private conversations')
            .setColor(COLORS.vote)
            .setDescription(
              'Click below to open a private room with another player. ' +
                'A private thread will be created that only the two of you (and the Storyteller) can see.'
            ),
        ],
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId('botc_whisper')
              .setLabel('Open a private chat')
              .setStyle(ButtonStyle.Primary)
              .setEmoji('💬')
          ),
        ],
      });
      game.whisperPanelId = panel.id;

      game.status = 'running';
      game.day = 1;
      game.phase = 'night';
      save();

      // Reference first, then the board — the board pins last so it sits on top.
      await postScriptReference(guild, game.script);
      await updateBoard(guild);

      const dist = SETUP_TABLE[Math.min(ids.length, 15)];
      await logAction(guild, {
        title: '🎭 The game begins!',
        color: 'night',
        description: [
          `**${ids.length} players** take their seats: ${ids.map((id) => mention(game, id)).join(', ')}`,
          dist ? `Suggested setup: ${dist[0]} Townsfolk / ${dist[1]} Outsiders / ${dist[2]} Minions / ${dist[3]} Demon` : '',
          '',
          '🌙 **Night 1 falls.** Close your eyes...',
        ].filter(Boolean).join('\n'),
      });
      // Night 1 has begun, but characters are normally dealt after this point,
      // so only alert if somebody already has one. `/st night-alert` re-fires it
      // once assignment is done.
      const dealt = Object.values(game.players).some((p) => p.character);
      if (dealt) await postNightAlert(guild);
      return interaction.editReply(
        `Game started with ${ids.length} players. Private Storyteller threads created under <#${cfg.channels.townSquare}>. ` +
          `Assign characters with \`/assign\`, then run \`/st night-alert\` to ping everyone who acts on Night 1.`
      );
    }

    if (sub === 'end') {
      const game = cfg.game;
      if (!game) return interaction.reply({ content: 'No game to end.', flags: MessageFlags.Ephemeral });
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

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
      await archive(cfg.channels.townSquare);
      await archive(cfg.channels.grimoire);
      await archive(cfg.channels.whispers);

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
      await logAction(guild, { title: '🏁 Game over', description: 'The game has ended. Threads archived. Thanks for playing!' });
      return interaction.editReply('Game ended and threads archived.');
    }
  },
};
