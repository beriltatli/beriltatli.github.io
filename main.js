// The hero: a koi pond drawn as ordered-dither pixel art. The water, the koi and the things
// floating on the water are separate layers, each dithered along its own colour ramp. The water
// moves, and the koi swim, steering round everything on the surface rather than under it.
(() => {
  const wrap = document.getElementById('scene');
  if (!wrap) return;
  const waterCv = wrap.querySelector('.layer-water');
  const koiCv = wrap.querySelector('.layer-koi');
  const floatCv = wrap.querySelector('.layer-float');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const PS = 3; // CSS pixels per art pixel

  /* ---------- Dither primitives ---------- */

  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(v => (v + 0.5) / 16);
  const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const ramp = cs => cs.map(rgb);

  // Green pond water that deepens to teal, with pale glints; lily pads, lotuses in three tones,
  // white blossoms with red hearts, a dark stacked stone and kohaku koi.
  const RAMPS = {
    water: ramp(['#0a2622', '#0f342c', '#154536', '#1d5841', '#276b4b', '#357f56', '#4c9463', '#6caa72', '#97c288']),
    glint: ramp(['#8fc4a6', '#b9dcc3', '#e3f1e2']),
    pad: ramp(['#2a4415', '#41651d', '#5d8627', '#7fa532', '#a4c247', '#cbdf78']),
    lotus: ramp(['#9a5577', '#c47c9e', '#e2a5c1', '#f4cfe0', '#fff0f6']),
    lotusDeep: ramp(['#6e2350', '#9c3a72', '#c45f95', '#e597bf', '#f8d6e7']),
    lotusPale: ramp(['#a8919e', '#d8c4cf', '#f1e6ec', '#fdf8fa', '#ffffff']),
    lotusHeart: ramp(['#c9821f', '#e8a93a', '#f6d36b']),
    petal: ramp(['#c9b8b2', '#eadbd6', '#fbf1ee', '#ffffff']),
    petalHeart: ramp(['#a92b1c', '#d8452c', '#f0703f']),
    stone: ramp(['#16191d', '#23282e', '#323840', '#454c55', '#5c646d', '#7b838c', '#9aa2aa']),
    white: ramp(['#a9a6a2', '#d3cfc9', '#f2efe9', '#ffffff']),
    orange: ramp(['#a8311a', '#d9461f', '#f2612a', '#ff8c4f']),
    fin: ramp(['#aaa6b8', '#d3cfde', '#efecf5']),
  };

  const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);

  function put(d, i, colors, t, threshold) {
    const n = colors.length - 1;
    const v = clamp01(t) * n;
    let k = Math.floor(v);
    if (v - k > threshold) k++;
    if (k > n) k = n;
    const c = colors[k];
    d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255;
  }

  function hash(x, y, s) {
    let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 982451653);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  function noise(x, y, s) {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = hash(xi, yi, s), b = hash(xi + 1, yi, s), c = hash(xi, yi + 1, s), d = hash(xi + 1, yi + 1, s);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  function fbm(x, y, s, oct = 3) {
    let sum = 0, amp = 0.5, norm = 0;
    for (let o = 0; o < oct; o++) { sum += noise(x, y, s + o * 17) * amp; norm += amp; x *= 2.03; y *= 2.03; amp *= 0.5; }
    return sum / norm;
  }

  /* ---------- Layout ---------- */

  // The pond is seen from a little above, so every circle on the water is squashed.
  const Q = 0.66;

  // A seeded random sequence (mulberry32), so the scatter comes out the same on every visit.
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), a | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Where everything floats, in art pixels. U keeps round things round on any frame.
  //
  // The pads are scattered, not placed. Spots are drawn at random across the pond; each grows a
  // pad, or a small clump of two or three that may touch and overlap. Most pads carry a lotus,
  // the big ones sometimes two, and a few closed buds and white blossoms drift between them.
  //
  // Open water has to stay swimmable: between clumps (and round the stone) a lane is left wide
  // enough for a koi, so the scatter can never wall the fish into a pocket. Nothing grows under
  // the menu along the top edge.
  function scene(W, H) {
    const U = Math.min(W, H * 1.25);
    const stone = { x: W * 0.84, y: H * 0.27, r: U * 0.13 };
    // pads never shrink below a comfortable size on small screens, so they read as pads
    const P = Math.max(U, 190);
    const rand = rng(1872);
    // a koi's width plus room to spare, and a few pixels for the coarse grid it steers on
    const lane = U * 0.17 + 8, menu = 27;
    const nearStone = (x, y, r) => Math.hypot(x - stone.x, (y - stone.y) / Q) < stone.r * 1.3 + r;
    const crowded = (list, x, y, r) => list.some(p => Math.hypot(x - p.x, (y - p.y) / Q) < r + p.r + lane);

    const pads = [];
    let clumps = 0;
    for (let n = 0; n < 6000 && clumps < 12; n++) {
      const u = 0.02 + rand() * 0.96, v = 0.04 + rand() * 0.94, k = rand();
      const members = 1 + (k < 0.8 ? 1 : 0) + (k < 0.5 ? 1 : 0) + (k < 0.25 ? 1 : 0) + (k < 0.08 ? 1 : 0);
      const clump = [];
      for (let m = 0; m < members; m++) {
        const r = P * (0.042 + 0.055 * rand()), oa = rand() * Math.PI * 2, turn = rand();
        const host = clump[Math.floor(rand() * clump.length)];
        const od = m ? (host.r + r) * (0.7 + 0.15 * rand()) : 0;
        const cx = m ? host.x : W * u, cy = m ? host.y : H * v;
        clump.push({ x: cx + Math.cos(oa) * od, y: cy + Math.sin(oa) * od * Q, r, a: turn * Math.PI * 2 });
      }
      if (clump.some(p => p.y - p.r * Q < menu || nearStone(p.x, p.y, p.r + lane) || crowded(pads, p.x, p.y, p.r))) continue;
      pads.push(...clump);
      clumps++;
    }

    const tones = ['lotus', 'lotus', 'lotusPale', 'lotusDeep'];
    const lotuses = [], buds = [];
    const bloom = (p, k, off, oa, a, tone) => lotuses.push({ x: p.x + Math.cos(oa) * off, y: p.y + Math.sin(oa) * off * Q, r: p.r * k, a, tone });
    for (const p of pads) {
      const [l1, l2, l3, l4, l5, l6, l7, l8, b1, b2, b3] = Array.from({ length: 11 }, rand);
      const pick = (t) => tones[Math.floor(t * 97) % tones.length];
      if (l1 < 0.95) bloom(p, 0.42 + 0.2 * l2, p.r * 0.3 * l3, l4 * Math.PI * 2, l5 * Math.PI, pick(l6));
      // mid-sized and big pads often open a second, smaller flower, the biggest now and then a third
      if (p.r > P * 0.058 && l7 < 0.65) bloom(p, 0.3 + 0.06 * l8, p.r * 0.52, l4 * Math.PI * 2 + Math.PI * (0.8 + 0.4 * l8), l5 * Math.PI + 1, pick(l7));
      if (p.r > P * 0.08 && l8 < 0.4) bloom(p, 0.24, p.r * 0.55, l4 * Math.PI * 2 + Math.PI * 0.45, l5 * Math.PI + 2, pick(l8));
      if (b1 < 0.28) {
        const oa = b2 * Math.PI * 2;
        buds.push({ x: p.x + Math.cos(oa) * p.r * 0.62, y: p.y + Math.sin(oa) * p.r * 0.62 * Q, r: P * (0.018 + 0.01 * b3), a: oa + Math.PI / 2 + (b3 - 0.5), tone: b3 > 0.5 ? 'lotus' : 'lotusDeep' });
      }
    }

    // a few white blossoms adrift in the open water
    const blossoms = [];
    for (let n = 0; n < 800 && blossoms.length < 3; n++) {
      const u = 0.05 + rand() * 0.9, v = 0.08 + rand() * 0.86, size = rand(), turn = rand();
      const x = W * u, y = H * v, r = P * (0.026 + 0.014 * size);
      if (y - r * Q < menu || nearStone(x, y, r + lane) || crowded([...pads, ...blossoms], x, y, r)) continue;
      blossoms.push({ x, y, r, a: turn * Math.PI * 2 });
    }

    // the water laps at the stone and the larger pads, sending rings out from each on its own beat
    const emitters = [
      { x: stone.x, y: stone.y + stone.r * 0.3, r0: stone.r * 1.12, span: stone.r * 0.9, period: 3.4, k: 0.9 },
      ...[...pads].sort((p, q) => q.r - p.r).slice(0, 9).map((p, n) => ({ x: p.x, y: p.y, r0: p.r * 1.1, span: p.r * 0.75, period: 4.6 + n * 0.8, k: 0.5 })),
    ];
    return { U, stone, pads, lotuses, buds, blossoms, emitters };
  }

  /* ---------- Water ---------- */

  // Everything about the water that does not move is worked out once per size: the depth and
  // mottling, the pad shadows, and a field of flat sparkles. Each frame then adds what does
  // move: two crossing swells, sparkles sliding along their rows and twinkling, the stone's
  // reflection wavering, and rings spreading from the stone, the pads, falling drops and koi.

  function shadow(x, y, S) {
    let v = 0;
    for (const p of S.pads) {
      const e = Math.hypot(x - p.x - p.r * 0.14, (y - p.y - p.r * 0.22) / Q);
      v = Math.max(v, clamp01((p.r * 1.02 - e) / 2.5));
    }
    for (const b of [...S.blossoms, ...S.lotuses, ...S.buds]) {
      const e = Math.hypot(x - b.x - 1, (y - b.y - 2) / Q);
      v = Math.max(v, clamp01((b.r * 1.05 - e) / 2) * 0.7);
    }
    return v;
  }

  let WT = null;

  function buildWater(W, H, S) {
    waterCv.width = W; waterCv.height = H;
    const base = new Float32Array(W * H), spark = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        // lighter where the sky reflects at the far edge, deeper towards the viewer
        let t = 0.68 - 0.38 * (y / H);
        t += (fbm(x * 0.03, y * 0.05, 21) - 0.5) * 0.36;
        t += (fbm(x * 0.12, y * 0.12, 5) - 0.5) * 0.06;
        base[i] = t - shadow(x, y, S) * 0.3;
        // sparkles are stretched flat along rows; blending with a copy one width over makes
        // the field wrap seamlessly, so each row can slide sideways for ever
        const u = x / W;
        spark[i] = (1 - u) * fbm(x * 0.045, y * 0.7, 33, 2) + u * fbm((x - W) * 0.045, y * 0.7, 33, 2);
      }
    }
    const sx1 = new Float32Array(W), cx1 = new Float32Array(W), sx2 = new Float32Array(W), cx2 = new Float32Array(W);
    for (let x = 0; x < W; x++) { sx1[x] = Math.sin(x * 0.07); cx1[x] = Math.cos(x * 0.07); sx2[x] = Math.sin(x * 0.13); cx2[x] = Math.cos(x * 0.13); }
    const rowSpeed = new Float32Array(H);
    for (let y = 0; y < H; y++) rowSpeed[y] = (2.5 + hash(y, 7, 51) * 3) * (hash(y >> 3, 9, 52) > 0.5 ? 1 : -1);
    const ctx = waterCv.getContext('2d');
    WT = { W, H, S, base, spark, sx1, cx1, sx2, cx2, rowSpeed, ctx, im: ctx.createImageData(W, H), drops: [], nextDrop: 0, lastWake: [] };
  }

  // A spreading ring, broken into arcs, fading as it grows.
  function ring(d, W, H, cx, cy, r, k, seed) {
    if (r < 1 || k <= 0.02) return;
    const n = Math.ceil(r * 7);
    for (let j = 0; j < n; j++) {
      const a = j / n * Math.PI * 2;
      if (noise(a * 2.5 + seed, r * 0.08, 8) < 0.4) continue;
      const x = Math.round(cx + Math.cos(a) * r), y = Math.round(cy + Math.sin(a) * r * Q);
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      if (k < 0.35 && hash(x, y, seed | 0) > k / 0.35) continue;
      put(d, (y * W + x) * 4, RAMPS.glint, k, BAYER[((y & 3) << 2) | (x & 3)]);
    }
  }

  function drawWater(time) {
    if (!WT) return;
    const { W, H, S, base, spark, sx1, cx1, sx2, cx2, rowSpeed, im } = WT;
    const d = im.data, s = S.stone;
    const ry0 = Math.floor(s.y), ry1 = Math.min(H - 1, Math.ceil(s.y + s.r * 1.5));
    for (let y = 0; y < H; y++) {
      // two swells crossing at an angle, each split into its x and y halves
      const b1 = y * 0.18 - time * 0.9, b2 = -y * 0.09 + time * 1.3;
      const sy1 = Math.sin(b1), cy1 = Math.cos(b1), sy2 = Math.sin(b2), cy2 = Math.cos(b2);
      const off = Math.floor(time * rowSpeed[y]);
      const inRefl = y > ry0 && y <= ry1, band = ((y + Math.floor(time * 3)) >> 1) & 1;
      const wob = Math.sin(y * 0.8 + time * 2.4) * 1.3;
      for (let x = 0; x < W; x++) {
        const i = y * W + x, o = i * 4;
        const th = BAYER[((y & 3) << 2) | (x & 3)];
        let t = base[i] + 0.06 * (sx1[x] * cy1 + cx1[x] * sy1) + 0.04 * (sx2[x] * cy2 + cx2[x] * sy2);
        if (inRefl) {
          const ex = (x - s.x + wob) / (s.r * 0.95), ey = (y - s.y - s.r * 0.75) / (s.r * 0.75);
          if (ex * ex + ey * ey < 1) t -= (band ? 0.95 : 0.7) * 0.3;
        }
        let sx = (x + off) % W; if (sx < 0) sx += W;
        const sn = spark[y * W + sx];
        const thr = 0.74 + 0.05 * Math.sin(x * 0.09 + y * 0.5 - time * 1.6);
        if (sn > thr && hash(sx >> 2, y, 3) > 0.45) put(d, o, RAMPS.glint, (sn - thr) * 3.5, th);
        else put(d, o, RAMPS.water, t, th);
      }
    }
    // rings lapping out from the stone and the pads, three alive at a time on each
    S.emitters.forEach((e, n) => {
      for (let m = 0; m < 3; m++) {
        const age = ((time / e.period + n * 0.37 + m / 3) % 1 + 1) % 1;
        ring(d, W, H, e.x, e.y, e.r0 + e.span * age, e.k * (1 - age), n * 13 + m);
      }
    });
    // now and then something touches the surface in open water
    if (time >= WT.nextDrop) {
      for (let n = 0; n < 12; n++) {
        const x = W * (0.06 + 0.88 * Math.random()), y = H * (0.08 + 0.84 * Math.random());
        if (shadow(x, y, S) > 0 || (K && K.obstacles.some(ob => clearance(ob, x, y) < 4))) continue;
        WT.drops.push({ x, y, t0: time, life: 2.6, size: S.U * (0.05 + Math.random() * 0.04), seed: Math.random() * 100 });
        break;
      }
      WT.nextDrop = time + 0.8 + Math.random() * 1.6;
    }
    // and each koi swimming near the top leaves a soft ring behind its head
    if (K) K.fish.forEach((f, j) => {
      if (time - (WT.lastWake[j] || -9) < 1.4) return;
      WT.lastWake[j] = time;
      WT.drops.push({ x: f.x, y: f.y, t0: time, life: 1.8, size: f.L * 0.28, seed: j * 7 + time, k: 0.45 });
    });
    WT.drops = WT.drops.filter(p => time - p.t0 < p.life);
    for (const p of WT.drops) {
      for (let m = 0; m < 2; m++) {
        const age = (time - p.t0 - m * 0.35) / p.life;
        if (age > 0 && age < 1) ring(d, W, H, p.x, p.y, p.size * age, (p.k || 0.75) * (1 - age), p.seed + m);
      }
    }
    WT.ctx.putImageData(im, 0, 0);
  }

  /* ---------- On the water: stone, pads, lotus, blossoms ---------- */

  function renderFloat(W, H, S) {
    floatCv.width = W; floatCv.height = H;
    const ctx = floatCv.getContext('2d');
    const im = ctx.createImageData(W, H);
    const d = im.data;
    const box = (cx, cy, rx, ry, fn) => {
      for (let y = Math.max(0, Math.floor(cy - ry)); y <= Math.min(H - 1, Math.ceil(cy + ry)); y++) {
        for (let x = Math.max(0, Math.floor(cx - rx)); x <= Math.min(W - 1, Math.ceil(cx + rx)); x++) {
          fn(x, y, (y * W + x) * 4, BAYER[((y & 3) << 2) | (x & 3)]);
        }
      }
    };

    // The stone: five slabs, each a squashed disc with a side, stacked smaller to the top.
    const s = S.stone;
    for (let j = 0; j < 5; j++) {
      const rx = s.r * (1 - j * 0.17), ry = rx * 0.42, side = s.r * 0.13;
      const cy = s.y - j * s.r * 0.21;
      box(s.x, cy + side / 2, rx, ry + side, (x, y, i, th) => {
        const u = (x - s.x) / rx;
        if (Math.abs(u) > 1) return;
        const half = ry * Math.sqrt(1 - u * u);
        if (y < cy - half || y > cy + side + half) return;
        let t;
        if (y <= cy + half) t = 0.78 - 0.3 * ((y - (cy - half)) / (2 * half + 0.01)) - u * 0.08;
        else t = 0.38 - 0.22 * ((y - cy - half) / (side + 0.01)) - u * 0.1;
        if (y > cy + side + half - 1.2) t = 0.05;
        if (Math.abs(y - (cy - half)) < 0.8) t = 0.95;
        put(d, i, RAMPS.stone, t + (hash(x, y, 4) - 0.5) * 0.08, th);
      });
    }

    // Lily pads, each with its notch and pale veins, lit from the upper left.
    for (const p of S.pads) {
      box(p.x, p.y, p.r, p.r * Q, (x, y, i, th) => {
        const dx = x - p.x, dy = (y - p.y) / Q, e = Math.hypot(dx, dy);
        if (e > p.r) return;
        const ang = Math.atan2(dy, dx);
        let off = Math.abs(((ang - p.a + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        if (off < 0.26 && e > p.r * 0.06) return;
        let t = 0.55 - (dx * 0.6 + dy * 0.8) / p.r * 0.22;
        const vein = ((ang - p.a + Math.PI * 4) % (Math.PI * 2 / 11));
        if (vein < 0.07 && e > p.r * 0.14) t += 0.2;
        t += (fbm(x * 0.2, y * 0.2, 6, 2) - 0.5) * 0.14;
        if (e > p.r - 1.2) t = 0.1;
        put(d, i, RAMPS.pad, t, th);
      });
    }

    // Five-petalled flowers seen from above: an outer ring of petals, a turned inner ring, a heart.
    const flower = (f, petals, heart, inner) => {
      box(f.x, f.y, f.r, f.r * Q, (x, y, i, th) => {
        const dx = x - f.x, dy = (y - f.y) / Q, e = Math.hypot(dx, dy);
        const ang = Math.atan2(dy, dx) - f.a;
        const outer = f.r * (0.5 + 0.5 * Math.pow(Math.abs(Math.cos(2.5 * ang)), 0.7));
        const innerR = f.r * inner * (0.5 + 0.5 * Math.pow(Math.abs(Math.cos(2.5 * ang + Math.PI / 2)), 0.7));
        if (e <= f.r * 0.2) { put(d, i, heart, 0.75 - (dx + dy) / f.r, th); return; }
        if (inner && e <= innerR) { put(d, i, petals, 0.95 - e / innerR * 0.35, th); return; }
        if (e > outer) return;
        let t = 0.45 + 0.4 * (1 - e / outer) - (dx * 0.4 + dy * 0.6) / f.r * 0.25;
        if (e > outer - 1) t -= 0.3;
        put(d, i, petals, t, th);
      });
    };
    S.blossoms.forEach(b => flower(b, RAMPS.petal, RAMPS.petalHeart, 0));

    // Lotuses from above: eight pointed outer petals, eight more turned between them, and a
    // yellow seed head. Petals are palest at the base and deepen towards their tips.
    for (const f of S.lotuses) {
      const petals = RAMPS[f.tone];
      box(f.x, f.y, f.r, f.r * Q, (x, y, i, th) => {
        const dx = x - f.x, dy = (y - f.y) / Q, e = Math.hypot(dx, dy);
        const ang = Math.atan2(dy, dx) - f.a;
        const po = Math.abs(Math.cos(4 * ang)), pi = Math.abs(Math.cos(4 * ang + Math.PI / 2));
        const outer = f.r * (0.42 + 0.58 * Math.pow(po, 1.8));
        const inner = f.r * 0.68 * (0.45 + 0.55 * Math.pow(pi, 1.4));
        const light = -(dx * 0.4 + dy * 0.6) / f.r * 0.2;
        if (e <= f.r * 0.2) {
          let t = 0.7 - (dx + dy) / f.r;
          if (hash(x, y, 61) > 0.72) t -= 0.45; // the seed holes
          put(d, i, RAMPS.lotusHeart, t, th);
          return;
        }
        if (e <= inner) {
          let t = 0.95 - 0.4 * (e / inner) + light;
          if (pi > 0.985) t += 0.08;
          if (e > inner - 1) t -= 0.25;
          put(d, i, petals, t, th);
          return;
        }
        if (e > outer) return;
        let t = 0.85 - 0.55 * (e / outer) + light;
        if (po > 0.985) t += 0.1;
        if (e > outer - 1) t -= 0.3;
        put(d, i, petals, t, th);
      });
    }

    // Closed buds: a pointed lens of folded petals on a green cup.
    for (const b of S.buds) {
      const ca = Math.cos(b.a), sa = Math.sin(b.a);
      box(b.x, b.y, b.r, b.r * Q, (x, y, i, th) => {
        const dx = x - b.x, dy = (y - b.y) / Q;
        const u = (dx * ca + dy * sa) / b.r, v = (-dx * sa + dy * ca) / b.r;
        if (Math.abs(u) > 1 || Math.abs(v) > 0.44 * (1 - u * u)) return;
        if (u < -0.62) { put(d, i, RAMPS.pad, 0.55 - v, th); return; }
        let t = 0.75 - 0.45 * u - v * 0.4;
        if (Math.abs(v) < 0.05) t -= 0.25;
        put(d, i, RAMPS[b.tone], t, th);
      });
    }

    ctx.putImageData(im, 0, 0);
  }

  /* ---------- Koi ---------- */

  // Two koi wander the open water, each following a path round the stone, the pads and the
  // flowers to a spot it has picked. The body follows the trail the head has swum, so keeping
  // the head clear keeps the whole fish clear.
  //
  // Under the steering sits a hard rule: a fish only ever steps onto open water. If the step
  // straight ahead is blocked it takes the nearest open heading instead. Turning back along its
  // own trail is always open, so a fish can be slowed by a tight spot but never stopped.
  const N = 16, STEP = 1 / 30;

  function makeKoi(W, H, S, hide) {
    const s = S.stone;
    const obstacles = [
      { x: s.x, y: s.y, r: s.r * 1.05 },
      { x: s.x, y: s.y - s.r * 0.55, r: s.r * 0.8 },
      ...S.pads, ...S.lotuses, ...S.buds, ...S.blossoms,
    ];
    const fish = [
      { seed: 1, len: 0.2, x: W * 0.55, y: H * 0.5, a: 0.4 },
      { seed: 2, len: 0.18, x: W * 0.3, y: H * 0.8, a: 3.4 },
    ].map(f => ({ ...f, L: S.U * f.len, trail: [] }));
    const k = { W, H, obstacles, fish, hide, t: 0, acc: 0 };
    // start each fish on the open water nearest to where it was placed
    for (const f of fish) {
      for (let r = 0; r < Math.max(W, H) && !isFree(k, f, f.x, f.y); r += 2) {
        for (let j = 0; j < 32; j++) {
          const x = f.x + Math.cos(j / 32 * Math.PI * 2) * r, y = f.y + Math.sin(j / 32 * Math.PI * 2) * r;
          if (isFree(k, f, x, y)) { f.x = x; f.y = y; break; }
        }
      }
    }
    fish.forEach(f => {
      buildGrid(k, f);
      // start in the largest stretch of connected water, not in a pool inside the lotus bed
      const G = f.grid, seen = new Int32Array(G.cols * G.rows).fill(-1);
      let biggest = -1, biggestSize = 0;
      for (let c = 0; c < seen.length; c++) {
        if (!G.free[c] || seen[c] >= 0) continue;
        const reach = bfs(G, c);
        let size = 0;
        for (let m = 0; m < reach.length; m++) if (reach[m] >= 0) { seen[m] = c; size++; }
        if (size > biggestSize) { biggestSize = size; biggest = c; }
      }
      if (biggest >= 0 && seen[cellAt(G, f.x, f.y)] !== biggest) {
        let best = Infinity;
        for (let c = 0; c < seen.length; c++) {
          if (seen[c] !== biggest) continue;
          const x = (c % G.cols + 0.5) * G.g, y = (((c / G.cols) | 0) + 0.5) * G.g, d = Math.hypot(x - f.x, y - f.y);
          if (d < best) { best = d; f.nx = x; f.ny = y; }
        }
        f.x = f.nx; f.y = f.ny;
      }
    });
    // let them settle into the pond before anyone sees it
    for (let i = 0; i < 20 / STEP; i++) stepKoi(k);
    return k;
  }

  // How far a point is outside an obstacle, measured on the squashed pond surface.
  const clearance = (o, x, y) => Math.hypot(x - o.x, (y - o.y) / Q) - o.r;

  // Each fish swims towards a spot of open water and picks a new one when it gets there. The
  // pond is laid out as a coarse grid of cells the fish may stand in; a breadth-first search
  // over it finds the real way round the pads and the stone, so a fish follows the path rather
  // than nosing into a dead end towards a goal it cannot reach in a straight line. Goals are
  // only ever picked where the fish can get to, and never behind the name card.
  const NB = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

  function buildGrid(k, f) {
    const g = 4, cols = Math.ceil(k.W / g), rows = Math.ceil(k.H / g);
    const free = new Uint8Array(cols * rows);
    // a cell counts as open only if every point in it is, so any path on the grid can be swum
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) free[r * cols + c] = isFree(k, f, (c + 0.5) * g, (r + 0.5) * g, g * 0.75) ? 1 : 0;
    // how many cells each open cell is from the nearest blocked one, so paths can keep off
    // the pads instead of brushing along them
    const clear = new Uint8Array(cols * rows).fill(255), q = new Int32Array(cols * rows);
    let h = 0, t = 0;
    for (let c = 0; c < cols * rows; c++) if (!free[c]) { clear[c] = 0; q[t++] = c; }
    while (h < t) {
      const c = q[h++], cx = c % cols, cy = (c / cols) | 0;
      for (const [ox, oy] of NB.slice(0, 4)) {
        const nx = cx + ox, ny = cy + oy, m = ny * cols + nx;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows || clear[m] <= clear[c] + 1) continue;
        clear[m] = clear[c] + 1; q[t++] = m;
      }
    }
    f.grid = { g, cols, rows, free, clear };
  }

  // Cheapest way from one cell to every other: a step costs more the closer it runs to
  // something on the water, so the routes found are roomy ones. Unreachable cells get -1.
  function bfs(G, start) {
    const n = G.cols * G.rows, dist = new Float64Array(n).fill(Infinity);
    const heap = [[0, start]];
    dist[start] = 0;
    const push = (e) => { heap.push(e); let i = heap.length - 1; while (i) { const p = (i - 1) >> 1; if (heap[p][0] <= e[0]) break; heap[i] = heap[p]; i = p; } heap[i] = e; };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { let i = 0; for (;;) { let m = i * 2 + 1; if (m >= heap.length) break; if (m + 1 < heap.length && heap[m + 1][0] < heap[m][0]) m++; if (heap[m][0] >= last[0]) break; heap[i] = heap[m]; i = m; } heap[i] = last; } return top; };
    while (heap.length) {
      const [dc, c] = pop();
      if (dc > dist[c]) continue;
      const cx = c % G.cols, cy = (c / G.cols) | 0;
      for (const [ox, oy] of NB) {
        const nx = cx + ox, ny = cy + oy;
        if (nx < 0 || ny < 0 || nx >= G.cols || ny >= G.rows) continue;
        const m = ny * G.cols + nx;
        if (!G.free[m]) continue;
        // no squeezing diagonally between two blocked cells
        if (ox && oy && (!G.free[cy * G.cols + nx] || !G.free[ny * G.cols + cx])) continue;
        const nd = dc + (ox && oy ? 1.41 : 1) * (1 + Math.max(0, 5 - G.clear[m]) * 1.2);
        if (nd < dist[m]) { dist[m] = nd; push([nd, m]); }
      }
    }
    for (let c = 0; c < n; c++) if (dist[c] === Infinity) dist[c] = -1;
    return dist;
  }

  // The free cell nearest to a point (the head can sit on a blocked cell's edge).
  function cellAt(G, x, y) {
    const cx = Math.floor(x / G.g), cy = Math.floor(y / G.g);
    for (let r = 0; r < 6; r++) {
      for (let oy = -r; oy <= r; oy++) for (let ox = -r; ox <= r; ox++) {
        const nx = cx + ox, ny = cy + oy;
        if (nx >= 0 && ny >= 0 && nx < G.cols && ny < G.rows && G.free[ny * G.cols + nx]) return ny * G.cols + nx;
      }
    }
    return Math.max(0, Math.min(G.cols * G.rows - 1, cy * G.cols + cx));
  }

  function pickGoal(k, f) {
    const G = f.grid, reach = bfs(G, cellAt(G, f.x, f.y)), h = k.hide;
    const far = Math.ceil(f.L * 1.5 / G.g);
    f.picks = (f.picks || 0) + 1;
    let goal = -1, best = -1;
    for (let n = 0; n < 80; n++) {
      const c = Math.floor(hash(f.picks, n, f.seed * 31) * G.cols * G.rows);
      if (reach[c] < far) continue;
      const x = (c % G.cols + 0.5) * G.g, y = (((c / G.cols) | 0) + 0.5) * G.g;
      if (h && x > h.x0 && x < h.x1 && y > h.y0 && y < h.y1) continue;
      goal = c; break;
    }
    if (goal < 0) for (let c = 0; c < reach.length; c++) if (reach[c] > best) { best = reach[c]; goal = c; }
    f.goal = [(goal % G.cols + 0.5) * G.g, (((goal / G.cols) | 0) + 0.5) * G.g];
    f.flow = bfs(G, goal);
    f.until = k.t + 45;
    f.best = Infinity; f.bestAt = k.t;
  }

  // Where to head next: walk the path downhill from the fish's cell a few steps, so turns are
  // taken early and wide, and the target is never on the far side of a pad.
  function nextOnPath(f) {
    const G = f.grid;
    let c = cellAt(G, f.x, f.y);
    if (f.flow[c] < 0) return [f.goal[0], f.goal[1], 99];
    for (let step = 0; step < 4; step++) {
      const cx = c % G.cols, cy = (c / G.cols) | 0;
      let next = c;
      for (const [ox, oy] of NB) {
        const nx = cx + ox, ny = cy + oy;
        if (nx < 0 || ny < 0 || nx >= G.cols || ny >= G.rows) continue;
        const m = ny * G.cols + nx;
        if (ox && oy && (!G.free[cy * G.cols + nx] || !G.free[ny * G.cols + cx])) continue;
        if (f.flow[m] >= 0 && f.flow[m] < f.flow[next]) next = m;
      }
      if (next === c) break;
      c = next;
    }
    return [(c % G.cols + 0.5) * G.g, (((c / G.cols) | 0) + 0.5) * G.g, f.flow[cellAt(G, f.x, f.y)]];
  }

  function isFree(k, f, x, y, extra = 0) {
    const keep = f.L * 0.38 + extra, lo = f.L * 0.2 + extra;
    if (x < lo || y < lo || x > k.W - lo || y > k.H - lo) return false;
    for (const o of k.obstacles) if (clearance(o, x, y) < keep) return false;
    return true;
  }

  function stepKoi(k) {
    k.t += STEP;
    for (const f of k.fish) {
      if (!f.goal || k.t > f.until || Math.hypot(f.goal[0] - f.x, f.goal[1] - f.y) < f.L * 0.6) pickGoal(k, f);
      const [tx, ty, left] = nextOnPath(f);
      // a new goal when this one is reached, or when the path has stopped getting shorter
      if (left < (f.best ?? Infinity)) { f.best = left; f.bestAt = k.t; }
      if (left <= 1 || k.t - f.bestAt > 8) { pickGoal(k, f); f.best = Infinity; }
      // the only push is a gentle one apart from the other fish; the path does the rest
      let fx = 0, fy = 0;
      for (const g of k.fish) {
        if (g === f) continue;
        const dx = f.x - g.x, dy = f.y - g.y, d = Math.hypot(dx, dy) || 1, w = clamp01((f.L - d) / f.L);
        fx += dx / d * w; fy += dy / d * w;
      }
      let turn = (noise(k.t * 0.22, f.seed * 9.7, 77) - 0.5) * 0.9;
      const gx = tx - f.x, gy = ty - f.y, gm = Math.hypot(gx, gy) || 1;
      const want = Math.atan2(gy / gm + fy * 0.5, gx / gm + fx * 0.5);
      const diff = Math.atan2(Math.sin(want - f.a), Math.cos(want - f.a));
      turn += diff * 2.4;
      turn = Math.max(-2.2, Math.min(2.2, turn));
      f.a += turn * STEP;
      // like a real koi, it slows right down to make a sharp turn, so it can pivot through a
      // gap it would otherwise overshoot
      const sharp = Math.abs(diff);
      const pace = sharp < 0.8 ? 1 : Math.max(0.2, 1 - (sharp - 0.8) / 1.6);
      // step onto open water: straight on if possible, else the nearest open heading,
      // trying the side the fish was already turning towards first
      const step = f.L * 0.2 * pace * STEP, side = turn >= 0 ? 1 : -1;
      for (let j = 0; j <= 48; j++) {
        const a = f.a + Math.ceil(j / 2) * (Math.PI / 24) * (j % 2 ? side : -side);
        const nx = f.x + Math.cos(a) * step, ny = f.y + Math.sin(a) * step;
        if (isFree(k, f, nx, ny)) { f.a = a; f.x = nx; f.y = ny; break; }
      }
      f.trail.push([f.x, f.y]);
      if (f.trail.length > 900) f.trail.shift();
    }
  }

  function spine(f, time) {
    const step = f.L / (N - 1), tr = f.trail;
    const pts = [tr[tr.length - 1]];
    let prev = pts[0], acc = 0;
    for (let i = tr.length - 2; i >= 0 && pts.length < N; i--) {
      const p = tr[i];
      acc += Math.hypot(p[0] - prev[0], p[1] - prev[1]);
      prev = p;
      if (acc >= step) { pts.push(p); acc -= step; }
    }
    while (pts.length < N) pts.push(pts[pts.length - 1]);
    // the tail sweeps from side to side, more the further back it is
    return pts.map((p, i) => {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(N - 1, i + 1)];
      const dx = b[0] - a[0], dy = b[1] - a[1], m = Math.hypot(dx, dy) || 1;
      const s = i / (N - 1), sway = Math.sin(time * 4.2 + f.seed * 2 - s * 5.5) * f.L * 0.05 * Math.pow(s, 1.6);
      return [p[0] - dy / m * sway, p[1] + dx / m * sway];
    });
  }

  // What part of the fish (if any) a point falls on: 1 body, 2 fin. s runs head to tail.
  function sample(pts, Wm, x, y) {
    let best = Infinity, bs = 0, side = 0, beyond = false, before = false;
    for (let k = 0; k < N - 1; k++) {
      const a = pts[k], b = pts[k + 1];
      const ex = b[0] - a[0], ey = b[1] - a[1], l2 = ex * ex + ey * ey || 1;
      const raw = ((x - a[0]) * ex + (y - a[1]) * ey) / l2, u = clamp01(raw);
      const px = a[0] + ex * u - x, py = a[1] + ey * u - y, dist = px * px + py * py;
      if (dist < best) {
        best = dist; bs = (k + u) / (N - 1);
        side = ex * (y - a[1]) - ey * (x - a[0]);
        beyond = k === N - 2 && raw > 1; before = k === 0 && raw < 0;
      }
    }
    if (beyond) return null;
    const dist = Math.sqrt(best), s = bs;
    const w = s < 0.78
      ? Wm * Math.pow(Math.sin(Math.PI * Math.min(1, (s + 0.06) / 0.86)), 0.55)
      : Wm * 0.24;
    if (dist <= w && s < 0.8) return { kind: 1, s, lat: (side < 0 ? -1 : 1) * dist / w };
    if (before) return null;
    // forked tail fin
    if (s >= 0.76) {
      const g = (s - 0.76) / 0.24, fw = Wm * (0.24 + 1.35 * g);
      if (dist <= fw && !(g > 0.55 && dist < (g - 0.55) / 0.45 * fw * 0.6)) return { kind: 2, s, lat: dist / fw };
    }
    // pectoral fins swept back from behind the head, and a pair of small pelvic fins
    if (s > 0.17 && s < 0.37 && dist <= w + Wm * 1.05 * Math.pow((0.37 - s) / 0.2, 0.7)) return { kind: 2, s, lat: 1 };
    if (s > 0.5 && s < 0.6 && dist <= w + Wm * 0.45 * ((0.6 - s) / 0.1)) return { kind: 2, s, lat: 1 };
    return null;
  }

  let K = null, clock = 0;

  function drawKoi(time) {
    if (!K) return;
    const { W, H } = K, ctx = koiCv.getContext('2d');
    const im = ctx.createImageData(W, H);
    const d = im.data;
    const fish = K.fish.map(f => {
      const L = f.L, Wm = L * 0.105;
      const pts = spine(f, time);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      pts.forEach(([x, y]) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); });
      const pad = Wm * 2.4;
      return { f, L, Wm, pts, x0: Math.max(0, Math.floor(x0 - pad)), y0: Math.max(0, Math.floor(y0 - pad)), x1: Math.min(W - 1, Math.ceil(x1 + pad)), y1: Math.min(H - 1, Math.ceil(y1 + pad)) };
    });
    // shadows on the pond floor first, under every fish
    for (const F of fish) {
      const ox = F.L * 0.05, oy = F.L * 0.1;
      for (let y = F.y0; y <= Math.min(H - 1, F.y1 + oy); y++) {
        for (let x = F.x0; x <= Math.min(W - 1, F.x1 + ox); x++) {
          if (!sample(F.pts, F.Wm, x - ox, y - oy)) continue;
          const i = (y * W + x) * 4;
          d[i] = 4; d[i + 1] = 30; d[i + 2] = 24; d[i + 3] = 100;
        }
      }
    }
    for (const F of fish) {
      const seed = F.f.seed;
      for (let y = F.y0; y <= F.y1; y++) {
        for (let x = F.x0; x <= F.x1; x++) {
          const hit = sample(F.pts, F.Wm, x, y);
          if (!hit) continue;
          const i = (y * W + x) * 4;
          const th = BAYER[((y & 3) << 2) | (x & 3)];
          if (hit.kind === 2) {
            const streak = Math.sin(hit.s * 60 + hit.lat * 4) > 0.4 ? 0.25 : 0;
            put(d, i, RAMPS.fin, 0.45 + streak - hit.lat * 0.2, th);
            d[i + 3] = 215;
            continue;
          }
          const lat = hit.lat, a = Math.abs(lat);
          let t = 0.78 - 0.5 * a * a + (lat < 0 ? 0.08 : -0.06);
          if (a > 0.86) t -= 0.35;
          // kohaku: red patches on white, with a red cap behind the head
          let n = noise(hit.s * 7 + seed * 13, lat * 1.3 + seed * 5, 40 + seed);
          if (hit.s < 0.22) n += 0.18;
          const red = n > 0.52 && hit.s > 0.05 && hit.s < 0.74;
          put(d, i, red ? RAMPS.orange : RAMPS.white, t, th);
        }
      }
      // eyes, one each side just behind the snout
      const [hx, hy] = F.pts[1], [nx, ny] = F.pts[0];
      const dx = nx - hx, dy = ny - hy, m = Math.hypot(dx, dy) || 1;
      [-1, 1].forEach(sd => {
        const ex = Math.round(hx + (-dy / m) * sd * F.Wm * 0.55), ey = Math.round(hy + (dx / m) * sd * F.Wm * 0.55);
        if (ex < 0 || ey < 0 || ex >= W || ey >= H) return;
        const i = (ey * W + ex) * 4;
        d[i] = 18; d[i + 1] = 16; d[i + 2] = 16; d[i + 3] = 255;
      });
    }
    ctx.putImageData(im, 0, 0);
  }

  /* ---------- Render ---------- */

  let queued = false;

  // The part of the pond hidden behind the name card, in art pixels, if the card is over it.
  function cardShadow() {
    const card = document.querySelector('.hero .label');
    if (!card) return null;
    const a = card.getBoundingClientRect(), b = wrap.getBoundingClientRect();
    if (a.bottom <= b.top || a.top >= b.bottom || a.right <= b.left || a.left >= b.right) return null;
    return { x0: (a.left - b.left + 16) / PS, y0: (a.top - b.top + 16) / PS, x1: (a.right - b.left + 16) / PS, y1: (a.bottom - b.top + 16) / PS };
  }

  function render() {
    queued = false;
    const cssW = wrap.clientWidth, cssH = wrap.clientHeight;
    if (!cssW || !cssH) return;
    const W = Math.ceil((cssW + 32) / PS), H = Math.ceil((cssH + 32) / PS);
    const S = scene(W, H);
    buildWater(W, H, S);
    renderFloat(W, H, S);
    koiCv.width = W; koiCv.height = H;
    K = makeKoi(W, H, S, cardShadow(W, H));
    drawWater(clock);
    drawKoi(clock);
    wrap.classList.add('is-ready');
  }
  const schedule = () => { if (!queued) { queued = true; requestAnimationFrame(render); } };

  render();
  let lastW = wrap.clientWidth, lastH = wrap.clientHeight;
  new ResizeObserver(() => {
    if (Math.abs(wrap.clientWidth - lastW) > 2 || Math.abs(wrap.clientHeight - lastH) > 2) {
      lastW = wrap.clientWidth; lastH = wrap.clientHeight; schedule();
    }
  }).observe(wrap);

  if (reduceMotion) return;

  // The pond moves at a pixel-art frame rate, and only while it is on screen.
  let raf = 0, last = 0, onScreen = true;
  const frame = (now) => {
    raf = requestAnimationFrame(frame);
    if (!K || now - last < 1000 / 14) return;
    const dt = Math.min(0.2, (now - (last || now)) / 1000);
    last = now;
    clock += dt;
    K.acc += dt;
    while (K.acc >= STEP) { stepKoi(K); K.acc -= STEP; }
    drawWater(clock);
    drawKoi(clock);
  };
  const run = () => {
    const go = onScreen && !document.hidden;
    if (go && !raf) { last = 0; raf = requestAnimationFrame(frame); }
    if (!go && raf) { cancelAnimationFrame(raf); raf = 0; }
  };
  new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; run(); }).observe(wrap);
  document.addEventListener('visibilitychange', run);

  // The layers drift apart a little under the pointer.
  if (matchMedia('(pointer: fine)').matches) {
    let praf = 0;
    wrap.addEventListener('pointermove', (e) => {
      if (praf) return;
      praf = requestAnimationFrame(() => {
        const r = wrap.getBoundingClientRect();
        wrap.style.setProperty('--px', (((e.clientX - r.left) / r.width) * 2 - 1).toFixed(3));
        wrap.style.setProperty('--py', (((e.clientY - r.top) / r.height) * 2 - 1).toFixed(3));
        praf = 0;
      });
    });
    wrap.addEventListener('pointerleave', () => {
      wrap.style.setProperty('--px', 0);
      wrap.style.setProperty('--py', 0);
    });
  }
})();

// Entrances: each part of a section rises in turn as the section arrives.
(() => {
  const items = [...document.querySelectorAll('[data-reveal]')];
  if (!('IntersectionObserver' in window)) { items.forEach(el => el.classList.add('in')); return; }
  const groups = new Map();
  items.forEach(el => {
    const key = el.closest('section') || document.body;
    const n = groups.get(key) || 0;
    el.style.setProperty('--d', `${Math.min(n, 6) * 80}ms`);
    groups.set(key, n + 1);
  });
  const io = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (!e.isIntersecting) return;
      e.target.classList.add('in');
      io.unobserve(e.target);
      // Once risen, drop the stagger so hover transitions answer at once.
      setTimeout(() => e.target.style.removeProperty('--d'), 1400);
    });
  }, { rootMargin: '0px 0px -8% 0px' });
  items.forEach(el => io.observe(el));
})();

// Nav: frosted once the painting starts to scroll away; the current section gets a dot.
(() => {
  const nav = document.getElementById('nav');
  if (!nav) return;
  const onScroll = () => nav.classList.toggle('is-scrolled', window.scrollY > 40);
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  const links = new Map([...nav.querySelectorAll('.nav-link')].map(a => [a.getAttribute('href').slice(1), a]));
  if (!('IntersectionObserver' in window)) return;
  const io = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (!e.isIntersecting) return;
      links.forEach(a => a.classList.remove('is-active'));
      const a = links.get(e.target.id);
      if (a) a.classList.add('is-active');
    });
  }, { rootMargin: '-45% 0px -50% 0px' });
  document.querySelectorAll('main section[id]').forEach(s => io.observe(s));
})();

// Work cards: a patch of sunlight follows the pointer.
(() => {
  if (!matchMedia('(pointer: fine)').matches) return;
  document.querySelectorAll('.card-core').forEach(core => {
    core.addEventListener('pointermove', (e) => {
      const r = core.getBoundingClientRect();
      core.style.setProperty('--mx', `${e.clientX - r.left}px`);
      core.style.setProperty('--my', `${e.clientY - r.top}px`);
    });
  });
})();

// Competition photos: click one to see it large, then step through that team's set.
(() => {
  const box = document.getElementById('lightbox');
  if (!box || typeof box.showModal !== 'function') return;
  const img = box.querySelector('img'), cap = box.querySelector('figcaption');
  let set = [], at = 0;
  const show = (n) => {
    at = (n + set.length) % set.length;
    const b = set[at], thumb = b.querySelector('img');
    img.src = b.dataset.full;
    img.alt = thumb.alt;
    cap.textContent = `${thumb.alt} (${at + 1} of ${set.length})`;
  };
  document.querySelectorAll('.tf-gallery').forEach(g => {
    const shots = [...g.querySelectorAll('.tf-shot')];
    shots.forEach((b, n) => b.addEventListener('click', () => { set = shots; show(n); box.showModal(); }));
  });
  box.querySelector('.lb-prev').addEventListener('click', () => show(at - 1));
  box.querySelector('.lb-next').addEventListener('click', () => show(at + 1));
  box.querySelector('.lb-close').addEventListener('click', () => box.close());
  box.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') show(at - 1);
    if (e.key === 'ArrowRight') show(at + 1);
  });
  // a click on the dark backdrop, outside the photo and the buttons, closes it
  box.addEventListener('click', (e) => { if (e.target === box) box.close(); });
  box.addEventListener('close', () => { const b = set[at]; if (b) b.focus(); });
})();
