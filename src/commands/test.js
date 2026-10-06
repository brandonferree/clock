const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getGuild, save } = require('../store');
const { isStoryteller, mention } = require('../game');
const { voteBlock } = require('../voteRules');
const { refreshJoinPanel } = require('./game');
const { updateLobbyPanel } = require('../lobbyPanel');
const { updateAssignPanel } = require('../assignPanel');
const { voteEmbed } = require('./nominate');
const { updateBoard } = require('../grimoire');
const { updateChecklist } = require('../night');
const { dealCharacters } = require('../deal');

// The cryptography cast, in order. Fourteen of them: a full 15-player town
// minus the seat the Storyteller sits a real player in to test delivery.
const BOT_NAMES = [
  'Alice',
  'Bob',
  'Carol',
  'Dave',
  'Eve',
  'Frank',
  'Grace',
  'Heidi',
  'Ivan',
  'Judy',
  'Mallory',
  'Niaj',
  'Olivia',
  'Peggy',
];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('test')
    .setDescription('Testing tools — simulated players (Storyteller only)')
    .addSubcommand((s) =>
      s
        .setName('add-bots')
        .setDescription('Add simulated players to the lobby')
        .addIntegerOption((o) =>
          o.setName('count').setDescription('How many, 1–14 (default 4)').setMinValue(1).setMaxValue(14)
        )
    )
    .addSubcommand((s) => s.setName('remove-bots').setDescription('Remove all simulated players from the lobby'))
    .addSubcommand((s) =>
      s
        .setName('deal')
        .setDescription('Randomly stage characters for everyone (bots included) — publish to send them')
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
      await updateLobbyPanel(interaction.guild);
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
      await updateLobbyPanel(interaction.guild);
      return interaction.reply({ content: `Removed ${removed.length} simulated players.`, flags: MessageFlags.Ephemeral });
    }

    if (sub === 'deal') {
      if (game.status !== 'running') {
        return interaction.reply({ content: 'Start the game first with `/game start`.', flags: MessageFlags.Ephemeral });
      }
      // Same engine as `/st deal`: it stages the spread and sends nothing.
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const result = dealCharacters(game);
      if (result.error) return interaction.editReply(result.error);

      await updateBoard(interaction.guild);
      await updateChecklist(interaction.guild);
      await updateAssignPanel(interaction.guild);
      return interaction.editReply(
        [
          `Staged (${result.dist.join('/')}) — **nothing sent yet**:`,
          result.dealt.map(({ id, role }) => `${mention(game, id)} → **${role.name}**`).join('\n'),
          '\n*(No setup-modifying abilities like Baron were applied — adjust with `/assign` if needed.)*',
          `Hit 📨 **Publish** on the 🎭 panel in <#${cfg.channels.grimoire}> to deliver them all at once.`,
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
      const held = [];
      // Butlers go last. Their hand is only allowed up if their Master's is,
      // and whether the Master voted is a fact that does not exist until every
      // other simulated player has been through this loop.
      const order = Object.entries(game.players).sort(
        ([, a], [, b]) => (a.character === 'butler' ? 1 : 0) - (b.character === 'butler' ? 1 : 0)
      );
      for (const [id, p] of order) {
        if (!p.isBot) continue;
        if (!p.alive && p.deadVoteUsed) continue;
        const wants = how === 'yes' ? true : how === 'no' ? false : Math.random() < 0.5;
        // Simulated players play by the same rules as everyone else — a random
        // yes from a Butler whose Master kept their hand down is a vote that
        // could not have happened at a table.
        if (wants && voteBlock(game, id, true)) {
          held.push(p.name);
          delete nom.votes[id];
          continue;
        }
        if (wants) {
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
        content:
          (voted.length
            ? `🤖 Voted yes: ${voted.join(', ')}. Others voted no.`
            : '🤖 All simulated players voted no.') +
          (held.length ? `
🧈 Hand kept down by the Butler rule: ${held.join(', ')}.` : ''),
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
