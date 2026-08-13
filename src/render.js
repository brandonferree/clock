const fs = require('fs');
const path = require('path');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { rolesById, editions, iconUrl } = require('./data/scripts');
const { drawBackdrop } = require('./backdrop');

const FONT = '"Segoe UI", Arial, Helvetica, sans-serif';
const CACHE_DIR = path.join(__dirname, '..', 'data', 'icon-cache');

// The real parchment token and shroud the online grimoire uses. token.png is
// 539x539, the same as every character glyph, so it underlays them exactly.
const ASSET_BASE =
  process.env.ASSET_BASE_URL || 'https://raw.githubusercontent.com/bra1n/townsquare/main/src/assets/';
const ASSETS = { token: 'token.png' };

const PALETTE = {
  day: { bgInner: '#3c4a6b', bgOuter: '#141a2b', text: '#ffffff' },
  night: { bgInner: '#1e2340', bgOuter: '#0a0c16', text: '#e8eaf6' },
  parchment: { inner: '#f6e7c8', outer: '#c9a875', ring: '#3b2a17' },
  evilRing: '#8c1c1c',
  goodRing: '#1c3f6e',
  dead: '#8b8f9a',
};

/**
 * Remote art, cached in memory and on disk so a game only ever downloads each
 * image once. A failed fetch resolves to null and the token still draws.
 */
const memCache = new Map();

/** Fetch-and-cache for any remote image, keyed by its cache filename. */
function cached(key, file, resolveUrl) {
  if (memCache.has(key)) return memCache.get(key);

  const promise = (async () => {
    try {
      return await loadImage(await fs.promises.readFile(file));
    } catch {
      /* not cached yet */
    }
    const url = resolveUrl();
    if (!url) return null;
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      await fs.promises.mkdir(CACHE_DIR, { recursive: true });
      await fs.promises.writeFile(file, buf).catch(() => null);
      return await loadImage(buf);
    } catch {
      return null;
    }
  })();

  memCache.set(key, promise);
  // Do not cache a failure forever — a transient network error should retry.
  promise.then((img) => img ?? memCache.delete(key)).catch(() => memCache.delete(key));
  return promise;
}

/** A character's glyph. */
function getIcon(roleId) {
  return cached(`icon:${roleId}`, path.join(CACHE_DIR, `${roleId}.png`), () => iconUrl(roleId));
}

/** A shared asset — the parchment token or the shroud. */
function getAsset(name) {
  const file = ASSETS[name];
  return cached(`asset:${name}`, path.join(CACHE_DIR, file), () => ASSET_BASE + file);
}

/** A rounded translucent plate, drawn behind text sitting over busy artwork. */
function plate(ctx, x, y, w, h, radius) {
  const rr = Math.min(radius, h / 2, w / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
  ctx.fill();
}

/** Truncate to fit `maxWidth`, and report the width it will actually occupy. */
function fitText(ctx, text, { size, weight = 'bold', maxWidth }) {
  ctx.font = `${weight} ${size}px ${FONT}`;
  let out = text;
  if (maxWidth) {
    while (out.length > 1 && ctx.measureText(out).width > maxWidth) out = out.slice(0, -1);
    if (out !== text) out = `${out.slice(0, -1)}…`;
  }
  return { text: out, width: ctx.measureText(out).width };
}

/**
 * Text with a dark outline, so names stay readable over any background.
 * `backing` adds a plate underneath as well — the outline alone is not enough
 * over lit windows or the moon.
 */
function label(ctx, text, x, y, { size = 26, weight = 'bold', color = '#fff', maxWidth, backing, outline = true } = {}) {
  ctx.font = `${weight} ${size}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let out = text;
  if (maxWidth) {
    while (out.length > 1 && ctx.measureText(out).width > maxWidth) out = out.slice(0, -1);
    if (out !== text) out = `${out.slice(0, -1)}…`;
  }
  if (backing) {
    const tw = ctx.measureText(out).width;
    const padX = size * 0.42;
    const padY = size * 0.28;
    ctx.fillStyle = `rgba(6,8,16,${backing})`;
    plate(ctx, x - tw / 2 - padX, y - size / 2 - padY, tw + padX * 2, size + padY * 2, size * 0.45);
    ctx.font = `${weight} ${size}px ${FONT}`;
  }
  if (outline) {
    ctx.lineWidth = Math.max(3, size / 7);
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.lineJoin = 'round';
    ctx.strokeText(out, x, y);
  }
  ctx.fillStyle = color;
  ctx.fillText(out, x, y);
  return ctx.measureText(out).width;
}

/**
 * The dead-vote marker stamped on a token in the public view, where there is no
 * character to show: a ringed tick if the player still holds their one ghost
 * vote, a ringed cross once it is spent.
 */
function drawVoteMark(ctx, cx, cy, d, used) {
  const rad = d * 0.17;
  const ink = used ? 'rgba(48,34,20,0.55)' : 'rgba(52,36,18,0.9)';
  ctx.save();
  ctx.strokeStyle = ink;
  ctx.lineWidth = Math.max(3, d * 0.032);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  ctx.beginPath();
  ctx.arc(cx, cy, rad, 0, Math.PI * 2);
  ctx.stroke();

  ctx.lineWidth = Math.max(3.5, d * 0.042);
  ctx.beginPath();
  if (used) {
    const k = rad * 0.46;
    ctx.moveTo(cx - k, cy - k);
    ctx.lineTo(cx + k, cy + k);
    ctx.moveTo(cx + k, cy - k);
    ctx.lineTo(cx - k, cy + k);
  } else {
    ctx.moveTo(cx - rad * 0.5, cy + rad * 0.02);
    ctx.lineTo(cx - rad * 0.12, cy + rad * 0.42);
    ctx.lineTo(cx + rad * 0.54, cy - rad * 0.4);
  }
  ctx.stroke();
  ctx.restore();
}

/**
 * One reminder token: a small parchment disc carrying its source character's
 * glyph with the reminder text underneath, matching the physical grimoire.
 */
function drawReminder(ctx, { cx, cy, m, icon, text, token }) {
  const r = m / 2;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = m * 0.1;
  ctx.shadowOffsetY = m * 0.03;
  if (token) {
    ctx.drawImage(token, cx - r, cy - r, m, m);
    ctx.shadowColor = 'transparent';
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r - 1, 0, Math.PI * 2);
    ctx.clip();
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = '#e9d4ac';
    ctx.fillRect(cx - r, cy - r, m, m);
    ctx.restore();
  } else {
    ctx.fillStyle = PALETTE.parchment.inner;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  ctx.beginPath();
  ctx.arc(cx, cy, r - 1, 0, Math.PI * 2);
  ctx.lineWidth = Math.max(1.5, m * 0.03);
  ctx.strokeStyle = PALETTE.parchment.ring;
  ctx.stroke();

  const ink = 'rgba(45,30,14,1)';
  const maxW = m * 0.84;
  // Shrink from `base` until the text fits; null if even `min` is too small.
  const shrinkToFit = (txt, base, min) => {
    for (let s = base; s >= min; s -= m * 0.005) {
      ctx.font = `700 ${s}px ${FONT}`;
      if (ctx.measureText(txt).width <= maxW) return s;
    }
    return null;
  };
  if (icon) {
    // Glyph in the top half, text in the bottom — the real token layout.
    const g = m * 0.46;
    ctx.drawImage(icon, cx - g / 2, cy - r + m * 0.08, g, g);
    const words = String(text).split(' ');
    const oneSize = shrinkToFit(text, m * 0.18, m * 0.135);
    if (oneSize) {
      label(ctx, text, cx, cy + m * 0.26, { size: oneSize, weight: '700', color: ink, outline: false });
    } else if (words.length > 1) {
      // Split across two lines, each sized to fit.
      const mid = Math.ceil(words.length / 2);
      for (const [line, y] of [
        [words.slice(0, mid).join(' '), cy + m * 0.18],
        [words.slice(mid).join(' '), cy + m * 0.35],
      ]) {
        const s = shrinkToFit(line, m * 0.165, m * 0.12) ?? m * 0.12;
        label(ctx, line, cx, y, { size: s, weight: '700', color: ink, maxWidth: maxW, outline: false });
      }
    } else {
      // One immovable word: smallest size, truncated as a last resort.
      label(ctx, text, cx, cy + m * 0.26, { size: m * 0.135, weight: '700', color: ink, maxWidth: maxW, outline: false });
    }
  } else {
    // No glyph (overflow disc, or art failed): text alone, centred.
    label(ctx, String(text), cx, cy, { size: m * 0.28, weight: '700', color: ink, maxWidth: maxW, outline: false });
  }
}

/**
 * One seat: parchment disc, character glyph, name, and a shadow over the top of
 * the disc if dead. `out` is -1 for seats in the top half and +1 for the
 * bottom, so names are always pushed away from the centre instead of over it.
 */
function drawToken(ctx, { cx, cy, d, role, player, icon, out, reveal, token, inAngle, reminders = [] }) {
  const r = d / 2;
  // Without reveal, nothing about the character may show — not the glyph, not
  // the name, and not the team ring, which would leak alignment.
  const shown = reveal ? role : null;
  const isEvil = shown && (shown.team === 'minion' || shown.team === 'demon');

  ctx.save();
  // Drop shadow for the disc only.
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = d * 0.11;
  ctx.shadowOffsetY = d * 0.035;
  if (token) {
    // The genuine token art. It ships greyscale — a paper texture meant to be
    // tinted — so multiply parchment over it to get the printed-token look
    // instead of a flat grey disc.
    ctx.drawImage(token, cx - r, cy - r, d, d);
    ctx.shadowColor = 'transparent';
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r - 1, 0, Math.PI * 2);
    ctx.clip();
    ctx.globalCompositeOperation = 'multiply';
    const tint = ctx.createRadialGradient(cx - r * 0.25, cy - r * 0.3, r * 0.1, cx, cy, r);
    tint.addColorStop(0, '#fff2d4');
    tint.addColorStop(0.7, '#e8cfa0');
    tint.addColorStop(1, '#c19d68');
    ctx.fillStyle = tint;
    ctx.fillRect(cx - r, cy - r, d, d);
    ctx.restore();
  } else {
    // Fallback if the asset could not be fetched.
    const grad = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.35, r * 0.1, cx, cy, r);
    grad.addColorStop(0, PALETTE.parchment.inner);
    grad.addColorStop(1, PALETTE.parchment.outer);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // Glyph, clipped to the disc.
  if (shown && icon) {
    const inset = d * 0.1;
    const size = d - inset * 2;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r - 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(icon, cx - size / 2, cy - size / 2, size, size);
    ctx.restore();
  } else if (shown) {
    // Revealed, but the art would not load — fall back to initials.
    label(ctx, role.name.slice(0, 2), cx, cy, {
      size: d * 0.34,
      color: 'rgba(59,42,23,0.65)',
    });
  } else if (!reveal) {
    // Public view: no character to show, so the face carries the dead-vote
    // state instead. Living players need no marking.
    if (!player.alive) drawVoteMark(ctx, cx, cy, d, !!player.deadVoteUsed);
  } else {
    // Revealed but no character assigned yet.
    label(ctx, '?', cx, cy, { size: d * 0.34, color: 'rgba(59,42,23,0.65)' });
  }

  ctx.beginPath();
  ctx.arc(cx, cy, r - 2, 0, Math.PI * 2);
  ctx.lineWidth = Math.max(3, d * 0.035);
  ctx.strokeStyle = shown ? (isEvil ? PALETTE.evilRing : PALETTE.goodRing) : PALETTE.parchment.ring;
  ctx.stroke();

  if (!player.alive) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r - 1, 0, Math.PI * 2);
    ctx.clip();
    // Drain the colour out of the disc, then dim it.
    ctx.fillStyle = 'rgba(120,124,136,0.7)';
    ctx.globalCompositeOperation = 'saturation';
    ctx.fillRect(cx - r, cy - r, d, d);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = 'rgba(10,12,22,0.28)';
    ctx.fillRect(cx - r, cy - r, d, d);

    // Death is shown as a shadow falling over the top of the token, densest at
    // the rim and gone by the middle, so the character stays readable.
    const fade = ctx.createLinearGradient(cx, cy - r, cx, cy + r * 0.1);
    fade.addColorStop(0, 'rgba(6,8,16,0.82)');
    fade.addColorStop(0.55, 'rgba(6,8,16,0.42)');
    fade.addColorStop(1, 'rgba(6,8,16,0)');
    ctx.fillStyle = fade;
    ctx.fillRect(cx - r, cy - r, d, r * 1.1);
    ctx.restore();
  }

  // Reminder tokens, fanned along the inward rim where the board has room.
  // Grim view only — reminders are hidden information by definition.
  if (reveal && reminders.length) {
    const m = d * 0.52;
    const max = 6;
    const shownRems = reminders.slice(0, max);
    if (reminders.length > max) {
      shownRems[max - 1] = { text: `+${reminders.length - max + 1}`, icon: null };
    }
    // Rows of three hugging the rim, each further row a step closer to the
    // board centre — a single wide fan would wrap into the neighbouring seats.
    const perRow = 3;
    shownRems.forEach((rem, i) => {
      const row = Math.floor(i / perRow);
      const inRow = Math.min(perRow, shownRems.length - row * perRow);
      const dist = r + m * 0.34 + row * m * 0.92;
      const step = 2 * Math.asin(Math.min(0.95, (m * 0.56) / dist));
      const a = inAngle + (i % perRow - (inRow - 1) / 2) * step;
      drawReminder(ctx, {
        cx: cx + Math.cos(a) * dist,
        cy: cy + Math.sin(a) * dist,
        m,
        icon: rem.icon,
        text: rem.text,
        token,
      });
    });
  }

  // Name and character on the outward side, stacked name-above-character.
  const edge = cy + out * (r + d * 0.17);
  const nameY = out > 0 ? edge : edge - d * 0.18;
  const roleY = out > 0 ? edge + d * 0.18 : edge;
  const nameSize = d * 0.16;
  const subSize = d * 0.14;
  // In the public view the subtitle spells out what the stamp on the token
  // means, so the mark never has to be guessed at.
  const subtitle = reveal
    ? role
      ? role.name
      : 'unassigned'
    : player.alive
      ? ''
      : player.deadVoteUsed
        ? 'vote spent'
        : 'ghost vote';
  const subWeight = role && reveal ? '600' : 'italic 600';

  // One plate behind both lines rather than two stacked boxes.
  const fitName = fitText(ctx, player.name, { size: nameSize, maxWidth: d * 1.55 });
  const fitSub = subtitle
    ? fitText(ctx, subtitle, { size: subSize, weight: subWeight, maxWidth: d * 1.55 })
    : { width: 0 };
  const padX = nameSize * 0.45;
  const padY = nameSize * 0.3;
  const boxW = Math.max(fitName.width, fitSub.width) + padX * 2;
  const top = Math.min(nameY - nameSize / 2, roleY - subSize / 2) - padY;
  const bottom = Math.max(nameY + nameSize / 2, subtitle ? roleY + subSize / 2 : nameY + nameSize / 2) + padY;
  ctx.fillStyle = 'rgba(6,8,16,0.62)';
  plate(ctx, cx - boxW / 2, top, boxW, bottom - top, nameSize * 0.45);

  label(ctx, player.name, cx, nameY, {
    size: nameSize,
    color: player.alive ? '#ffffff' : PALETTE.dead,
    maxWidth: d * 1.55,
  });
  const w = subtitle
    ? label(ctx, subtitle, cx, roleY, {
        size: subSize,
        weight: subWeight,
        color: shown ? (isEvil ? '#ffb3b3' : '#b9dcff') : 'rgba(255,255,255,0.55)',
        maxWidth: d * 1.55,
      })
    : 0;

  if (!player.alive && w && reveal) {
    // Strike the character through — matches how the text board shows deaths.
    // Only when revealed; striking the literal word "dead" would be redundant.
    ctx.strokeStyle = 'rgba(220,60,60,0.9)';
    ctx.lineWidth = Math.max(2, d * 0.02);
    ctx.beginPath();
    ctx.moveTo(cx - w / 2 - 4, roleY);
    ctx.lineTo(cx + w / 2 + 4, roleY);
    ctx.stroke();
  }
}

/**
 * Render the town as a PNG buffer: every seat, who is dead, and the phase.
 *
 * With `reveal: true` it also shows each player's character and alignment —
 * that is the real grimoire, and it must only ever reach the Storyteller.
 * The default hides all of that and is safe to post publicly as a day status.
 */
async function renderGrimoire(game, { reveal = false } = {}) {
  const entries = Object.entries(game.players);
  const n = entries.length;
  const night = game.phase === 'night';

  // Token size shrinks as the town grows; the ring grows to fit them without
  // overlap, and the canvas is sized from the ring.
  const d = n <= 8 ? 168 : n <= 12 ? 142 : 120;
  const gap = d * 0.55;
  const minRadius = d * 1.35;
  const ring = n <= 1 ? 0 : Math.max(minRadius, (n * (d + gap)) / (2 * Math.PI));
  const margin = d * 0.75;
  const size = Math.round((ring + d / 2 + margin) * 2);
  const cx = size / 2;
  const cy = size / 2;

  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  const pal = night ? PALETTE.night : PALETTE.day;
  // The spooky town itself. Both renders get it — it carries no game state, so
  // there is nothing here that could leak.
  drawBackdrop(ctx, size, night, { ring, tokenR: d / 2 });

  // Fetch art up front so tokens draw in one pass. Character glyphs are skipped
  // entirely when they will not be drawn; the token and shroud are always used.
  const [token, seats] = await Promise.all([
    getAsset('token'),
    Promise.all(
      entries.map(async ([id, player]) => {
        const role = player.character ? rolesById.get(player.character) : null;
        return {
          id,
          player,
          role,
          icon: role && reveal ? await getIcon(role.id) : null,
          // Each reminder carries its source character's glyph.
          reminders: reveal
            ? await Promise.all(
                (player.reminders ?? []).map(async (rem) => ({
                  text: rem.text,
                  icon: await getIcon(rem.role),
                }))
              )
            : [],
        };
      })
    ),
  ]);

  if (n > 0) {
    // Faint guide ring so the town reads as a circle even with few players.
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, ring, 0, Math.PI * 2);
    ctx.stroke();
  }

  seats.forEach((seat, i) => {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    const sy = Math.sin(angle);
    drawToken(ctx, {
      ...seat,
      d,
      cx: cx + Math.cos(angle) * ring,
      cy: cy + sy * ring,
      // Seats above the midline label upward, seats below label downward.
      out: sy < -0.001 ? -1 : 1,
      // Reminders fan out toward the board centre, where there is open space.
      inAngle: angle + Math.PI,
      reveal,
      token,
    });
  });

  // Centre plate: script, phase, and the numbers that drive the day.
  const alive = seats.filter((s) => s.player.alive).length;
  const script = editions.find((e) => e.id === game.script);
  const phase =
    game.status === 'lobby' ? 'Lobby' : `${night ? 'Night' : 'Day'} ${game.day}`;

  // No plate here — the backdrop's scrim already darkens the middle, and the
  // text outlines carry the rest. A box this size covered too much of the town.
  label(ctx, reveal ? (script?.name ?? game.script) : 'Town Square', cx, cy - d * 0.5, {
    size: d * 0.17,
    color: 'rgba(255,255,255,0.72)',
    maxWidth: ring * 1.1,
  });
  label(ctx, phase, cx, cy - d * 0.12, { size: d * 0.42, color: pal.text });
  label(ctx, `${alive} alive of ${n}`, cx, cy + d * 0.28, {
    size: d * 0.19,
    color: 'rgba(255,255,255,0.85)',
  });
  if (alive > 0 && game.status !== 'lobby') {
    label(ctx, `${Math.ceil(alive / 2)} votes to execute`, cx, cy + d * 0.55, {
      size: d * 0.16,
      color: 'rgba(255,255,255,0.62)',
    });
  }

  return canvas.encode('png');
}

module.exports = { renderGrimoire, getIcon };
