const {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
} = require('discord.js');
const { getGuild, save } = require('../store');
const { logAction, isStoryteller, seatedChoices, mention, daySegment, COLORS } = require('../game');
const { virginTrigger } = require('../nominationRules');
const { placeToken } = require('../tokens');

/**
 * The vote count, rendered as a Markdown heading so it reads across the room.
 *
 * The tally is the whole point of a nomination and it was previously buried
 * mid-sentence in a paragraph of mentions. A `#` heading is the largest text
 * Discord will render inside an embed, so the number that decides the game is
 * the first thing the eye lands on, and the qualifiers sit under it.
 */
function bigCount(count, needed, verdict) {
  return [`# ${count}`, `**yes vote${count === 1 ? '' : 's'}** · ${needed} needed${verdict ? ` · ${verdict}` : ''}`].join('\n');
}

/**
 * The hands that went up, numbered one per line.
 *
 * A comma-joined run of mentions wraps into a block nobody can count at a
 * glance, which is the one thing this list exists to show — so it is a list,
 * and the numbering makes the total checkable against the heading above it.
 */
function voterList(game, ids, empty = '*none yet*') {
  if (!ids.length) return empty;
  return ids.map((id, i) => `\`${String(i + 1).padStart(2, ' ')}.\` ${mention(game, id)}`).join('\n');
}

function voteEmbed(game) {
  const nom = game.nomination;
  const yes = Object.entries(nom.votes).filter(([, v]) => v).map(([id]) => id);
  const alive = Object.values(game.players).filter((p) => p.alive).length;
  const needed = Math.ceil(alive / 2);
  return new EmbedBuilder()
    .setTitle('⚖️ Nomination')
    .setColor(COLORS.vote)
    .setDescription(
      [
        `${mention(game, nom.nominator)} has nominated ${mention(game, nom.nominee)} for execution.`,
        '',
        bigCount(yes.length, needed, yes.length >= needed ? '**majority reached**' : `${needed - yes.length} more to pass`),
      ].join('\n')
    )
    .addFields({ name: `Voted yes (${yes.length})`, value: voterList(game, yes).slice(0, 1024) })
    .setFooter({
      text: 'Votes are final — once cast you cannot change or retract it. Dead players may spend their one dead vote. The Storyteller closes the vote.',
    });
}

function voteButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('botc_vote_yes').setLabel('Vote YES').setStyle(ButtonStyle.Danger).setEmoji('🗳️'),
    new ButtonBuilder().setCustomId('botc_vote_no').setLabel('Vote NO').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('botc_vote_close').setLabel('Close vote (ST)').setStyle(ButtonStyle.Primary).setEmoji('🔒')
  );
}

/**
 * Put the Virgin in front of the Storyteller, with the decision already argued.
 *
 * Posted in #grimoire, which players cannot read, and never in the square: who
 * the Virgin is and whether their ability worked is not the town's business
 * until somebody drops dead. Nothing happens until the Storyteller presses —
 * the whole point is that this is a judgement call, not a lookup.
 */
async function postVirginPrompt(guild, cfg, game, trigger) {
  const virgin = game.players[trigger.virginId];
  const nominator = game.players[trigger.nominatorId];

  const embed = new EmbedBuilder()
    .setTitle('😇 The Virgin has been nominated')
    .setColor(COLORS.vote)
    .setDescription(
      [
        `${mention(game, trigger.nominatorId)} nominated ${mention(game, trigger.virginId)} — the **Virgin**, ` +
          'and this is the first time they have been nominated.',
        '',
        trigger.fires
          ? `**${nominator.name} registers as a Townsfolk, so they are executed immediately.**` +
            ` This is today's execution — the town does not get another one.`
          : `**Nothing happens by the book** — ${nominator.name} does not register as a Townsfolk.`,
        '',
        `The **No ability** token is now on ${virgin.name}: the Virgin fires once, whether or not anyone dies.`,
      ].join('\n')
    )
    .setFooter({ text: 'Only you can see this. The nomination stays open either way — the vote goes ahead.' });
  if (trigger.caveats.length) {
    embed.addFields({ name: 'Before you press', value: trigger.caveats.map((c) => `⚠️ ${c}`).join('\n\n').slice(0, 1024) });
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`botc_virgin_go:${trigger.nominatorId}`)
      .setLabel(`Execute ${nominator.name} now`.slice(0, 80))
      .setStyle(trigger.fires ? ButtonStyle.Danger : ButtonStyle.Secondary)
      .setEmoji('⚖️'),
    new ButtonBuilder()
      .setCustomId('botc_virgin_no')
      .setLabel('Nothing happens')
      .setStyle(trigger.fires ? ButtonStyle.Secondary : ButtonStyle.Success)
      .setEmoji('🤐')
  );

  const grimoire = cfg.channels.grimoire && (await guild.channels.fetch(cfg.channels.grimoire).catch(() => null));
  return grimoire
    ? grimoire
        .send({
          content: game.storytellerId ? `<@${game.storytellerId}> — a call to make.` : '',
          embeds: [embed],
          components: [row],
        })
        .catch(() => null)
    : null;
}

/**
 * Open a nomination and post the vote in the town square.
 *
 * Shared by `/nominate`, the players' button in #game-log, and the
 * Storyteller's nominate-on-behalf button in #grimoire, so every route enforces
 * the same rules. Returns `{ error }` or `{ message }`.
 */
async function openNomination(guild, nominatorId, nomineeId) {
  const cfg = getGuild(guild.id);
  const game = cfg.game;
  if (!game || game.status !== 'running') return { error: 'No game is running.' };
  if (game.phase !== 'day') return { error: 'Nominations only happen during the day.' };
  // The town has to be standing together before anyone can be put up for
  // execution. Enforced here rather than only on the button, so `/nominate`
  // cannot walk around a panel that is deliberately not showing one.
  if (daySegment(game) !== 'town') {
    return {
      error:
        'The town has not been called in yet — the Storyteller opens nominations when everyone gathers in the square.',
    };
  }

  const nominator = game.players[nominatorId];
  if (!nominator) return { error: 'Only seated players can nominate.' };
  if (!nominator.alive) return { error: 'Dead players cannot nominate.' };
  if (game.nomination?.open) {
    return { error: 'A nomination is already being voted on. Wait for the Storyteller to close it.' };
  }
  if (!game.players[nomineeId]) return { error: 'That player is not in this game.' };
  if (nominator.nominatedToday === game.day) {
    return { error: `${mention(game, nominatorId)} has already nominated today.` };
  }
  if (game.nominationDay === game.day && game.nominatedToday?.includes(nomineeId)) {
    return { error: 'That player has already been nominated today.' };
  }

  nominator.nominatedToday = game.day;
  if (!game.nominatedToday || game.nominationDay !== game.day) {
    game.nominatedToday = [];
    game.nominationDay = game.day;
  }
  game.nominatedToday.push(nomineeId);
  game.nomination = { nominator: nominatorId, nominee: nomineeId, votes: {}, open: true, messageId: null };

  const townSquare = await guild.channels.fetch(cfg.channels.townSquare).catch(() => null);
  if (!townSquare) {
    game.nomination = null;
    return { error: 'The town square channel is missing — run `/setup`.' };
  }
  const msg = await townSquare.send({ embeds: [voteEmbed(game)], components: [voteButtons()] });
  game.nomination.messageId = msg.id;
  save();

  await logAction(guild, {
    title: '⚖️ Nomination',
    color: 'vote',
    description: `Day ${game.day}: ${mention(game, nominatorId)} nominated ${mention(game, nomineeId)}. Voting is open in the town square.`,
  });

  // The Virgin fires on being nominated, not on the vote — so it is settled
  // here, before a single hand goes up. The ability is spent the moment it
  // triggers, whether or not the Storyteller decides anyone dies.
  const trigger = virginTrigger(game, nominatorId, nomineeId);
  if (trigger) {
    placeToken(game, nomineeId, 'virgin', 'No ability');
    save();
    await postVirginPrompt(guild, cfg, game, trigger);
  }

  return { message: msg, virgin: trigger };
}

module.exports = {
  voteEmbed,
  postVirginPrompt,
  voteButtons,
  openNomination,
  bigCount,
  voterList,

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

    let nominatorId = interaction.user.id;
    const asId = interaction.options.getString('as');
    if (asId) {
      if (!isStoryteller(interaction.member)) {
        return interaction.reply({ content: 'Only the Storyteller can nominate on behalf of a player.', flags: MessageFlags.Ephemeral });
      }
      nominatorId = asId;
    }

    const { error } = await openNomination(interaction.guild, nominatorId, interaction.options.getString('player'));
    return interaction.reply({
      content: error ?? `Nomination posted in <#${cfg.channels.townSquare}>.`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
