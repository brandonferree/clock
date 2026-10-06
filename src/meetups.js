const fs = require('fs');
const path = require('path');
const chrono = require('chrono-node');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
  PermissionFlagsBits,
} = require('discord.js');

// Meetups live in their own file so they survive between games and never get
// tangled up with the game state in games.json.
const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'meetups.json');

let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    cache = {};
  }
  cache.events ??= {};
  cache.guilds ??= {};
  return cache;
}

function save() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(cache ?? {}, null, 2));
}

// Every meetup time is entered and read as Pacific time; Discord still shows
// each viewer the time in their own zone.
const TIMEZONE = 'America/Los_Angeles';
const DEFAULT_OPTIONS = '✅ Going, 🤔 Maybe, ❌ Not going';
const MAX_OPTIONS = 10;
const MAX_IMAGES = 4;
const MAX_GUESTS = 100; // per option
const COLOR = 0x8b1e2d;

// ---------------------------------------------------------------- time ----

/** Minutes east of UTC for an IANA zone at a given instant (DST-aware). */
function offsetMinutes(tz, date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value])
  );
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return Math.round((asUtc - date.getTime()) / 60000);
}

/**
 * "friday 8pm", "tomorrow 7:30pm", "oct 12 6pm", "2026-10-20 19:00", "in 3 hours".
 * Read as Pacific time; parsed twice so a date across a DST change
 * uses the offset in force on that day rather than today's.
 */
function parseWhen(text, tz = TIMEZONE) {
  const now = new Date();
  let date = chrono.parseDate(text, { instant: now, timezone: offsetMinutes(tz, now) }, { forwardDate: true });
  if (!date) return null;
  const actual = offsetMinutes(tz, date);
  if (actual !== offsetMinutes(tz, now)) {
    date = chrono.parseDate(text, { instant: now, timezone: actual }, { forwardDate: true }) ?? date;
  }
  return date;
}

/** "2h", "1h 30m", "90m", "90" (minutes). */
function parseDuration(text) {
  if (!text) return 60;
  const t = text.trim().toLowerCase();
  if (/^\d+$/.test(t)) return Number(t);
  const h = /(\d+(?:\.\d+)?)\s*h/.exec(t);
  const m = /(\d+)\s*m/.exec(t);
  if (!h && !m) return null;
  return Math.round((h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0));
}

// ------------------------------------------------------------- options ----

/**
 * "✅ Playing (15), 👀 Watching, ❌ Can't make it" → [{ emoji, label, limit }].
 * A leading emoji is optional; "(N)" caps the option and extras go to a waitlist.
 */
function parseOptions(text) {
  const out = [];
  for (const raw of (text || DEFAULT_OPTIONS).split(',')) {
    let s = raw.trim();
    if (!s) continue;
    let limit = null;
    const lim = /\((\d+)\)\s*$/.exec(s);
    if (lim) {
      limit = Number(lim[1]) || null;
      s = s.slice(0, lim.index).trim();
    }
    let emoji = null;
    const custom = /^<a?:\w+:\d+>/.exec(s);
    if (custom) {
      emoji = custom[0];
    } else {
      // Anything before the first space that has no letters or digits is an emoji.
      const first = s.split(/\s+/)[0];
      if (first && !/[\p{L}\p{N}]/u.test(first)) emoji = first;
    }
    const label = (emoji ? s.slice(emoji.length) : s).trim() || 'Option';
    out.push({ emoji, label: label.slice(0, 80), limit });
  }
  return out;
}

function optionLabel(opt) {
  return opt.emoji ? `${opt.emoji} ${opt.label}` : opt.label;
}

// --------------------------------------------------------------- image ----

/**
 * Discord only shows an embed image when the URL is a direct link to the
 * picture, so a page link ("copy link" instead of "copy image address") would
 * just leave a blank space. Ask the host what the URL really is.
 */
async function checkImageUrl(url) {
  if (!url) return { ok: true, url: null };
  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    return { ok: false, error: 'That image link is not a valid URL.' };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { ok: false, error: 'The image link must start with http:// or https://.' };
  }
  try {
    const res = await fetch(parsed, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(5000) });
    const type = res.headers.get('content-type') || '';
    res.body?.cancel?.().catch(() => null);
    if (res.ok && !type.startsWith('image/')) {
      return {
        ok: false,
        error:
          'That link opens a web page, not an image. Right-click the picture and choose **Copy image address** (or **Copy image link**), then use that.',
      };
    }
  } catch {
    // Host unreachable or slow — let Discord try; it may still render.
  }
  return { ok: true, url: parsed.toString() };
}

/** Image links come as an array (web form) or as text, one per line or space. */
function splitImageLinks(input) {
  const list = Array.isArray(input) ? input : String(input || '').split(/\s+/);
  return list.map((u) => String(u || '').trim()).filter(Boolean);
}

async function checkImageUrls(input) {
  const links = splitImageLinks(input);
  if (links.length > MAX_IMAGES) return { ok: false, error: `At most ${MAX_IMAGES} images, please.` };
  const results = await Promise.all(links.map(checkImageUrl));
  const bad = results.findIndex((r) => !r.ok);
  if (bad !== -1) {
    return { ok: false, error: links.length > 1 ? `Image ${bad + 1}: ${results[bad].error}` : results[bad].error };
  }
  return { ok: true, urls: results.map((r) => r.url) };
}

/** Meetups saved before multiple images kept a single `image`. */
function imagesOf(ev) {
  return ev.images ?? (ev.image ? [ev.image] : []);
}

// -------------------------------------------------------------- guests ----

/**
 * Guests are people tracked by name only (no Discord account here). They
 * take up spots like anyone else but are never pinged or given roles.
 */
function guestsOf(ev, i) {
  return ev.guests?.[i] ?? [];
}

/** Everyone holding a spot in an option: Discord members plus guests. */
function takenCount(ev, i) {
  return (ev.rsvps[i]?.length ?? 0) + guestsOf(ev, i).length;
}

/** "Ann, Bob\nCat" → ["Ann", "Bob", "Cat"]. */
function parseGuests(input) {
  const list = Array.isArray(input) ? input : String(input || '').split(/[\n,]/);
  return [...new Set(list.map((n) => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 60)).filter(Boolean))].slice(0, MAX_GUESTS);
}

// --------------------------------------------------------------- embed ----

function namesList(ids, max = 25, guests = []) {
  const all = [...ids.map((id) => `<@${id}>`), ...guests.map((g) => `${g} *(guest)*`)];
  if (!all.length) return '—';
  const shown = all.slice(0, max).join('\n');
  return all.length > max ? `${shown}\n*+${all.length - max} more*` : shown;
}

// Discord rejects a whole message whose link button URL is over 512 characters.
const MAX_BUTTON_URL = 512;

function googleCalendarUrl(ev) {
  const fmt = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const build = (title, details, location) =>
    `https://calendar.google.com/calendar/render?${new URLSearchParams({
      action: 'TEMPLATE',
      text: title,
      dates: `${fmt(ev.start)}/${fmt(ev.start + ev.duration * 60000)}`,
      details,
      location,
    })}`;
  // Shorten the description first, then the location and title, until it fits.
  let [title, details, location] = [ev.title, ev.description || '', ev.location || ''];
  const shorten = (s) => (s.length > 40 ? `${s.slice(0, Math.floor(s.length * 0.8))}…` : '');
  while (build(title, details, location).length > MAX_BUTTON_URL) {
    if (details) details = shorten(details);
    else if (location) location = shorten(location);
    else title = shorten(title) || title.slice(0, 20);
  }
  return build(title, details, location);
}

function meetupEmbeds(ev) {
  const unix = Math.floor(ev.start / 1000);
  const end = Math.floor((ev.start + ev.duration * 60000) / 1000);
  const lines = [`🗓️ <t:${unix}:F> – <t:${end}:t>`, `⏳ <t:${unix}:R>`];
  if (ev.location) lines.push(`📍 ${ev.location}`);
  if (ev.description) lines.push('', ev.description);

  const embed = new EmbedBuilder()
    .setColor(ev.cancelled ? 0x555555 : ev.color ?? COLOR)
    .setTitle(ev.cancelled ? `~~${ev.title}~~ — CANCELLED` : ev.title)
    .setDescription(lines.join('\n').slice(0, 4096))
    .setFooter({ text: `Hosted by ${ev.hostName} · times show in your own timezone` });
  const images = imagesOf(ev);
  if (images[0]) embed.setImage(images[0]);

  // One column per option, with its count (and cap) in the heading and the
  // waitlist underneath. Hidden attendees still show the counts.
  ev.options.forEach((opt, i) => {
    const ids = ev.rsvps[i] ?? [];
    const wait = ev.waitlist[i] ?? [];
    const count = takenCount(ev, i);
    let value;
    if (ev.hideAttendees) {
      value = '*names hidden*';
      if (wait.length) value += `\n⏳ Waitlist: ${wait.length}`;
    } else {
      value = namesList(ids, 25, guestsOf(ev, i));
      if (wait.length) value += `\n\n⏳ **Waitlist (${wait.length})**\n${namesList(wait, 10)}`;
    }
    embed.addFields({
      name: `${optionLabel(opt)} (${count}${opt.limit ? `/${opt.limit}` : ''})`.slice(0, 256),
      value: value.slice(0, 1024),
      inline: true,
    });
  });
  if (images.length < 2) return [embed];

  // Discord merges embeds that share a URL into one card with an image
  // gallery, so each extra picture rides on an otherwise empty embed. The
  // shared URL also makes the title an "add to calendar" link.
  const url = googleCalendarUrl(ev);
  embed.setURL(url);
  return [embed, ...images.slice(1).map((img) => new EmbedBuilder().setURL(url).setImage(img))];
}

function meetupComponents(ev) {
  const rows = [];
  if (!ev.cancelled) {
    let row = new ActionRowBuilder();
    ev.options.forEach((opt, i) => {
      if (row.components.length === 5) {
        rows.push(row);
        row = new ActionRowBuilder();
      }
      const b = new ButtonBuilder()
        .setCustomId(`meetup_rsvp:${ev.id}:${i}`)
        .setLabel(opt.label)
        .setStyle(i === 0 ? ButtonStyle.Success : ButtonStyle.Secondary);
      if (opt.emoji) b.setEmoji(opt.emoji);
      row.addComponents(b);
    });
    if (row.components.length) rows.push(row);
  }
  const tools = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`meetup_manage:${ev.id}`).setEmoji('⚙️').setStyle(ButtonStyle.Secondary)
  );
  if (!ev.cancelled) {
    tools.addComponents(
      new ButtonBuilder().setLabel('Add to Google Calendar').setStyle(ButtonStyle.Link).setURL(googleCalendarUrl(ev))
    );
  }
  rows.push(tools);
  return rows;
}

function meetupPayload(ev) {
  return { embeds: meetupEmbeds(ev), components: meetupComponents(ev) };
}

async function fetchMessage(client, ev) {
  const channel = await client.channels.fetch(ev.channelId).catch(() => null);
  if (!channel) return null;
  return channel.messages.fetch(ev.messageId).catch(() => null);
}

async function refresh(client, ev) {
  const msg = await fetchMessage(client, ev);
  if (msg) await msg.edit(meetupPayload(ev)).catch((err) => console.error('Meetup post update failed:', err.message));
}

// ------------------------------------------------------------ creating ----

/** "2026-10-18T15:00" read as a wall-clock time in an IANA zone → epoch ms. */
function zonedToUtc(local, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local || '');
  if (!m) return null;
  const guess = Date.UTC(m[1], m[2] - 1, m[3], m[4], m[5]);
  let ms = guess - offsetMinutes(tz, new Date(guess)) * 60000;
  // Second pass lands correctly when the guess straddles a DST change.
  ms = guess - offsetMinutes(tz, new Date(ms)) * 60000;
  return ms;
}

/**
 * Validate everything except the channel, shared by the slash command, the
 * edit modal and the web form. Times come either as text (`when`) or as a
 * calendar value (`local`), both read as Pacific time. Options come as text
 * or as rows.
 */
async function normalize(input) {
  let start;
  if (input.local) {
    start = zonedToUtc(input.local, TIMEZONE);
    if (!start) return { error: 'Pick a start date and time.' };
  } else {
    const parsed = parseWhen(input.when);
    if (!parsed) {
      return { error: `I couldn't read **${input.when}** as a time. Try \`friday 8pm\`, \`oct 12 7:30pm\` or \`2026-10-20 19:00\`.` };
    }
    start = parsed.getTime();
  }
  if (input.isNew && start < Date.now() - 60000) return { error: 'That time is in the past.' };

  const duration = typeof input.duration === 'number' ? input.duration : parseDuration(input.duration);
  if (!duration || duration < 1) return { error: `I couldn't read **${input.duration}** as a length. Try \`2h\` or \`1h 30m\`.` };

  const options = Array.isArray(input.options)
    ? input.options
        .map((o) => ({
          emoji: (o.emoji || '').trim() || null,
          label: String(o.label || '').trim().slice(0, 80),
          limit: Number(o.limit) > 0 ? Math.floor(Number(o.limit)) : null,
          from: Number.isInteger(o.from) ? o.from : null,
          guests: parseGuests(o.guests),
        }))
        .filter((o) => o.label)
    : parseOptions(input.options);
  if (!options.length) return { error: 'Give at least one RSVP option.' };
  if (options.length > MAX_OPTIONS) return { error: `At most ${MAX_OPTIONS} RSVP options, please.` };

  const images = await checkImageUrls(input.images ?? input.image);
  if (!images.ok) return { error: images.error };

  let color = null;
  if (input.color) {
    const hex = String(input.color).replace(/^#/, '');
    if (!/^[0-9a-f]{6}$/i.test(hex)) return { error: 'Colour must be a hex code like `#3498db`.' };
    color = parseInt(hex, 16);
  }
  const title = String(input.title || '').trim().slice(0, 200);
  if (!title) return { error: 'Give the meetup a title.' };

  return {
    fields: {
      title,
      description: input.description?.trim() || null,
      location: input.location?.trim() || null,
      images: images.urls,
      color,
      start,
      duration,
      multi: !!input.multi,
      hideAttendees: !!input.hideAttendees,
      remindMinutes: Number.isFinite(input.remind) ? input.remind : 60,
      mention: input.mention || null,
      startMention: input.startMention || null,
      roleAssign: input.roleAssign?.roleId
        ? { roleId: input.roleAssign.roleId, when: input.roleAssign.when === 'start' ? 'start' : 'rsvp', removeAtEnd: input.roleAssign.removeAtEnd !== false }
        : null,
    },
    options,
  };
}

async function postNew(channel, ev) {
  try {
    return {
      message: await channel.send({
        content: ev.mention ? `${ev.mention} — new meetup!` : undefined,
        ...meetupPayload(ev),
        allowedMentions: { parse: ['everyone', 'roles', 'users'] },
      }),
    };
  } catch (err) {
    if (err?.code === 50035) {
      console.error('Meetup post rejected:', JSON.stringify(err.rawError?.errors ?? err.message));
      if (/emoji/i.test(JSON.stringify(err.rawError?.errors ?? ''))) {
        return { error: 'Discord rejected one of the RSVP emojis. Use a standard emoji or one from this server.' };
      }
      return { error: `Discord rejected the post: ${err.message.split('\n').slice(1).join(' ') || err.message}` };
    }
    if (err?.code === 50013 || err?.code === 50001) return { error: `I can't post in #${channel.name}.` };
    throw err;
  }
}

/**
 * Validate, post and store a new meetup.
 * host = { guildId, hostId, hostName }. Returns { error } or { ev, message }.
 */
async function createMeetup(host, input) {
  const norm = await normalize({ ...input, isNew: true });
  if (norm.error) return norm;
  const options = norm.options.map(({ emoji, label, limit }) => ({ emoji, label, limit }));
  const guests = norm.options.map((o) => o.guests ?? []);
  const ev = {
    id: Date.now().toString(36),
    guildId: host.guildId,
    channelId: input.channel.id,
    messageId: null,
    hostId: host.hostId,
    hostName: host.hostName,
    ...norm.fields,
    options,
    rsvps: options.map(() => []),
    waitlist: options.map(() => []),
    guests,
    reminded: false,
    started: false,
    cancelled: false,
  };
  const { error, message } = await postNew(input.channel, ev);
  if (error) return { error };
  ev.messageId = message.id;
  load().events[ev.id] = ev;
  save();
  return { ev, message };
}

/**
 * Apply a full edit from the web form. Option rows carry `from` (their index
 * before the edit) so the people who picked them stay put when rows are
 * renamed, reordered or deleted. Changing the channel reposts the card.
 */
async function updateMeetup(client, ev, input) {
  const norm = await normalize(input);
  if (norm.error) return norm;
  const rsvps = [];
  const waitlist = [];
  const guests = [];
  const options = norm.options.map((o) => {
    const keep = o.from !== null && ev.options[o.from];
    rsvps.push(keep ? [...ev.rsvps[o.from]] : []);
    waitlist.push(keep ? [...ev.waitlist[o.from]] : []);
    guests.push(o.guests ?? []);
    return { emoji: o.emoji, label: o.label, limit: o.limit };
  });
  // Someone who picked an option that was removed simply drops off the list.
  // Over-full options keep everyone already in; only new sign-ups wait.
  const moved = norm.fields.start !== ev.start;
  const before = { ...ev };
  Object.assign(ev, norm.fields, { options, rsvps, waitlist, guests });
  delete ev.image;
  ev.mention = before.mention; // the creation ping is not resent on edit
  if (moved) {
    ev.reminded = false;
    ev.started = ev.start <= Date.now();
    ev.ended = false;
  }
  promote(ev, ev.options.map((_, i) => i));

  if (input.channel && input.channel.id !== ev.channelId) {
    const { error, message } = await postNew(input.channel, { ...ev, mention: null });
    if (error) {
      Object.assign(ev, before);
      return { error };
    }
    const old = await fetchMessage(client, before);
    await old?.delete().catch(() => null);
    ev.channelId = input.channel.id;
    ev.messageId = message.id;
  } else {
    await refresh(client, ev);
  }
  await syncRole(client, ev);
  save();
  return { ev };
}

// ---------------------------------------------------------- role grant ----

/**
 * Give the meetup's role to everyone signed up (except "not going"-type
 * answers), on sign-up or from the start, and take it back as they leave or
 * when it ends. `roleGrant` records who actually got it from us, so someone
 * who already had the role never loses it because of a meetup.
 */
async function syncRole(client, ev) {
  const ra = ev.roleAssign;
  const record = ev.roleGrant;
  if (!ra && !record?.users.length) return;
  const guild = client.guilds.cache.get(ev.guildId);
  if (!guild) return;
  const take = async (roleId, uid) => {
    const member = await guild.members.fetch(uid).catch(() => null);
    await member?.roles.remove(roleId, `Meetup: ${ev.title}`).catch((err) => console.error('Meetup role remove:', err.message));
  };

  // The role was changed or turned off: undo the old one first.
  if (record && record.roleId !== ra?.roleId) {
    for (const uid of record.users) await take(record.roleId, uid);
    ev.roleGrant = null;
  }
  if (!ra) return;
  ev.roleGrant ??= { roleId: ra.roleId, users: [] };
  const grant = ev.roleGrant;

  const ended = Date.now() >= ev.start + ev.duration * 60000;
  let target;
  if (ev.cancelled || (ended && ra.removeAtEnd)) target = [];
  else if (ended && ev.ended) return; // after the end, whoever has it keeps it
  else if (ra.when === 'start' && !ev.started) target = [];
  else target = attendeeIds(ev, true);

  const want = new Set(target);
  for (const uid of [...grant.users]) {
    if (want.has(uid)) continue;
    await take(grant.roleId, uid);
    grant.users = grant.users.filter((u) => u !== uid);
  }
  for (const uid of target) {
    if (grant.users.includes(uid)) continue;
    const member = await guild.members.fetch(uid).catch(() => null);
    if (!member || member.roles.cache.has(grant.roleId)) continue;
    const ok = await member.roles
      .add(grant.roleId, `Meetup: ${ev.title}`)
      .then(() => true)
      .catch((err) => console.error('Meetup role add:', err.message));
    if (ok) grant.users.push(uid);
  }
}

function syncRoleLater(client, ev) {
  syncRole(client, ev)
    .then(save)
    .catch((err) => console.error('Meetup role sync error:', err));
}

// ------------------------------------------------------------- RSVPing ----

function removeEverywhere(ev, userId) {
  const freed = [];
  ev.rsvps.forEach((ids, i) => {
    const at = ids.indexOf(userId);
    if (at !== -1) {
      ids.splice(at, 1);
      freed.push(i);
    }
  });
  ev.waitlist.forEach((ids) => {
    const at = ids.indexOf(userId);
    if (at !== -1) ids.splice(at, 1);
  });
  return freed;
}

/** Move the first waitlisted person up into each option that has room. */
function promote(ev, indexes) {
  const promoted = [];
  for (const i of indexes) {
    const opt = ev.options[i];
    while (ev.waitlist[i].length && (!opt.limit || takenCount(ev, i) < opt.limit)) {
      const next = ev.waitlist[i].shift();
      ev.rsvps[i].push(next);
      promoted.push({ userId: next, option: i });
    }
  }
  return promoted;
}

async function handleRsvp(interaction, ev, index) {
  const opt = ev.options[index];
  if (!opt) return interaction.reply({ content: 'That option no longer exists.', flags: MessageFlags.Ephemeral });
  const uid = interaction.user.id;
  const inIt = ev.rsvps[index].includes(uid);
  const waiting = ev.waitlist[index].includes(uid);
  let note;
  let freed = [];

  if (inIt || waiting) {
    // Clicking your current choice again takes you off it.
    ev.rsvps[index] = ev.rsvps[index].filter((x) => x !== uid);
    ev.waitlist[index] = ev.waitlist[index].filter((x) => x !== uid);
    if (inIt) freed.push(index);
    note = `Removed you from **${optionLabel(opt)}**.`;
  } else {
    if (!ev.multi) freed = removeEverywhere(ev, uid);
    if (opt.limit && takenCount(ev, index) >= opt.limit) {
      ev.waitlist[index].push(uid);
      note = `**${optionLabel(opt)}** is full — you're #${ev.waitlist[index].length} on the waitlist. I'll DM you if a spot opens.`;
    } else {
      ev.rsvps[index].push(uid);
      note = `You're down as **${optionLabel(opt)}**.`;
    }
  }

  const promoted = promote(ev, freed);
  save();
  await interaction.update(meetupPayload(ev));
  await interaction.followUp({ content: note, flags: MessageFlags.Ephemeral }).catch(() => null);
  syncRoleLater(interaction.client, ev);
  for (const p of promoted) {
    const user = await interaction.client.users.fetch(p.userId).catch(() => null);
    await user
      ?.send(`🎉 A spot opened up — you're now **${optionLabel(ev.options[p.option])}** for **${ev.title}** (<t:${Math.floor(ev.start / 1000)}:F>).`)
      .catch(() => null);
  }
}

// ------------------------------------------------------------ managing ----

function canManage(interaction, ev) {
  return (
    interaction.user.id === ev.hostId ||
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageEvents) ||
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
  );
}

function managePanel(ev, webLink) {
  return {
    content: `⚙️ Manage **${ev.title}**`,
    flags: MessageFlags.Ephemeral,
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel('Edit on web (all options)').setEmoji('🌐').setStyle(ButtonStyle.Link).setURL(webLink),
        new ButtonBuilder().setCustomId(`meetup_guests:${ev.id}`).setLabel('Guests').setEmoji('🧑‍🤝‍🧑').setStyle(ButtonStyle.Secondary)
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`meetup_edit:${ev.id}`).setLabel('Edit details').setEmoji('✏️').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`meetup_export:${ev.id}`).setLabel('Attendee list').setEmoji('📋').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`meetup_ping:${ev.id}`).setLabel('Ping attendees').setEmoji('📣').setStyle(ButtonStyle.Secondary),
        ev.cancelled
          ? new ButtonBuilder().setCustomId(`meetup_restore:${ev.id}`).setLabel('Un-cancel').setEmoji('↩️').setStyle(ButtonStyle.Success)
          : new ButtonBuilder().setCustomId(`meetup_cancel:${ev.id}`).setLabel('Cancel meetup').setEmoji('🚫').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`meetup_delete:${ev.id}`).setLabel('Delete post').setEmoji('🗑️').setStyle(ButtonStyle.Danger)
      ),
    ],
  };
}

function editModal(ev) {
  const local = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
    .format(new Date(ev.start))
    .replace(',', '');
  const field = (id, label, value, style = TextInputStyle.Short, required = false, max = 4000) =>
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId(id)
        .setLabel(label)
        .setStyle(style)
        .setRequired(required)
        .setMaxLength(max)
        .setValue(value ?? '')
    );
  return new ModalBuilder()
    .setCustomId(`meetup_editsubmit:${ev.id}`)
    .setTitle('Edit meetup')
    .addComponents(
      field('title', 'Title', ev.title, TextInputStyle.Short, true, 200),
      field('when', 'When (Pacific time)', local, TextInputStyle.Short, true, 100),
      field('location', 'Location', ev.location),
      field('image', `Image links, one per line (up to ${MAX_IMAGES})`, imagesOf(ev).join('\n'), TextInputStyle.Paragraph),
      field('description', 'Description', ev.description, TextInputStyle.Paragraph)
    );
}

/** One box per option (a modal holds five), each listing that option's guests. */
function guestsModal(ev) {
  return new ModalBuilder()
    .setCustomId(`meetup_guestsubmit:${ev.id}`)
    .setTitle('Guests (people not on Discord)')
    .addComponents(
      ev.options.slice(0, 5).map((opt, i) =>
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId(`g${i}`)
            .setLabel(`${opt.label} — one name per line`.slice(0, 45))
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false)
            .setMaxLength(4000)
            .setPlaceholder('Jane Smith')
            .setValue(guestsOf(ev, i).join('\n'))
        )
      )
    );
}

async function handleGuestsSubmit(interaction, ev) {
  ev.guests = ev.options.map((_, i) => {
    if (i >= 5) return guestsOf(ev, i);
    return parseGuests(interaction.fields.getTextInputValue(`g${i}`));
  });
  promote(ev, ev.options.map((_, i) => i));
  save();
  await refresh(interaction.client, ev);
  const total = ev.guests.reduce((n, g) => n + g.length, 0);
  return interaction.reply({ content: `🧑‍🤝‍🧑 Guest list saved — ${total} guest${total === 1 ? '' : 's'}.`, flags: MessageFlags.Ephemeral });
}

async function handleEditSubmit(interaction, ev) {
  const get = (k) => interaction.fields.getTextInputValue(k).trim();
  const start = parseWhen(get('when'));
  if (!start) return interaction.reply({ content: `I couldn't read **${get('when')}** as a time.`, flags: MessageFlags.Ephemeral });
  const images = await checkImageUrls(get('image'));
  if (!images.ok) return interaction.reply({ content: images.error, flags: MessageFlags.Ephemeral });

  const moved = start.getTime() !== ev.start;
  const startedBefore = ev.started;
  ev.title = get('title');
  ev.location = get('location') || null;
  ev.description = get('description') || null;
  ev.images = images.urls;
  delete ev.image;
  ev.start = start.getTime();
  if (moved) {
    ev.reminded = false;
    ev.started = ev.start <= Date.now();
    ev.ended = false;
  }
  save();
  await refresh(interaction.client, ev);
  if (ev.started !== startedBefore) syncRoleLater(interaction.client, ev);
  return interaction.reply({ content: '✏️ Meetup updated.', flags: MessageFlags.Ephemeral });
}

function attendeeIds(ev, includeMaybeish = false) {
  // The first option is "going"; with includeMaybeish, everyone who answered
  // anything except an option that reads like a no.
  if (!includeMaybeish) return [...ev.rsvps[0]];
  const no = /\b(no|not|can'?t|cannot|decline|skip|out)\b/i;
  return [...new Set(ev.rsvps.flatMap((ids, i) => (no.test(ev.options[i].label) ? [] : ids)))];
}

async function handleButton(interaction) {
  const [action, id, extra] = interaction.customId.split(':');
  const ev = load().events[id];
  if (!ev) return interaction.reply({ content: 'That meetup no longer exists.', flags: MessageFlags.Ephemeral });

  if (action === 'meetup_rsvp') {
    if (ev.cancelled) return interaction.reply({ content: 'This meetup was cancelled.', flags: MessageFlags.Ephemeral });
    return handleRsvp(interaction, ev, Number(extra));
  }

  if (!canManage(interaction, ev)) {
    return interaction.reply({ content: 'Only the host or a server event manager can manage this meetup.', flags: MessageFlags.Ephemeral });
  }

  switch (action) {
    case 'meetup_manage': {
      // Required lazily: meetupWeb requires this module.
      const { editorLink } = require('./meetupWeb');
      const link = editorLink({ guildId: ev.guildId, userId: interaction.user.id, eventId: ev.id });
      return interaction.reply(managePanel(ev, link));
    }
    case 'meetup_edit':
      return interaction.showModal(editModal(ev));
    case 'meetup_guests':
      return interaction.showModal(guestsModal(ev));
    case 'meetup_export': {
      const guild = interaction.guild;
      const sections = await Promise.all(
        ev.options.map(async (opt, i) => {
          const names = await Promise.all(
            ev.rsvps[i].map(async (uid) => (await guild.members.fetch(uid).catch(() => null))?.displayName ?? uid)
          );
          names.push(...guestsOf(ev, i).map((g) => `${g} (guest)`));
          const wait = ev.waitlist[i].length ? ` (+${ev.waitlist[i].length} waitlisted)` : '';
          return `${optionLabel(opt)} — ${names.length}${wait}\n${names.map((n) => `  • ${n}`).join('\n') || '  (nobody)'}`;
        })
      );
      const text = `${ev.title}\n${new Date(ev.start).toISOString()}\n\n${sections.join('\n\n')}`;
      return interaction.update({
        content: `📋 Attendee list for **${ev.title}**`,
        components: [],
        files: [{ attachment: Buffer.from(text, 'utf8'), name: `meetup-${ev.id}.txt` }],
      });
    }
    case 'meetup_ping': {
      const ids = attendeeIds(ev, true);
      if (!ids.length) return interaction.update({ content: 'Nobody has signed up yet.', components: [] });
      const channel = await interaction.client.channels.fetch(ev.channelId);
      await channel.send({
        content: `📣 **${ev.title}** — ${ids.map((u) => `<@${u}>`).join(' ')}`,
        reply: { messageReference: ev.messageId, failIfNotExists: false },
      });
      return interaction.update({ content: `📣 Pinged ${ids.length} people.`, components: [] });
    }
    case 'meetup_cancel':
    case 'meetup_restore':
      ev.cancelled = action === 'meetup_cancel';
      save();
      await refresh(interaction.client, ev);
      syncRoleLater(interaction.client, ev);
      if (ev.cancelled) {
        const ids = attendeeIds(ev, true);
        const channel = await interaction.client.channels.fetch(ev.channelId).catch(() => null);
        if (ids.length && channel) {
          await channel
            .send({
              content: `🚫 **${ev.title}** has been cancelled. ${ids.map((u) => `<@${u}>`).join(' ')}`,
              reply: { messageReference: ev.messageId, failIfNotExists: false },
            })
            .catch(() => null);
        }
      }
      return interaction.update({ content: ev.cancelled ? '🚫 Meetup cancelled.' : '↩️ Meetup restored.', components: [] });
    case 'meetup_delete': {
      if (extra !== 'yes') {
        return interaction.update({
          content: `Delete the **${ev.title}** post and all its RSVPs? This can't be undone.`,
          components: [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId(`meetup_delete:${ev.id}:yes`).setLabel('Yes, delete it').setStyle(ButtonStyle.Danger)
            ),
          ],
        });
      }
      const msg = await fetchMessage(interaction.client, ev);
      await msg?.delete().catch(() => null);
      ev.roleAssign = null;
      await syncRole(interaction.client, ev).catch(() => null);
      delete load().events[ev.id];
      save();
      return interaction.update({ content: '🗑️ Meetup deleted.', components: [] });
    }
    default:
      return interaction.reply({ content: 'Unknown meetup action.', flags: MessageFlags.Ephemeral });
  }
}

async function handleModal(interaction) {
  const [action, id] = interaction.customId.split(':');
  const ev = load().events[id];
  if (!ev) return interaction.reply({ content: 'That meetup no longer exists.', flags: MessageFlags.Ephemeral });
  if (!canManage(interaction, ev)) return interaction.reply({ content: 'You cannot edit this meetup.', flags: MessageFlags.Ephemeral });
  if (action === 'meetup_editsubmit') return handleEditSubmit(interaction, ev);
  if (action === 'meetup_guestsubmit') return handleGuestsSubmit(interaction, ev);
}

// ----------------------------------------------------------- reminders ----

async function tick(client) {
  const data = load();
  const now = Date.now();
  let dirty = false;
  for (const ev of Object.values(data.events)) {
    if (ev.cancelled) continue;
    const ids = attendeeIds(ev, true);
    const tag = ids.map((u) => `<@${u}>`).join(' ');
    const reply = { messageReference: ev.messageId, failIfNotExists: false };

    if (!ev.reminded && ev.remindMinutes > 0 && now >= ev.start - ev.remindMinutes * 60000 && now < ev.start) {
      ev.reminded = true;
      dirty = true;
      const channel = await client.channels.fetch(ev.channelId).catch(() => null);
      await channel
        ?.send({ content: `⏰ **${ev.title}** starts <t:${Math.floor(ev.start / 1000)}:R>! ${tag}`, reply })
        .catch(() => null);
    }
    if (!ev.started && now >= ev.start) {
      ev.started = true;
      ev.reminded = true;
      dirty = true;
      // Only announce if we're not hours late (e.g. the bot was offline).
      if (now - ev.start < 15 * 60000) {
        const channel = await client.channels.fetch(ev.channelId).catch(() => null);
        const extra = ev.startMention ? ` ${ev.startMention}` : '';
        await channel
          ?.send({
            content: `🔔 **${ev.title}** is starting now! ${tag}${extra}`,
            reply,
            allowedMentions: { parse: ['everyone', 'roles', 'users'] },
          })
          .catch(() => null);
      }
      await syncRole(client, ev).catch((err) => console.error('Meetup role sync error:', err));
    }
    if (!ev.ended && now >= ev.start + ev.duration * 60000) {
      await syncRole(client, ev).catch((err) => console.error('Meetup role sync error:', err));
      ev.ended = true;
      dirty = true;
    }
    // Forget meetups a week after they end; the post itself stays in the channel.
    if (now > ev.start + ev.duration * 60000 + 7 * 86400000) {
      delete data.events[ev.id];
      dirty = true;
    }
  }
  if (dirty) save();
}

function startReminders(client) {
  const run = () => tick(client).catch((err) => console.error('Meetup reminder error:', err));
  run();
  setInterval(run, 30 * 1000);
}

function upcoming(guildId) {
  return Object.values(load().events)
    .filter((e) => e.guildId === guildId && !e.cancelled && e.start + e.duration * 60000 > Date.now())
    .sort((a, b) => a.start - b.start);
}

module.exports = {
  DEFAULT_OPTIONS,
  load,
  save,
  createMeetup,
  updateMeetup,
  canManage,
  handleButton,
  handleModal,
  startReminders,
  upcoming,
  TIMEZONE,
  MAX_IMAGES,
  imagesOf,
  guestsOf,
  takenCount,
  parseOptions,
  parseWhen,
};
