const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} = require('discord.js');
const { rolesById, rolesForScript, TEAM_LABEL } = require('./data/scripts');

/**
 * The click-through reminder token panel, reachable from the 🔖 button on the
 * night wake list and from a night step that leaves a token behind.
 *
 * Character first, then the token, then who it lands on — the order the tokens
 * are actually handled at a table, where you pick the Poisoner's "Poisoned"
 * token up out of the bag and *then* decide whose seat it goes in front of. It
 * also keeps every menu under the 25-option cap on every script: Bad Moon
 * Rising carries 39 tokens, which is more than a Discord select menu holds at
 * all, and no Storyteller wants to scroll 39 rows mid-night to find "Poisoned".
 */

/**
 * Characters on this game's script that have any reminder token.
 *
 * In-play characters sort first because they are what a Storyteller reaches for
 * almost every time, but the rest stay listed rather than hidden — a token
 * sometimes has to go down for a character nobody was dealt (a Drunk's real
 * character, a bluff being tracked), and having to abandon the panel for that
 * would defeat it.
 */
function tokenCharacters(game) {
  const inPlay = new Set(
    Object.values(game.players)
      .map((p) => p.character)
      .filter(Boolean)
  );
  return rolesForScript(game.script ?? 'tb')
    .filter((r) => tokensFor(r).length)
    .map((r) => ({ role: r, inPlay: inPlay.has(r.id) }))
    .sort((a, b) => Number(b.inPlay) - Number(a.inPlay))
    .slice(0, 25);
}

/** Every token belonging to one character. */
function tokensFor(role) {
  return [...(role?.reminders ?? []), ...(role?.remindersGlobal ?? [])];
}

/** Every token on the board right now, as `{ playerId, index, role, text }`. */
function tokensInPlay(game) {
  return Object.entries(game.players).flatMap(([id, p]) =>
    (p.reminders ?? []).map((rem, index) => ({ playerId: id, player: p, index, ...rem }))
  );
}

/** The board's tokens, grouped under the character they belong to. */
function heldLines(game) {
  const held = tokensInPlay(game);
  if (!held.length) return '*No tokens are on the board.*';
  const byRole = new Map();
  for (const t of held) {
    if (!byRole.has(t.role)) byRole.set(t.role, []);
    byRole.get(t.role).push(t);
  }
  return [...byRole.entries()]
    .map(
      ([roleId, list]) =>
        `🔖 **${rolesById.get(roleId)?.name ?? roleId}** — ` +
        list.map((t) => `${t.text} → **${t.player.name}**${t.player.alive ? '' : ' 💀'}`).join(', ')
    )
    .join('\n');
}

/**
 * Step one: whose token is it?
 *
 * This is the panel's front door, and it is a character list rather than a
 * player list because a token belongs to a character — the Poisoner's token is
 * the Poisoner's wherever it ends up sitting.
 */
function tokenPanelPayload(game, roleId = null, tokenIndex = null) {
  const chars = tokenCharacters(game);
  const chosen = roleId ? rolesById.get(roleId) : null;
  const tokens = chosen ? tokensFor(chosen) : [];
  const token = tokenIndex !== null && tokenIndex !== undefined ? tokens[tokenIndex] : null;
  const rows = [];

  rows.push(
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('botc_rem_char')
        .setPlaceholder('1️⃣ Whose token is it?')
        .addOptions(
          chars.map(({ role, inPlay }) => ({
            label: `${inPlay ? '● ' : ''}${role.name}`.slice(0, 100),
            value: role.id,
            // The tokens go in the description, so the right character is
            // usually identifiable without drilling in at all.
            description: `${TEAM_LABEL[role.team] ?? role.team} · ${tokensFor(role).join(', ')}`.slice(0, 100),
            default: role.id === roleId,
          }))
        )
    )
  );

  if (chosen) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`botc_rem_tok:${chosen.id}`)
          .setPlaceholder(`2️⃣ Which ${chosen.name} token?`.slice(0, 150))
          .addOptions(
            tokens.slice(0, 25).map((text, i) => ({
              label: text.slice(0, 100),
              // The index, not the text: token names repeat across characters,
              // and the custom id has to survive a colon in one of them.
              value: String(i),
              default: i === tokenIndex,
            }))
          )
      )
    );
  }

  if (token) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`botc_rem_put:${chosen.id}:${tokenIndex}`)
          .setPlaceholder(`3️⃣ Put “${token}” in front of…`.slice(0, 150))
          .addOptions(
            Object.entries(game.players)
              .slice(0, 25)
              .map(([id, p]) => ({
                label: p.name.slice(0, 100),
                value: id,
                // Their character, because a token is placed against what
                // somebody *is*, not against a name you then have to look up.
                description: [rolesById.get(p.character)?.name, p.alive ? null : 'dead']
                  .filter(Boolean)
                  .join(' · ')
                  .slice(0, 100) || undefined,
              }))
          )
      )
    );
  }

  const held = tokensInPlay(game);
  if (held.length) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('botc_rem_del')
          .setPlaceholder('Take a token off the board')
          .addOptions(
            held.slice(0, 25).map((t) => ({
              label: `${rolesById.get(t.role)?.name ?? t.role}: ${t.text}`.slice(0, 100),
              description: `on ${t.player.name}`.slice(0, 100),
              // Player and index together: one player can legitimately carry two
              // tokens reading the same, and removing "one of them" has to mean
              // a specific one.
              value: `${t.playerId}|${t.index}`,
            }))
          )
      )
    );
  }

  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('botc_rem_back')
        .setLabel('Start over')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('↩️')
    )
  );

  return {
    content: ['🔖 **Reminder tokens**', heldLines(game), '-# ● marks a character that is in play. Changes show on the Grimoire board immediately.'].join('\n'),
    components: rows,
  };
}

module.exports = { tokenPanelPayload, tokenCharacters, tokensFor, tokensInPlay };
