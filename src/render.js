const fs = require('fs');
const path = require('path');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { rolesById, editions, iconUrl, TEAM_LABEL, SETUP_TABLE } = require('./data/scripts');
const { drawBackdrop } = require('./backdrop');

const FONT = '"Segoe UI", Arial, Helvetica, sans-serif';
// How many pixels the board is drawn at per layout pixel. 1.6 roughly doubles
// the file size for a board that stays crisp when opened full-size.
const SUPERSAMPLE = 1.6;
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

/**
 * A character glyph, drawn punchier than the source art.
 *
 * The icons are 539px line drawings shrunk to around 100px a side on the board.
 * At that reduction the default filtering eats the thin strokes, and the art's
 * own pale palette — the Fortune Teller's and Investigator's especially — is
 * left looking faded on the cream parchment. So: high-quality downscaling, a
 * saturate/contrast pass to put the ink back, and a second low-alpha pass that
 * deepens the strokes and their antialiased edges without fattening them.
 */
function drawGlyph(ctx, icon, x, y, size) {
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.filter = 'saturate(1.55) contrast(1.2)';
  ctx.drawImage(icon, x, y, size, size);
  ctx.globalAlpha = 0.45;
  ctx.drawImage(icon, x, y, size, size);
  ctx.restore();
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
 * character to show: a green ringed tick if the player still holds their one
 * ghost vote, a red ringed cross once it is spent.
 *
 * Colour does the work here — whether a ghost still has a vote is the single
 * thing the town reads off a dead token, and at a glance across fifteen seats a
 * tick and a cross in the same brown ink are far too easy to confuse. A tinted
 * disc sits behind the mark so it holds up against the parchment.
 */
function drawVoteMark(ctx, cx, cy, d, used) {
  const rad = d * 0.17;
  const ink = used ? '#c0261f' : '#1f8f3f';
  ctx.save();

  // Highlight disc, then a soft dark edge to lift it off the parchment.
  ctx.fillStyle = used ? 'rgba(192,38,31,0.20)' : 'rgba(31,143,63,0.22)';
  ctx.beginPath();
  ctx.arc(cx, cy, rad * 1.1, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = 'rgba(20,14,8,0.35)';
  ctx.lineWidth = Math.max(1, d * 0.012);
  ctx.beginPath();
  ctx.arc(cx, cy, rad * 1.1, 0, Math.PI * 2);
  ctx.stroke();

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
function drawReminder(ctx, { cx, cy, m, icon, text, evil }) {
  const r = m / 2;
  const tint = evil ? PALETTE.evilRing : PALETTE.goodRing;
  const rim = evil ? '#ff7b7b' : '#8fc4ff';

  // A dark disc, not parchment. The glyphs are thin blue and red line art: on
  // cream at this size they wash out, while on near-black they read at a glance.
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.65)';
  ctx.shadowBlur = m * 0.14;
  ctx.shadowOffsetY = m * 0.04;
  const disc = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.35, r * 0.1, cx, cy, r);
  disc.addColorStop(0, evil ? '#3b1f28' : '#232f4d');
  disc.addColorStop(1, '#0c0f1a');
  ctx.fillStyle = disc;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Team-coloured rim, so good and evil reminders are separable across the board.
  ctx.beginPath();
  ctx.arc(cx, cy, r - 1, 0, Math.PI * 2);
  ctx.lineWidth = Math.max(2, m * 0.055);
  ctx.strokeStyle = rim;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, r - 1, 0, Math.PI * 2);
  ctx.lineWidth = Math.max(1, m * 0.018);
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.stroke();

  const ink = '#ffffff';
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
    const g = m * 0.56;
    const gx = cx - g / 2;
    const gy = cy - r + m * 0.06;
    ctx.save();
    // Halo first, so the thin strokes have something to sit against, then the
    // glyph twice — the second pass in `lighter` adds its own colour back onto
    // itself, which is what turns muddy line art into something readable small.
    const halo = ctx.createRadialGradient(cx, gy + g / 2, g * 0.08, cx, gy + g / 2, g * 0.62);
    halo.addColorStop(0, 'rgba(255,255,255,0.22)');
    halo.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = halo;
    ctx.fillRect(cx - g * 0.7, gy - g * 0.12, g * 1.4, g * 1.24);
    ctx.shadowColor = tint;
    ctx.shadowBlur = m * 0.09;
    ctx.drawImage(icon, gx, gy, g, g);
    ctx.shadowColor = 'transparent';
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.85;
    ctx.drawImage(icon, gx, gy, g, g);
    ctx.restore();
    const words = String(text).split(' ');
    const oneSize = shrinkToFit(text, m * 0.2, m * 0.145);
    if (oneSize) {
      label(ctx, text, cx, cy + m * 0.29, { size: oneSize, weight: '700', color: ink });
    } else if (words.length > 1) {
      // Split across two lines, each sized to fit.
      const mid = Math.ceil(words.length / 2);
      for (const [line, y] of [
        [words.slice(0, mid).join(' '), cy + m * 0.21],
        [words.slice(mid).join(' '), cy + m * 0.38],
      ]) {
        const s = shrinkToFit(line, m * 0.18, m * 0.13) ?? m * 0.13;
        label(ctx, line, cx, y, { size: s, weight: '700', color: ink, maxWidth: maxW });
      }
    } else {
      // One immovable word: smallest size, truncated as a last resort.
      label(ctx, text, cx, cy + m * 0.29, { size: m * 0.145, weight: '700', color: ink, maxWidth: maxW });
    }
  } else {
    // No glyph (overflow disc, or art failed): text alone, centred.
    label(ctx, String(text), cx, cy, { size: m * 0.3, weight: '700', color: ink, maxWidth: maxW });
  }
}

/**
 * One seat: parchment disc, character glyph, name, and a shadow over the top of
 * the disc if dead. `out` is -1 for seats in the top half and +1 for the
 * bottom, so names are always pushed away from the centre instead of over it.
 */
function drawToken(ctx, { cx, cy, d, role, player, icon, out, reveal, token, inAngle, reminders = [], subtitle: subtitleOverride, centre }) {
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
    drawGlyph(ctx, icon, cx - size / 2, cy - size / 2, size);
    ctx.restore();
  } else if (shown) {
    // Revealed, but the art would not load — fall back to initials.
    label(ctx, role.name.slice(0, 2), cx, cy, {
      size: d * 0.34,
      color: 'rgba(59,42,23,0.65)',
    });
  } else if (!reveal) {
    // Public view: the face carries the dead-vote state instead of a character,
    // but the mark is stamped after the death shroud below — the shroud drains
    // the disc's colour, and the whole point of the mark is its colour.
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

    // Ghost vote, over the top of the shroud so its green or red survives.
    if (!reveal) drawVoteMark(ctx, cx, cy, d, !!player.deadVoteUsed);
  }

  // Reminder tokens, fanned along the inward rim where the board has room.
  // Grim view only — reminders are hidden information by definition.
  if (reveal && reminders.length) {
    const max = 6;
    const shownRems = reminders.slice(0, max);
    if (reminders.length > max) {
      shownRems[max - 1] = { text: `+${reminders.length - max + 1}`, icon: null };
    }
    // A seat carrying four or more needs a second row, and two full-size rows
    // do not fit between the rim and the middle of the board. Shrinking the
    // discs on those seats only costs a little legibility on the busiest seat,
    // where the alternative is stacking them on top of each other.
    const m = d * (shownRems.length > 3 ? 0.5 : 0.58);
    // Rows of three hugging the rim, each further row a step closer to the
    // board centre — a single wide fan would wrap into the neighbouring seats.
    const perRow = 3;
    shownRems.forEach((rem, i) => {
      const row = Math.floor(i / perRow);
      const inRow = Math.min(perRow, shownRems.length - row * perRow);
      // Far enough in that the disc clears the seat's rim rather than covering
      // the character art — the discs grew, so this has to grow with them.
      const dist = r + m * 0.58 + row * m * 0.95;
      const step = 2 * Math.asin(Math.min(0.95, (m * 0.56) / dist));
      // Odd rows are offset by half a step so they interleave with the row in
      // front rather than sitting directly behind it — which is what they end
      // up doing whenever the clamp below pulls them back out to the same
      // radius as their neighbours.
      const a = inAngle + (i % perRow - (inRow - 1) / 2 + (row % 2) * 0.5) * step;
      let rx = cx + Math.cos(a) * dist;
      let ry = cy + Math.sin(a) * dist;
      // Every seat fans its reminders toward the same point, so on a busy
      // board the middle is where they all pile up — on top of each other and
      // on top of the phase and the stat strip. `centre` is the block the town
      // reads at a glance; a disc that would land inside it gets pushed back
      // out along its own line until it clears, which keeps it beside its own
      // seat rather than shuffled off to some other part of the board.
      if (centre) {
        const dx = rx - centre.x;
        const dy = ry - centre.y;
        const away = Math.hypot(dx, dy);
        const clear = centre.r + m / 2;
        if (away < clear) {
          // Dead centre has no direction to push along; fall back to the line
          // from the board's middle out through this seat.
          const k = away > 0.001 ? clear / away : 0;
          rx = k ? centre.x + dx * k : cx - Math.cos(inAngle) * clear;
          ry = k ? centre.y + dy * k : cy - Math.sin(inAngle) * clear;
        }
      }
      drawReminder(ctx, { cx: rx, cy: ry, m, icon: rem.icon, text: rem.text, evil: rem.evil });
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
  const subtitle =
    subtitleOverride !== undefined
      ? subtitleOverride
      : reveal
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
 * The stat strip under the centre text: two rows of numeral-and-glyph pairs,
 * the way the online grimoire sums a town up at a glance.
 *
 * These numbers were already in the middle of the board as words, and words in
 * the middle of a busy board get read last. The four questions asked every
 * single day — how many of us are there, how many are left, how many can still
 * vote, and what is in the bag — are answered here by colour and shape before
 * anyone reads a digit.
 */
const STAT_COLORS = {
  players: '#57f287',
  alive: '#ed4245',
  votes: '#ffffff',
  townsfolk: '#4a9eff',
  outsider: '#a9d6ff',
  minion: '#ff9d4a',
  demon: '#ff4a4a',
};

/** A head-and-shoulders silhouette, the base of the player and team glyphs. */
function personPath(ctx, x, y, s) {
  ctx.beginPath();
  ctx.arc(x, y - s * 0.21, s * 0.165, 0, Math.PI * 2);
  ctx.closePath();
  ctx.moveTo(x - s * 0.3, y + s * 0.36);
  ctx.arc(x, y + s * 0.36, s * 0.3, Math.PI, 0);
  ctx.closePath();
}

/** A filled glyph with a dark keyline, so it holds up over the lit town. */
function stamp(ctx, color, s, path) {
  ctx.save();
  path();
  ctx.lineWidth = Math.max(2, s * 0.13);
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(0,0,0,0.8)';
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

/** A stroked glyph: the same keyline trick, drawn twice instead of filled. */
function stroked(ctx, color, s, weight, path) {
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  path();
  ctx.lineWidth = Math.max(4, s * (weight + 0.09));
  ctx.strokeStyle = 'rgba(0,0,0,0.8)';
  ctx.stroke();
  ctx.lineWidth = Math.max(2, s * weight);
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.restore();
}

const GLYPHS = {
  /** Three overlapping silhouettes: everyone at the table. */
  players(ctx, x, y, s, color) {
    ctx.save();
    for (const [dx, dy, k, alpha] of [
      [-0.3, -0.04, 0.78, 0.6],
      [0.3, -0.04, 0.78, 0.6],
      [0, 0.05, 1, 1],
    ]) {
      ctx.globalAlpha = alpha;
      stamp(ctx, color, s * k, () => personPath(ctx, x + s * dx, y + s * dy, s * k));
    }
    ctx.restore();
  },
  /** A heart: who is still breathing. */
  alive(ctx, x, y, s, color) {
    stamp(ctx, color, s, () => {
      const w = s * 0.34;
      ctx.beginPath();
      ctx.moveTo(x, y + s * 0.36);
      ctx.bezierCurveTo(x - w * 2.1, y - s * 0.06, x - w * 1.15, y - s * 0.48, x, y - s * 0.06);
      ctx.bezierCurveTo(x + w * 1.15, y - s * 0.48, x + w * 2.1, y - s * 0.06, x, y + s * 0.36);
      ctx.closePath();
    });
  },
  /** A ticked box: hands that can still go up, ghost votes included. */
  votes(ctx, x, y, s, color) {
    const r = s * 0.32;
    const c = s * 0.08;
    stroked(ctx, color, s, 0.11, () => {
      ctx.beginPath();
      ctx.moveTo(x - r + c, y - r);
      ctx.arcTo(x + r, y - r, x + r, y + r, c);
      ctx.arcTo(x + r, y + r, x - r, y + r, c);
      ctx.arcTo(x - r, y + r, x - r, y - r, c);
      ctx.arcTo(x - r, y - r, x + r, y - r, c);
      ctx.closePath();
    });
    stroked(ctx, color, s, 0.13, () => {
      ctx.beginPath();
      ctx.moveTo(x - r * 0.5, y + r * 0.02);
      ctx.lineTo(x - r * 0.1, y + r * 0.44);
      ctx.lineTo(x + r * 0.56, y - r * 0.42);
    });
  },
  /** One silhouette, tinted by team: the four bag counts. */
  team(ctx, x, y, s, color) {
    stamp(ctx, color, s, () => personPath(ctx, x, y, s));
  },
};

/**
 * One row of `{ value, glyph, color }` stats, centred on `cx`. Numeral first,
 * then its glyph, matching the layout players already know from the app.
 */
function statRow(ctx, items, cx, cy, s) {
  const fs = s * 0.82;
  const pairGap = s * 0.16;
  const itemGap = s * 0.44;
  ctx.font = `800 ${fs}px ${FONT}`;
  const measured = items.map((item) => {
    const numW = ctx.measureText(String(item.value)).width;
    return { ...item, numW, width: numW + pairGap + s };
  });
  const total = measured.reduce((a, m) => a + m.width, 0) + itemGap * (measured.length - 1);

  let x = cx - total / 2;
  for (const m of measured) {
    label(ctx, String(m.value), x + m.numW / 2, cy, { size: fs, weight: '800', color: '#ffffff' });
    (GLYPHS[m.glyph] ?? GLYPHS.team)(ctx, x + m.numW + pairGap + s / 2, cy, s, m.color);
    x += m.width + itemGap;
  }
}

/**
 * The strip itself: the town's vital numbers, then the split of the bag.
 *
 * The split is always the official table for the seat count — the same numbers
 * printed on every script sheet — and never what was actually dealt. A Baron
 * game really is 3/3/1/1, but saying so on the board is the one thing that
 * would give the Baron away, and the grim is read over shoulders. The
 * Storyteller has `/setup` and the publish review for the adjusted counts;
 * this row stays the common-knowledge one on both views.
 *
 * Returns the y the strip ended at.
 */
function drawStatStrip(ctx, { cx, top, size, seats }) {
  const n = seats.length;
  const alive = seats.filter((s) => s.player.alive).length;
  // A dead player keeps one vote until they spend it, so voting power is not
  // the same number as the heartbeat — and that gap decides close executions.
  const votes = seats.filter((s) => s.player.alive || !s.player.deadVoteUsed).length;

  const split = SETUP_TABLE[n] ?? null;

  const rows = [
    [
      { value: n, glyph: 'players', color: STAT_COLORS.players },
      { value: alive, glyph: 'alive', color: STAT_COLORS.alive },
      { value: votes, glyph: 'votes', color: STAT_COLORS.votes },
    ],
  ];
  if (split) {
    const teamRow = ['townsfolk', 'outsider', 'minion', 'demon']
      .map((team, i) => ({ value: split[i], glyph: 'team', color: STAT_COLORS[team] }))
      // A team nobody is on is noise, not information.
      .filter((item) => item.value > 0);
    if (teamRow.length) rows.push(teamRow);
  }

  const gap = size * 1.3;
  rows.forEach((items, i) => statRow(ctx, items, cx, top + size / 2 + i * gap, size));
  return top + (rows.length - 1) * gap + size;
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
  // The ring never closes in tighter than this, even with five seats. The
  // centre has to hold the phase, the votes line and the stat strip, and the
  // ring also has to stand clear of the reminder tokens fanning inward off
  // every seat. At the old 1.35 both fought over the same pixels on a small
  // town; the seats are further apart now and the middle is left to breathe.
  const minRadius = d * 2.5;
  const ring = n <= 1 ? 0 : Math.max(minRadius, (n * (d + gap)) / (2 * Math.PI));
  const margin = d * 0.75;
  const size = Math.round((ring + d / 2 + margin) * 2);
  const cx = size / 2;
  const cy = size / 2;

  // Draw the whole board oversized and let the viewer shrink it. A token glyph
  // is a 539px drawing squeezed onto a ~100px disc; at 1x that reduction is
  // brutal enough to visibly soften the thin line art, and every text outline
  // and rim stroke pays the same cost. Rendering above the layout size means
  // the downscale happens once, in the viewer, from real detail rather than
  // from an already-degraded canvas. Everything below still works in layout
  // coordinates — only the pixels underneath got denser.
  const canvas = createCanvas(Math.round(size * SUPERSAMPLE), Math.round(size * SUPERSAMPLE));
  const ctx = canvas.getContext('2d');
  ctx.scale(SUPERSAMPLE, SUPERSAMPLE);
  // Every image here is a big one shrunk down. The default filter is a cheap
  // one and it shows, so pay for the good one across the whole board.
  ctx.imageSmoothingQuality = 'high';

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
                (player.reminders ?? []).map(async (rem) => {
                  const src = rolesById.get(rem.role);
                  return {
                    text: rem.text,
                    icon: await getIcon(rem.role),
                    evil: src?.team === 'minion' || src?.team === 'demon',
                  };
                })
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

  // The middle of the board is laid out before the seats are drawn, because
  // the reminder fans need to know what to steer around. `centre` is the disc
  // the block occupies: the script line at the top, the strip at the bottom,
  // and the widest stat row across.
  const alive = seats.filter((s) => s.player.alive).length;
  const showVotes = alive > 0 && game.status !== 'lobby';
  const stripTop = cy + d * (showVotes ? 0.5 : 0.28);
  const wanted = d * 0.2;
  // What is left once a row of reminder tokens has had its share of the gap
  // between the ring and the middle. Two stat rows and the gap between them
  // come to 2.3 glyphs tall; below half size the numerals stop reading at a
  // glance, so a board that tight goes without the strip rather than squinting.
  const stripSize = Math.min(wanted, (cy + ring - d * 1.15 - stripTop) / 2.3);
  const strip = n > 0 && stripSize >= wanted * 0.5 ? { top: stripTop, size: stripSize } : null;
  const centre = {
    x: cx,
    y: cy,
    r: (strip ? strip.top - cy + strip.size * 2.3 : d * (showVotes ? 0.44 : 0.06)) + d * 0.12,
  };

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
      centre,
    });
  });

  // Centre plate: script, phase, and the numbers that drive the day.
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
  // No "x alive of y" line: the headcount and the heartbeat are both in the
  // strip below, in colour, and saying it twice cost a line of the middle that
  // the reminder tokens want back.
  if (showVotes) {
    label(ctx, `${Math.ceil(alive / 2)} votes to execute`, cx, cy + d * 0.28, {
      size: d * 0.16,
      color: 'rgba(255,255,255,0.62)',
    });
  }
  if (strip) drawStatStrip(ctx, { cx, ...strip, seats });

  return canvas.encode('png');
}

/**
 * A row of character tokens as one PNG — the Demon's three bluffs shown the way
 * a Storyteller fans the tokens out at the table.
 *
 * An embed carries one thumbnail, so three characters described in text arrived
 * illustrated by whichever of them happened to be first. Drawing the row into a
 * single image gives all three the same weight, and the art is what a player
 * actually recognises mid-game — the token, not the name.
 *
 * Returns null if nothing renders, so callers can fall back to text.
 */
async function renderTokenRow(roleIds) {
  const roles = roleIds.map((id) => rolesById.get(id)).filter(Boolean);
  if (!roles.length) return null;

  const d = 190;
  const gap = d * 0.3;
  const padX = d * 0.4;
  const padTop = d * 0.3;
  // Room under the discs for the two stacked lines drawToken writes there.
  const nameBand = d * 0.62;
  const width = Math.round(padX * 2 + roles.length * d + (roles.length - 1) * gap);
  const height = Math.round(padTop + d + nameBand);

  const canvas = createCanvas(Math.round(width * SUPERSAMPLE), Math.round(height * SUPERSAMPLE));
  const ctx = canvas.getContext('2d');
  ctx.scale(SUPERSAMPLE, SUPERSAMPLE);
  ctx.imageSmoothingQuality = 'high';

  // No town behind these — they are tokens held in a hand, not seats on a board.
  const bg = ctx.createLinearGradient(0, 0, 0, height);
  bg.addColorStop(0, PALETTE.night.bgInner);
  bg.addColorStop(1, PALETTE.night.bgOuter);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  const [token, icons] = await Promise.all([
    getAsset('token'),
    Promise.all(roles.map((r) => getIcon(r.id))),
  ]);

  roles.forEach((role, i) => {
    drawToken(ctx, {
      cx: padX + d / 2 + i * (d + gap),
      cy: padTop + d / 2,
      d,
      role,
      icon: icons[i],
      // No seat behind these, so the token carries the character's own name and
      // its team where a seat would have carried the player's.
      player: { name: role.name, alive: true },
      subtitle: TEAM_LABEL[role.team] ?? role.team,
      out: 1,
      reveal: true,
      token,
    });
  });

  return canvas.encode('png');
}

module.exports = { renderGrimoire, renderTokenRow, getIcon };
