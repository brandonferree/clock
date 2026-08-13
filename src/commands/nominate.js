const {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
} = require('discord.js');
const { getGuild, save } = require('../store');
const { logAction, isStoryteller, seatedChoices, mention, COLORS } = require('../game');

function voteEmbed(game) {
  const nom = game.nomination;
  const yes = Object.entries(nom.votes).filter(([, v]) => v);
  const alive = Object.values(game.players).filter((p) => p.alive).length;
  const needed = Math.ceil(alive / 2);
  return new EmbedBuilder()
    .setTitle('⚖️ Nomination')
    .setColor(COLORS.vote)
    .setDescription(`${mention(game, nom.nominator)} has nominated ${mention(game, nom.nominee)} for execution.`)
    .addFields({
      name: `Votes for (${yes.length}/${needed} needed)`,
      value: yes.length ? yes.map(([id]) => mention(game, id)).join(', ') : '*none yet*',
    })
    .setFooter({ text: 'Dead players may spend their one dead vote. The Storyteller closes the vote.' });
}

function voteButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('botc_vote_yes').setLabel('Vote YES').setStyle(ButtonStyle.Danger).setEmoji('🗳️'),
    new ButtonBuilder().setCustomId('botc_vote_no').setLabel('Vote NO / retract').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('botc_vote_close').setLabel('Close vote (ST)').setStyle(ButtonStyle.Primary).setEmoji('🔒')
  );
}

module.exports = {
  voteEmbed,
  voteButtons,

  data: new SlashCommandBuilder()
    .setName('nominate')
    .setDescription('Nominate a player for execution')
    .addStringOption((o) =>
      o.setName('player').setDescription('Who are you nominating?').setRequired(true).setAutocomplete(true)
    )
    .addStringOption((o) =>
      o
        .setName('as')
        .setDescription('Storyteller only: nominate on behalf of this player')
        .setAutocomplete(true)
    ),

  async autocomplete(interaction) {
    const cfg = getGuild(interaction.guild.id);
    return interaction.respond(seatedChoices(cfg.game, interaction.options.getFocused()));
  },

  async execute(interaction) {
    const cfg = getGuild(interaction.guild.id);
    const game = cfg.game;
    if (!game || game.status !== 'running') {
      return interaction.reply({ content: 'No game is running.', flags: MessageFlags.Ephemeral });
    }
    if (game.phase !== 'day') {
      return interaction.reply({ content: 'Nominations only happen during the day.', flags: MessageFlags.Ephemeral });
    }

    let nominatorId = interaction.user.id;
    const asId = interaction.options.getString('as');
    if (asId) {
      if (!isStoryteller(interaction.member)) {
        return interaction.reply({ content: 'Only the Storyteller can nominate on behalf of a player.', flags: MessageFlags.Ephemeral });
      }
      if (!game.players[asId]) {
        return interaction.reply({ content: 'That player is not in this game.', flags: MessageFlags.Ephemeral });
      }
      nominatorId = asId;
    }

    const nominator = game.players[nominatorId];
    if (!nominator) {
      return interaction.reply({ content: 'Only seated players can nominate.', flags: MessageFlags.Ephemeral });
    }
    if (!nominator.alive) {
      return interaction.reply({ content: 'Dead players cannot nominate.', flags: MessageFlags.Ephemeral });
    }
    if (game.nomination?.open) {
      return interaction.reply({
        content: 'A nomination is already being voted on. Wait for the Storyteller to close it.',
        flags: MessageFlags.Ephemeral,
      });
    }
    const nomineeId = interaction.options.getString('player');
    if (!game.players[nomineeId]) {
      return interaction.reply({ content: 'That player is not in this game. Pick one from the autocomplete list.', flags: MessageFlags.Ephemeral });
    }
    if (nominator.nominatedToday === game.day) {
      return interaction.reply({ content: `${mention(game, nominatorId)} has already nominated today.`, flags: MessageFlags.Ephemeral });
    }
    if (game.nominationDay === game.day && game.nominatedToday?.includes(nomineeId)) {
      return interaction.reply({ content: 'That player has already been nominated today.', flags: MessageFlags.Ephemeral });
    }

    nominator.nominatedToday = game.day;
    if (!game.nominatedToday || game.nominationDay !== game.day) {
      game.nominatedToday = [];
      game.nominationDay = game.day;
    }
    game.nominatedToday.push(nomineeId);
    game.nomination = {
      nominator: nominatorId,
      nominee: nomineeId,
      votes: {},
      open: true,
      messageId: null,
    };

    const townSquare = await interaction.guild.channels.fetch(cfg.channels.townSquare);
    const msg = await townSquare.send({ embeds: [voteEmbed(game)], components: [voteButtons()] });
    game.nomination.messageId = msg.id;
    save();

    await logAction(interaction.guild, {
      title: '⚖️ Nomination',
      color: 'vote',
      description: `Day ${game.day}: ${mention(game, nominatorId)} nominated ${mention(game, nomineeId)}. Voting is open in the town square.`,
    });
    return interaction.reply({ content: `Nomination posted in <#${cfg.channels.townSquare}>.`, flags: MessageFlags.Ephemeral });
  },
};
