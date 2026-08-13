const {
  SlashCommandBuilder,
  ChannelType,
  PermissionFlagsBits,
  MessageFlags,
} = require('discord.js');
const { getGuild, save } = require('../store');

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
    const REQUIRED = {
      ViewChannel: 'View Channels',
      ManageChannels: 'Manage Channels',
      ManageRoles: 'Manage Roles',
      SendMessages: 'Send Messages',
      SendMessagesInThreads: 'Send Messages in Threads',
      CreatePrivateThreads: 'Create Private Threads',
      ManageThreads: 'Manage Threads',
      EmbedLinks: 'Embed Links',
      ReadMessageHistory: 'Read Message History',
    };
    const missing = Object.entries(REQUIRED)
      .filter(([flag]) => !me.permissions.has(PermissionFlagsBits[flag]))
      .map(([, label]) => label);

    if (missing.length) {
      const inviteUrl =
        `https://discord.com/oauth2/authorize?client_id=${interaction.client.user.id}` +
        '&scope=bot+applications.commands&permissions=395405511696';
      return interaction.editReply(
        [
          "⚠️ **I'm missing server permissions and can't run setup.**",
          '',
          `Missing: ${missing.map((m) => `\`${m}\``).join(', ')}`,
          '',
          '**Fastest fix** — re-invite me with the right permissions (this updates my existing role, it will not duplicate me):',
          inviteUrl,
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
    let storyteller = cfg.roleIds.storyteller && (await guild.roles.fetch(cfg.roleIds.storyteller).catch(() => null));
    if (!storyteller) {
      storyteller =
        guild.roles.cache.find((r) => r.name === 'Storyteller') ||
        (await guild.roles.create({ name: 'Storyteller', color: 0x8b5cf6, mentionable: true, reason: 'BOTC setup' }));
    }
    let playerRole = cfg.roleIds.player && (await guild.roles.fetch(cfg.roleIds.player).catch(() => null));
    if (!playerRole) {
      playerRole =
        guild.roles.cache.find((r) => r.name === 'Townsfolk') ||
        (await guild.roles.create({ name: 'Townsfolk', color: 0xf9c440, mentionable: true, reason: 'BOTC setup' }));
    }
    cfg.roleIds.storyteller = storyteller.id;
    cfg.roleIds.player = playerRole.id;

    // A bot can only write overwrites for roles ranked below its own.
    const myTop = me.roles.highest.position;
    const blocked = [storyteller, playerRole].filter((r) => r.position >= myTop);
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

    // --- Category ---
    at('creating the category');
    let category = cfg.channels.category && (await guild.channels.fetch(cfg.channels.category).catch(() => null));
    if (!category) {
      category = await guild.channels.create({
        name: '🕰️ Blood on the Clocktower',
        type: ChannelType.GuildCategory,
      });
      cfg.channels.category = category.id;
    }

    // The bot must re-allow anything denied to @everyone below — channel overwrites
    // apply to bots as well, so a blanket deny would block it from creating threads.
    // Discord rejects an overwrite granting a permission the bot itself lacks, so
    // filter to what it actually holds; the precheck above guarantees the essentials.
    const botOverwrite = {
      id: me.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.SendMessagesInThreads,
        PermissionFlagsBits.CreatePrivateThreads,
        PermissionFlagsBits.CreatePublicThreads,
        PermissionFlagsBits.ManageThreads,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.ReadMessageHistory,
      ].filter((flag) => me.permissions.has(flag)),
    };

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
        'Public discussion — the town square. All players and spectators may talk here. Your private Storyteller thread lives here too.',
      permissionOverwrites: [
        {
          id: everyone.id,
          deny: [PermissionFlagsBits.CreatePublicThreads, PermissionFlagsBits.CreatePrivateThreads],
        },
        {
          id: storyteller.id,
          allow: [PermissionFlagsBits.ManageThreads, PermissionFlagsBits.CreatePrivateThreads],
        },
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
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.SendMessagesInThreads,
            PermissionFlagsBits.CreatePublicThreads,
            PermissionFlagsBits.CreatePrivateThreads,
            PermissionFlagsBits.AddReactions,
          ],
        },
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
        {
          id: storyteller.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ManageThreads,
          ],
        },
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
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.CreatePublicThreads,
            PermissionFlagsBits.CreatePrivateThreads,
          ],
          allow: [PermissionFlagsBits.SendMessagesInThreads],
        },
        { id: storyteller.id, allow: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageThreads] },
        botOverwrite,
      ],
    });

    // Recreated channels have new IDs, so any panel posted in the old ones is gone.
    let repostNote = '';
    if (repair && cfg.game?.status === 'lobby') {
      at('restoring the lobby panel');
      const { joinPanel } = require('./game');
      const townSquare = await guild.channels.fetch(cfg.channels.townSquare);
      const msg = await townSquare.send(joinPanel(cfg.game));
      cfg.game.joinMessageId = msg.id;
      repostNote = `\n\nYour lobby (${Object.keys(cfg.game.players).length} players) was preserved and reposted.`;
    }

    save();

    await interaction.editReply(
      [
        '✅ **Setup complete.**',
        `- <#${cfg.channels.townSquare}> — public town chat (private Storyteller threads live here too)`,
        `- <#${cfg.channels.gameLog}> — read-only game log`,
        `- <#${cfg.channels.grimoire}> — Storyteller-only channel, hidden from players`,
        `- <#${cfg.channels.whispers}> — private rooms via buttons`,
        `- Roles: <@&${storyteller.id}> and <@&${playerRole.id}>`,
        '',
        `Give the <@&${storyteller.id}> role to your Storyteller, then run \`/game new\`.` + repostNote,
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
