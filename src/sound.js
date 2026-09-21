// ============================================================
// 程序化音效(WebAudio,无音频文件)
// 球碰球脆响 / 库边闷响 / 落袋 / 出杆 / 胜负提示
// ============================================================
let ctx = null;
let master = null;
let enabled = true;

function ensure() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = 0.8;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

export function setSoundEnabled(v) { enabled = v; }
export function isSoundEnabled() { return enabled; }
export function unlockAudio() { ensure(); }

function noiseBuffer(dur) {
  const c = ensure();
  const buf = c.createBuffer(1, (c.sampleRate * dur) | 0, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

// 球碰球:高频短促脆响,音量随碰撞速度
export function sfxBallHit(speed) {
  if (!enabled) return;
  const c = ensure();
  const t = c.currentTime;
  const vol = Math.min(speed / 5, 1) * 0.9 + 0.05;
  const src = c.createBufferSource();
  src.buffer = noiseBuffer(0.06);
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass'; bp.frequency.value = 3600 + speed * 250; bp.Q.value = 1.2;
  const g = c.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.055);
  src.connect(bp).connect(g).connect(master);
  src.start(t);
  // 附加一点“咔”的音头
  const osc = c.createOscillator();
  osc.type = 'sine'; osc.frequency.setValueAtTime(2600, t);
  osc.frequency.exponentialRampToValueAtTime(900, t + 0.03);
  const g2 = c.createGain();
  g2.gain.setValueAtTime(vol * 0.5, t);
  g2.gain.exponentialRampToValueAtTime(0.001, t + 0.035);
  osc.connect(g2).connect(master);
  osc.start(t); osc.stop(t + 0.04);
}

// 库边:低频闷响
export function sfxCushion(speed) {
  if (!enabled) return;
  const c = ensure();
  const t = c.currentTime;
  const vol = Math.min(speed / 4, 1) * 0.5 + 0.03;
  const src = c.createBufferSource();
  src.buffer = noiseBuffer(0.09);
  const lp = c.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 420;
  const g = c.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
  src.connect(lp).connect(g).connect(master);
  src.start(t);
}

// 落袋:下坠 + 袋底闷响
export function sfxPocket() {
  if (!enabled) return;
  const c = ensure();
  const t = c.currentTime;
  const osc = c.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(500, t);
  osc.frequency.exponentialRampToValueAtTime(130, t + 0.16);
  const g = c.createGain();
  g.gain.setValueAtTime(0.5, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
  osc.connect(g).connect(master);
  osc.start(t); osc.stop(t + 0.22);
  const src = c.createBufferSource();
  src.buffer = noiseBuffer(0.12);
  const lp = c.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 300;
  const g2 = c.createGain();
  g2.gain.setValueAtTime(0.001, t + 0.1);
  g2.gain.linearRampToValueAtTime(0.4, t + 0.14);
  g2.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
  src.connect(lp).connect(g2).connect(master);
  src.start(t + 0.1);
}

// 出杆
export function sfxStrike(power) {
  if (!enabled) return;
  const c = ensure();
  const t = c.currentTime;
  const src = c.createBufferSource();
  src.buffer = noiseBuffer(0.04);
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 0.8;
  const g = c.createGain();
  g.gain.setValueAtTime(0.25 + power * 0.5, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
  src.connect(bp).connect(g).connect(master);
  src.start(t);
}

function tone(freq, t0, dur, vol, type) {
  const c = ensure();
  const osc = c.createOscillator();
  osc.type = type || 'triangle';
  osc.frequency.value = freq;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(vol, t0 + 0.02);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  osc.connect(g).connect(master);
  osc.start(t0); osc.stop(t0 + dur + 0.02);
}

export function sfxWin() {
  if (!enabled) return;
  const c = ensure();
  const t = c.currentTime;
  tone(523.25, t, 0.35, 0.3);
  tone(659.25, t + 0.12, 0.35, 0.3);
  tone(783.99, t + 0.24, 0.5, 0.3);
  tone(1046.5, t + 0.38, 0.7, 0.35);
}

export function sfxLose() {
  if (!enabled) return;
  const c = ensure();
  const t = c.currentTime;
  tone(392, t, 0.4, 0.28, 'sawtooth');
  tone(311.13, t + 0.18, 0.5, 0.28, 'sawtooth');
  tone(233.08, t + 0.36, 0.8, 0.3, 'sawtooth');
}

export function sfxFoul() {
  if (!enabled) return;
  const c = ensure();
  const t = c.currentTime;
  tone(220, t, 0.18, 0.3, 'square');
  tone(185, t + 0.16, 0.25, 0.3, 'square');
}
