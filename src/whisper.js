const { ChannelType } = require('discord.js');
const { getGuild, save } = require('./store');

/**
 * Open (or reuse) a private thread in #whispers between two users.
 * Returns { thread, existed }.
 */
async function openWhisper(guild, userA, userB) {
  const cfg = getGuild(guild.id);
  if (!cfg.channels.whispers) throw new Error('Whispers channel not set up. Run /setup.');
  const whispers = await guild.channels.fetch(cfg.channels.whispers);

  const key = [userA.id, userB.id].sort().join(':');
  if (cfg.whisperThreads[key]) {
    const existing = await guild.channels.fetch(cfg.whisperThreads[key]).catch(() => null);
    if (existing && !existing.archived) return { thread: existing, existed: true };
    if (existing && existing.archived) {
      await existing.setArchived(false).catch(() => null);
      return { thread: existing, existed: true };
    }
  }

  const nameA = (await guild.members.fetch(userA.id).catch(() => null))?.displayName ?? userA.username;
  const nameB = (await guild.members.fetch(userB.id).catch(() => null))?.displayName ?? userB.username;
  const thread = await whispers.threads.create({
    name: `🤫-${nameA}-${nameB}`.slice(0, 100),
    type: ChannelType.PrivateThread,
    invitable: false,
    reason: 'BOTC private conversation',
  });
  await thread.members.add(userA.id).catch(() => null);
  await thread.members.add(userB.id).catch(() => null);
  await thread.send(
    `💬 Private room for <@${userA.id}> and <@${userB.id}>. ` +
      `Only you two (and the Storyteller) can see this. It will be archived when the game ends.`
  );
  cfg.whisperThreads[key] = thread.id;
  save();
  return { thread, existed: false };
}

module.exports = { openWhisper };
