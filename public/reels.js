// Reels: a vertical feed of 30-90 s discourse clips over generative, audio-reactive visuals.
// Clips are cut at natural pauses found by listening (silently, at 4x) rather than from transcripts.

const CLIP_MIN = 30, CLIP_MAX = 90, PAUSE_MS = 420;
const SCENES = ['flow', 'ripples', 'orbit', 'bloom'];

const reelsEl = $('reels'), feed = $('feed'), rcv = $('rcv');
const rctx = rcv.getContext('2d');
const ra = new Audio();
ra.preload = 'auto';

let rAn = null, rGain = null, rFreq = null, rWave = null;
function reelAudioGraph() {
  if (rAn) return;
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const src = ac.createMediaElementSource(ra);
    rAn = ac.createAnalyser();
    rAn.fftSize = 1024;
    rAn.smoothingTimeConstant = 0.6;
    rGain = ac.createGain();
    src.connect(rAn);
    rAn.connect(rGain);
    rGain.connect(ac.destination);
    rFreq = new Uint8Array(rAn.frequencyBinCount);
    rWave = new Uint8Array(rAn.fftSize);
    ra.addEventListener('play', () => ac.resume());
  } catch { rAn = null; }
}
const setGain = v => { if (rGain) rGain.gain.value = v; };
const rms = () => {
  rAn.getByteTimeDomainData(rWave);
  let s = 0;
  for (let i = 0; i < rWave.length; i++) { const x = (rWave[i] - 128) / 128; s += x * x; }
  return Math.sqrt(s / rWave.length);
};

const durSecs = d => d.split(':').reduce((a, p) => a * 60 + +p, 0);
const rand = (a, b) => a + Math.random() * (b - a);
const seeded = n => { const x = Math.sin(n * 127.1) * 43758.5453; return x - Math.floor(x); };

// ---------- clips ----------

let reels = [];
let active = -1;
let token = 0;
let wasPlaying = false;

function newReel() {
  const pool = series.filter(s => s.tracks.length);
  const s = pool[Math.floor(Math.random() * pool.length)];
  const i = Math.floor(Math.random() * s.tracks.length);
  const t = s.tracks[i];
  const len = durSecs(t.dur) || 3600;
  const id = Math.floor(Math.random() * 1e6);
  return {
    s, i, t, id,
    from: rand(Math.min(120, len * 0.1), Math.max(180, len - CLIP_MAX - 120)),
    start: null, end: null,
    scene: SCENES[id % SCENES.length],
    hue: Math.floor(seeded(id) * 360),
  };
}

// Play silently at 4x until the speaker pauses; resolves with the media time of the pause.
function scanForPause(from, limit, tok) {
  return new Promise(resolve => {
    if (!rAn) return resolve(from);
    ra.currentTime = from;
    ra.playbackRate = 4;
    setGain(0);
    ra.play().catch(() => {});
    let env = 0.02, quiet = 0, last = performance.now();
    const tick = () => {
      if (tok !== token) return resolve(null);
      const now = performance.now();
      const dt = now - last;
      last = now;
      const v = rms();
      env = Math.max(v, env * 0.998);
      // Count quiet time in media seconds (4x real time), so a 0.4 s pause is ~100 ms of scanning.
      // Ignore the seek/buffering gap: only judge once playback has really reached the target.
      const moving = !ra.seeking && ra.readyState >= 3 && ra.currentTime >= from + 1;
      quiet = moving && v < Math.max(0.006, env * 0.12) ? quiet + dt * 4 : 0;
      if (moving && (quiet >= PAUSE_MS || ra.currentTime - from > limit)) return resolve(ra.currentTime);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function prepare(r, tok) {
  if (r.start == null) {
    const at = await scanForPause(r.from, 45, tok);
    if (at == null) return false;
    r.start = at;
  }
  ra.playbackRate = 1;
  ra.currentTime = r.start;
  setGain(1);
  r.ended = false;
  await ra.play().catch(() => {});
  return tok === token;
}

// While a clip plays, cut at the first pause after CLIP_MIN, or at CLIP_MAX regardless.
let quietFor = 0, lastTick = 0;
function watchEnd() {
  const r = reels[active];
  if (!r || r.start == null || ra.paused) { quietFor = 0; lastTick = 0; return; }
  const now = performance.now();
  const dt = lastTick ? now - lastTick : 0;
  lastTick = now;
  const pos = ra.currentTime - r.start;
  if (rAn) quietFor = rms() < 0.012 ? quietFor + dt : 0;
  if (pos >= CLIP_MAX || (pos >= CLIP_MIN && quietFor >= PAUSE_MS)) {
    r.end = ra.currentTime;
    ra.currentTime = r.start; // loop the clip
    quietFor = 0;
  } else if (r.end != null && ra.currentTime >= r.end) {
    ra.currentTime = r.start;
  }
}

async function activate(i) {
  if (i === active || !reels[i]) return;
  active = i;
  const tok = ++token;
  ra.pause();
  reelAudioGraph();
  const r = reels[i];
  ra.src = streamUrl(r.t.file);
  await new Promise(res => { ra.onloadedmetadata = ra.onerror = res; });
  if (tok !== token) return;
  const slide = feed.children[i];
  slide.classList.add('loading');
  clearScene();
  const ok = await prepare(r, tok);
  if (!ok) return;
  slide.classList.remove('loading');
  if (i >= reels.length - 2) addReels(3);
}

// ---------- feed ----------

const liked = () => new Set(saved.likes || []);
const reelKey = r => `${r.t.file}@${Math.round(r.start ?? r.from)}`;

function slideFor(r) {
  const el = document.createElement('section');
  el.className = 'reel';
  el.innerHTML = `
    <div class="loadmsg">TUNING IN…</div>
    <div class="rinfo"><div class="rtitle"></div><div class="rsub"></div></div>
    <div class="rside">
      <button class="rbtn like" title="Like">&#9825;</button>
      <button class="rbtn full" title="Play full discourse from here">&#9654;&#9654;</button>
    </div>
    <div class="rbar"><div class="rfill"></div></div>`;
  el.querySelector('.rtitle').textContent = cleanTitle(r.s.title);
  el.querySelector('.rsub').textContent = r.t.title.startsWith(cleanTitle(r.s.title)) ? `Discourse ${String(r.t.n).padStart(2, '0')}` : r.t.title;
  const like = el.querySelector('.like');
  like.onclick = e => {
    e.stopPropagation();
    const set = liked(), k = reelKey(r);
    set.has(k) ? set.delete(k) : set.add(k);
    save({ likes: [...set] });
    like.classList.toggle('on', set.has(k));
    like.innerHTML = set.has(k) ? '&#9829;' : '&#9825;';
  };
  el.querySelector('.full').onclick = e => {
    e.stopPropagation();
    const at = ra.currentTime;
    closeReels();
    load(r.s, r.i, { play: true, at });
  };
  el.onclick = () => {
    if (ra.paused) ra.play().catch(() => {}); else ra.pause();
    el.classList.toggle('paused', ra.paused);
  };
  return el;
}

function addReels(n) {
  for (let k = 0; k < n; k++) {
    const r = newReel();
    reels.push(r);
    feed.append(slideFor(r));
  }
}

let scrollT = 0;
feed.addEventListener('scroll', () => {
  clearTimeout(scrollT);
  scrollT = setTimeout(() => activate(Math.round(feed.scrollTop / feed.clientHeight)), 90);
});
document.addEventListener('keydown', e => {
  if (reelsEl.hidden) return;
  if (e.key === 'Escape') closeReels();
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    feed.scrollBy({ top: (e.key === 'ArrowDown' ? 1 : -1) * feed.clientHeight, behavior: 'smooth' });
  }
});

function openReels() {
  if (!series.length) return;
  wasPlaying = !audio.paused;
  audio.pause();
  reelsEl.hidden = false;
  if (!reels.length) addReels(4);
  size();
  active = -1;
  feed.scrollTop = 0;
  activate(0);
  requestAnimationFrame(frame);
}
function closeReels() {
  token++;
  ra.pause();
  reelsEl.hidden = true;
  active = -1;
}
$('reelsBtn').onclick = openReels;
$('rclose').onclick = closeReels;

// ---------- visuals ----------

let W = 0, H = 0, DPR = 1;
function size() {
  DPR = Math.min(2, window.devicePixelRatio || 1);
  W = rcv.clientWidth; H = rcv.clientHeight;
  rcv.width = W * DPR; rcv.height = H * DPR;
  rctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
window.addEventListener('resize', () => { if (!reelsEl.hidden) size(); });

let level = 0, low = 0, parts = [], drops = [], lastDrop = 0;
function clearScene() { parts = []; drops = []; rctx.clearRect(0, 0, W, H); }

function listen() {
  let l = 0, b = 0;
  if (rAn && !ra.paused) {
    rAn.getByteFrequencyData(rFreq);
    const n = Math.floor(rFreq.length * 0.3);
    let s = 0, sb = 0;
    for (let i = 0; i < n; i++) { s += rFreq[i]; if (i < n / 6) sb += rFreq[i]; }
    l = s / n / 255; b = sb / (n / 6) / 255;
  } else if (!ra.paused) { l = 0.3 + 0.2 * Math.sin(performance.now() / 300); b = l; }
  level += (l - level) * 0.25;
  low += (b - low) * 0.25;
}

const hsl = (h, s, l, a = 1) => `hsla(${((h % 360) + 360) % 360},${s}%,${l}%,${a})`;
const fade = (r, a) => {
  rctx.fillStyle = hsl(r.hue + 200, 45, 6, a);
  rctx.fillRect(0, 0, W, H);
};

// Thousands of grains riding a slow flow field, leaving soft trails.
function sceneFlow(r, t) {
  fade(r, 0.09);
  while (parts.length < 700) parts.push({ x: Math.random() * W, y: Math.random() * H, a: Math.random() });
  rctx.globalCompositeOperation = 'lighter';
  for (const p of parts) {
    const ang = Math.sin(p.x * 0.004 + t / 4000) * 2 + Math.cos(p.y * 0.005 - t / 5000) * 2;
    const sp = 0.7 + level * 4;
    p.x += Math.cos(ang) * sp;
    p.y += Math.sin(ang) * sp;
    if (p.x < 0 || p.x > W || p.y < 0 || p.y > H) { p.x = Math.random() * W; p.y = Math.random() * H; }
    rctx.fillStyle = hsl(r.hue + p.a * 70, 80, 60, 0.5);
    rctx.fillRect(p.x, p.y, 1.8, 1.8);
  }
  rctx.globalCompositeOperation = 'source-over';
}

// A calm pond: a ring leaves the centre on each swell of the voice.
function sceneRipples(r, t) {
  fade(r, 0.14);
  if (!ra.paused && low > 0.22 && t - lastDrop > 380) {
    drops.push({ born: t, x: W / 2 + (Math.random() - 0.5) * W * 0.3, y: H / 2 + (Math.random() - 0.5) * H * 0.2, s: 0.5 + low });
    lastDrop = t;
  }
  if (!ra.paused && t - lastDrop > 2200) { drops.push({ born: t, x: W / 2, y: H / 2, s: 0.5 }); lastDrop = t; }
  for (let i = drops.length - 1; i >= 0; i--) {
    const d = drops[i], age = (t - d.born) / 3800;
    if (age >= 1) { drops.splice(i, 1); continue; }
    for (let k = 0; k < 3; k++) {
      const rad = (age - k * 0.06) * Math.max(W, H) * 0.9;
      if (rad <= 0) continue;
      rctx.strokeStyle = hsl(r.hue + k * 25, 75, 62, (1 - age) * 0.6);
      rctx.lineWidth = 3 * (1 - age) * d.s + 0.5;
      rctx.beginPath(); rctx.arc(d.x, d.y, rad, 0, 7); rctx.stroke();
    }
  }
}

// Concentric rings of beads turning in opposite directions; the voice swells them.
function sceneOrbit(r, t) {
  fade(r, 0.2);
  const cx = W / 2, cy = H / 2, R = Math.min(W, H) * 0.46;
  const rings = 9;
  for (let k = 1; k <= rings; k++) {
    const rad = (k / rings) * R * (1 + level * 0.25);
    const n = 8 + k * 6, dir = k % 2 ? 1 : -1;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + dir * t / (3500 + k * 400);
      const wob = 1 + 0.18 * Math.sin(a * 3 + t / 700 + k) * (0.4 + level * 2);
      rctx.fillStyle = hsl(r.hue + k * 14, 80, 55 + k * 2, 0.9);
      rctx.beginPath();
      rctx.arc(cx + Math.cos(a) * rad * wob, cy + Math.sin(a) * rad * wob, 1.5 + k * 0.35 + low * 3, 0, 7);
      rctx.fill();
    }
  }
}

// A mandala of petals that breathes in and out.
function sceneBloom(r, t) {
  fade(r, 0.16);
  const cx = W / 2, cy = H / 2, R = Math.min(W, H) * 0.42;
  const petals = 14, layers = 4;
  rctx.globalCompositeOperation = 'lighter';
  for (let l = 0; l < layers; l++) {
    const breathe = 0.75 + 0.2 * Math.sin(t / 1800 + l) + level * 0.5;
    for (let i = 0; i < petals; i++) {
      const a = (i / petals) * Math.PI * 2 + (l % 2 ? 1 : -1) * t / 9000;
      const len = R * breathe * (0.35 + l * 0.22);
      rctx.save();
      rctx.translate(cx, cy);
      rctx.rotate(a);
      rctx.fillStyle = hsl(r.hue + l * 28 + i * 3, 75, 55, 0.05 + level * 0.05);
      rctx.beginPath();
      rctx.ellipse(len / 2, 0, len / 2, len * 0.14, 0, 0, 7);
      rctx.fill();
      rctx.restore();
    }
  }
  rctx.globalCompositeOperation = 'source-over';
}

const DRAW = { flow: sceneFlow, ripples: sceneRipples, orbit: sceneOrbit, bloom: sceneBloom };

function frame(t) {
  if (reelsEl.hidden) return;
  requestAnimationFrame(frame);
  const r = reels[active];
  if (!r) return;
  listen();
  DRAW[r.scene](r, t);
  watchEnd();
  const fill = feed.children[active] && feed.children[active].querySelector('.rfill');
  if (fill && r.start != null) {
    const len = (r.end ?? r.start + CLIP_MAX) - r.start;
    fill.style.width = Math.max(0, Math.min(100, ((ra.currentTime - r.start) / len) * 100)) + '%';
  }
}
