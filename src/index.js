require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, Collection, GatewayIntentBits, Events, MessageFlags } = require('discord.js');
const { handleButton, handleSelect } = require('./interactions');
const meetups = require('./meetups');
const { startWebServer } = require('./meetupWeb');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

client.commands = new Collection();
const commandsPath = path.join(__dirname, 'commands');
for (const file of fs.readdirSync(commandsPath).filter((f) => f.endsWith('.js'))) {
  const command = require(path.join(commandsPath, file));
  if (command.data) client.commands.set(command.data.name, command);
}

/** Turn raw Discord API errors into something a Storyteller can act on. */
function explain(err) {
  switch (err?.code) {
    case 50001:
      return "I don't have access to do that. Check that my role has **Manage Channels**, **Manage Roles**, and thread permissions in Server Settings → Roles.";
    case 50013:
      return 'I lack the permissions for that. My role may also need to sit **above** the Storyteller and Townsfolk roles in Server Settings → Roles.';
    case 160002:
      return 'I could not create a private thread here. Private threads require the parent channel to allow them.';
    case 30056:
      return 'This server has hit its maximum number of channels. Delete some before running setup.';
    default:
      return err?.message ?? 'Something went wrong.';
  }
}

client.once(Events.ClientReady, (c) => {
  console.log(`🕰️ Logged in as ${c.user.tag} — ready to tell some stories.`);
  meetups.startReminders(c);
  startWebServer(c);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const command = client.commands.get(interaction.commandName);
      if (command) await command.execute(interaction);
    } else if (interaction.isAutocomplete()) {
      const command = client.commands.get(interaction.commandName);
      if (command?.autocomplete) await command.autocomplete(interaction);
    } else if (interaction.isButton() && interaction.customId.startsWith('meetup_')) {
      await meetups.handleButton(interaction);
    } else if (interaction.isModalSubmit() && interaction.customId.startsWith('meetup_')) {
      await meetups.handleModal(interaction);
    } else if (interaction.isButton()) {
      await handleButton(interaction);
    } else if (interaction.isUserSelectMenu() || interaction.isStringSelectMenu()) {
      await handleSelect(interaction);
    }
  } catch (err) {
    console.error('Interaction error:', err);
    const payload = { content: `⚠️ ${explain(err)}`, flags: MessageFlags.Ephemeral };
    if (interaction.isRepliable()) {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(payload).catch(() => null);
      } else {
        await interaction.reply(payload).catch(() => null);
      }
    }
  }
});

if (!process.env.DISCORD_TOKEN || process.env.DISCORD_TOKEN.startsWith('your-')) {
  console.error('⚠️  DISCORD_TOKEN is not set. Edit .env and paste your bot token (Developer Portal → Bot → Reset Token).');
  process.exit(1);
}
client.login(process.env.DISCORD_TOKEN).catch((err) => {
  console.error(`⚠️  Login failed: ${err.message}. Check that DISCORD_TOKEN in .env is a valid bot token.`);
  process.exit(1);
});
