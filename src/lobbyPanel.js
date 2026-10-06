const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  EmbedBuilder,
} = require('discord.js');
const { getGuild, save } = require('./store');
const { mention, COLORS } = require('./game');
const { editions } = require('./data/scripts');
const { whisperRules, describeRules, LOG_MODES, BUDGET_RANGE, SIZE_RANGE } = require('./whisperRules');

const MIN_PLAYERS = 5;

/**
 * The Storyteller's side of the lobby, posted in #grimoire by `/game new`.
 *
 * The players' half — Join / Leave — lives on the join panel in #town-square.
 * This is the half only the Storyteller should see or press: seat someone who
 * hasn't clicked in yet, call the @BOTC role for more, and start the game.
 * #grimoire is hidden from players, so a Start button here cannot be pressed
 * by the town, and the handlers check the Storyteller role regardless.
 */
function lobbyPanelPayload(game) {
  const script = editions.find((e) => e.id === game.script);
  const players = Object.entries(game.players);
  const short = Math.max(0, MIN_PLAYERS - players.length);

  const embed = new EmbedBuilder()
    .setTitle('🎪 Lobby controls')
    .setColor(COLORS.info)
    .setDescription(
      [
        `**Script:** ${script?.name ?? game.script}`,
        players.length
          ? `**Seated (${players.length}):**\n${players.map(([id], i) => `\`${i + 1}.\` ${mention(game, id)}`).join('\n')}`
          : '*Nobody has taken a seat yet.*',
        '',
        short
          ? `Need **${short} more** before the game can start.`
          : '✅ Enough players — start whenever the town is ready.',
        '',
        describeRules(game),
      ].join('\n').slice(0, 4000)
    )
    .setFooter({ text: 'Storyteller only · whisper rules lock when the game starts · players join from #town-square' })
    .setTimestamp(new Date());

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('botc_lobby_add')
      .setLabel('Add players')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('➕'),
    new ButtonBuilder()
      .setCustomId('botc_lobby_remove')
      .setLabel('Remove players')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('➖')
      .setDisabled(players.length === 0),
    // The script decides which characters can be dealt and which reminder
    // tokens are offered all game — too consequential to be fixed by a flag the
    // Storyteller may not have known to pass to `/game new`. This changes it any
    // time before the game starts.
    new ButtonBuilder()
      .setCustomId('botc_script')
      .setLabel('Change script')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('📜'),
    new ButtonBuilder()
      .setCustomId('botc_lobby_ping')
      .setLabel('Call @BOTC')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('📣'),
    new ButtonBuilder()
      .setCustomId('botc_lobby_start')
      .setLabel('Start game')
      .setStyle(ButtonStyle.Success)
      .setEmoji('▶️')
      .setDisabled(players.length < MIN_PLAYERS)
  );

  // Second row: the rules, not the roster. These are frozen at start, so this
  // is the last place they can be changed — worth its own button rather than an
  // option on `/game new` that nobody remembers is there.
  const rules = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('botc_whisper_rules')
      .setLabel('Whisper rules')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('⚙️')
  );

  return { embeds: [embed], components: [row, rules] };
}

/**
 * The ⚙️ settings pickers: budget, room size, and how public the whispering is.
 * Three menus on one ephemeral message, each re-rendering the whole thing so the
 * Storyteller can see the ruleset take shape as they set it.
 */
function whisperRulesRows(game) {
  const r = whisperRules(game);
  const [minSize, maxSize] = SIZE_RANGE;
  const [minBudget, maxBudget] = BUDGET_RANGE;

  const budgetOptions = [
    { label: 'Off — unlimited, unmonitored', value: '0', default: !r.enabled },
    ...Array.from({ length: maxBudget - minBudget + 1 }, (_, i) => {
      const n = minBudget + i;
      return {
        label: `${n} whisper${n === 1 ? '' : 's'} per player per day`,
        value: String(n),
        default: r.enabled && r.budget === n,
      };
    }),
  ];

  const sizeOptions = Array.from({ length: maxSize - minSize + 1 }, (_, i) => {
    const n = minSize + i;
    return {
      label: n === 2 ? '2 — pairs only' : `${n} — up to ${n} people in a room`,
      value: String(n),
      default: r.size === n,
    };
  });

  const logOptions = Object.entries(LOG_MODES).map(([value, label]) => ({
    label: label.split(' — ')[0],
    description: label.split(' — ')[1]?.slice(0, 100),
    value,
    default: r.log === value,
  }));

  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('botc_wr_budget')
        .setPlaceholder('How many whispers per player per day?')
        .addOptions(budgetOptions)
    ),
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('botc_wr_size')
        .setPlaceholder('How many people fit in one room?')
        .setDisabled(!r.enabled)
        .addOptions(sizeOptions)
    ),
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('botc_wr_log')
        .setPlaceholder('How much does the town get to see?')
        .setDisabled(!r.enabled)
        .addOptions(logOptions)
    ),
  ];
}

/** The body of the ⚙️ settings message, shared by the button and each menu. */
function whisperRulesPayload(game) {
  const r = whisperRules(game);
  return {
    content: [
      '⚙️ **Whisper rules** — these lock when the game starts.',
      '',
      describeRules(game),
      '',
      r.enabled
        ? 'Players spend one whisper each when a room opens, and everyone invited must accept. ' +
          'The same people on a later day costs another. Whispers close when you call the town in.'
        : 'Whispers are unlimited and private, and nothing is recorded — the way the bot has always worked.',
    ].join('\n'),
    components: whisperRulesRows(game),
  };
}

/**
 * The unseat picker behind ➖ Remove players. A select of seated players rather
 * than a user picker: simulated players from `/test add-bots` are not Discord
 * users, and the Storyteller should be able to clear them out the same way.
 * Multi-select, so a stale lobby can be emptied in one press.
 */
function removeSelectRow(game) {
  const options = Object.entries(game.players)
    .slice(0, 25)
    .map(([id, p]) => ({
      label: p.name.slice(0, 100),
      value: id,
      description: p.isBot ? 'simulated player' : undefined,
    }));
  if (!options.length) return null;
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('botc_lobby_remove_select')
      .setPlaceholder('Pick players to unseat')
      .setMinValues(1)
      .setMaxValues(options.length)
      .addOptions(options)
  );
}

/**
 * The 🎲 button that opens the next lobby, posted in #grimoire when there is no
 * game to run — after `/setup`, and again after `/game end`.
 *
 * `/game new` deliberately takes no options, so this button is not a shortcut
 * past a configuration step: it is the same starting point, reached without
 * typing. Everything that used to be a slash-command option is a control on the
 * lobby panel this opens, where it can still be changed and where it is visible
 * rather than remembered.
 */
function newGamePanelPayload() {
  const embed = new EmbedBuilder()
    .setTitle('🎲 Ready when you are')
    .setColor(COLORS.info)
    .setDescription(
      [
        'No game is running. Press below to open a lobby — players join from #town-square.',
        '',
        'It opens on **Trouble Brewing** with whispers **unmonitored**; the script, the whisper ' +
          'rules and the roster are all yours to change on the panel that appears, right up until ' +
          'you start.',
      ].join('\n')
    )
    .setFooter({ text: 'Storyteller only · same as /game new' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('botc_new_game')
      .setLabel('New game')
      .setStyle(ButtonStyle.Success)
      .setEmoji('🎲')
  );
  return { embeds: [embed], components: [row] };
}

/**
 * Put the 🎲 button up in #grimoire, replacing any previous one.
 *
 * The id lives on `channels` rather than on the game: this panel exists in the
 * gap *between* games, when `cfg.game` is null and has nowhere to hold it.
 */
async function postNewGamePanel(guild) {
  const cfg = getGuild(guild.id);
  if (!cfg.channels.grimoire) return null;
  const channel = await guild.channels.fetch(cfg.channels.grimoire).catch(() => null);
  if (!channel) return null;

  await clearNewGamePanel(guild);
  const msg = await channel.send(newGamePanelPayload()).catch(() => null);
  cfg.channels.newGamePanelId = msg?.id ?? null;
  save();
  return msg;
}

/**
 * Take the 🎲 button down. Called when a lobby opens: a second press would hit
 * the "game already in progress" guard, and a button whose only answer is a
 * refusal is worse than no button.
 */
async function clearNewGamePanel(guild) {
  const cfg = getGuild(guild.id);
  if (!cfg.channels.newGamePanelId || !cfg.channels.grimoire) return;
  const channel = await guild.channels.fetch(cfg.channels.grimoire).catch(() => null);
  const old = channel && (await channel.messages.fetch(cfg.channels.newGamePanelId).catch(() => null));
  await old?.delete().catch(() => null);
  cfg.channels.newGamePanelId = null;
  save();
}

/** Post a fresh panel in #grimoire, replacing the previous one if it is still there. */
async function postLobbyPanel(guild) {
  const cfg = getGuild(guild.id);
  const game = cfg.game;
  if (!game || !cfg.channels.grimoire) return null;
  const channel = await guild.channels.fetch(cfg.channels.grimoire).catch(() => null);
  if (!channel) return null;

  if (game.lobbyPanelId) {
    const old = await channel.messages.fetch(game.lobbyPanelId).catch(() => null);
    await old?.delete().catch(() => null);
  }
  const msg = await channel.send(lobbyPanelPayload(game)).catch(() => null);
  game.lobbyPanelId = msg?.id ?? null;
  save();
  return msg;
}

/**
 * Re-render in place. Called from every path that changes the lobby roster, so
 * the seat list and the Start button track the join panel across the server.
 */
async function updateLobbyPanel(guild) {
  const cfg = getGuild(guild.id);
  const game = cfg.game;
  if (!game?.lobbyPanelId || game.status !== 'lobby' || !cfg.channels.grimoire) return null;
  const channel = await guild.channels.fetch(cfg.channels.grimoire).catch(() => null);
  const msg = channel && (await channel.messages.fetch(game.lobbyPanelId).catch(() => null));
  if (!msg) return null;
  await msg.edit(lobbyPanelPayload(game)).catch(() => null);
  return msg;
}

module.exports = {
  lobbyPanelPayload,
  removeSelectRow,
  postLobbyPanel,
  updateLobbyPanel,
  newGamePanelPayload,
  postNewGamePanel,
  clearNewGamePanel,
  whisperRulesPayload,
  MIN_PLAYERS,
};
