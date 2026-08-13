const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { openWhisper } = require('../whisper');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('whisper')
    .setDescription('Open a private chat thread with another player')
    .addUserOption((o) => o.setName('player').setDescription('Who do you want to talk to?').setRequired(true)),

  async execute(interaction) {
    const target = interaction.options.getUser('player');
    if (target.id === interaction.user.id) {
      return interaction.reply({ content: 'You cannot whisper to yourself.', flags: MessageFlags.Ephemeral });
    }
    if (target.bot) {
      return interaction.reply({ content: 'Bots have no secrets to share.', flags: MessageFlags.Ephemeral });
    }
    const { thread, existed } = await openWhisper(interaction.guild, interaction.user, target);
    return interaction.reply({
      content: existed
        ? `You already have a room with <@${target.id}>: <#${thread.id}>`
        : `🤫 Private room opened: <#${thread.id}>`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
