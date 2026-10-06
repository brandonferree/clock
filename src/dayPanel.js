const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  EmbedBuilder,
} = require('discord.js');
const { getGuild, save } = require('./store');
const { COLORS, daySegment } = require('./game');

/**
 * The two panels that belong to the day.
 *
 * - #grimoire gets the Storyteller's controls: kill, nominate on behalf of a
 *   player, and call night. Hidden channel, so it may say anything.
 * - #game-log gets the players' nomination button. That channel is read-only
 *   for players, which is exactly what we want: the button is the only way in,
 *   and it checks that whoever pressed it is actually seated and alive.
 *
 * Both are torn down when night falls, so a stale day panel can never be used
 * to nominate at night.
 *
 * The day has two halves and both panels change between them. In `discussion`
 * the town is milling about and there is no nomination button at all; the
 * Storyteller's ⚖️ Nominate is replaced by 📢 Call the town in. That press is
 * what opens nominations — at a real table nobody nominates across a room of
 * people still holding private conversations.
 */
function dayControlsPayload(game) {
  const alive = Object.values(game.players).filter((p) => p.alive).length;
  const gathered = daySegment(game) === 'town';

  const middle = gathered
    ? new ButtonBuilder()
        .setCustomId('botc_day_nominate')
        .setLabel('Nominate')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('⚖️')
    : new ButtonBuilder()
        .setCustomId('botc_day_gather')
        .setLabel('Call the town in')
        .setStyle(ButtonStyle.Success)
        .setEmoji('📢');

  return {
    embeds: [
      new EmbedBuilder()
        .setTitle(`☀️ Day ${game.day} — ${gathered ? 'the town is gathered' : 'the town is talking'}`)
        .setColor(COLORS.day)
        .setDescription(
          gathered
            ? `${alive} alive. Run the day from here, or use \`/st kill\`, \`/nominate\` and \`/phase night\`.`
            : `${alive} alive. Nobody can nominate yet — press **📢 Call the town in** when you are ready to open ` +
              'nominations, or go straight to night for a day without an execution.'
        ),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('botc_day_kill').setLabel('Kill').setStyle(ButtonStyle.Danger).setEmoji('💀'),
        middle,
        new ButtonBuilder()
          .setCustomId('botc_day_night')
          .setLabel('Night falls')
          .setStyle(ButtonStyle.Primary)
          .setEmoji('🌙')
      ),
    ],
  };
}

/**
 * What #game-log shows while the town is still talking: no nomination button,
 * and a plain statement of who opens them. A player who cannot find the button
 * should know it is the Storyteller they are waiting on, not a broken bot.
 */
function discussionPanelPayload(game) {
  return {
    embeds: [
      new EmbedBuilder()
        .setTitle(`☀️ Day ${game.day} — the town is talking`)
        .setColor(COLORS.day)
        .setDescription(
          [
            'Talk in the town square. Nobody can be nominated yet.',
            '',
            '**The Storyteller will call the town in when the day is done** — nominations open then, and this panel ' +
              'becomes the nomination button.',
          ].join('\n')
        )
        .setFooter({ text: 'Nominations are closed until the town gathers.' }),
    ],
    components: [],
  };
}

function nominationPanelPayload(game) {
  return {
    embeds: [
      new EmbedBuilder()
        .setTitle('⚖️ Nominations are open')
        .setColor(COLORS.vote)
        .setDescription(
          `Day ${game.day}. Any living player may nominate once. ` +
            'Press the button and choose who you are putting up for execution — the vote opens in the town square.'
        )
        .setFooter({ text: 'Seated, living players only · one nomination each per day · votes are final once cast.' }),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('botc_nom_open')
          .setLabel('Nominate a player')
          .setStyle(ButtonStyle.Danger)
          .setEmoji('⚖️')
      ),
    ],
  };
}

/** A select menu of seated players, for the pickers behind the day buttons. */
function playerSelect(game, customId, placeholder, { aliveOnly = false } = {}) {
  const options = Object.entries(game.players)
    .filter(([, p]) => !aliveOnly || p.alive)
    .slice(0, 25)
    .map(([id, p]) => ({ label: p.name.slice(0, 100), value: id, description: p.alive ? undefined : 'dead' }));
  if (!options.length) return null;
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder.slice(0, 150)).addOptions(options)
  );
}

async function postIn(guild, channelId, payload) {
  const channel = channelId && (await guild.channels.fetch(channelId).catch(() => null));
  if (!channel) return null;
  return channel.send(payload).catch(() => null);
}

async function deleteIn(guild, channelId, messageId) {
  if (!messageId) return;
  const channel = channelId && (await guild.channels.fetch(channelId).catch(() => null));
  const msg = channel && (await channel.messages.fetch(messageId).catch(() => null));
  await msg?.delete().catch(() => null);
}

/**
 * Put up both day panels for the current segment, replacing any left over from
 * an earlier day — or from the other half of this one, since calling the town
 * in swaps both panels over.
 */
async function postDayPanels(guild) {
  const cfg = getGuild(guild.id);
  const game = cfg.game;
  if (!game) return;
  await clearDayPanels(guild);
  const gathered = daySegment(game) === 'town';
  game.dayPanelId = (await postIn(guild, cfg.channels.grimoire, dayControlsPayload(game)))?.id ?? null;
  game.nomPanelId =
    (await postIn(guild, cfg.channels.gameLog, gathered ? nominationPanelPayload(game) : discussionPanelPayload(game)))
      ?.id ?? null;
  save();
}

/** Take both day panels down — nominating at night must not be one click away. */
async function clearDayPanels(guild) {
  const cfg = getGuild(guild.id);
  const game = cfg.game;
  if (!game) return;
  await deleteIn(guild, cfg.channels.grimoire, game.dayPanelId);
  await deleteIn(guild, cfg.channels.gameLog, game.nomPanelId);
  game.dayPanelId = null;
  game.nomPanelId = null;
  save();
}

module.exports = {
  postDayPanels,
  clearDayPanels,
  deleteIn,
  dayControlsPayload,
  nominationPanelPayload,
  discussionPanelPayload,
  playerSelect,
};
