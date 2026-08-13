const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getGuild, save } = require('../store');
const { isStoryteller, seatedChoices, mention } = require('../game');
const { rolesForScript, findRole, TEAM_LABEL } = require('../data/scripts');
const { updateBoard } = require('../grimoire');
const { updateChecklist } = require('../night');
const { deliverCharacter } = require('../deal');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('assign')
    .setDescription('Assign a character to a player — sent to their Grimoire thread (Storyteller only)')
    .addStringOption((o) =>
      o.setName('player').setDescription('The player').setRequired(true).setAutocomplete(true)
    )
    .addStringOption((o) =>
      o.setName('character').setDescription('The character to assign').setRequired(true).setAutocomplete(true)
    ),

  async autocomplete(interaction) {
    const cfg = getGuild(interaction.guild.id);
    const focused = interaction.options.getFocused(true);
    if (focused.name === 'player') {
      return interaction.respond(seatedChoices(cfg.game, focused.value));
    }
    const pool = rolesForScript(cfg.game?.script ?? 'tb');
    const matches = pool
      .filter((r) => r.name.toLowerCase().includes(focused.value.toLowerCase()))
      .slice(0, 25)
      .map((r) => ({ name: `${r.name} (${TEAM_LABEL[r.team] ?? r.team})`, value: r.id }));
    return interaction.respond(matches);
  },

  async execute(interaction) {
    if (!isStoryteller(interaction.member)) {
      return interaction.reply({ content: 'Only the Storyteller can assign characters.', flags: MessageFlags.Ephemeral });
    }
    const cfg = getGuild(interaction.guild.id);
    const game = cfg.game;
    if (!game || game.status !== 'running') {
      return interaction.reply({ content: 'No game is running.', flags: MessageFlags.Ephemeral });
    }
    const playerId = interaction.options.getString('player');
    const player = game.players[playerId];
    if (!player) {
      return interaction.reply({ content: 'That player is not in this game. Pick one from the autocomplete list.', flags: MessageFlags.Ephemeral });
    }
    const role = findRole(interaction.options.getString('character'));
    if (!role) {
      return interaction.reply({ content: 'Unknown character.', flags: MessageFlags.Ephemeral });
    }

    player.character = role.id;
    save();

    // Deliver secretly via the player's Storyteller thread.
    const delivered = await deliverCharacter(interaction.guild, game, playerId);
    await updateBoard(interaction.guild);
    // A newly assigned character may act tonight, so keep the wake list honest.
    await updateChecklist(interaction.guild);
    return interaction.reply({
      content: `Assigned **${role.name}** to ${mention(game, playerId)}${delivered ? ' and posted it in their Storyteller thread.' : ' — **but their thread could not be reached, so tell them directly.**'}`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
