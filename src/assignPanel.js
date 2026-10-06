const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  EmbedBuilder,
} = require('discord.js');
const { getGuild, save } = require('./store');
const { mention, COLORS } = require('./game');
const { rolesById, rolesForScript, TEAM_LABEL, SETUP_TABLE } = require('./data/scripts');
const { postNightAlert } = require('./night');
const { setupWarning, stagedSetupMods, stagedCounts, targetCounts } = require('./setupMods');

const TEAM_ORDER = ['townsfolk', 'outsider', 'minion', 'demon', 'traveler'];
const TEAM_EMOJI = { townsfolk: '🔵', outsider: '🟦', minion: '🔴', demon: '👹', traveler: '🧳' };

/**
 * The Storyteller's click-through character assignment board, posted in
 * #grimoire alongside the wake checklist and modelled on it: one button per
 * player, green once that player has a character, plus a Random Deal button
 * that runs the same deal as `/st deal`.
 *
 * This carries hidden information (who is what), so like the wake checklist it
 * must only ever be posted in #grimoire.
 */
/**
 * One player's line on the panel. Four states, and the distinction that matters
 * most is staged-versus-sent: 🟡 is a character the Storyteller can still take
 * back, ✅ is one the player has already read.
 */
function playerLine(game, id, player, counts) {
  const role = player.character && rolesById.get(player.character);
  const told = player.delivered && rolesById.get(player.delivered);

  if (!role) {
    // Cleared after publishing: the player is still walking around believing
    // the character we sent them, and no button can unsend it.
    return told
      ? `⚠️ ${mention(game, id)} — *unassigned, but was told **${told.name}***`
      : `⬜ ${mention(game, id)} — *unassigned*`;
  }
  const dup = counts[player.character] > 1 ? ' ⚠️ *duplicate*' : '';
  const what = `**${role.name}** *(${TEAM_LABEL[role.team] ?? role.team})*`;
  if (player.delivered === player.character) return `✅ ${mention(game, id)} — ${what}${dup}`;
  return told
    ? `🟡 ${mention(game, id)} — ${what}${dup} *(not sent — was told **${told.name}**)*`
    : `🟡 ${mention(game, id)} — ${what}${dup} *(not sent)*`;
}

const TEAM_NAMES = ['Townsfolk', 'Outsider', 'Minion', 'Demon'];

/** "Townsfolk" is already plural; the rest take an -s. */
function plural(n, i) {
  return `${n} ${TEAM_NAMES[i]}${n !== 1 && TEAM_NAMES[i] !== 'Townsfolk' ? 's' : ''}`;
}

/** `5 Townsfolk · 1 Outsider · 1 Minion · 1 Demon`. */
function spellOut(counts) {
  return counts.map((n, i) => plural(n, i)).join(' · ');
}

/** How the staged spread differs from the target, in the Storyteller's words. */
function describeGap(actual, target) {
  const off = [];
  target.forEach((want, i) => {
    const have = actual[i];
    if (have === want) return;
    off.push(`${plural(Math.abs(have - want), i)} too ${have > want ? 'many' : 'few'}`);
  });
  return off.join(', ');
}

/**
 * The official setup for this many players, always on the panel.
 *
 * The counts were only ever shown two places, and neither is where the
 * Storyteller is looking while they deal: the launch announcement in the game
 * log, which has scrolled away by then, and the Baron warning, which only
 * appears when a setup-modifying character is already staged. So the one number
 * they need before every hand-built spread — 8 players, 5/1/1/1 — meant leaving
 * #grimoire to go find it. It lives here now, next to the buttons that change it.
 *
 * Returns null only when there are no players yet; every other case has
 * something worth saying, including the counts the table does not cover.
 */
function setupField(game) {
  const seated = Object.keys(game.players ?? {}).length;
  if (!seated) return null;

  // Deliberately not clamped: at 4 or 16 players the table genuinely does not
  // apply, and showing the 5- or 15-player row as though it did is worse than
  // saying so.
  const base = SETUP_TABLE[seated];
  if (!base) {
    return {
      name: `📊 Setup — ${seated} players`,
      value:
        `The official table covers **5–15 players**, so there is no published split for ${seated}. ` +
        'Build the spread by hand — 🎲 Random deal will refuse.',
    };
  }

  // `targetCounts` folds in a staged Baron, Drunk, Fang Gu and so on. It clamps
  // where this does not, but `base` is in range here, so the two agree.
  const counts = targetCounts(game);
  const target = counts?.target ?? base;
  const actual = stagedCounts(game);
  const staged = actual.reduce((n, x) => n + x, 0);

  const lines = [`\`${base.join('/')}\` — ${spellOut(base)}`];
  if (counts?.changed) {
    lines.push(
      `With what you have staged: \`${target.join('/')}\`` +
        (counts.ambiguous ? ' *(at least — some of it is your call)*' : '')
    );
  }

  if (!staged) {
    lines.push('Nothing staged yet.');
  } else {
    const gap = describeGap(actual, target);
    lines.push(
      `Staged: \`${actual.join('/')}\`` +
        (gap ? ` ⚠️ ${gap}` : counts?.ambiguous ? ' — matches, but check the calls above' : ' ✅')
    );
  }

  // Travelers sit outside the table entirely, so a spread that looks one short
  // may be exactly right.
  const travelers = Object.values(game.players).filter(
    (p) => p.character && rolesById.get(p.character)?.team === 'traveler'
  ).length;
  if (travelers) {
    lines.push(`-# ${travelers} traveler${travelers === 1 ? '' : 's'} staged — travelers are outside these counts.`);
  }

  return { name: `📊 Setup — ${seated} players`, value: lines.join('\n').slice(0, 1024) };
}

function assignPanelPayload(game) {
  const players = Object.entries(game.players);
  const assigned = players.filter(([, p]) => p.character);
  const pending = players.filter(([, p]) => p.character && p.delivered !== p.character);
  const ready = players.length > 0 && assigned.length === players.length;

  // Flag a character sitting on two players — usually a misclick, and easy to
  // miss in a 15-player list.
  const counts = {};
  for (const [, p] of assigned) counts[p.character] = (counts[p.character] ?? 0) + 1;

  const lines = players.length
    ? players.map(([id, p]) => playerLine(game, id, p, counts))
    : ['*Nobody is seated yet.*'];

  const mods = stagedSetupMods(game);

  let footer;
  if (!players.length) footer = 'Seat players first with /game start.';
  else if (!ready) footer = `${assigned.length}/${players.length} assigned · nothing has been sent yet — build the whole spread first.`;
  else if (pending.length)
    footer = mods.length
      ? `Ready: ${pending.length} to send · ⚠️ fix the setup counts below before you publish.`
      : `Ready: ${pending.length} to send · review the list, then hit 📨 Publish to tell everyone at once.`;
  else footer = `All ${players.length} players have been told. Changing anyone re-arms Publish for that seat only.`;

  const embed = new EmbedBuilder()
    .setTitle('🎭 Character assignment')
    .setColor(COLORS.vote)
    .setDescription(lines.join('\n').slice(0, 4000))
    .setFooter({ text: footer })
    .setTimestamp(new Date());

  // What the spread is supposed to look like, before anything is clicked.
  const setup = setupField(game);
  if (setup) embed.addFields(setup);

  // A Baron on the board means the counts the deal just used are wrong. Say so
  // on the panel itself, in front of the Publish button, for as long as it is
  // true — a one-off message in the deal reply scrolls away, and this is the
  // mistake that cannot be undone once the town has been told.
  // No counts line: the field above already carries it, and printing the same
  // three numbers twice in one embed reads as two different instructions.
  const warning = setupWarning(game, { heading: '', counts: false });
  if (warning) {
    // A Drunk needs handling but moves nothing, so it does not get the red
    // embed and the "changes the counts" heading — those are for the spreads
    // that are actually wrong, and spending them on a Drunk teaches the
    // Storyteller to skim past the Baron sitting underneath it.
    const shifted = targetCounts(game);
    const movesCounts = Boolean(shifted?.changed || shifted?.ambiguous);
    if (movesCounts) embed.setColor(COLORS.evil);
    embed.addFields({
      name: movesCounts ? '⚠️ Setup changes the counts' : '📌 Setup characters — handle by hand',
      value: warning.slice(0, 1024),
    });
  }

  // 5 rows of 5: the last row is reserved for the controls, so 20 player
  // buttons fit — well past the 15-player maximum. Anything beyond is still
  // listed above and assignable with `/assign`.
  const buttons = players.slice(0, 20).map(([id, p]) =>
    new ButtonBuilder()
      .setCustomId(`botc_assign_pick:${id}`)
      .setLabel(p.name.slice(0, 80))
      // Green means told, blue means staged: the panel is readable at a glance
      // without counting down the list.
      .setStyle(
        p.delivered && p.delivered === p.character
          ? ButtonStyle.Success
          : p.character
            ? ButtonStyle.Primary
            : ButtonStyle.Secondary
      )
  );

  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
  }
  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('botc_assign_deal')
        .setLabel('Random deal')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('🎲')
        .setDisabled(players.length === 0),
      // Taking one character back off the board without disturbing the rest —
      // the usual fix when the random deal put the Demon somewhere you did not
      // want it.
      new ButtonBuilder()
        .setCustomId('botc_assign_remove')
        .setLabel('Remove one')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('➖')
        .setDisabled(assigned.length === 0),
      new ButtonBuilder()
        .setCustomId('botc_assign_clear')
        .setLabel('Clear all')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('🧹')
        .setDisabled(assigned.length === 0),
      // The only door between the grimoire and the town. Shut until every seat
      // is filled, because a half-published town is one no review can fix.
      new ButtonBuilder()
        .setCustomId('botc_assign_publish')
        .setLabel(pending.length ? `Publish (${pending.length})` : 'Published')
        .setStyle(ButtonStyle.Success)
        .setEmoji('📨')
        .setDisabled(!ready || pending.length === 0)
    )
  );

  return { embeds: [embed], components: rows };
}

/** The picker behind ➖ Remove one: the players who currently hold a character. */
function removeCharacterRow(game) {
  const options = Object.entries(game.players)
    .filter(([, p]) => p.character)
    .slice(0, 25)
    .map(([id, p]) => {
      const role = rolesById.get(p.character);
      return {
        label: `${p.name} — ${role?.name ?? p.character}`.slice(0, 100),
        value: id,
        description: p.delivered === p.character ? 'already told — they will not be un-told' : 'not sent yet',
      };
    });
  if (!options.length) return null;
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('botc_assign_remove_select')
      .setPlaceholder('Whose character comes off?')
      .setMinValues(1)
      .setMaxValues(options.length)
      .addOptions(options)
  );
}

/** The character menus shown when a player button is pressed — one per team. */
function characterMenus(game, playerId) {
  const player = game.players[playerId];
  const pool = rolesForScript(game.script ?? 'tb');
  const taken = new Set(
    Object.entries(game.players)
      .filter(([id, p]) => id !== playerId && p.character)
      .map(([, p]) => p.character)
  );

  // Discord allows 25 options per menu and 5 menus per message; the largest
  // team on any official script is 13 townsfolk, so one menu per team fits.
  return TEAM_ORDER.flatMap((team) => {
    const roles = pool.filter((r) => r.team === team).slice(0, 25);
    if (!roles.length) return [];
    // Custom ids must be unique within a message, hence the team suffix.
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`botc_assign_set:${playerId}:${team}`)
      .setPlaceholder(`${TEAM_EMOJI[team] ?? ''} ${TEAM_LABEL[team] ?? team}`.slice(0, 150))
      .addOptions(
        roles.map((r) => {
          // Marking what is already taken keeps the Storyteller from
          // accidentally putting one character on two players.
          const description = ((taken.has(r.id) ? '⚠️ already in play — ' : '') + (r.ability ?? '')).slice(0, 100);
          return {
            label: r.name.slice(0, 100),
            value: r.id,
            ...(description ? { description } : {}),
            default: player?.character === r.id,
          };
        })
      );
    return [new ActionRowBuilder().addComponents(menu)];
  }).slice(0, 5);
}

/** Post a fresh panel in #grimoire, replacing the previous one if it is still there. */
async function postAssignPanel(guild) {
  const cfg = getGuild(guild.id);
  const game = cfg.game;
  if (!game || !cfg.channels.grimoire) return null;
  const channel = await guild.channels.fetch(cfg.channels.grimoire).catch(() => null);
  if (!channel) return null;

  if (game.assignPanelId) {
    const old = await channel.messages.fetch(game.assignPanelId).catch(() => null);
    await old?.delete().catch(() => null);
  }
  const msg = await channel.send(assignPanelPayload(game)).catch(() => null);
  game.assignPanelId = msg?.id ?? null;
  save();
  return msg;
}

/**
 * Once every seated player has been *told* their character, the Storyteller's
 * next two moves are always the same: check the night order, then wake the
 * town. Put them in #grimoire as buttons the moment the town is published.
 *
 * Published, not merely assigned: the night alert pings players in their own
 * threads, so firing it off a staged spread would wake a town that has not been
 * told who they are.
 *
 * Posted once per publish: the id is cleared again if characters are cleared,
 * so a re-deal brings it back rather than leaving a stale panel.
 */
async function syncNightControls(guild) {
  const cfg = getGuild(guild.id);
  const game = cfg.game;
  if (!game || !cfg.channels.grimoire) return;
  const players = Object.values(game.players);
  const complete = players.length > 0 && players.every((p) => p.character && p.delivered === p.character);

  if (complete === Boolean(game.nightControlsId)) return;
  const channel = await guild.channels.fetch(cfg.channels.grimoire).catch(() => null);
  if (!channel) return;

  if (!complete) {
    const old = await channel.messages.fetch(game.nightControlsId).catch(() => null);
    await old?.delete().catch(() => null);
    game.nightControlsId = null;
    save();
    return;
  }

  // Every other night, `setPhase` fires the alert and the wake list goes up on
  // its own. Night 1 is the exception: the game starts into night *before*
  // characters exist, so nothing ever posts the first night's list unless the
  // Storyteller thinks to press the button — leaving them working the most
  // complicated night of the game off the read-only order, with no checkboxes,
  // no token button and no way to call the day. Deal completes, list goes up.
  if (game.day === 1 && game.phase === 'night' && !game.nightAlert?.messageId) {
    await postNightAlert(guild);
  }

  const msg = await channel
    .send({
      embeds: [
        new EmbedBuilder()
          .setTitle('🌙 The town has been told')
          .setColor(COLORS.night)
          .setDescription(
            `All **${players.length}** players have their character and have read it privately. Ready for the night.`
          )
          .setFooter({ text: 'The wake list is posted below · Night alert re-pings every waking player’s thread.' }),
      ],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('botc_night_order')
            .setLabel('ST Night Order')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('📜'),
          new ButtonBuilder()
            .setCustomId('botc_night_alert')
            .setLabel('Night Alert')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('🌙')
        ),
      ],
    })
    .catch(() => null);
  game.nightControlsId = msg?.id ?? null;
  save();
}

/**
 * Re-render the panel in place. Every path that changes a character calls this,
 * so the board never lags behind `/assign` or `/st deal`.
 */
async function updateAssignPanel(guild) {
  const cfg = getGuild(guild.id);
  const game = cfg.game;
  // Any character change can complete (or un-complete) the town, and every
  // assignment path lands here — so this is where the night controls follow.
  await syncNightControls(guild);
  if (!game?.assignPanelId || !cfg.channels.grimoire) return null;
  const channel = await guild.channels.fetch(cfg.channels.grimoire).catch(() => null);
  const msg = channel && (await channel.messages.fetch(game.assignPanelId).catch(() => null));
  if (!msg) return null;
  await msg.edit(assignPanelPayload(game)).catch(() => null);
  return msg;
}

module.exports = {
  assignPanelPayload,
  characterMenus,
  removeCharacterRow,
  postAssignPanel,
  updateAssignPanel,
  syncNightControls,
};
