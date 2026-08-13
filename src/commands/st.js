const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder, MessageFlags } = require('discord.js');
const { getGuild, save } = require('../store');
const { logAction, isStoryteller, seatedChoices, mention, COLORS } = require('../game');
const { rolesById, rolesForScript } = require('../data/scripts');
const { updateBoard, postScriptReference } = require('../grimoire');
const { renderGrimoire } = require('../render');
const { nightOrder, postNightAlert, updateChecklist } = require('../night');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('st')
    .setDescription('Storyteller tools')
    .addSubcommand((s) =>
      s
        .setName('kill')
        .setDescription('Mark a player as dead')
        .addStringOption((o) => o.setName('player').setDescription('Who died').setRequired(true).setAutocomplete(true))
        .addStringOption((o) =>
          o
            .setName('cause')
            .setDescription('How they died')
            .addChoices(
              { name: 'Died in the night', value: 'night' },
              { name: 'Executed by the town', value: 'execution' },
              { name: 'Other', value: 'other' }
            )
        )
    )
    .addSubcommand((s) =>
      s
        .setName('revive')
        .setDescription('Bring a player back to life')
        .addStringOption((o) => o.setName('player').setDescription('Who returns').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((s) =>
      s
        .setName('remind')
        .setDescription('Attach a reminder token to a player (e.g. Poisoned, Red herring)')
        .addStringOption((o) => o.setName('player').setDescription('Who gets the token').setRequired(true).setAutocomplete(true))
        .addStringOption((o) => o.setName('token').setDescription('The reminder token').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((s) =>
      s
        .setName('unremind')
        .setDescription('Remove a reminder token from a player')
        .addStringOption((o) => o.setName('player').setDescription('Who loses the token').setRequired(true).setAutocomplete(true))
        .addStringOption((o) => o.setName('token').setDescription('The reminder token to remove').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((s) => s.setName('night-order').setDescription('Show the night order for characters in play (private)'))
    .addSubcommand((s) =>
      s
        .setName('night-alert')
        .setDescription('Ping the Storyteller thread of everyone who acts tonight and post the wake checklist')
    )
    .addSubcommand((s) => s.setName('grimoire').setDescription('View the full grimoire — all players and characters (private)'))
    .addSubcommand((s) =>
      s.setName('refresh').setDescription('Refresh the pinned Grimoire board with current town, deaths, and status')
    )
    .addSubcommand((s) =>
      s.setName('script').setDescription('Re-post the character reference (all abilities) in the Grimoire')
    ),

  async autocomplete(interaction) {
    const cfg = getGuild(interaction.guild.id);
    const game = cfg.game;
    const focused = interaction.options.getFocused(true);
    if (focused.name === 'player') {
      return interaction.respond(seatedChoices(game, focused.value));
    }

    // Token option. Values are `roleId|text` so execute can recover both halves.
    const q = focused.value.toLowerCase();
    let choices;
    if (interaction.options.getSubcommand() === 'unremind') {
      // Only offer tokens the chosen player actually has.
      const player = game?.players?.[interaction.options.getString('player')];
      choices = (player?.reminders ?? []).map((rem) => ({
        name: `${rolesById.get(rem.role)?.name ?? rem.role} — ${rem.text}`,
        value: `${rem.role}|${rem.text}`,
      }));
    } else {
      choices = rolesForScript(game?.script ?? 'tb').flatMap((r) =>
        [...(r.reminders ?? []), ...(r.remindersGlobal ?? [])].map((text) => ({
          name: `${r.name} — ${text}`,
          value: `${r.id}|${text}`,
        }))
      );
    }
    return interaction.respond(choices.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 25));
  },

  async execute(interaction) {
    if (!isStoryteller(interaction.member)) {
      return interaction.reply({ content: 'Only the Storyteller can use this.', flags: MessageFlags.Ephemeral });
    }
    const cfg = getGuild(interaction.guild.id);
    const game = cfg.game;
    if (!game || game.status !== 'running') {
      return interaction.reply({ content: 'No game is running.', flags: MessageFlags.Ephemeral });
    }
    const sub = interaction.options.getSubcommand();

    if (sub === 'kill') {
      const playerId = interaction.options.getString('player');
      const player = game.players[playerId];
      if (!player) return interaction.reply({ content: 'That player is not in the game. Pick one from the autocomplete list.', flags: MessageFlags.Ephemeral });
      if (!player.alive) return interaction.reply({ content: 'They are already dead.', flags: MessageFlags.Ephemeral });
      player.alive = false;
      save();
      const cause = interaction.options.getString('cause') ?? 'other';
      const causeText = {
        night: `died in the night. ${game.phase === 'day' ? `The town wakes to grim news on Day ${game.day}.` : ''}`,
        execution: `was executed by the town on Day ${game.day}.`,
        other: 'has died.',
      }[cause];
      await logAction(interaction.guild, {
        title: '💀 Death',
        color: 'death',
        description: `${mention(game, playerId)} ${causeText}\n*Dead players may still talk, and have one final vote.*`,
      });
      await updateBoard(interaction.guild);
      // A death removes them from tonight's wake list.
      await updateChecklist(interaction.guild);
      return interaction.reply({ content: `${mention(game, playerId)} marked dead — logged and board updated.`, flags: MessageFlags.Ephemeral });
    }

    if (sub === 'revive') {
      const playerId = interaction.options.getString('player');
      const player = game.players[playerId];
      if (!player) return interaction.reply({ content: 'That player is not in the game. Pick one from the autocomplete list.', flags: MessageFlags.Ephemeral });
      if (player.alive) return interaction.reply({ content: 'They are already alive.', flags: MessageFlags.Ephemeral });
      player.alive = true;
      save();
      await logAction(interaction.guild, {
        title: '✨ Resurrection',
        color: 'good',
        description: `${mention(game, playerId)} has returned to life!`,
      });
      await updateBoard(interaction.guild);
      await updateChecklist(interaction.guild);
      return interaction.reply({ content: `${mention(game, playerId)} revived — logged and board updated.`, flags: MessageFlags.Ephemeral });
    }

    if (sub === 'remind' || sub === 'unremind') {
      const playerId = interaction.options.getString('player');
      const player = game.players[playerId];
      if (!player) {
        return interaction.reply({ content: 'That player is not in the game. Pick one from the autocomplete list.', flags: MessageFlags.Ephemeral });
      }
      const [roleId, ...rest] = interaction.options.getString('token').split('|');
      const text = rest.join('|');
      const role = rolesById.get(roleId);
      if (!role || !text) {
        return interaction.reply({ content: 'Pick a token from the autocomplete list.', flags: MessageFlags.Ephemeral });
      }

      player.reminders ??= [];
      if (sub === 'remind') {
        player.reminders.push({ role: roleId, text });
      } else {
        const i = player.reminders.findIndex((rem) => rem.role === roleId && rem.text === text);
        if (i === -1) {
          return interaction.reply({ content: `${mention(game, playerId)} does not have a **${role.name} — ${text}** token.`, flags: MessageFlags.Ephemeral });
        }
        player.reminders.splice(i, 1);
      }
      save();
      await updateBoard(interaction.guild);
      return interaction.reply({
        content:
          sub === 'remind'
            ? `🔖 **${role.name} — ${text}** placed on ${mention(game, playerId)}.`
            : `Removed **${role.name} — ${text}** from ${mention(game, playerId)}.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'night-order') {
      // Shared with the night alert so both views agree on who acts when.
      const { first, entries: ordered } = nightOrder(game);

      const lines = ordered.length
        ? ordered.map(({ player, role, order, reminder }) =>
            player.alive
              ? `🟢 **${order}. ${role.name}** — ${player.name}\n${reminder}`
              : `💀 **${order}. ~~${role.name}~~** — ~~${player.name}~~ *(dead — skip)*\n*${reminder}*`
          )
        : ['*No characters in play act tonight (or no characters assigned yet).*'];

      const deadCount = ordered.filter(({ player }) => !player.alive).length;
      return interaction.reply({
        flags: MessageFlags.Ephemeral,
        embeds: [
          new EmbedBuilder()
            .setTitle(`🌙 ${first ? 'First night' : 'Night'} order`)
            .setColor(COLORS.night)
            .setDescription(lines.join('\n\n').slice(0, 4000))
            .setFooter({
              text: deadCount
                ? `🟢 alive · 💀 dead (${deadCount} to skip) — dead players lose their ability, except on-death ones like the Ravenkeeper.`
                : '🟢 all players with night actions are still alive.',
            }),
        ],
      });
    }

    if (sub === 'night-alert') {
      if (game.phase !== 'night') {
        return interaction.reply({
          content: `It is Day ${game.day} — there is nobody to wake. Call \`/phase night\` first.`,
          flags: MessageFlags.Ephemeral,
        });
      }
      // Pinging N threads is N round-trips, so defer.
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const alert = await postNightAlert(interaction.guild);
      if (!alert?.waking) {
        return interaction.editReply(
          'Nobody acts tonight — either no character in play has a night action, or characters have not been assigned yet (`/assign`).'
        );
      }
      return interaction.editReply(
        `🌙 Pinged **${alert.waking}** Storyteller thread${alert.waking === 1 ? '' : 's'}. ` +
          (alert.message
            ? `Wake checklist: ${alert.message.url}`
            : `Could not post the checklist in <#${cfg.channels.grimoire}> — is the channel still there?`)
      );
    }

    if (sub === 'refresh') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const msg = await updateBoard(interaction.guild);
      return interaction.editReply(
        msg
          ? `Grimoire board refreshed: ${msg.url}`
          : 'Could not update the board — is the Grimoire channel still there? Try `/setup`.'
      );
    }

    if (sub === 'script') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await postScriptReference(interaction.guild, game.script);
      await updateBoard(interaction.guild);
      return interaction.editReply(`Character reference posted in <#${cfg.channels.grimoire}>.`);
    }

    if (sub === 'grimoire') {
      // Rendering fetches character art on a cold cache, so defer first.
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const lines = Object.entries(game.players).map(([id, p]) => {
        const role = p.character && rolesById.get(p.character);
        const rems = p.reminders?.length ? ` · 🔖 ${p.reminders.map((rem) => `\`${rem.text}\``).join(' ')}` : '';
        return `${p.alive ? '🙂' : '💀'} ${mention(game, id)} — **${role?.name ?? 'unassigned'}**${rems}`;
      });
      const embed = new EmbedBuilder()
        .setTitle('📖 Grimoire')
        .setColor(COLORS.vote)
        .setDescription(lines.join('\n') || '*No players.*');

      // The board picture is a bonus — if it fails, still send the text.
      const png = await renderGrimoire(game, { reveal: true }).catch(() => null);
      if (png) {
        embed.setImage('attachment://grimoire.png');
        return interaction.editReply({
          embeds: [embed],
          files: [new AttachmentBuilder(png, { name: 'grimoire.png' })],
        });
      }
      return interaction.editReply({ embeds: [embed] });
    }
  },
};
