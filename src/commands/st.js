const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getGuild, save } = require('../store');
const { logAction, isStoryteller, seatedChoices, mention } = require('../game');
const { placeToken } = require('../tokens');
const { rolesById, rolesForScript } = require('../data/scripts');
const { updateBoard, clearScriptReference, grimoireView } = require('../grimoire');
const { postScriptSheets, sheetStatus } = require('../scriptSheets');
const { tokenCharacters, tokensFor } = require('../reminderPanel');
const { updateChecklist, nightOrderEmbed, nightAlertSummary } = require('../night');
const { dealCharacters } = require('../deal');
const { postAssignPanel, updateAssignPanel } = require('../assignPanel');
const { setupWarning } = require('../setupMods');

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
        // Character first, token second — the same narrowing the 🔖 panel uses.
        // One combined list runs to 39 entries on Bad Moon Rising, which is more
        // than autocomplete will show at once.
        .addStringOption((o) =>
          o.setName('character').setDescription('Whose token is it?').setRequired(true).setAutocomplete(true)
        )
        .addStringOption((o) => o.setName('token').setDescription('The reminder token').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((s) =>
      s
        .setName('unremind')
        .setDescription('Remove a reminder token from a player')
        .addStringOption((o) => o.setName('player').setDescription('Who loses the token').setRequired(true).setAutocomplete(true))
        .addStringOption((o) => o.setName('token').setDescription('The reminder token to remove').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((s) =>
      s
        .setName('deal')
        .setDescription('Randomly stage the whole town — review on the panel, then publish to send')
        .addBooleanOption((o) =>
          o.setName('redeal').setDescription('Re-deal even though characters are already assigned (default no)')
        )
    )
    .addSubcommand((s) =>
      s
        .setName('assign-panel')
        .setDescription('Post the click-through character assignment panel in the Grimoire')
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
      s
        .setName('script')
        .setDescription('Re-post the pinned reference sheets in the town square')
    ),

  async autocomplete(interaction) {
    const cfg = getGuild(interaction.guild.id);
    const game = cfg.game;
    const focused = interaction.options.getFocused(true);
    if (focused.name === 'player') {
      return interaction.respond(seatedChoices(game, focused.value));
    }

    const q = focused.value.toLowerCase();
    let choices;

    // Characters on this script that carry any token, in-play ones first —
    // those are what a Storyteller reaches for nearly every time.
    if (focused.name === 'character') {
      choices = tokenCharacters(game ?? { players: {}, script: 'tb' }).map(({ role, inPlay }) => ({
        name: `${inPlay ? '● ' : ''}${role.name} — ${tokensFor(role).join(', ')}`.slice(0, 100),
        value: role.id,
      }));
    } else if (interaction.options.getSubcommand() === 'unremind') {
      // Only offer tokens the chosen player actually has. Values are
      // `roleId|text` so execute can recover both halves.
      const player = game?.players?.[interaction.options.getString('player')];
      choices = (player?.reminders ?? []).map((rem) => ({
        name: `${rolesById.get(rem.role)?.name ?? rem.role} — ${rem.text}`,
        value: `${rem.role}|${rem.text}`,
      }));
    } else {
      // Tokens belonging to the character already chosen. Falling back to the
      // whole script keeps the option usable if it is filled in out of order.
      const role = rolesById.get(interaction.options.getString('character'));
      choices = role
        ? tokensFor(role).map((text) => ({ name: text, value: text }))
        : rolesForScript(game?.script ?? 'tb').flatMap((r) =>
            tokensFor(r).map((text) => ({ name: `${r.name} — ${text}`, value: text }))
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
      // Which night they died on, for the characters that wake because of it.
      player.diedAt = game.day;
      const cause = interaction.options.getString('cause') ?? 'other';
      // Remembered for the Undertaker, who is told tonight which character was
      // executed today — by then the day is gone and only this record is left.
      if (cause === 'execution') game.lastExecuted = { id: playerId, character: player.character, day: game.day };
      save();
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
      // `remind` names the character in its own option; `unremind` picks from
      // what the player is already carrying, so its value packs both halves.
      const [roleId, text] =
        sub === 'remind'
          ? [interaction.options.getString('character'), interaction.options.getString('token')]
          : (() => {
              const [id, ...rest] = interaction.options.getString('token').split('|');
              return [id, rest.join('|')];
            })();
      const role = rolesById.get(roleId);
      if (!role || !text) {
        return interaction.reply({ content: 'Pick a character and token from the autocomplete lists.', flags: MessageFlags.Ephemeral });
      }

      player.reminders ??= [];
      let movedFrom = null;
      if (sub === 'remind') {
        // One of each token exists, so this moves it rather than cloning it.
        movedFrom = placeToken(game, playerId, roleId, text);
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
            ? `🔖 **${role.name} — ${text}** placed on ${mention(game, playerId)}.` +
              (movedFrom ? ` Moved off ${mention(game, movedFrom)} — only one is ever on the board.` : '')
            : `Removed **${role.name} — ${text}** from ${mention(game, playerId)}.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'assign-panel') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const msg = await postAssignPanel(interaction.guild);
      return interaction.editReply(
        msg
          ? `🎭 Assignment panel posted: ${msg.url}\nTap a player to pick their character, or **🎲 Random deal** for the whole town.`
          : `Could not post it in <#${cfg.channels.grimoire}> — is the Grimoire channel still there? Try \`/setup\`.`
      );
    }

    if (sub === 'night-order') {
      // Shared with the night-controls button so both views agree on who acts when.
      return interaction.reply({ embeds: [nightOrderEmbed(game)], flags: MessageFlags.Ephemeral });
    }

    if (sub === 'deal') {
      const already = Object.entries(game.players).filter(([, p]) => p.character);
      if (already.length && !interaction.options.getBoolean('redeal')) {
        return interaction.reply({
          content:
            `⚠️ ${already.length} player${already.length === 1 ? ' already has a character' : 's already have characters'}. ` +
            'Re-dealing replaces every character and tells everyone their new one, which mid-game would be a mess. ' +
            'If you really mean it, run `/st deal redeal:true`.',
          flags: MessageFlags.Ephemeral,
        });
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const result = dealCharacters(game);
      if (result.error) return interaction.editReply(result.error);

      await updateBoard(interaction.guild);
      await updateChecklist(interaction.guild);
      await updateAssignPanel(interaction.guild);
      return interaction.editReply(
        [
          `🎲 Staged **${result.dealt.length}** characters (${result.dist.join('/')} townsfolk/outsiders/minions/demon):`,
          result.dealt.map(({ id, role }) => `${mention(game, id)} → **${role.name}**`).join('\n'),
          '',
          `**Nothing has been sent.** Review the spread on the 🎭 panel in <#${cfg.channels.grimoire}>, fix whatever you want, ` +
            'then hit 📨 **Publish** to tell everyone at once.',
          setupWarning(game),
        ]
          .filter(Boolean)
          .join('\n')
      );
    }

    if (sub === 'night-alert') {
      // Pinging N threads is N round-trips, so defer.
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      return interaction.editReply(await nightAlertSummary(interaction.guild));
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
      await clearScriptReference(interaction.guild);
      await updateBoard(interaction.guild);
      const sheets = await postScriptSheets(interaction.guild, game.script);
      return interaction.editReply(sheetStatus(sheets, cfg.channels.townSquare));
    }

    if (sub === 'grimoire') {
      // Rendering fetches character art on a cold cache, so defer first.
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      return interaction.editReply(await grimoireView(game));
    }
  },
};
