const { PermissionFlagsBits } = require('discord.js');

/**
 * Every permission this bot needs, and the name Discord shows for it.
 *
 * One list, used three ways — the `/setup` precheck, the channel overwrites it
 * writes for the bot, and the invite link it hands back when something is
 * missing — so the three can never disagree about what "correctly invited"
 * means. They did disagree before: the invite link was missing **Pin Messages**
 * and **Attach Files** entirely, so a bot invited by that link could post the
 * script sheets but never pin them.
 *
 * `Pin Messages` is the subtle one. Pinning used to be a Manage Messages
 * action; Discord split it out into its own permission, and an older bot with
 * Manage Messages now gets a bare 50013 from the pin endpoint with nothing in
 * the error to say which permission it actually wanted.
 */
const REQUIRED = {
  ViewChannel: 'View Channels',
  ManageChannels: 'Manage Channels',
  ManageRoles: 'Manage Roles',
  SendMessages: 'Send Messages',
  SendMessagesInThreads: 'Send Messages in Threads',
  CreatePublicThreads: 'Create Public Threads',
  CreatePrivateThreads: 'Create Private Threads',
  ManageThreads: 'Manage Threads',
  ManageMessages: 'Manage Messages',
  // Its own permission since Discord split pinning out of Manage Messages.
  PinMessages: 'Pin Messages',
  EmbedLinks: 'Embed Links',
  // The script reference sheets are image and PDF uploads; without this the
  // whole message is refused, not just the files.
  AttachFiles: 'Attach Files',
  ReadMessageHistory: 'Read Message History',
  AddReactions: 'Add Reactions',
};

/** The same list as the number an OAuth invite link wants. */
const INVITE_BITS = Object.keys(REQUIRED)
  .reduce((bits, flag) => bits | PermissionFlagsBits[flag], 0n)
  .toString();

/** The re-invite link. Updates the bot's existing role rather than duplicating it. */
function inviteUrl(client) {
  return (
    `https://discord.com/oauth2/authorize?client_id=${client.user.id}` +
    `&scope=bot+applications.commands&permissions=${INVITE_BITS}`
  );
}

/** The permissions the bot is missing server-wide, by display name. */
function missingFor(member) {
  return Object.entries(REQUIRED)
    .filter(([flag]) => !member.permissions.has(PermissionFlagsBits[flag]))
    .map(([, label]) => label);
}

module.exports = { REQUIRED, INVITE_BITS, inviteUrl, missingFor };
