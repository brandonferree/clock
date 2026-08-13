const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { getGuild } = require('../store');
const { COLORS } = require('../game');
const { roles, rolesForScript, findRole, iconUrl, TEAM_LABEL } = require('../data/scripts');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('character')
    .setDescription('Look up a character ability (private reply)')
    .addStringOption((o) =>
      o.setName('name').setDescription('Character name').setRequired(true).setAutocomplete(true)
    ),

  async autocomplete(interaction) {
    const cfg = getGuild(interaction.guild.id);
    const focused = interaction.options.getFocused().toLowerCase();
    const pool = cfg.game ? rolesForScript(cfg.game.script) : roles;
    const matches = pool
      .filter((r) => r.name.toLowerCase().includes(focused))
      .slice(0, 25)
      .map((r) => ({ name: `${r.name} (${TEAM_LABEL[r.team] ?? r.team})`, value: r.id }));
    await interaction.respond(matches);
  },

  async execute(interaction) {
    const role = findRole(interaction.options.getString('name'));
    if (!role) return interaction.reply({ content: 'Unknown character.', flags: MessageFlags.Ephemeral });
    const isEvil = role.team === 'minion' || role.team === 'demon';
    return interaction.reply({
      flags: MessageFlags.Ephemeral,
      embeds: [
        new EmbedBuilder()
          .setTitle(role.name)
          .setColor(isEvil ? COLORS.evil : COLORS.good)
          .setThumbnail(iconUrl(role))
          .setDescription(`**${TEAM_LABEL[role.team] ?? role.team}**\n\n${role.ability}`),
      ],
    });
  },
};
