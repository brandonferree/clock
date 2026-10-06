const { SlashCommandBuilder, ChannelType, MessageFlags } = require('discord.js');
const { DEFAULT_OPTIONS, createMeetup, upcoming, takenCount } = require('../meetups');
const { editorLink } = require('../meetupWeb');

const PRESETS = {
  standard: DEFAULT_OPTIONS,
  game: '🎲 Playing, 👀 Spectating, 🤔 Maybe, ❌ Can\'t make it',
  yesno: '👍 Yes, 👎 No',
  late: '✅ On time, 🕒 Running late, 🤔 Maybe, ❌ Not going',
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName('meetup')
    .setDescription('Schedule meetups people can RSVP to')
    .addSubcommand((s) =>
      s
        .setName('create')
        .setDescription('Post a new meetup with RSVP buttons')
        .addStringOption((o) => o.setName('title').setDescription('What is it?').setRequired(true).setMaxLength(200))
        .addStringOption((o) =>
          o.setName('when').setDescription('Pacific time, e.g. "friday 8pm", "oct 12 7:30pm", "2026-10-20 19:00"').setRequired(true)
        )
        .addStringOption((o) => o.setName('description').setDescription('Details, agenda, what to bring…').setMaxLength(3000))
        .addStringOption((o) => o.setName('location').setDescription('Where (an address, a voice channel, a link)'))
        .addStringOption((o) =>
          o.setName('image').setDescription('Image links (up to 4, space-separated) — right-click a picture → "Copy image address"')
        )
        .addStringOption((o) =>
          o
            .setName('preset')
            .setDescription('Ready-made RSVP buttons (ignored if you type your own options)')
            .addChoices(
              { name: 'Going / Maybe / Not going', value: 'standard' },
              { name: 'Playing / Spectating / Maybe / Can\'t', value: 'game' },
              { name: 'Yes / No', value: 'yesno' },
              { name: 'On time / Late / Maybe / Not going', value: 'late' }
            )
        )
        .addStringOption((o) =>
          o
            .setName('options')
            .setDescription('Your own RSVP buttons, comma-separated. "(N)" caps one: ✅ Playing (12), 👀 Watching, ❌ Out')
        )
        .addBooleanOption((o) => o.setName('multi').setDescription('Let people pick more than one option (default: one)'))
        .addStringOption((o) => o.setName('duration').setDescription('How long, e.g. "2h" or "1h 30m" (default 1h)'))
        .addIntegerOption((o) =>
          o
            .setName('remind')
            .setDescription('Minutes before start to ping everyone who signed up (default 60, 0 = off)')
            .setMinValue(0)
            .setMaxValue(10080)
        )
        .addMentionableOption((o) => o.setName('mention').setDescription('Role or person to ping when it is posted'))
        .addChannelOption((o) =>
          o
            .setName('channel')
            .setDescription('Where to post it (default: here)')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        )
        .addStringOption((o) => o.setName('color').setDescription('Embed colour as hex, e.g. #3498db'))
        .addBooleanOption((o) => o.setName('hide_attendees').setDescription('Show only counts, not names'))
    )
    .addSubcommand((s) => s.setName('web').setDescription('Get a private link to create a meetup in your browser, with a calendar picker'))
    .addSubcommand((s) => s.setName('list').setDescription('Show upcoming meetups in this server')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'create') {
      const o = interaction.options;
      const channel = o.getChannel('channel') ?? interaction.channel;
      const me = interaction.guild.members.me;
      if (!channel.permissionsFor(me)?.has(['ViewChannel', 'SendMessages', 'EmbedLinks'])) {
        return interaction.reply({ content: `I can't post embeds in ${channel}.`, flags: MessageFlags.Ephemeral });
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const mention = o.getMentionable('mention');
      const mentionText = mention
        ? mention.id === interaction.guild.id
          ? '@everyone'
          : mention.user || mention.username
            ? `<@${mention.id}>`
            : `<@&${mention.id}>`
        : null;
      const host = {
        guildId: interaction.guild.id,
        hostId: interaction.user.id,
        hostName: interaction.member?.displayName ?? interaction.user.username,
      };
      const { error, ev, message } = await createMeetup(host, {
        title: o.getString('title'),
        when: o.getString('when'),
        description: o.getString('description'),
        location: o.getString('location'),
        image: o.getString('image'),
        options: o.getString('options') ?? PRESETS[o.getString('preset') ?? 'standard'],
        multi: o.getBoolean('multi'),
        duration: o.getString('duration'),
        remind: o.getInteger('remind'),
        mention: mentionText,
        channel,
        color: o.getString('color'),
        hideAttendees: o.getBoolean('hide_attendees'),
      });
      if (error) return interaction.editReply(`⚠️ ${error}`);
      return interaction.editReply(
        `📅 Posted **${ev.title}** for <t:${Math.floor(ev.start / 1000)}:F> — ${message.url}\n` +
          `Use the ⚙️ button on the post to edit, cancel, export the list, or ping attendees.`
      );
    }

    if (sub === 'web') {
      const link = editorLink({ guildId: interaction.guild.id, userId: interaction.user.id });
      return interaction.reply({
        content: `🌐 **[Open the meetup editor](${link})**
This link is just for you and works for 2 hours. To edit an existing meetup, use ⚙️ → **Edit on web** on its post.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'list') {
      const events = upcoming(interaction.guild.id);
      if (!events.length) return interaction.reply({ content: 'No upcoming meetups.', flags: MessageFlags.Ephemeral });
      const lines = events.slice(0, 20).map((ev) => {
        const going = takenCount(ev, 0);
        const url = `https://discord.com/channels/${ev.guildId}/${ev.channelId}/${ev.messageId}`;
        return `• **[${ev.title}](${url})** — <t:${Math.floor(ev.start / 1000)}:F> (<t:${Math.floor(ev.start / 1000)}:R>) · ${going} ${ev.options[0].label.toLowerCase()}`;
      });
      return interaction.reply({ content: `📅 **Upcoming meetups**\n${lines.join('\n')}`, flags: MessageFlags.Ephemeral });
    }
  },
};
