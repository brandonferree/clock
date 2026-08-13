const {
  ActionRowBuilder,
  UserSelectMenuBuilder,
  MessageFlags,
} = require('discord.js');
const { getGuild, save } = require('./store');
const { logAction, isStoryteller, mention } = require('./game');
const { openWhisper } = require('./whisper');
const { refreshJoinPanel } = require('./commands/game');
const { voteEmbed } = require('./commands/nominate');
const { checklistPayload } = require('./night');

async function handleButton(interaction) {
  const id = interaction.customId;
  const cfg = getGuild(interaction.guild.id);
  const game = cfg.game;

  // --- Lobby join/leave ---
  if (id === 'botc_join' || id === 'botc_leave') {
    if (!game || game.status !== 'lobby') {
      return interaction.reply({ content: 'The lobby is closed.', flags: MessageFlags.Ephemeral });
    }
    if (id === 'botc_join') {
      if (game.players[interaction.user.id]) {
        return interaction.reply({ content: 'You are already in the game.', flags: MessageFlags.Ephemeral });
      }
      game.players[interaction.user.id] = {
        name: interaction.member.displayName,
        character: null,
        alive: true,
        deadVoteUsed: false,
        stThreadId: null,
      };
      save();
      await refreshJoinPanel(interaction.guild);
      await logAction(interaction.guild, {
        title: '🪑 Player joined',
        description: `<@${interaction.user.id}> takes a seat. (${Object.keys(game.players).length} players)`,
      });
      return interaction.reply({ content: 'You joined the game! 🪑', flags: MessageFlags.Ephemeral });
    } else {
      if (!game.players[interaction.user.id]) {
        return interaction.reply({ content: 'You are not in the game.', flags: MessageFlags.Ephemeral });
      }
      delete game.players[interaction.user.id];
      save();
      await refreshJoinPanel(interaction.guild);
      await logAction(interaction.guild, {
        title: '🚪 Player left',
        description: `<@${interaction.user.id}> leaves the lobby. (${Object.keys(game.players).length} players)`,
      });
      return interaction.reply({ content: 'You left the game.', flags: MessageFlags.Ephemeral });
    }
  }

  // --- Night wake checklist (Storyteller only, lives in #grimoire) ---
  if (id.startsWith('botc_night_done:') || id === 'botc_night_reset') {
    if (!isStoryteller(interaction.member)) {
      return interaction.reply({ content: 'Only the Storyteller can use the wake list.', flags: MessageFlags.Ephemeral });
    }
    if (!game?.nightAlert || interaction.message.id !== game.nightAlert.messageId) {
      return interaction.reply({ content: 'This wake list is from an earlier night. Run `/st night-alert` for the current one.', flags: MessageFlags.Ephemeral });
    }
    game.nightAlert.done ??= {};
    if (id === 'botc_night_reset') {
      game.nightAlert.done = {};
    } else {
      const playerId = id.slice('botc_night_done:'.length);
      if (game.nightAlert.done[playerId]) delete game.nightAlert.done[playerId];
      else game.nightAlert.done[playerId] = true;
    }
    save();
    return interaction.update(checklistPayload(game));
  }

  // --- Whisper: show a user picker ---
  if (id === 'botc_whisper') {
    const menu = new UserSelectMenuBuilder()
      .setCustomId('botc_whisper_select')
      .setPlaceholder('Choose who to talk to privately')
      .setMinValues(1)
      .setMaxValues(1);
    return interaction.reply({
      content: 'Who do you want to open a private room with?',
      components: [new ActionRowBuilder().addComponents(menu)],
      flags: MessageFlags.Ephemeral,
    });
  }

  // --- Voting ---
  if (id === 'botc_vote_yes' || id === 'botc_vote_no' || id === 'botc_vote_close') {
    if (!game?.nomination?.open || interaction.message.id !== game.nomination.messageId) {
      return interaction.reply({ content: 'This vote is closed.', flags: MessageFlags.Ephemeral });
    }
    const nom = game.nomination;

    if (id === 'botc_vote_close') {
      if (!isStoryteller(interaction.member)) {
        return interaction.reply({ content: 'Only the Storyteller can close the vote.', flags: MessageFlags.Ephemeral });
      }
      nom.open = false;
      const yes = Object.entries(nom.votes).filter(([, v]) => v).map(([id]) => id);
      const alive = Object.values(game.players).filter((p) => p.alive).length;
      const needed = Math.ceil(alive / 2);
      const passed = yes.length >= needed;
      // Spend dead votes for dead players who voted yes.
      for (const voterId of yes) {
        const p = game.players[voterId];
        if (p && !p.alive) p.deadVoteUsed = true;
      }
      save();
      await interaction.update({ embeds: [voteEmbed(game)], components: [] });
      await logAction(interaction.guild, {
        title: passed ? '🗳️ Vote passed' : '🗳️ Vote failed',
        color: 'vote',
        description: [
          `Nomination of ${mention(game, nom.nominee)} by ${mention(game, nom.nominator)}: **${yes.length} votes** (${needed} needed).`,
          yes.length ? `Voted yes: ${yes.map((id) => mention(game, id)).join(', ')}` : 'No votes were cast.',
          passed
            ? `**${mention(game, nom.nominee)} is about to be executed** (unless a later nomination gets more votes today).`
            : 'The nomination does not reach a majority.',
        ].join('\n'),
      });
      return;
    }

    const voter = game.players[interaction.user.id];
    if (!voter) {
      return interaction.reply({ content: 'Only seated players can vote.', flags: MessageFlags.Ephemeral });
    }
    if (id === 'botc_vote_yes') {
      if (!voter.alive && voter.deadVoteUsed) {
        return interaction.reply({
          content: 'You are dead and have already spent your dead vote.',
          flags: MessageFlags.Ephemeral,
        });
      }
      nom.votes[interaction.user.id] = true;
    } else {
      delete nom.votes[interaction.user.id];
    }
    save();
    await interaction.update({ embeds: [voteEmbed(game)] });
    return;
  }
}

async function handleSelect(interaction) {
  if (interaction.customId === 'botc_whisper_select') {
    const targetId = interaction.values[0];
    if (targetId === interaction.user.id) {
      return interaction.update({ content: 'You cannot whisper to yourself.', components: [] });
    }
    const target = await interaction.client.users.fetch(targetId);
    if (target.bot) {
      return interaction.update({ content: 'Bots have no secrets to share.', components: [] });
    }
    const { thread, existed } = await openWhisper(interaction.guild, interaction.user, target);
    return interaction.update({
      content: existed
        ? `You already have a room with <@${targetId}>: <#${thread.id}>`
        : `🤫 Private room opened: <#${thread.id}>`,
      components: [],
    });
  }
}

module.exports = { handleButton, handleSelect };
