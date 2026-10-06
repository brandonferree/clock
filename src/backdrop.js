// Procedural spooky-town backdrop: sky, moon, fog, a rooftop skyline and the
// clocktower itself. Drawn rather than sourced so every tone is under our
// control — the tokens and labels on top have to stay readable, which means the
// scene must stay dark, low-contrast and free of clutter behind the centre.

/** Deterministic PRNG, so the town looks identical every render. */
function rng(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const THEME = {
  night: {
    skyTop: '#05060d',
    skyMid: '#131a33',
    skyLow: '#2a2b45',
    far: '#161a2c',
    near: '#080a12',
    fog: 'rgba(120,135,180,0.10)',
    window: 'rgba(255,196,92,0.85)',
    moon: 'rgba(226,232,255,0.95)',
    moonGlow: 'rgba(150,175,255,0.20)',
    face: 'rgba(255,214,130,0.92)',
    stars: 0.9,
  },
  day: {
    // Still overcast and moody — this is a town with a body count.
    skyTop: '#141c30',
    skyMid: '#38394f',
    skyLow: '#5c4f52',
    far: '#2c2f44',
    near: '#14161f',
    fog: 'rgba(200,190,195,0.13)',
    window: 'rgba(255,214,140,0.45)',
    moon: null,
    moonGlow: null,
    face: 'rgba(250,238,210,0.85)',
    stars: 0,
  },
};

/** A jagged run of rooftops across the width, returned as a fill path. */
function skyline(ctx, { w, baseY, height, rand, color, seed }) {
  const r = rng(seed);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, baseY + height);
  let x = -20;
  const roofs = [];
  while (x < w + 20) {
    const bw = 40 + r() * 90;
    const bh = height * (0.35 + r() * 0.65);
    const top = baseY + height - bh;
    roofs.push({ x, w: bw, top });
    if (r() < 0.35) {
      // Pitched roof.
      ctx.lineTo(x, top + bh * 0.25);
      ctx.lineTo(x + bw / 2, top);
      ctx.lineTo(x + bw, top + bh * 0.25);
      ctx.lineTo(x + bw, baseY + height);
    } else {
      ctx.lineTo(x, top);
      ctx.lineTo(x + bw, top);
      ctx.lineTo(x + bw, baseY + height);
    }
    x += bw;
  }
  ctx.lineTo(w + 20, baseY + height);
  ctx.closePath();
  ctx.fill();
  return roofs;
}

/** The clocktower: a tall silhouette with a lit face and a spire. */
function clocktower(ctx, { x, baseY, h, theme, faceR }) {
  const w = Math.max(h * 0.19, faceR * 2.9);
  const left = x - w / 2;

  ctx.fillStyle = theme.near;
  // Body.
  ctx.fillRect(left, baseY - h, w, h);
  // Belfry, slightly wider than the shaft.
  const belfryH = h * 0.1;
  ctx.fillRect(left - w * 0.12, baseY - h - belfryH * 0.4, w * 1.24, belfryH);
  // Spire.
  ctx.beginPath();
  ctx.moveTo(left - w * 0.16, baseY - h - belfryH * 0.4);
  ctx.lineTo(x, baseY - h - belfryH * 0.4 - h * 0.3);
  ctx.lineTo(left + w + w * 0.16, baseY - h - belfryH * 0.4);
  ctx.closePath();
  ctx.fill();

  // Clock face, glowing faintly against the dark stone.
  const fr = faceR ?? w * 0.34;
  const fy = baseY - h + h * 0.17;
  const glow = ctx.createRadialGradient(x, fy, fr * 0.2, x, fy, fr * 2.6);
  glow.addColorStop(0, 'rgba(255,206,120,0.20)');
  glow.addColorStop(1, 'rgba(255,206,120,0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(x, fy, fr * 2.6, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = theme.face;
  ctx.beginPath();
  ctx.arc(x, fy, fr, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(20,16,12,0.85)';
  ctx.lineWidth = Math.max(1.5, fr * 0.12);
  ctx.stroke();

  // Hands at a deliberately ominous hour.
  ctx.strokeStyle = 'rgba(20,16,12,0.9)';
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(1.5, fr * 0.14);
  ctx.beginPath();
  ctx.moveTo(x, fy);
  ctx.lineTo(x, fy - fr * 0.62);
  ctx.moveTo(x, fy);
  ctx.lineTo(x + fr * 0.42, fy + fr * 0.3);
  ctx.stroke();
  ctx.lineCap = 'butt';

  // A couple of lit belfry openings.
  ctx.fillStyle = theme.window;
  const ow = w * 0.14;
  ctx.fillRect(x - w * 0.3, baseY - h - belfryH * 0.2, ow, belfryH * 0.6);
  ctx.fillRect(x + w * 0.16, baseY - h - belfryH * 0.2, ow, belfryH * 0.6);
}

/**
 * Paint the whole backdrop into a square canvas of `size`.
 * Keeps the middle band quiet so the centre plate stays legible.
 *
 * `ring`/`tokenR` describe where the seats will be drawn, so the clock face can
 * be placed in the empty corner beyond them — otherwise it lands behind a token
 * and the one landmark in the scene is invisible.
 */
function drawBackdrop(ctx, size, night, { ring = 0, tokenR = 0 } = {}) {
  const theme = night ? THEME.night : THEME.day;
  const w = size;
  const h = size;

  // Sky.
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, theme.skyTop);
  sky.addColorStop(0.55, theme.skyMid);
  sky.addColorStop(1, theme.skyLow);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  const r = rng(20260812);

  // Stars, thinning out towards the horizon haze.
  if (theme.stars) {
    for (let i = 0; i < 220; i++) {
      const sx = r() * w;
      const sy = r() * h * 0.6;
      const a = (1 - sy / (h * 0.6)) * theme.stars * (0.25 + r() * 0.75);
      ctx.fillStyle = `rgba(226,232,255,${a.toFixed(3)})`;
      const rad = r() < 0.12 ? 1.6 : 0.9;
      ctx.beginPath();
      ctx.arc(sx, sy, rad, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Moon, pushed well into the corner so it never crowds the seat ring or sits
  // behind the centre text. A half moon rather than a full one: the flat
  // terminator gives the sky a shape instead of another plain disc, and it reads
  // as a moon at a glance even this small.
  if (theme.moon) {
    const mx = w * 0.88;
    const my = h * 0.095;
    const mr = size * 0.05;
    // The lit half is the right-hand one — a semicircle whose closing edge is
    // the straight terminator down the middle.
    const litHalf = () => {
      ctx.beginPath();
      ctx.arc(mx, my, mr, -Math.PI / 2, Math.PI / 2);
      ctx.closePath();
    };

    const g = ctx.createRadialGradient(mx, my, mr * 0.5, mx, my, mr * 6);
    g.addColorStop(0, theme.moonGlow);
    g.addColorStop(1, 'rgba(150,175,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(mx, my, mr * 6, 0, Math.PI * 2);
    ctx.fill();

    // Earthshine: the unlit half, barely there, so the moon still reads round.
    ctx.fillStyle = 'rgba(200,212,255,0.07)';
    ctx.beginPath();
    ctx.arc(mx, my, mr, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = theme.moon;
    litHalf();
    ctx.fill();

    // A few faint maria, clipped to the lit half so none float in the shadow.
    ctx.save();
    litHalf();
    ctx.clip();
    ctx.fillStyle = 'rgba(150,160,200,0.35)';
    for (const [ox, oy, orad] of [
      [0.16, -0.28, 0.22],
      [0.42, 0.16, 0.18],
      [0.1, 0.44, 0.15],
      [0.6, -0.3, 0.11],
    ]) {
      ctx.beginPath();
      ctx.arc(mx + mr * ox, my + mr * oy, mr * orad, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // Far skyline, hazy.
  const farBase = h * 0.6;
  ctx.save();
  ctx.globalAlpha = 0.75;
  skyline(ctx, { w, baseY: farBase, height: h * 0.16, color: theme.far, seed: 991 });
  ctx.restore();

  // Fog between the two skylines.
  const fog1 = ctx.createLinearGradient(0, farBase + h * 0.06, 0, farBase + h * 0.2);
  fog1.addColorStop(0, theme.fog);
  fog1.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = fog1;
  ctx.fillRect(0, farBase + h * 0.04, w, h * 0.2);

  // The tower. Its clock face is aimed at the lower-left corner, just outside
  // the seat ring, which is dead space at every player count — the seats form a
  // circle inscribed in a square, so the corners are always free.
  const faceR = size * 0.036;
  const clear = ring + tokenR + faceR + size * 0.03;
  const angle = Math.PI * 0.78; // down and to the left
  const faceX = w / 2 + Math.cos(angle) * clear;
  const faceY = h / 2 + Math.sin(angle) * clear;
  const towerBase = h * 1.04;
  // faceY sits 17% down the tower, so solve the height that puts it there.
  clocktower(ctx, {
    x: faceX,
    baseY: towerBase,
    h: (towerBase - faceY) / 0.83,
    theme,
    faceR,
  });

  // Near skyline, darkest, with scattered lit windows.
  const nearBase = h * 0.8;
  const roofs = skyline(ctx, { w, baseY: nearBase, height: h * 0.2, color: theme.near, seed: 4242 });
  const rw = rng(777);
  ctx.fillStyle = theme.window;
  for (const b of roofs) {
    const cols = Math.max(1, Math.floor(b.w / 34));
    for (let c = 0; c < cols; c++) {
      for (let row = 0; row < 3; row++) {
        if (rw() > 0.22) continue;
        const wx = b.x + 12 + c * 34;
        const wy = b.top + 18 + row * 30;
        if (wy > nearBase + h * 0.2 - 10) continue;
        ctx.fillRect(wx, wy, 7, 10);
      }
    }
  }

  // Ground fog rolling over the base of the town.
  const fog2 = ctx.createLinearGradient(0, nearBase + h * 0.02, 0, h);
  fog2.addColorStop(0, 'rgba(0,0,0,0)');
  fog2.addColorStop(0.55, theme.fog);
  fog2.addColorStop(1, night ? 'rgba(90,105,150,0.16)' : 'rgba(200,190,195,0.18)');
  ctx.fillStyle = fog2;
  ctx.fillRect(0, nearBase, w, h - nearBase);

  // Vignette: pulls the eye inward and buys contrast for the outer labels.
  const vig = ctx.createRadialGradient(w / 2, h / 2, size * 0.28, w / 2, h / 2, size * 0.75);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, w, h);

  // Scrim across the middle band, so the centre plate always has something
  // dark and even behind it no matter what the skyline is doing.
  const scrim = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, size * 0.3);
  scrim.addColorStop(0, 'rgba(4,6,14,0.72)');
  scrim.addColorStop(0.7, 'rgba(4,6,14,0.35)');
  scrim.addColorStop(1, 'rgba(4,6,14,0)');
  ctx.fillStyle = scrim;
  ctx.fillRect(0, 0, w, h);
}

module.exports = { drawBackdrop };
