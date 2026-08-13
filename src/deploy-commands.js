require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { REST, Routes } = require('discord.js');

const commands = [];
const commandsPath = path.join(__dirname, 'commands');
for (const file of fs.readdirSync(commandsPath).filter((f) => f.endsWith('.js'))) {
  const command = require(path.join(commandsPath, file));
  if (command.data) commands.push(command.data.toJSON());
}

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;
if (!DISCORD_TOKEN || !CLIENT_ID || DISCORD_TOKEN.startsWith('your-') || CLIENT_ID.startsWith('your-')) {
  console.error(
    '⚠️  .env still has placeholder values. Edit .env and set:\n' +
      '   DISCORD_TOKEN = Bot token (Developer Portal → your app → Bot → Reset Token)\n' +
      '   CLIENT_ID     = Application ID (Developer Portal → your app → General Information)\n' +
      '   GUILD_ID      = your Discord server ID (optional but recommended — commands appear instantly)'
  );
  process.exit(1);
}

(async () => {
  const rest = new REST().setToken(DISCORD_TOKEN);
  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log(`Registered ${commands.length} commands to guild ${GUILD_ID}.`);
  } else {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log(`Registered ${commands.length} global commands (may take up to an hour to appear).`);
  }
})();
