const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { isStoryteller } = require('../game');
const { setPhase } = require('../phaseFlow');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('phase')
    .setDescription('Advance the day (Storyteller only)')
    .addSubcommand((s) => s.setName('day').setDescription('Dawn breaks — the town wakes and starts talking'))
    .addSubcommand((s) =>
      s.setName('town').setDescription('Call everyone back to the square — closes whispers and opens nominations')
    )
    .addSubcommand((s) => s.setName('night').setDescription('Night falls — everyone close your eyes')),

  async execute(interaction) {
    if (!isStoryteller(interaction.member)) {
      return interaction.reply({ content: 'Only the Storyteller can change the phase.', flags: MessageFlags.Ephemeral });
    }
    // Rendering fetches art on a cold cache, so defer before doing the work.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const { error, summary } = await setPhase(interaction.guild, interaction.options.getSubcommand());
    return interaction.editReply(error ?? summary);
  },
};
