const { EmbedBuilder } = require('discord.js');
const { getGuild, save } = require('./store');
const { mention, COLORS } = require('./game');
const { rolesById, rolesForScript, editions, TEAM_LABEL, TEAM_ORDER } = require('./data/scripts');

const TEAM_EMOJI = {
  townsfolk: '🔵',
  outsider: '🟦',
  minion: '🔴',
  demon: '👹',
  traveler: '🟣',
  fabled: '⭐',
};

/** The at-a-glance town board: who is alive, who they are, current phase. */
function boardEmbed(game) {
  const script = editions.find((e) => e.id === game.script);
  const entries = Object.entries(game.players);
  const alive = entries.filter(([, p]) => p.alive).length;
  const needed = Math.ceil(alive / 2);

  const lines = entries.map(([id, p]) => {
    const role = p.character && rolesById.get(p.character);
    const who = mention(game, id);
    const what = role ? `${TEAM_EMOJI[role.team] ?? ''} **${role.name}**` : '*unassigned*';
    const rems = p.reminders?.length ? ` · 🔖 ${p.reminders.map((rem) => `\`${rem.text}\``).join(' ')}` : '';
    if (p.alive) return `🟢 ${who} — ${what}${rems}`;
    return `💀 ~~${who}~~ — ${what}${p.deadVoteUsed ? ' · *dead vote spent*' : ' · *dead vote available*'}${rems}`;
  });

  const phase =
    game.status === 'lobby'
      ? 'Lobby'
      : `${game.phase === 'night' ? '🌙 Night' : '☀️ Day'} ${game.day}`;

  return new EmbedBuilder()
    .setTitle('📖 Grimoire')
    .setColor(game.phase === 'night' ? COLORS.night : COLORS.day)
    .setDescription(lines.join('\n') || '*No players seated.*')
    .addFields(
      { name: 'Phase', value: phase, inline: true },
      { name: 'Alive', value: `${alive} / ${entries.length}`, inline: true },
      { name: 'Votes to execute', value: `${needed}`, inline: true }
    )
    .setFooter({ text: `${script?.name ?? game.script} · updates automatically` })
    .setTimestamp(new Date());
}

/** Post the board, or edit the existing one in place. Safe to call on every change. */
async function updateBoard(guild) {
  const cfg = getGuild(guild.id);
  const game = cfg.game;
  if (!game || !cfg.channels.grimoire) return null;
  const channel = await guild.channels.fetch(cfg.channels.grimoire).catch(() => null);
  if (!channel) return null;

  const embed = boardEmbed(game);
  if (cfg.channels.boardMessageId) {
    const existing = await channel.messages.fetch(cfg.channels.boardMessageId).catch(() => null);
    if (existing) {
      await existing.edit({ embeds: [embed] }).catch(() => null);
      return existing;
    }
  }
  const msg = await channel.send({ embeds: [embed] }).catch(() => null);
  if (msg) {
    await msg.pin().catch(() => null);
    cfg.channels.boardMessageId = msg.id;
    save();
  }
  return msg;
}

/** Post the full character reference for a script, one message per team. */
async function postScriptReference(guild, scriptId) {
  const cfg = getGuild(guild.id);
  if (!cfg.channels.grimoire) return;
  const channel = await guild.channels.fetch(cfg.channels.grimoire).catch(() => null);
  if (!channel) return;

  // Clear any reference from a previous game so the channel does not accumulate copies.
  for (const id of cfg.channels.scriptMessageIds ?? []) {
    const old = await channel.messages.fetch(id).catch(() => null);
    await old?.delete().catch(() => null);
  }
  cfg.channels.scriptMessageIds = [];

  const script = editions.find((e) => e.id === scriptId);
  const pool = rolesForScript(scriptId);
  const header = await channel
    .send({
      embeds: [
        new EmbedBuilder()
          .setTitle(`📜 ${script?.name ?? scriptId} — character reference`)
          .setColor(COLORS.info)
          .setDescription(
            `Every character on this script and what it does. ${pool.length} characters total.\n` +
              'The pinned Grimoire board above tracks who is who.'
          ),
      ],
    })
    .catch(() => null);
  if (header) cfg.channels.scriptMessageIds.push(header.id);

  for (const team of TEAM_ORDER) {
    const group = pool.filter((r) => r.team === team);
    if (!group.length) continue;
    // Embeds cap at 25 fields, so chunk large teams across messages.
    for (let i = 0; i < group.length; i += 25) {
      const chunk = group.slice(i, i + 25);
      const embed = new EmbedBuilder()
        .setTitle(`${TEAM_EMOJI[team] ?? ''} ${TEAM_LABEL[team] ?? team}${group.length > 25 ? ` (${i + 1}–${i + chunk.length})` : ''}`)
        .setColor(team === 'minion' || team === 'demon' ? COLORS.evil : COLORS.good)
        .addFields(chunk.map((r) => ({ name: r.name, value: r.ability.slice(0, 1024) })));
      const msg = await channel.send({ embeds: [embed] }).catch(() => null);
      if (msg) cfg.channels.scriptMessageIds.push(msg.id);
    }
  }
  save();
}

module.exports = { updateBoard, postScriptReference, boardEmbed };
