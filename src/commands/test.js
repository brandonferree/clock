const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getGuild, save } = require('../store');
const { logAction, isStoryteller, mention } = require('../game');
const { rolesForScript, rolesById, SETUP_TABLE } = require('../data/scripts');
const { refreshJoinPanel } = require('./game');
const { voteEmbed } = require('./nominate');
const { updateBoard } = require('../grimoire');
const { updateChecklist } = require('../night');

const BOT_NAMES = ['Alice', 'Bob', 'Carol', 'Dave', 'Eve', 'Frank', 'Grace', 'Heidi', 'Ivan', 'Judy'];

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

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
      s.setName('deal').setDescription('Randomly deal characters to all players using the official setup table')
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
      const ids = shuffle(Object.keys(game.players));
      const dist = SETUP_TABLE[Math.min(Math.max(ids.length, 5), 15)];
      if (!dist) {
        return interaction.reply({ content: 'Player count outside 5–15; deal manually with `/assign`.', flags: MessageFlags.Ephemeral });
      }
      const pool = rolesForScript(game.script);
      const byTeam = (team) => shuffle(pool.filter((r) => r.team === team));
      const deck = [
        ...byTeam('townsfolk').slice(0, dist[0]),
        ...byTeam('outsider').slice(0, dist[1]),
        ...byTeam('minion').slice(0, dist[2]),
        ...byTeam('demon').slice(0, dist[3]),
      ];
      const lines = [];
      for (let i = 0; i < ids.length && i < deck.length; i++) {
        game.players[ids[i]].character = deck[i].id;
        lines.push(`${mention(game, ids[i])} → **${deck[i].name}**`);
      }
      save();
      await logAction(interaction.guild, {
        title: '🎲 Characters dealt',
        description: `The Storyteller dealt characters randomly (${dist[0]}/${dist[1]}/${dist[2]}/${dist[3]}). Check \`/st grimoire\`.`,
      });
      await updateBoard(interaction.guild);
      await updateChecklist(interaction.guild);
      return interaction.reply({
        content: `Dealt:\n${lines.join('\n')}\n\n*(Note: no setup-modifying abilities like Baron were applied — adjust with \`/assign\` if needed.)*\n\nRun \`/st night-alert\` to ping tonight's actors.`,
        flags: MessageFlags.Ephemeral,
      });
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
