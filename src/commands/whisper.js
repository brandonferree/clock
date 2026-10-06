const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getGuild } = require('../store');
const { startInvite } = require('../whisperInvite');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('whisper')
    .setDescription('Ask another player for a private word')
    .addUserOption((o) => o.setName('player').setDescription('Who do you want to talk to?').setRequired(true)),

  async execute(interaction) {
    const target = interaction.options.getUser('player');
    if (target.bot) {
      return interaction.reply({ content: 'Bots have no secrets to share.', flags: MessageFlags.Ephemeral });
    }
    // The same path as the 🤫 button, so the command cannot become a way around
    // the budget, the room size, or the consent. It only ever asks for a pair —
    // trios are put together on the panel, where the picker takes more than one.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const game = getGuild(interaction.guild.id).game;
    const { error, summary } = await startInvite(interaction.guild, game, interaction.user.id, [target.id]);
    return interaction.editReply(error ?? summary);
  },
};
