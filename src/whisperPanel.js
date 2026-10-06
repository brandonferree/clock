const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { getGuild, save } = require('./store');
const { mention, daySegment, COLORS } = require('./game');
const { whisperRules, whispersMonitored, describeRules } = require('./whisperRules');
const { remaining } = require('./whisperSessions');

/**
 * The panel in #whispers: the button that opens a room, and — when whispers are
 * counted — the board of who has how many left.
 *
 * The remaining budget is public. It could not usefully be hidden: anyone can
 * count a player's spent whispers off the day's summary, so keeping the number
 * private would buy no secrecy at all and cost every player the bookkeeping of
 * working it out by hand. Better to put it where the decision is made.
 */
function whisperPanelPayload(game) {
  const monitored = whispersMonitored(game);
  const r = whisperRules(game);

  const embed = new EmbedBuilder()
    .setTitle('🤫 Private conversations')
    .setColor(COLORS.vote)
    .setDescription(
      monitored
        ? [
            describeRules(game),
            '',
            'Press below and pick who you want to talk to. **Everyone invited has to accept**, and when the room ' +
              'opens it costs each of you one whisper — including the people you invited. The same people on a ' +
              'later day costs another.',
            '',
            'Rooms lock when the Storyteller calls the town in — they stay listed in this channel and stay readable, and walking back in with the same people later reopens the same room. There is no whispering at night.',
          ].join('\n')
        : 'Click below to open a private room with another player. A private thread will be created that only the ' +
            'two of you (and the Storyteller) can see. It stays in this channel for the rest of the game, so you ' +
            'can read back what was said.'
    );

  if (monitored) {
    const seated = Object.keys(game.players);
    if (seated.length) {
      embed.addFields({
        name: `Whispers left — Day ${game.day}`,
        value: seated
          .map((id) => `${mention(game, id)} — ${'🔵'.repeat(remaining(game, id)) || '—'}`)
          .join('\n')
          .slice(0, 1024),
      });
    }
    embed.setFooter({
      text:
        game.phase !== 'day'
          ? 'Whispers are closed — it is night.'
          : daySegment(game) === 'town'
            ? 'Whispers are closed — the town is gathered.'
            : `Up to ${r.size} people in a room · everyone invited pays one.`,
    });
  }

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('botc_whisper')
          .setLabel(monitored ? 'Ask for a private word' : 'Open a private chat')
          .setStyle(ButtonStyle.Primary)
          .setEmoji('💬')
      ),
    ],
  };
}

/** Put the panel up in #whispers and remember it, replacing any earlier one. */
async function postWhisperPanel(guild) {
  const cfg = getGuild(guild.id);
  const game = cfg.game;
  if (!game) return null;
  const channel = cfg.channels.whispers && (await guild.channels.fetch(cfg.channels.whispers).catch(() => null));
  if (!channel) return null;
  const msg = await channel.send(whisperPanelPayload(game)).catch(() => null);
  game.whisperPanelId = msg?.id ?? null;
  save();
  return msg;
}

/**
 * Redraw the panel. Called after anything that spends a whisper or changes
 * whether one can be spent at all — the budget board is only worth showing if
 * it is right, and a stale one is worse than none.
 */
async function updateWhisperPanel(guild) {
  const cfg = getGuild(guild.id);
  const game = cfg.game;
  if (!game?.whisperPanelId) return;
  const channel = cfg.channels.whispers && (await guild.channels.fetch(cfg.channels.whispers).catch(() => null));
  const msg = channel && (await channel.messages.fetch(game.whisperPanelId).catch(() => null));
  await msg?.edit(whisperPanelPayload(game)).catch(() => null);
}

module.exports = { whisperPanelPayload, postWhisperPanel, updateWhisperPanel };
