const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getGuild, save } = require('../store');
const { logAction, isStoryteller, mention } = require('../game');
const { refreshJoinPanel } = require('./game');
const { voteEmbed } = require('./nominate');
const { updateBoard } = require('../grimoire');
const { updateChecklist } = require('../night');
const { dealCharacters } = require('../deal');

const BOT_NAMES = ['Alice', 'Bob', 'Carol', 'Dave', 'Eve', 'Frank', 'Grace', 'Heidi', 'Ivan', 'Judy'];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('test')
    .setDescription('Testing tools — simulated players (Storyteller only)')
    .addSubcommand((s) =>
      s
        .setName('add-bots')
        .setDescription('Add simulated players to the lobby')
        .addIntegerOption((o) =>
          o.setName('count').setDescription('How many (default 4)').setMinValue(1).setMaxValue(10)
        )
    )
    .addSubcommand((s) => s.setName('remove-bots').setDescription('Remove all simulated players from the lobby'))
    .addSubcommand((s) =>
      s
        .setName('deal')
        .setDescription('Randomly deal characters to everyone (bots included) and send each to their thread')
    )
    .addSubcommand((s) =>
      s
        .setName('vote')
        .setDescription('Make simulated players vote on the open nomination')
        .addStringOption((o) =>
          o
            .setName('how')
            .setDescription('How should they vote? (default: random)')
            .addChoices(
              { name: 'Random', value: 'random' },
              { name: 'All yes', value: 'yes' },
              { name: 'All no', value: 'no' }
            )
        )
    ),

  async execute(interaction) {
    if (!isStoryteller(interaction.member)) {
      return interaction.reply({ content: 'Only the Storyteller can use testing tools.', flags: MessageFlags.Ephemeral });
    }
    const cfg = getGuild(interaction.guild.id);
    const game = cfg.game;
    if (!game) {
      return interaction.reply({ content: 'No game. Open a lobby with `/game new` first.', flags: MessageFlags.Ephemeral });
    }
    const sub = interaction.options.getSubcommand();

    if (sub === 'add-bots') {
      if (game.status !== 'lobby') {
        return interaction.reply({ content: 'Bots can only join while the lobby is open.', flags: MessageFlags.Ephemeral });
      }
      const count = interaction.options.getInteger('count') ?? 4;
      const used = new Set(Object.values(game.players).map((p) => p.name));
      const added = [];
      for (const name of BOT_NAMES) {
        if (added.length >= count) break;
        if (used.has(name)) continue;
        const id = `sim_${name.toLowerCase()}`;
        if (game.players[id]) continue;
        game.players[id] = {
          name,
          character: null,
          alive: true,
          deadVoteUsed: false,
          stThreadId: null,
          isBot: true,
        };
        added.push(name);
      }
      save();
      await refreshJoinPanel(interaction.guild);
      await logAction(interaction.guild, {
        title: '🤖 Simulated players joined',
        description: `${added.map((n) => `**🤖 ${n}**`).join(', ')} take their seats. (${Object.keys(game.players).length} players)`,
      });
      return interaction.reply({
        content: `Added ${added.length} simulated players: ${added.join(', ')}.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'remove-bots') {
      if (game.status !== 'lobby') {
        return interaction.reply({ content: 'Bots can only be removed while the lobby is open.', flags: MessageFlags.Ephemeral });
      }
      const removed = Object.entries(game.players).filter(([, p]) => p.isBot);
      for (const [id] of removed) delete game.players[id];
      save();
      await refreshJoinPanel(interaction.guild);
      return interaction.reply({ content: `Removed ${removed.length} simulated players.`, flags: MessageFlags.Ephemeral });
    }

    if (sub === 'deal') {
      if (game.status !== 'running') {
        return interaction.reply({ content: 'Start the game first with `/game start`.', flags: MessageFlags.Ephemeral });
      }
      // Same engine as `/st deal` — it delivers each character to its player's
      // Storyteller thread, which is N round-trips, so defer.
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await dealCharacters(interaction.guild, game);
      if (result.error) return interaction.editReply(result.error);

      await logAction(interaction.guild, {
        title: '🎲 Characters dealt',
        description: `The Storyteller dealt characters randomly (${result.dist.join('/')}). Check \`/st grimoire\`.`,
      });
      await updateBoard(interaction.guild);
      await updateChecklist(interaction.guild);
      return interaction.editReply(
        [
          'Dealt and delivered to every Storyteller thread:',
          result.dealt.map(({ id, role }) => `${mention(game, id)} → **${role.name}**`).join('\n'),
          result.undelivered.length
            ? `\n⚠️ Could not reach the thread for: ${result.undelivered.map((id) => mention(game, id)).join(', ')} — tell them directly.`
            : '',
          '\n*(No setup-modifying abilities like Baron were applied — adjust with `/assign` if needed.)*',
          "Run `/st night-alert` to ping tonight's actors.",
        ]
          .filter(Boolean)
          .join('\n')
      );
    }

    if (sub === 'vote') {
      if (!game.nomination?.open) {
        return interaction.reply({ content: 'No open nomination to vote on.', flags: MessageFlags.Ephemeral });
      }
      const how = interaction.options.getString('how') ?? 'random';
      const nom = game.nomination;
      const voted = [];
      for (const [id, p] of Object.entries(game.players)) {
        if (!p.isBot) continue;
        if (!p.alive && p.deadVoteUsed) continue;
        const yes = how === 'yes' ? true : how === 'no' ? false : Math.random() < 0.5;
        if (yes) {
          nom.votes[id] = true;
          voted.push(p.name);
        } else {
          delete nom.votes[id];
        }
      }
      save();
      // Update the live vote message.
      const townSquare = await interaction.guild.channels.fetch(cfg.channels.townSquare).catch(() => null);
      const msg = townSquare && (await townSquare.messages.fetch(nom.messageId).catch(() => null));
      if (msg) await msg.edit({ embeds: [voteEmbed(game)] }).catch(() => null);
      return interaction.reply({
        content: voted.length
          ? `🤖 Voted yes: ${voted.join(', ')}. Others voted no.`
          : '🤖 All simulated players voted no.',
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
