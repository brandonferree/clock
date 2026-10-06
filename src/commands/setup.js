const {
  SlashCommandBuilder,
  ChannelType,
  PermissionFlagsBits,
  MessageFlags,
} = require('discord.js');
const { getGuild, save } = require('../store');
const { postNewGamePanel } = require('../lobbyPanel');
const { REQUIRED, inviteUrl, missingFor } = require('../permissions');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Create the Blood on the Clocktower channels and roles for this server')
    .addBooleanOption((o) =>
      o
        .setName('repair')
        .setDescription('Delete and recreate the game channels — fixes broken permissions, but erases their history')
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guild = interaction.guild;
    const cfg = getGuild(guild.id);
    const me = await guild.members.fetchMe();
    const everyone = guild.roles.everyone;

    // Fail early with an actionable list rather than a bare "Missing Access" from the API.
    // The list lives in ../permissions so the precheck, the overwrites below and
    // the invite link cannot drift apart.
    const missing = missingFor(me);

    if (missing.length) {
      return interaction.editReply(
        [
          "⚠️ **I'm missing server permissions and can't run setup.**",
          '',
          `Missing: ${missing.map((m) => `\`${m}\``).join(', ')}`,
          '',
          '**Fastest fix** — re-invite me with the right permissions (this updates my existing role, it will not duplicate me):',
          inviteUrl(interaction.client),
          '',
          '**Or fix it by hand:** Server Settings → Roles → my role, and enable the permissions above.',
          "Also drag my role **above** the Storyteller and Townsfolk roles, or I can't assign them to players.",
        ].join('\n')
      );
    }

    // Track progress so a failure names the exact step instead of a bare API error.
    let step = 'resolving roles';
    const at = (label) => {
      step = label;
    };

    try {
    // --- Roles ---
    // Never adopt the bot's own role: an integration role (`managed`) can't be given
    // to a member at all, and any role the bot wears outranks it, so it could not
    // write overwrites for it. This bot is named BOTC, so the collision is likely.
    const usable = (r) => r && !r.managed && !me.roles.cache.has(r.id);
    const ensureRole = async (key, name, color) => {
      const saved = cfg.roleIds[key] && (await guild.roles.fetch(cfg.roleIds[key]).catch(() => null));
      if (usable(saved)) return saved;
      return (
        guild.roles.cache.find((r) => r.name === name && usable(r)) ||
        (await guild.roles.create({ name, color, mentionable: true, reason: 'BOTC setup' }))
      );
    };

    const storyteller = await ensureRole('storyteller', 'Storyteller', 0x8b5cf6);
    const playerRole = await ensureRole('player', 'Townsfolk', 0xf9c440);
    // The umbrella "I play Clocktower" role — the gate that replaces @everyone on
    // the category, so the rest of the server never sees these channels at all.
    const botcRole = await ensureRole('botc', 'BOTC', 0xb91c1c);
    cfg.roleIds.storyteller = storyteller.id;
    cfg.roleIds.player = playerRole.id;
    cfg.roleIds.botc = botcRole.id;

    // A bot can only write overwrites for roles ranked below its own.
    const myTop = me.roles.highest.position;
    const blocked = [storyteller, playerRole, botcRole].filter((r) => r.position >= myTop);
    if (blocked.length) {
      return interaction.editReply(
        [
          '⚠️ **My role is ranked too low to manage these roles.**',
          '',
          `Ranked at or above me: ${blocked.map((r) => `**${r.name}**`).join(', ')}`,
          '',
          'Go to **Server Settings → Roles** and drag my role (**' +
            me.roles.highest.name +
            '**) above them, then run `/setup` again.',
        ].join('\n')
      );
    }

    // The bot must re-allow anything denied to @everyone below — channel overwrites
    // apply to bots as well, so a blanket deny would block it from creating threads.
    // Discord rejects an overwrite granting a permission the bot itself lacks, so
    // filter to what it actually holds; the precheck above guarantees the essentials.
    const botOverwrite = {
      id: me.id,
      allow: Object.keys(REQUIRED)
        // Not these two: they are server-level powers used to *build* the
        // category, and an overwrite granting them here would hand the bot
        // rights over a channel it only needs to talk in.
        .filter((flag) => flag !== 'ManageChannels' && flag !== 'ManageRoles')
        .map((flag) => PermissionFlagsBits[flag])
        .filter((flag) => me.permissions.has(flag)),
    };

    // Everything here is invite-only: @everyone loses View Channel, and each of the
    // three roles is granted it back on the channels it is meant to see.
    const hideFromEveryone = { id: everyone.id, deny: [PermissionFlagsBits.ViewChannel] };
    const canView = (role, extraAllow = []) => ({
      id: role.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, ...extraAllow],
    });

    // --- Category ---
    at('creating the category');
    const categoryOverwrites = [
      hideFromEveryone,
      canView(botcRole),
      canView(playerRole),
      canView(storyteller),
      botOverwrite,
    ];
    let category = cfg.channels.category && (await guild.channels.fetch(cfg.channels.category).catch(() => null));
    if (!category) {
      category = await guild.channels.create({
        name: '🕰️ Blood on the Clocktower',
        type: ChannelType.GuildCategory,
        permissionOverwrites: categoryOverwrites,
      });
      cfg.channels.category = category.id;
    } else {
      at('updating category permissions');
      await category.permissionOverwrites.set(categoryOverwrites);
    }

    // A previous bad run can leave a channel where the bot is denied a permission it
    // must grant itself — Discord then blocks the fix, so the only way out is to
    // recreate the channel with correct overwrites from the start.
    const repair = interaction.options.getBoolean('repair') ?? false;

    const ensureChannel = async (key, options) => {
      at(`configuring #${options.name}`);
      let ch = cfg.channels[key] && (await guild.channels.fetch(cfg.channels[key]).catch(() => null));
      if (ch && repair) {
        at(`deleting #${options.name} for repair`);
        await ch.delete('BOTC setup repair').catch(() => null);
        ch = null;
        cfg.channels[key] = null;
      }
      if (!ch) {
        at(`creating #${options.name}`);
        ch = await guild.channels.create({ ...options, parent: category.id });
        cfg.channels[key] = ch.id;
      } else {
        at(`updating permissions on #${options.name}`);
        await ch.permissionOverwrites.set(options.permissionOverwrites ?? []);
      }
      return ch;
    };

    // --- Town Square: open chat for everyone; also hosts each player's private
    // Storyteller thread, so the Grimoire channel can stay hidden from players. ---
    await ensureChannel('townSquare', {
      name: 'town-square',
      type: ChannelType.GuildText,
      topic:
        'Public discussion — the town square. All players and spectators may talk here. Your private Storyteller thread lives here too. Tonight’s script sheets are pinned.',
      permissionOverwrites: [
        {
          id: everyone.id,
          deny: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.SendMessagesInThreads,
            PermissionFlagsBits.CreatePublicThreads,
            PermissionFlagsBits.CreatePrivateThreads,
          ],
        },
        // Spectators: they can watch the town, but not talk in it — outside voices
        // must not steer the game.
        canView(botcRole),
        canView(playerRole, [PermissionFlagsBits.SendMessages, PermissionFlagsBits.SendMessagesInThreads]),
        canView(storyteller, [
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.SendMessagesInThreads,
          PermissionFlagsBits.ManageThreads,
          PermissionFlagsBits.CreatePrivateThreads,
        ]),
        botOverwrite,
      ],
    });

    // --- Game Log: read-only record of all game actions ---
    await ensureChannel('gameLog', {
      name: 'game-log',
      type: ChannelType.GuildText,
      topic: 'Official game record. Nominations, votes, deaths, and phase changes are logged here. No chatting.',
      permissionOverwrites: [
        {
          id: everyone.id,
          deny: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.SendMessagesInThreads,
            PermissionFlagsBits.CreatePublicThreads,
            PermissionFlagsBits.CreatePrivateThreads,
            PermissionFlagsBits.AddReactions,
          ],
        },
        canView(botcRole),
        canView(playerRole),
        canView(storyteller),
        botOverwrite,
      ],
    });

    // --- Grimoire: Storyteller-only. The pinned board and script reference show
    // hidden information, so players must not be able to view this channel at
    // all. Player threads live under #town-square instead. ---
    await ensureChannel('grimoire', {
      name: 'grimoire',
      type: ChannelType.GuildText,
      topic: 'Storyteller HQ — hidden from players. The live Grimoire board and full character reference live here.',
      permissionOverwrites: [
        {
          id: everyone.id,
          deny: [PermissionFlagsBits.ViewChannel],
        },
        canView(storyteller, [PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageThreads]),
        botOverwrite,
      ],
    });

    // --- Whispers: button-created private threads between players ---
    await ensureChannel('whispers', {
      name: 'whispers',
      type: ChannelType.GuildText,
      topic:
        'Private conversations. Use the buttons here to open a private room with another player. The Storyteller can see all rooms.',
      permissionOverwrites: [
        {
          id: everyone.id,
          deny: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.CreatePublicThreads,
            PermissionFlagsBits.CreatePrivateThreads,
          ],
          allow: [PermissionFlagsBits.SendMessagesInThreads],
        },
        canView(playerRole, [PermissionFlagsBits.SendMessagesInThreads]),
        canView(storyteller, [
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.SendMessagesInThreads,
          PermissionFlagsBits.ManageThreads,
        ]),
        botOverwrite,
      ],
    });

    // Recreated channels have new IDs, so any panel posted in the old ones is gone.
    let repostNote = '';
    // A repair replaces #town-square, and the pinned script sheets went with
    // the old channel. Pin them again so a game in progress does not lose its
    // reference halfway through.
    if (repair && cfg.game?.status === 'running') {
      at('re-pinning the script sheets');
      const { postScriptSheets, sheetStatus } = require('../scriptSheets');
      const sheets = await postScriptSheets(guild, cfg.game.script);
      repostNote = `\n\n${sheetStatus(sheets, cfg.channels.townSquare)}`;
    }
    if (repair && cfg.game?.status === 'lobby') {
      at('restoring the lobby panel');
      const { joinPanel } = require('./game');
      const townSquare = await guild.channels.fetch(cfg.channels.townSquare);
      const msg = await townSquare.send(joinPanel(cfg.game));
      cfg.game.joinMessageId = msg.id;
      repostNote = `\n\nYour lobby (${Object.keys(cfg.game.players).length} players) was preserved and reposted.`;
    }

    save();

    // The Storyteller's way in, so the last step of setup is a button in
    // #grimoire rather than a command they have to know the name of. Skipped
    // while a lobby is already open — `postLobbyPanel` owns that channel then,
    // and a 🎲 button beside it could only refuse.
    if (!cfg.game || cfg.game.status === 'ended') {
      at('posting the New game button');
      await postNewGamePanel(guild);
    }

    await interaction.editReply(
      [
        '✅ **Setup complete.** The category is hidden from everyone without one of the three roles.',
        `- <#${cfg.channels.townSquare}> — town chat (private Storyteller threads live here too) — <@&${playerRole.id}> and <@&${storyteller.id}> talk, <@&${botcRole.id}> watches`,
        `- <#${cfg.channels.gameLog}> — read-only game log — <@&${botcRole.id}>, <@&${playerRole.id}>, <@&${storyteller.id}>`,
        `- <#${cfg.channels.whispers}> — private rooms via buttons — <@&${playerRole.id}>, <@&${storyteller.id}>`,
        `- <#${cfg.channels.grimoire}> — <@&${storyteller.id}> only, hidden from players`,
        '',
        `Give <@&${botcRole.id}> to anyone interested in Clocktower, <@&${playerRole.id}> to the players, ` +
          `and <@&${storyteller.id}> to your Storyteller — then press 🎲 **New game** in ` +
          `<#${cfg.channels.grimoire}>.` + repostNote,
      ].join('\n')
    );
    } catch (err) {
      // Persist whatever succeeded so a retry resumes instead of duplicating channels.
      save();
      console.error(`Setup failed while ${step}:`, err);
      return interaction.editReply(
        [
          `⚠️ **Setup failed while ${step}.**`,
          '',
          `Discord said: \`${err.code ?? '?'} ${err.message ?? err}\``,
          '',
          err.code === 50001 || err.code === 50013
            ? 'That channel has an overwrite denying me a permission I need to grant, and Discord ' +
              "won't let me grant a permission I don't currently hold there — so I can't repair it in place.\n\n" +
              '**Fix:** run `/setup repair:true` to delete and recreate the game channels with correct ' +
              'permissions. (This erases those channels’ message history; roles and game state are kept.)'
            : 'Check the console output for the full error.',
        ].join('\n')
      );
    }
  },
};
