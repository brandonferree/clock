const { SlashCommandBuilder, AttachmentBuilder, MessageFlags } = require('discord.js');
const { getGuild, save } = require('../store');
const { logAction, isStoryteller } = require('../game');
const { updateBoard } = require('../grimoire');
const { renderGrimoire } = require('../render');
const { postNightAlert } = require('../night');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('phase')
    .setDescription('Advance to day or night (Storyteller only)')
    .addSubcommand((s) => s.setName('day').setDescription('Dawn breaks — start the day'))
    .addSubcommand((s) => s.setName('night').setDescription('Night falls — everyone close your eyes')),

  async execute(interaction) {
    if (!isStoryteller(interaction.member)) {
      return interaction.reply({ content: 'Only the Storyteller can change the phase.', flags: MessageFlags.Ephemeral });
    }
    const cfg = getGuild(interaction.guild.id);
    const game = cfg.game;
    if (!game || game.status !== 'running') {
      return interaction.reply({ content: 'No game is running.', flags: MessageFlags.Ephemeral });
    }
    const sub = interaction.options.getSubcommand();
    const day = sub === 'day';

    if (game.phase === sub) {
      return interaction.reply({
        content: `It is already ${day ? 'Day' : 'Night'} ${game.day}.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    if (day) {
      game.phase = 'day';
    } else {
      // Close any open nomination when night falls.
      game.nomination = null;
      game.phase = 'night';
      game.day += 1;
      game.nightAlert = null;
    }
    save();

    // Rendering fetches art on a cold cache, so defer before doing the work.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // Post a fresh town status on every phase change. Going into night this
    // picks up whoever was executed during the day, which is the whole point.
    // reveal:false — the game log is public, so no characters or alignments may
    // appear here. Fails soft to a text-only log.
    const label = day ? `day-${game.day}` : `night-${game.day}`;
    const png = await renderGrimoire(game).catch(() => null);
    await logAction(interaction.guild, {
      title: day ? `☀️ Day ${game.day} begins` : `🌙 Night ${game.day} falls`,
      color: day ? 'day' : 'night',
      description: day
        ? 'The town wakes. Discuss in the town square — nominations may follow.'
        : 'Everyone close your eyes. The Storyteller will wake you if needed.',
      ...(png
        ? {
            files: [new AttachmentBuilder(png, { name: `${label}.png` })],
            image: `attachment://${label}.png`,
          }
        : {}),
    });
    await updateBoard(interaction.guild);

    // Night only: ping the Storyteller threads of everyone who acts tonight and
    // post the wake checklist in the Grimoire.
    const alert = day ? null : await postNightAlert(interaction.guild);
    return interaction.editReply(
      `${day ? 'Day' : 'Night'} begun, town status posted, and board refreshed.` +
        (alert
          ? alert.waking
            ? ` 🌙 Pinged **${alert.waking}** Storyteller thread${alert.waking === 1 ? '' : 's'} — wake list posted in <#${cfg.channels.grimoire}>.`
            : ' 🌙 Nobody acts tonight.'
          : '')
    );
  },
};
