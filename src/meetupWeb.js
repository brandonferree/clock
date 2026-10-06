const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { ChannelType, PermissionFlagsBits } = require('discord.js');
const meetups = require('./meetups');

// The web editor is served by the bot itself. Nobody signs in: Discord hands
// each person a private link (from /meetup web or ⚙️ → Edit on web) carrying a
// signed token that says who they are, which server, and — for edits — which
// meetup. Tokens expire, so a link pasted somewhere public goes stale.
const PORT = Number(process.env.MEETUP_WEB_PORT) || 3000;
const HOST = process.env.MEETUP_WEB_HOST || '127.0.0.1';
const BASE_URL = (process.env.MEETUP_WEB_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const TOKEN_HOURS = 2;
const PAGE = path.join(__dirname, 'web', 'meetup.html');

function secret() {
  const data = meetups.load();
  if (!data.webSecret) {
    data.webSecret = crypto.randomBytes(32).toString('hex');
    meetups.save();
  }
  return data.webSecret;
}

function sign(body) {
  return crypto.createHmac('sha256', secret()).update(body).digest('base64url');
}

function makeToken({ guildId, userId, eventId = null }) {
  const body = Buffer.from(
    JSON.stringify({ g: guildId, u: userId, e: eventId, x: Date.now() + TOKEN_HOURS * 3600000 })
  ).toString('base64url');
  return `${body}.${sign(body)}`;
}

/** A link for one person to create (no eventId) or edit one meetup. */
function editorLink(who) {
  return `${BASE_URL}/meetup?t=${makeToken(who)}`;
}

function readToken(token) {
  const [body, mac] = String(token || '').split('.');
  if (!body || !mac) return null;
  const expected = Buffer.from(sign(body));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  try {
    const t = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return t.x > Date.now() ? t : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------- context ----

/** Text channels the bot can post embeds in and the person can see. */
async function postableChannels(guild, member) {
  const me = guild.members.me;
  return guild.channels.cache
    .filter(
      (c) =>
        (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement) &&
        c.permissionsFor(me)?.has(['ViewChannel', 'SendMessages', 'EmbedLinks']) &&
        c.permissionsFor(member)?.has('ViewChannel')
    )
    .sort((a, b) => (a.parent?.position ?? -1) - (b.parent?.position ?? -1) || a.position - b.position)
    .map((c) => ({ id: c.id, name: c.name, category: c.parent?.name ?? null }));
}

/** Who the token holder is, and whether they may still touch this meetup. */
async function resolve(client, token) {
  const t = readToken(token);
  if (!t) return { status: 401, error: 'This link has expired. Ask the bot for a fresh one with /meetup web.' };
  const guild = client.guilds.cache.get(t.g);
  if (!guild) return { status: 404, error: 'The bot is no longer in that server.' };
  const member = await guild.members.fetch(t.u).catch(() => null);
  if (!member) return { status: 403, error: 'You are no longer in that server.' };
  let ev = null;
  if (t.e) {
    ev = meetups.load().events[t.e];
    if (!ev) return { status: 404, error: 'That meetup no longer exists.' };
    const manager =
      member.id === ev.hostId ||
      member.permissions.has(PermissionFlagsBits.ManageEvents) ||
      member.permissions.has(PermissionFlagsBits.ManageGuild);
    if (!manager) return { status: 403, error: 'Only the host or a server event manager can edit this meetup.' };
  }
  return { t, guild, member, ev };
}

/**
 * Roles this person may have the bot hand out: ones below both the bot's and
 * their own top role, and only if they could manage roles themselves —
 * otherwise a host could RSVP their way into a role they were never given.
 */
function assignableRoles(guild, member) {
  const me = guild.members.me;
  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return { reason: 'The bot needs the Manage Roles permission to hand out roles.', roles: [] };
  }
  const owner = guild.ownerId === member.id;
  if (!owner && !member.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return { reason: 'Only people with Manage Roles can set this.', roles: [] };
  }
  const roles = guild.roles.cache
    .filter(
      (r) =>
        r.id !== guild.id &&
        !r.managed &&
        r.position < me.roles.highest.position &&
        (owner || r.position < member.roles.highest.position)
    )
    .sort((a, b) => b.position - a.position)
    .map((r) => ({ id: r.id, name: r.name, color: r.hexColor }));
  return { reason: roles.length ? null : 'No roles sit below the bot\'s own role, so it can\'t hand any out.', roles };
}

function canPingEveryone(member) {
  return member.permissions.has(PermissionFlagsBits.MentionEveryone);
}

/** Picker tokens ("everyone", "here", "role:ID", "user:ID") → message text. */
function mentionText(tokens, guild, member) {
  const out = [];
  for (const t of (Array.isArray(tokens) ? tokens : []).slice(0, 25).map(String)) {
    if ((t === 'everyone' || t === 'here') && canPingEveryone(member)) out.push(`@${t}`);
    else if (t.startsWith('role:')) {
      const r = guild.roles.cache.get(t.slice(5));
      if (r && r.id !== guild.id && (r.mentionable || canPingEveryone(member))) out.push(`<@&${r.id}>`);
    } else if (/^user:\d{5,25}$/.test(t)) out.push(`<@${t.slice(5)}>`);
  }
  return [...new Set(out)].join(' ') || null;
}

/** Message text → picker chips with readable labels. */
async function mentionChips(text, guild) {
  const chips = [];
  for (const m of String(text || '').matchAll(/@(everyone|here)|<@&(\d+)>|<@!?(\d+)>/g)) {
    if (m[1]) chips.push({ token: m[1], label: `@${m[1]}` });
    else if (m[2]) chips.push({ token: `role:${m[2]}`, label: `@${guild.roles.cache.get(m[2])?.name ?? 'deleted role'}` });
    else {
      const who = await guild.members.fetch(m[3]).catch(() => null);
      chips.push({ token: `user:${m[3]}`, label: `@${who?.displayName ?? 'unknown'}` });
    }
  }
  return chips;
}

async function contextFor(ctx) {
  const { guild, member, ev } = ctx;
  const roles = guild.roles.cache
    .filter((r) => r.id !== guild.id && !r.managed && (r.mentionable || canPingEveryone(member)))
    .sort((a, b) => b.position - a.position)
    .map((r) => ({ id: r.id, name: r.name, color: r.hexColor }));
  return {
    guild: { name: guild.name, icon: guild.iconURL({ size: 64 }) },
    user: { name: member.displayName },
    canEveryone: member.permissions.has(PermissionFlagsBits.MentionEveryone),
    timezone: meetups.TIMEZONE,
    maxImages: meetups.MAX_IMAGES,
    channels: await postableChannels(guild, member),
    roles,
    assign: assignableRoles(guild, member),
    defaultOptions: meetups.parseOptions(meetups.DEFAULT_OPTIONS),
    event: ev && {
      id: ev.id,
      title: ev.title,
      description: ev.description,
      location: ev.location,
      images: meetups.imagesOf(ev),
      color: ev.color === null || ev.color === undefined ? null : `#${ev.color.toString(16).padStart(6, '0')}`,
      start: ev.start,
      duration: ev.duration,
      channelId: ev.channelId,
      options: ev.options.map((o, i) => ({
        ...o,
        from: i,
        count: ev.rsvps[i].length + ev.waitlist[i].length,
        members: ev.rsvps[i].length,
        guests: meetups.guestsOf(ev, i),
      })),
      multi: ev.multi,
      hideAttendees: ev.hideAttendees,
      remind: ev.remindMinutes,
      mentions: { create: await mentionChips(ev.mention, guild), start: await mentionChips(ev.startMention, guild) },
      roleAssign: ev.roleAssign && {
        ...ev.roleAssign,
        roleName: guild.roles.cache.get(ev.roleAssign.roleId)?.name ?? 'deleted role',
      },
      cancelled: ev.cancelled,
      url: `https://discord.com/channels/${ev.guildId}/${ev.channelId}/${ev.messageId}`,
    },
  };
}

async function save(client, ctx, body) {
  const { guild, member, ev, t } = ctx;
  const channels = await postableChannels(guild, member);
  const channelId = body.channelId || ev?.channelId;
  if (!channels.some((c) => c.id === channelId)) return { error: 'Pick a channel I can post in.' };
  const channel = await guild.channels.fetch(channelId);

  let roleAssign = null;
  const ra = body.roleAssign;
  if (ra?.roleId) {
    const unchanged = ev?.roleAssign?.roleId === ra.roleId;
    if (!unchanged && !assignableRoles(guild, member).roles.some((r) => r.id === ra.roleId)) {
      return { error: "You can't have the bot hand out that role." };
    }
    roleAssign = { roleId: ra.roleId, when: ra.when, removeAtEnd: ra.removeAtEnd };
  }

  const input = {
    title: body.title,
    local: body.local,
    duration: Number(body.duration),
    description: body.description,
    location: body.location,
    images: Array.isArray(body.images) ? body.images : [],
    color: body.color,
    options: Array.isArray(body.options) ? body.options.slice(0, 25) : [],
    multi: body.multi,
    hideAttendees: body.hideAttendees,
    remind: Number(body.remind),
    mention: mentionText(body.mentions?.create, guild, member),
    startMention: mentionText(body.mentions?.start, guild, member),
    roleAssign,
    channel,
  };

  const result = ev
    ? await meetups.updateMeetup(client, ev, input)
    : await meetups.createMeetup({ guildId: guild.id, hostId: t.u, hostName: member.displayName }, input);
  if (result.error) return { error: result.error.replace(/\*\*/g, '').replace(/`/g, '"') };
  const saved = result.ev;
  return {
    ok: true,
    id: saved.id,
    editToken: ev ? undefined : makeToken({ guildId: guild.id, userId: t.u, eventId: saved.id }),
    url: `https://discord.com/channels/${saved.guildId}/${saved.channelId}/${saved.messageId}`,
  };
}

// -------------------------------------------------------------- server ----

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 200_000) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function startWebServer(client) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, BASE_URL);
      if (req.method === 'GET' && (url.pathname === '/meetup' || url.pathname === '/meetup/')) {
        return send(res, 200, fs.readFileSync(PAGE, 'utf8'), 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && url.pathname === '/api/meetup/members') {
        const ctx = await resolve(client, req.headers['x-meetup-token']);
        if (ctx.error) return send(res, ctx.status, { error: ctx.error });
        const query = (url.searchParams.get('q') || '').trim().slice(0, 32);
        if (!query) return send(res, 200, []);
        const found = await ctx.guild.members.search({ query, limit: 8 }).catch(() => null);
        return send(
          res,
          200,
          [...(found?.values() ?? [])].map((m) => ({ id: m.id, name: m.displayName, user: m.user.username }))
        );
      }
      if (url.pathname === '/api/meetup') {
        const token = req.headers['x-meetup-token'];
        const ctx = await resolve(client, token);
        if (ctx.error) return send(res, ctx.status, { error: ctx.error });
        if (req.method === 'GET') return send(res, 200, await contextFor(ctx));
        if (req.method === 'POST') {
          const body = JSON.parse(await readBody(req));
          const result = await save(client, ctx, body);
          return send(res, result.error ? 400 : 200, result);
        }
      }
      if (url.pathname === '/') {
        return send(res, 200, 'Clocktower meetup editor. Get a link with /meetup web in Discord.', 'text/plain; charset=utf-8');
      }
      return send(res, 404, { error: 'Not found' });
    } catch (err) {
      console.error('Meetup web error:', err);
      return send(res, 500, { error: 'Something went wrong on the bot side. Check the bot window for details.' });
    }
  });
  server.on('error', (err) => {
    console.error(`⚠️  Meetup web editor could not start on port ${PORT}: ${err.message}. Set MEETUP_WEB_PORT in .env to a free port.`);
  });
  server.listen(PORT, HOST, () => console.log(`🌐 Meetup web editor at ${BASE_URL}/meetup`));
}

module.exports = { startWebServer, editorLink, BASE_URL };
