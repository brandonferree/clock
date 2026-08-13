const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { getGuild, save } = require('./store');

const COLORS = {
  info: 0x5865f2,
  day: 0xf9c440,
  night: 0x2c2f5e,
  death: 0xb01e2e,
  vote: 0x8b5cf6,
  good: 0x1f9d55,
  evil: 0xb01e2e,
};

/**
 * Post an embed to the guild's game-log channel. Fails soft if setup is missing.
 * `files` are Discord attachments; pass `image` as an `attachment://name` URL to
 * show one of them inside the embed.
 */
async function logAction(guild, { title, description, color = 'info', fields, files, image }) {
  const cfg = getGuild(guild.id);
  if (!cfg.channels.gameLog) return null;
  const channel = await guild.channels.fetch(cfg.channels.gameLog).catch(() => null);
  if (!channel) return null;
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(COLORS[color] ?? COLORS.info)
    .setTimestamp(new Date());
  if (description) embed.setDescription(description);
  if (fields?.length) embed.addFields(fields);
  if (image) embed.setImage(image);
  return channel.send({ embeds: [embed], ...(files?.length ? { files } : {}) }).catch(() => null);
}

function isStoryteller(member) {
  const cfg = getGuild(member.guild.id);
  return (
    member.permissions.has(PermissionFlagsBits.ManageGuild) ||
    (cfg.roleIds.storyteller && member.roles.cache.has(cfg.roleIds.storyteller))
  );
}

function getGame(guildId) {
  return getGuild(guildId).game;
}

function requireGame(guildId) {
  const game = getGame(guildId);
  if (!game) throw new UserError('No game is active. Start one with `/game new`.');
  return game;
}

function alivePlayers(game) {
  return Object.entries(game.players).filter(([, p]) => p.alive);
}

function playerMention(userId) {
  return `<@${userId}>`;
}

/** Render a player as a mention (real users) or bold name (simulated players). */
function mention(game, id) {
  const p = game?.players?.[id];
  if (p?.isBot) return `**🤖 ${p.name}**`;
  return `<@${id}>`;
}

/** Autocomplete choices for seated players matching the focused text. */
function seatedChoices(game, focused) {
  if (!game) return [];
  const q = (focused ?? '').toLowerCase();
  return Object.entries(game.players)
    .filter(([, p]) => p.name.toLowerCase().includes(q))
    .slice(0, 25)
    .map(([id, p]) => ({ name: `${p.alive ? '🙂' : '💀'} ${p.isBot ? '🤖 ' : ''}${p.name}`, value: id }));
}

/** Error whose message is safe to show the user (ephemeral). */
class UserError extends Error {}

module.exports = { logAction, isStoryteller, getGame, requireGame, alivePlayers, playerMention, mention, seatedChoices, UserError, COLORS, save };
