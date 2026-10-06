const fs = require('fs');
const path = require('path');
const { AttachmentBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { getGuild, save } = require('./store');
const { inviteUrl } = require('./permissions');
const { editions } = require('./data/scripts');
const { COLORS } = require('./game');

/**
 * Official reference sheets, shipped with the bot and keyed by script id.
 *
 * These are the Pandemonium Institute reference sheets typeset by Ben Finney —
 * the same two pages of character abilities and night order a table would have
 * printed out and passed around.
 *
 * The PDFs in `assets/scripts/` are the source; what a game posts is the page
 * images `npm run sheets` renders from them, and only those. Discord will not
 * preview a PDF inline — it offers a download, and a file nobody opens mid-game
 * is the same as no reference at all — while a PNG is displayed in the channel
 * and zooms on a tap. Posting both put two dead download cards in the town
 * square under the pages that already said everything they said.
 *
 * A script with no rendered pages simply gets none, and the Storyteller is told
 * to run `npm run sheets` rather than left with a channel that quietly has no
 * reference in it.
 */
const SHEET_DIR = path.join(__dirname, '..', 'assets', 'scripts');

/** Permission names as Discord shows them, for the one message that names them. */
const LABELS = {
  PinMessages: 'Pin Messages',
  ManageMessages: 'Manage Messages',
  ReadMessageHistory: 'Read Message History',
  ViewChannel: 'View Channels',
};

const SHEET_KINDS = [
  { suffix: 'character-reference', label: 'Character reference', emoji: '📜' },
  { suffix: 'night-sheet', label: 'Night order', emoji: '🌙' },
];

/**
 * How many bytes one message may carry, less 10% of slack for the multipart
 * envelope. Read from the guild, because the real limit is its boost tier and a
 * hardcoded floor either wastes a boosted server's headroom or overshoots an
 * unboosted one — and overshooting means no reference sheets at all.
 */
function uploadBudget(guild) {
  const MiB = 1024 * 1024;
  // Discord's per-message limit by boost level. Levels 0 and 1 share the same
  // 10 MiB; only levels 2 and 3 raise it.
  const byTier = { 2: 50 * MiB, 3: 100 * MiB };
  const limit = byTier[guild.premiumTier] ?? 10 * MiB;
  return Math.floor(limit * 0.9);
}

/** The page images rendered from one PDF, in page order. */
function pagesOf(file) {
  const single = file.replace(/\.pdf$/i, '.png');
  if (fs.existsSync(single)) return [single];
  const pages = [];
  for (let n = 1; ; n++) {
    const page = file.replace(/\.pdf$/i, `.p${n}.png`);
    if (!fs.existsSync(page)) return pages;
    pages.push(page);
  }
}

/** The sheets that have rendered pages for a script, in the order shown. */
function sheetsFor(scriptId) {
  if (!scriptId) return [];
  const script = editions.find((e) => e.id === scriptId);
  const slug = (script?.name ?? scriptId).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return SHEET_KINDS.map((kind) => {
    // The PDF is only ever the thing the pages were rendered *from*; a sheet
    // with no pages has nothing to post, whether or not its source is on disk.
    const pages = pagesOf(path.join(SHEET_DIR, `${scriptId}.${kind.suffix}.pdf`));
    if (!pages.length) return null;
    // Named after the script rather than its id, so a player who saves pages
    // from three different games can still tell them apart afterwards.
    return {
      ...kind,
      pages: pages.map((page, i) => ({
        file: page,
        name: `${slug}.${kind.suffix}${pages.length > 1 ? `.page-${i + 1}` : ''}.png`,
      })),
    };
  }).filter(Boolean);
}

/** Whether we ship any sheet for this script. */
function hasSheets(scriptId) {
  return sheetsFor(scriptId).length > 0;
}

function bytesOf(files) {
  return files.reduce((n, f) => n + (fs.statSync(f.file).size || 0), 0);
}

/** The page images for a script — the whole of what players are shown. */
function imagesFor(scriptId) {
  return sheetsFor(scriptId).flatMap((s) => s.pages);
}

function attachmentsFor(scriptId) {
  return imagesFor(scriptId).map((f) => new AttachmentBuilder(f.file, { name: f.name }));
}

/**
 * Split the pages across as few messages as will hold them.
 *
 * Two pages per sheet at about 1.5 MB each fits one message comfortably today,
 * but a longer script or an unluckier render does not, and the failure mode for
 * going one byte over is the whole upload rejected. Chunking costs nothing when
 * everything fits — it returns a single group — and means a big script degrades
 * into two pinned messages rather than none.
 */
function chunkToBudget(files, budget) {
  const groups = [];
  let group = [];
  let size = 0;
  for (const f of files) {
    const bytes = fs.statSync(f.file).size || 0;
    // Always keep at least one file per message: a single page over the whole
    // budget cannot be split, and an empty group would just fail differently.
    if (group.length && size + bytes > budget) {
      groups.push(group);
      group = [];
      size = 0;
    }
    group.push(f);
    size += bytes;
  }
  if (group.length) groups.push(group);
  return groups;
}

/**
 * Take down whatever the last game pinned in the town square.
 *
 * The stored ids are the fast path, but they are not enough on their own: they
 * are cleared by `/setup`, by a channel recycle, and by anything that resets
 * the guild config, which leaves the old pinned pages in the channel with
 * nothing left pointing at them. From then on every game adds another script to
 * the pin list and none are ever removed. So sweep the bot's own pinned
 * messages too, and recognise them the way a reader would.
 *
 * `sheetMessageId` is the single-message form from before the sheets were
 * split; it is cleared here so those pins cannot outlive their script either.
 */
async function clearOldSheets(guild, channel, cfg) {
  const doomed = new Map();
  const stored = [...(cfg.channels.sheetMessageIds ?? []), cfg.channels.sheetMessageId].filter(Boolean);
  for (const id of stored) {
    const old = await channel.messages.fetch(id).catch(() => null);
    if (old) doomed.set(old.id, old);
  }

  // Only the pin list, not the channel: the sheets are always pinned, and
  // scanning history would risk deleting something a player posted.
  const meId = guild.client.user.id;
  const pins = await channel.messages.fetchPins({ limit: 50 }).catch((err) => {
    console.error('Script sheets: could not read the town square pins:', err);
    return null;
  });
  for (const item of pins?.items ?? []) {
    const msg = item.message ?? item;
    if (msg?.author?.id !== meId) continue;
    const title = msg.embeds?.[0]?.title ?? '';
    const isSheet =
      /— reference sheets$/u.test(title) ||
      // The continuation messages, and the printable-PDF message that used to
      // ride along beside the pages.
      /^-# (?:📖 .*reference, continued|🖨️ Printable)/u.test(msg.content ?? '');
    if (isSheet) doomed.set(msg.id, msg);
  }

  for (const msg of doomed.values()) await msg.delete().catch(() => null);
  cfg.channels.sheetMessageIds = [];
  cfg.channels.sheetMessageId = null;
  if (doomed.size || stored.length) save();
  return doomed.size;
}

/**
 * Pin the script's reference sheets in the town square.
 *
 * One message carrying the page images, pinned so it sits in the channel's pin
 * list where any player can reach it mid-game without scrolling. Replaces the
 * message from the previous game rather than adding to it — a channel with
 * three scripts pinned is worse than one with the right script pinned.
 *
 * Always returns a result object, never null: every way this can fail is a way
 * the town silently ends up with no reference sheet, and "nothing happened and
 * nobody was told" is exactly how that goes unnoticed for a whole game.
 *
 *   { ok: true, message, url, pinned }   posted; `pinned` false if the pin was refused
 *   { ok: false, reason, detail }        nothing posted, and why
 */
async function postScriptSheets(guild, scriptId) {
  const cfg = getGuild(guild.id);
  if (!cfg.channels.townSquare) {
    return { ok: false, reason: 'no-channel', detail: 'No town square is configured — run `/setup`.' };
  }
  const channel = await guild.channels.fetch(cfg.channels.townSquare).catch((err) => {
    console.error('Script sheets: could not fetch the town square:', err);
    return null;
  });
  if (!channel) {
    return {
      ok: false,
      reason: 'no-channel',
      detail: 'The town square channel could not be reached — it may have been deleted. Run `/setup`.',
    };
  }

  // Take down the previous game's sheets first, so a failure below leaves the
  // channel empty rather than showing the wrong script.
  await clearOldSheets(guild, channel, cfg);

  const sheets = sheetsFor(scriptId);
  if (!sheets.length) {
    // Two causes, one fix each. A host given only `src/` has no `assets/` at
    // all; a host that has the PDFs but never ran the render step has no pages.
    // Either way the town quietly plays without a reference sheet, so say both.
    const anyPdf = SHEET_KINDS.some((k) => fs.existsSync(path.join(SHEET_DIR, `${scriptId}.${k.suffix}.pdf`)));
    return {
      ok: false,
      reason: 'no-sheets',
      detail: anyPdf
        ? `The sheets for \`${scriptId}\` have not been rendered to page images — ` +
          'run `npm run sheets` where the bot lives, then restart it.'
        : `No sheet files for \`${scriptId}\` in \`assets/scripts/\` ` +
          `(looking for ${SHEET_KINDS.map((k) => `\`${scriptId}.${k.suffix}.pdf\``).join(' and ')}, ` +
          'then `npm run sheets` to render their pages).',
    };
  }
  const script = editions.find((e) => e.id === scriptId);
  const images = imagesFor(scriptId);
  const groups = chunkToBudget(images, uploadBudget(guild));

  const embed = new EmbedBuilder()
    .setTitle(`📖 ${script?.name ?? scriptId} — reference sheets`)
    .setColor(COLORS.info)
    .setDescription(
      `Every character on tonight's script and what it does, plus the night order.\n` +
        sheets.map((s2) => `${s2.emoji} **${s2.label}**`).join('\n') +
        '\n\nThe pages are below — tap one to read it full size. Nothing to download.' +
        '\nThis message is pinned.'
    )
    .setFooter({ text: 'Sheets by Ben Finney, after designs © Steven Medway and The Pandemonium Institute.' });

  const files = groups[0];

  let sendError = null;
  const msg = await channel
    .send({ embeds: [embed], files: files.map((f) => new AttachmentBuilder(f.file, { name: f.name })) })
    .catch((err) => {
      console.error('Could not post script sheets:', err);
      sendError = err;
      return null;
    });
  if (!msg) {
    // Several megabytes of pages, and an upload over the guild's limit is
    // rejected as a 40005 — worth naming, because it looks identical to a
    // permissions problem from the outside.
    const tooBig = sendError?.code === 40005;
    // 50013 on a message that is nothing but attachments is almost always
    // Attach Files, which Discord's error does not name.
    const noAttach = sendError?.code === 50013;
    return {
      ok: false,
      reason: tooBig ? 'too-big' : noAttach ? 'no-attach-files' : 'send-failed',
      detail: tooBig
        ? `The sheets are ${(bytesOf(files) / 1048576).toFixed(1)} MB together, over this server's ` +
          `${(uploadBudget(guild) / 1048576).toFixed(0)} MB upload limit.`
        : noAttach
          ? 'The town square refused the upload — I am missing **Attach Files** (or **Embed Links**) there. ' +
            `Re-invite me: ${inviteUrl(guild.client)}, then run \`/st script\`.`
          : `The town square refused the message: ${sendError?.message ?? 'unknown error'}` +
            (sendError?.code ? ` (code ${sendError.code})` : ''),
    };
  }

  // A failed pin is the one failure worth hearing about: the sheets are still
  // in the channel, but they scroll away, which is the whole problem this was
  // meant to solve.
  const { pinned, detail } = await pin(guild, channel, msg);
  cfg.channels.sheetMessageIds = [msg.id];

  // What Discord actually kept. A message can come back 200 with fewer files
  // than were sent, and "the images did not show up" is invisible from here
  // otherwise — the send looked like a success.
  let sent = files.length;
  let kept = msg.attachments.size;

  // Any pages that did not fit the first message. Pinned as well, so a reader
  // who opens the pin list gets the whole script rather than the front of it.
  for (const [i, group] of groups.slice(1).entries()) {
    const extra = await channel
      .send({
        content: `-# 📖 **${script?.name ?? scriptId}** reference, continued (${i + 2} of ${groups.length}).`,
        files: group.map((f) => new AttachmentBuilder(f.file, { name: f.name })),
      })
      .catch((err) => {
        console.error('Could not post the remaining sheet pages:', err);
        return null;
      });
    if (!extra) continue;
    await extra.pin('Script reference for this game').catch(() => null);
    cfg.channels.sheetMessageIds.push(extra.id);
    sent += group.length;
    kept += extra.attachments.size;
  }

  const lost = sent - kept;
  if (lost > 0) console.error(`Script sheets: sent ${sent} files, Discord kept ${kept}.`);

  save();
  return {
    ok: true,
    message: msg,
    url: msg.url,
    pinned,
    detail,
    images: sent,
    lost,
  };
}

/**
 * Pin the sheets, repairing the channel permission first if that is what is in
 * the way.
 *
 * Pinning wants **Pin Messages** — its own permission since Discord split it
 * out of Manage Messages. That split is why this failed silently for so long:
 * a bot invited before it existed has Manage Messages, does every other thing
 * it is asked to do, and gets a bare `50013 Missing Permissions` from the pin
 * endpoint that names nothing. Manage Messages is still asked for here because
 * deleting the *previous* game's pinned sheets needs it.
 *
 * Two distinct things can be missing, and they have different fixes:
 *
 *   - the channel overwrite does not grant it → the bot can fix that itself,
 *     which it does here rather than asking for `/setup` over a one-line edit
 *   - the bot's *role* does not have it → nothing the bot can do, because
 *     Discord refuses to let it grant a permission it does not hold. That needs
 *     a human and a re-invite, so say exactly that and hand over the link.
 */
async function pin(guild, channel, msg) {
  const attempt = () =>
    msg
      .pin('Script reference for this game')
      .then(() => ({ pinned: true }))
      .catch((err) => ({ pinned: false, err }));

  let result = await attempt();
  if (result.pinned) return { pinned: true, detail: null };

  if (result.err?.code === 30003) {
    return {
      pinned: false,
      detail: 'The town square already has 50 pinned messages — unpin something and run `/st script`.',
    };
  }

  const me = await guild.members.fetchMe().catch(() => null);
  // Only the ones the bot actually holds server-wide: Discord rejects an
  // overwrite granting a permission the grantor does not have, so asking for
  // all three when it holds two would fail the repair over the third.
  const REPAIR = ['PinMessages', 'ManageMessages', 'ReadMessageHistory', 'ViewChannel'];
  const held = REPAIR.filter((flag) => me?.permissions.has(PermissionFlagsBits[flag]));

  if (result.err?.code === 50013 && me && held.includes('PinMessages')) {
    const grant = Object.fromEntries(held.map((flag) => [flag, true]));
    const repaired = await channel.permissionOverwrites
      .edit(me.id, grant, { reason: 'BOTC: pinning the script sheets' })
      .then(() => true)
      .catch((err) => {
        console.error('Could not repair my pinning overwrite:', err);
        return false;
      });
    if (repaired) {
      result = await attempt();
      if (result.pinned) {
        return { pinned: true, detail: null, repaired: true };
      }
    }
  }

  console.error('Could not pin the script sheets:', result.err);
  // Name the permission. "Missing Permissions" on its own has sent people to
  // `/setup repair:true` — which recreates the channel and cannot help, because
  // the missing grant is on the bot's role, not the channel.
  const lacking = REPAIR.filter((flag) => !held.includes(flag));
  if (lacking.length) {
    return {
      pinned: false,
      detail:
        `My **role** does not have **${lacking.map((f) => LABELS[f]).join('** and **')}** on this server, and ` +
        'Discord will not let me grant myself a permission I do not hold. ' +
        (lacking.includes('PinMessages')
          ? '(Discord made **Pin Messages** a separate permission from Manage Messages, so a bot invited ' +
            'before that split has one and not the other.) '
          : '') +
        `Re-invite me (this updates my existing role, it will not duplicate me): ${inviteUrl(guild.client)}` +
        ' — then run `/st script` to pin them.',
    };
  }
  return {
    pinned: false,
    detail:
      `I could not pin it: ${result.err?.message ?? 'unknown error'}` +
      (result.err?.code ? ` (code ${result.err.code})` : '') +
      '. Try `/setup repair:true` — it recreates the town square with the right overwrites.',
  };
}

/**
 * One line telling the Storyteller where the sheets ended up, or why they did
 * not. Shared by every caller so the launch summary, `/st script` and `/setup`
 * cannot drift into saying different things about the same result.
 *
 * `public: true` keeps it to that one line. The warnings below are chores for
 * whoever runs the bot — a shell command, a permission to grant — and the game
 * log is read by the whole town, who can do nothing about either.
 */
function sheetStatus(result, channelId, { public: isPublic = false } = {}) {
  if (!result?.ok) {
    return `⚠️ **No script sheets were posted in <#${channelId}>.** ${result?.detail ?? 'Unknown reason.'}`;
  }
  const head = result.pinned
    ? `📖 Script reference sheets are **pinned** in <#${channelId}> — ${result.url}`
    : `📖 Script reference sheets are posted in <#${channelId}> (${result.url}) but **not pinned** — ${result.detail}`;
  if (isPublic) return head;

  // A message that posted but is short a page is the failure that looks most
  // like success, so it is worth a line of its own.
  if (result.lost > 0) {
    return (
      `${head}\n⚠️ Discord dropped ${result.lost} of the ${result.images} pages — ` +
      'check my **Attach Files** permission there.'
    );
  }
  return head;
}

module.exports = { postScriptSheets, sheetStatus, sheetsFor, hasSheets, attachmentsFor, SHEET_DIR };
