// ============================================================
// 主控制器:模式调度 / 相机 / 瞄准交互 / 出杆流程 / 联机胶水
// ============================================================
import * as THREE from 'm/three';
import {
  TABLE, DT, POCKETS, rackEightBall, applyStrike, stepPhysics, allResting,
  predictShot, isValidPlacement, findFreeSpot, quantizeShot, stateHash, cloneBalls,
} from 'm/physics';
import * as Rules from 'm/rules';
import { initScene } from 'm/scene';
import * as Sfx from 'm/sound';
import { aiChooseShot, aiPlaceCueBall } from 'm/ai';
import { CHALLENGES, buildChallengeBalls, judgeChallenge } from 'm/challenges';
import { createNet } from 'm/net';

const R = TABLE.R;
const $ = id => document.getElementById(id);

// ---------- 场景 ----------
const canvas = $('gl');
const scene3 = initScene(canvas);
window.__scene3 = scene3; // 调试钩子

// ---------- 全局状态 ----------
let mode = null;            // practice | ai | local2p | online | challenge
let balls = [];
let rules = null;
let phase = 'menu';         // menu | aim | rolling | place | over
let aimYaw = 0;
let followPitch = 0.34;
let followDist = 0.85;
let power = 0;
let spin = { a: 0, b: 0, elev: 0 };
let shotEvents = [];
let predDirty = true;
let lastPredFrame = 0;
let camMode = 'follow';     // follow | top | free
const orbit = { az: -Math.PI / 2, pol: 0.72, dist: 2.7 };
let charging = false, chargeDir = 1;
let cueFire = null;         // {t, dur, shot} 出杆动画
let aiBusy = false;
let challengeIdx = -1;
let names = ['玩家1', '玩家2'];
let mySeat = 0;
let net = null;
let onlineActive = false;
let gameCount = 0;
let myRematch = false, peerRematch = false;
let hashSeq = 0;
const remoteHashes = new Map(), localHashes = new Map();
let placeCandidate = null;  // 自由球候选位置
let practiceScratch = false;
let rollingCamFree = false; // 走球阶段用户是否已手动接管镜头
let shotSnapshot = null;    // 本杆起始局面(落袋回放用)
let shotRecord = null;      // 本杆出杆参数
let simStep = 0;            // 本杆已推进的物理步数
let pocketRecords = [];     // 本杆落袋事件 [{step,id,pocket}]
let replay = null;          // 落袋回放状态
let pendingShot = null;     // 联机:本地还在回放时收到的对方出杆,缓存待放

const cueBall = () => balls.find(b => b.id === 0);

// ---------- Toast ----------
const toastEl = $('toast');
let toastQueue = [], toastBusy = false;
function toast(msg, dur) {
  toastQueue.push({ msg, dur: dur || 1900 });
  if (!toastBusy) nextToast();
}
function nextToast() {
  const item = toastQueue.shift();
  if (!item) { toastBusy = false; return; }
  toastBusy = true;
  toastEl.textContent = item.msg;
  toastEl.style.opacity = '1';
  setTimeout(() => {
    toastEl.style.opacity = '0';
    setTimeout(nextToast, 280);
  }, item.dur);
}

// ---------- HUD ----------
const GROUP_COLORS = { 1: '#f4b400', 2: '#1b53b8', 3: '#d1301e', 4: '#5e2a8a', 5: '#e6720f', 6: '#177245', 7: '#8d2b1a' };
function refreshHUD() {
  const topBar = $('topBar');
  if (!rules) { topBar.style.display = 'none'; }
  else {
    topBar.style.display = 'flex';
    for (const seat of [0, 1]) {
      const card = $('pcard' + seat);
      card.querySelector('.pname').textContent = names[seat];
      const g = rules.groups[seat];
      card.querySelector('.pgroup').textContent = rules.open ? '未定' : Rules.groupName(g);
      card.classList.toggle('active', rules.shooter === seat && !rules.gameOver);
      const wrap = card.querySelector('.pballs');
      wrap.innerHTML = '';
      if (g) {
        const ids = g === 'solid' ? Rules.SOLIDS : Rules.STRIPES;
        for (const id of ids) {
          const b = balls.find(x => x.id === id);
          if (b && b.on) {
            const dot = document.createElement('div');
            dot.className = 'bdot' + (g === 'stripe' ? ' striped' : '');
            const c = GROUP_COLORS[g === 'stripe' ? id - 8 : id];
            dot.style.background = c;
            dot.style.setProperty('--c', c);
            wrap.appendChild(dot);
          }
        }
        if (Rules.remainingOf(balls, g) === 0) {
          const dot = document.createElement('div');
          dot.className = 'bdot';
          dot.style.background = '#151515';
          wrap.appendChild(dot);
        }
      }
    }
  }
  // 提示语
  const hint = $('hint');
  if (phase === 'place' && isMyTurn()) {
    hint.textContent = '拖动/移动鼠标放置母球,点击确认';
  } else if (phase === 'aim' && isMyTurn()) {
    hint.textContent = '拖动瞄准 · 方向键微调 · 右侧拉杆或按住空格蓄力出杆 · V 俯视 F 自由视角';
  } else if (phase === 'aim' || phase === 'place') {
    hint.textContent = mode === 'ai' ? '电脑思考中…' : '等待对方出杆…';
  } else {
    hint.textContent = '';
  }
  // 挑战信息
  const ci = $('challengeInfo');
  if (mode === 'challenge' && challengeIdx >= 0) {
    const lv = CHALLENGES[challengeIdx];
    ci.classList.remove('hidden');
    ci.innerHTML = `<b>第 ${challengeIdx + 1} 关 · ${lv.name}</b><br>${lv.desc}` + (lv.hint ? `<br><span style="color:#8a9">💡 ${lv.hint}</span>` : '');
    $('retryBtn').classList.remove('hidden');
  } else {
    ci.classList.add('hidden');
    $('retryBtn').classList.add('hidden');
  }
}

function isMyTurn() {
  if (!rules) return true;
  if (mode === 'online') return rules.shooter === mySeat;
  if (mode === 'ai') return rules.shooter === 0;
  return true;
}

// ---------- 面板切换 ----------
function showPanel(id) {
  for (const p of ['menu', 'onlinePanel', 'challengePanel', 'endPanel']) {
    $(p).classList.toggle('hidden', p !== id);
  }
  $('hud').classList.toggle('hidden', id !== null);
}

// ---------- 开局 ----------
function startGame(m, opts) {
  opts = opts || {};
  mode = m;
  Sfx.unlockAudio();
  scene3.resetDropAnims();
  scene3.clearTray();   // 顺序要在 resetDropAnims 之后:它会把进行中的落袋动画登记进托盘
  challengeIdx = -1;
  practiceScratch = false;
  aiBusy = false;
  cueFire = null;
  replay = null;
  shotSnapshot = null; shotRecord = null;
  pocketRecords = []; simStep = 0;
  pendingShot = null;
  rollingCamFree = false;
  power = 0; setPowerUI(0);
  spin = { a: 0, b: 0, elev: 0 }; syncSpinUI();
  remoteHashes.clear(); localHashes.clear(); hashSeq = 0;

  if (m === 'challenge') {
    challengeIdx = opts.level;
    balls = buildChallengeBalls(CHALLENGES[challengeIdx]);
    rules = null;
    names = ['挑战', ''];
  } else {
    balls = rackEightBall();
    if (m === 'practice') { rules = null; names = ['练习', '']; }
    else {
      rules = Rules.newMatch(opts.breaker || 0);
      if (m === 'ai') names = ['你', '电脑'];
      else if (m === 'local2p') names = ['玩家1', '玩家2'];
      // online 的 names 已由服务器下发
    }
  }
  const cue = cueBall();
  aimYaw = Math.atan2(-cue.z * 0.3, 1); // 大致朝球堆
  if (m === 'challenge') {
    // 朝目标球方向
    const t = balls.find(b => b.id !== 0);
    if (t) aimYaw = Math.atan2(t.z - cue.z, t.x - cue.x);
  }
  camMode = 'follow';
  phase = 'aim';
  predDirty = true;
  showPanel(null);
  refreshHUD();
  scheduleAI();
}

// ---------- 出杆 ----------
function buildMyShot() {
  const fx = Math.cos(aimYaw), fz = Math.sin(aimYaw);
  const er = spin.elev * Math.PI / 180;
  return quantizeShot({
    fx, fz, power: Math.max(power, 0.03),
    a: spin.a, b: spin.b,
    sinE: Math.sin(er), cosE: Math.cos(er),
  });
}

function fireShot(shot, fromRemote) {
  if (phase !== 'aim') return;
  if (!fromRemote && mode === 'online' && rules && rules.shooter !== mySeat) return;
  Sfx.unlockAudio();
  if (mode === 'online' && !fromRemote) net.send({ t: 'shot', shot });
  if (rules) Rules.beginShot(rules, balls);
  shotSnapshot = cloneBalls(balls);
  shotRecord = shot;
  simStep = 0;
  pocketRecords = [];
  rollingCamFree = false; // 出杆瞬间冻结机位,第一视角看完走球
  cueFire = { t: 0, dur: 0.09, shot };
  phase = 'rolling';
  shotEvents = [];
  scene3.setAim(null);
  Sfx.sfxStrike(shot.power);
  charging = false;
  refreshHUD();
}

// 物理推进(cueFire 动画结束后开始)
let acc = 0;
let lastHitSfx = 0, lastCushSfx = 0;
function advanceSim(dt) {
  acc += Math.min(dt, 0.05);
  const evBuf = [];
  while (acc >= DT) {
    acc -= DT;
    evBuf.length = 0;
    stepPhysics(balls, evBuf);
    simStep++;
    for (const e of evBuf) {
      shotEvents.push(e);
      if (e.type === 'pocket') pocketRecords.push({ step: simStep, id: e.id, pocket: e.pocket });
      const now = performance.now();
      if (e.type === 'hit' && now - lastHitSfx > 30) { Sfx.sfxBallHit(e.speed); lastHitSfx = now; }
      else if (e.type === 'cushion' && e.speed > 0.15 && now - lastCushSfx > 40) { Sfx.sfxCushion(e.speed); lastCushSfx = now; }
      else if (e.type === 'pocket') Sfx.sfxPocket();
    }
    if (allResting(balls)) break;
  }
  if (allResting(balls)) {
    // 本杆有落袋:先播袋口视角回放,再结算(标签页隐藏时由后台兜底直接结算)
    if (pocketRecords.length && shotSnapshot && mode !== null) startReplay();
    else settleShot();
  }
}

// ---------- 落袋回放:同一杆确定性重演,机位架在落袋袋口 ----------
function startReplay() {
  const first = pocketRecords[0].step;
  const last = pocketRecords[pocketRecords.length - 1].step;
  const startStep = Math.max(0, first - Math.round(1.25 / DT));
  const endStep = last + Math.round(0.35 / DT);
  const rb = cloneBalls(shotSnapshot);
  applyStrike(rb.find(b => b.id === 0), shotRecord);
  const ev = [];
  let s = 0;
  for (; s < startStep; s++) { ev.length = 0; stepPhysics(rb, ev); } // 快进到落袋前 ~1.25s
  const pk = POCKETS[pocketRecords[0].pocket];
  const ox = pk.corner ? Math.SQRT1_2 * Math.sign(pk.x) : 0;
  const oz = pk.corner ? Math.SQRT1_2 * Math.sign(pk.z) : Math.sign(pk.z);
  replay = {
    balls: rb, step: s, endStep, acc: 0,
    speed: 0.45,  // 慢动作
    hold: 0.9,    // 结束后停留,让下坠动画播完
    camPos: new THREE.Vector3(pk.x + ox * 0.42, 0.30, pk.z + oz * 0.42),
    camLook: new THREE.Vector3(pk.x - ox * 0.38, 0.0, pk.z - oz * 0.38),
  };
  scene3.resetDropAnims();
  scene3.setAim(null);
  phase = 'replay';
  toast('🎬 落袋回放 · 点按跳过', 1500);
  refreshHUD();
}

function finishReplay() {
  if (!replay) return;
  replay = null;
  scene3.resetDropAnims();
  settleShot();
}

// ---------- 结算 ----------
function settleShot() {
  acc = 0;
  const cue = cueBall();

  if (mode === 'challenge') {
    const lv = CHALLENGES[challengeIdx];
    const verdict = judgeChallenge(lv, shotEvents, balls);
    if (verdict.success) {
      phase = 'over';
      Sfx.sfxWin();
      $('endTitle').textContent = '挑战成功!';
      $('endDetail').textContent = verdict.msg;
      $('btnRematch').classList.add('hidden');
      $('btnNextLevel').classList.toggle('hidden', challengeIdx >= CHALLENGES.length - 1);
      showPanel('endPanel');
    } else {
      toast(verdict.msg || '未达成目标,点左侧「重摆本关」再试', 2200);
      if (!cue.on) {
        cue.on = true; cue.resting = true;
        const spot = findFreeSpot(balls, lv.cue.x, lv.cue.z);
        cue.x = spot.x; cue.z = spot.z;
        cue.vx = cue.vz = cue.wx = cue.wy = cue.wz = 0;
      }
      phase = 'aim';
      predDirty = true;
    }
    refreshHUD();
    return;
  }

  if (mode === 'practice') {
    const remaining = balls.filter(b => b.on && b.id !== 0).length;
    if (remaining === 0) {
      phase = 'over';
      Sfx.sfxWin();
      $('endTitle').textContent = '清台!';
      $('endDetail').textContent = '所有彩球全部入袋,重新摆球再来一次?';
      $('btnRematch').classList.remove('hidden');
      $('btnNextLevel').classList.add('hidden');
      showPanel('endPanel');
      return;
    }
    if (!cue.on) {
      cue.on = true; cue.resting = true;
      cue.vx = cue.vz = cue.wx = cue.wy = cue.wz = 0;
      const spot = findFreeSpot(balls, -TABLE.L / 4, 0);
      cue.x = spot.x; cue.z = spot.z;
      phase = 'place';
      toast('母球落袋,自由摆放');
    } else phase = 'aim';
    predDirty = true;
    refreshHUD();
    return;
  }

  // ---- 规则模式 ----
  console.log('[裁判] shooter=' + rules.shooter, 'pockets=' + JSON.stringify(shotEvents.filter(e => e.type === 'pocket').map(e => e.id)));
  const res = Rules.endShot(rules, balls, shotEvents, findFreeSpot);
  for (const m of res.messages) toast(m, 2100);
  if (res.foul) Sfx.sfxFoul();

  if (mode === 'online') {
    hashSeq++;
    const h = stateHash(balls);
    localHashes.set(hashSeq, h);
    net.send({ t: 'hash', n: hashSeq, h });
    checkHash(hashSeq);
  }

  if (res.gameOver) {
    phase = 'over';
    const winner = res.gameOver.winner;
    const iWon = mode === 'online' ? winner === mySeat : (mode === 'ai' ? winner === 0 : true);
    if (mode === 'local2p') {
      $('endTitle').textContent = `${names[winner]} 获胜!`;
      Sfx.sfxWin();
    } else {
      $('endTitle').textContent = iWon ? '你赢了!' : '你输了';
      iWon ? Sfx.sfxWin() : Sfx.sfxLose();
    }
    $('endDetail').textContent = res.gameOver.reason;
    $('btnRematch').classList.remove('hidden');
    $('btnNextLevel').classList.add('hidden');
    myRematch = peerRematch = false;
    showPanel('endPanel');
    refreshHUD();
    return;
  }

  // 轮转提示(联机/人机下轮到自己时提醒)
  if (res.turnChanged && (mode === 'online' || mode === 'ai') && isMyTurn() && !res.foul) {
    toast('轮到你了');
  }

  // 自由球
  if (rules.ballInHand) {
    const c = cueBall();
    if (!c.on) {
      c.on = true; c.resting = true;
      c.vx = c.vz = c.wx = c.wy = c.wz = 0;
      const spot = findFreeSpot(balls, -TABLE.L / 4, 0);
      c.x = spot.x; c.z = spot.z;
    }
    phase = 'place';
  } else {
    phase = 'aim';
  }
  predDirty = true;
  refreshHUD();
  scheduleAI();
  flushPendingShot();
}

// 联机:回放/结算期间收到的对方出杆,待回到瞄准态后补放
function flushPendingShot() {
  if (pendingShot && mode === 'online' && phase === 'aim' && rules && !rules.gameOver && rules.shooter !== mySeat) {
    const s = pendingShot;
    pendingShot = null;
    fireShot(s, true);
  }
}

function checkHash(n) {
  const a = localHashes.get(n), b = remoteHashes.get(n);
  if (a !== undefined && b !== undefined && a !== b) {
    toast('⚠ 检测到双方状态不同步', 3000);
  }
}

// ---------- AI 调度 ----------
function scheduleAI() {
  if (mode !== 'ai' || !rules || rules.gameOver || rules.shooter !== 1 || aiBusy) return;
  aiBusy = true;
  setTimeout(() => {
    if (mode !== 'ai' || phase === 'over') { aiBusy = false; return; }
    if (rules.ballInHand && phase === 'place') {
      const p = aiPlaceCueBall(rules, balls);
      const c = cueBall();
      c.x = p.x; c.z = p.z;
      rules.ballInHand = false;
      phase = 'aim';
      refreshHUD();
    }
    const shot = aiChooseShot(rules, balls, 0.62);
    aimYaw = Math.atan2(shot.fz, shot.fx);
    setTimeout(() => {
      aiBusy = false;
      if (mode === 'ai' && phase === 'aim' && rules.shooter === 1) fireShot(shot, false);
    }, 750);
  }, 900);
}

// ---------- 自由球放置 ----------
const raycaster = new THREE.Raycaster();
const tablePlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -R);
const ndc = new THREE.Vector2();
const hitPoint = new THREE.Vector3();

function pointerToTable(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(ndc, scene3.camera);
  if (raycaster.ray.intersectPlane(tablePlane, hitPoint)) return { x: hitPoint.x, z: hitPoint.z };
  return null;
}

function updatePlacePreview(px, pz) {
  const HL = TABLE.L / 2 - R, HW = TABLE.W / 2 - R;
  const x = Math.max(-HL, Math.min(HL, px));
  const z = Math.max(-HW, Math.min(HW, pz));
  const valid = isValidPlacement(balls, x, z, false);
  placeCandidate = { x, z, valid };
  const c = cueBall();
  c.x = x; c.z = z;
  scene3.placeMarker.visible = true;
  scene3.placeMarker.position.set(x, 0.003, z);
  scene3.placeMarker.material.color.set(valid ? 0x44ff88 : 0xff4444);
}

function commitPlace() {
  if (!placeCandidate || !placeCandidate.valid) { toast('这里不能放球'); return; }
  const qx = Math.round(placeCandidate.x * 1e6) / 1e6;
  const qz = Math.round(placeCandidate.z * 1e6) / 1e6;
  const c = cueBall();
  c.x = qx; c.z = qz;
  if (rules) rules.ballInHand = false;
  if (mode === 'online') net.send({ t: 'place', x: qx, z: qz });
  scene3.placeMarker.visible = false;
  placeCandidate = null;
  phase = 'aim';
  predDirty = true;
  refreshHUD();
}

// ---------- 输入:指针 ----------
let pointers = new Map();
let downInfo = null;
let pinchDist = 0;

canvas.addEventListener('pointerdown', e => {
  if (phase === 'replay') { finishReplay(); return; } // 点按跳过回放
  try { canvas.setPointerCapture(e.pointerId); } catch { }
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  downInfo = { x: e.clientX, y: e.clientY, moved: false };
  if (pointers.size === 2) {
    const [p1, p2] = [...pointers.values()];
    pinchDist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
  }
});

canvas.addEventListener('pointermove', e => {
  const prev = pointers.get(e.pointerId);
  if (phase === 'place' && isMyTurn()) {
    const p = pointerToTable(e.clientX, e.clientY);
    if (p) updatePlacePreview(p.x, p.z);
  }
  if (!prev) return;
  const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (downInfo && Math.abs(e.clientX - downInfo.x) + Math.abs(e.clientY - downInfo.y) > 7) downInfo.moved = true;

  if (pointers.size === 2) {
    const [p1, p2] = [...pointers.values()];
    const d = Math.hypot(p1.x - p2.x, p1.y - p2.y);
    const delta = (pinchDist - d) * 0.004;
    if (camMode === 'free' || phase === 'rolling') orbit.dist = clamp(orbit.dist + delta, 1.2, 5);
    else followDist = clamp(followDist + delta, 0.45, 1.8);
    pinchDist = d;
    return;
  }
  if (phase === 'place') return;

  const aiming = phase === 'aim' && isMyTurn() && !aiBusy;
  if (camMode === 'free' || phase === 'rolling' || (phase === 'aim' && !aiming)) {
    if (phase === 'rolling' && !rollingCamFree) { rollingCamFree = true; syncOrbitFromCamera(); }
    orbit.az += dx * 0.005;
    orbit.pol = clamp(orbit.pol - dy * 0.004, 0.15, 1.35);
  } else if (camMode === 'top' && aiming) {
    const p = pointerToTable(e.clientX, e.clientY);
    if (p) {
      const c = cueBall();
      const ddx = p.x - c.x, ddz = p.z - c.z;
      if (ddx * ddx + ddz * ddz > 0.001) {
        aimYaw = Math.atan2(ddz, ddx);
        predDirty = true;
      }
    }
  } else if (aiming) {
    aimYaw += dx * 0.0042;
    followPitch = clamp(followPitch - dy * 0.0035, 0.12, 1.25);
    predDirty = true;
  }
});

canvas.addEventListener('pointerup', e => {
  pointers.delete(e.pointerId);
  if (phase === 'place' && isMyTurn() && downInfo && !downInfo.moved) {
    const p = pointerToTable(e.clientX, e.clientY);
    if (p) updatePlacePreview(p.x, p.z);
    commitPlace();
  } else if (phase === 'place' && isMyTurn() && downInfo && downInfo.moved && placeCandidate) {
    // 触屏拖动后松手 → 确认
    if (placeCandidate.valid) commitPlace();
  }
  downInfo = null;
});
canvas.addEventListener('pointercancel', e => pointers.delete(e.pointerId));

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const d = e.deltaY * 0.0012;
  if (camMode === 'free' || phase === 'rolling') {
    if (phase === 'rolling' && !rollingCamFree) { rollingCamFree = true; syncOrbitFromCamera(); }
    orbit.dist = clamp(orbit.dist + d, 1.2, 5);
  } else followDist = clamp(followDist + d, 0.45, 1.8);
}, { passive: false });

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

// ---------- 输入:键盘 ----------
window.addEventListener('keydown', e => {
  if (phase === 'replay' && (e.code === 'Space' || e.code === 'Enter')) { e.preventDefault(); finishReplay(); return; }
  if (phase !== 'aim' && phase !== 'place') return;
  const aiming = phase === 'aim' && isMyTurn() && !aiBusy;
  if (e.code === 'ArrowLeft' && aiming) { aimYaw -= (e.shiftKey ? 0.0006 : 0.003); predDirty = true; }
  else if (e.code === 'ArrowRight' && aiming) { aimYaw += (e.shiftKey ? 0.0006 : 0.003); predDirty = true; }
  else if (e.code === 'Space' && aiming && !charging) {
    e.preventDefault();
    charging = true; chargeDir = 1;
  }
  else if (e.code === 'KeyV') toggleTop();
  else if (e.code === 'KeyF') toggleFree();
});
window.addEventListener('keyup', e => {
  if (e.code === 'Space' && charging) {
    charging = false;
    if (power > 0.03 && phase === 'aim' && isMyTurn()) fireShot(buildMyShot(), false);
    else { power = 0; setPowerUI(0); predDirty = true; }
  }
});

// ---------- 力度条 ----------
const powerTrack = $('powerTrack');
let powerDrag = false;
function setPowerUI(v) {
  $('powerFill').style.height = `${v * 100}%`;
  $('powerLabel').textContent = v > 0.01 ? `${Math.round(v * 100)}%` : '力度';
}
function powerFromEvent(e) {
  const rect = powerTrack.getBoundingClientRect();
  return clamp((e.clientY - rect.top) / rect.height, 0, 1);
}
powerTrack.addEventListener('pointerdown', e => {
  if (phase !== 'aim' || !isMyTurn() || aiBusy) return;
  powerDrag = true;
  try { powerTrack.setPointerCapture(e.pointerId); } catch { }
  power = powerFromEvent(e); setPowerUI(power); predDirty = true;
});
powerTrack.addEventListener('pointermove', e => {
  if (!powerDrag) return;
  power = powerFromEvent(e); setPowerUI(power); predDirty = true;
});
powerTrack.addEventListener('pointerup', () => {
  if (!powerDrag) return;
  powerDrag = false;
  if (power > 0.04 && phase === 'aim' && isMyTurn()) fireShot(buildMyShot(), false);
  else { power = 0; setPowerUI(0); predDirty = true; }
});

// ---------- 加塞盘 ----------
const spinDotMini = $('spinMiniDot'), spinDot = $('spinDot'), spinPad = $('spinPad');
function syncSpinUI() {
  const rMini = 37 * 0.82, rBig = spinPad.clientWidth / 2 * 0.86 || 110;
  spinDotMini.style.left = `${50 + spin.a * 41}%`;
  spinDotMini.style.top = `${50 - spin.b * 41}%`;
  spinDot.style.left = `${50 + spin.a * 43}%`;
  spinDot.style.top = `${50 - spin.b * 43}%`;
  $('elevSlider').value = spin.elev;
  $('elevVal').textContent = `${spin.elev}°`;
}
$('spinMini').addEventListener('pointerdown', () => {
  if (phase === 'aim' && isMyTurn()) $('spinBig').classList.remove('hidden');
});
let spinDragging = false;
function setSpinFromPad(e) {
  const rect = spinPad.getBoundingClientRect();
  let ax = ((e.clientX - rect.left) / rect.width - 0.5) * 2;
  let bz = -(((e.clientY - rect.top) / rect.height - 0.5) * 2);
  const m = Math.sqrt(ax * ax + bz * bz);
  const MAXOFF = 0.82; // 归一化盘面 → 实际偏移上限 0.45R 附近
  if (m > MAXOFF) { ax = ax / m * MAXOFF; bz = bz / m * MAXOFF; }
  spin.a = ax * 0.55; spin.b = bz * 0.55;
  syncSpinUI();
  predDirty = true;
}
spinPad.addEventListener('pointerdown', e => { spinDragging = true; try { spinPad.setPointerCapture(e.pointerId); } catch { } setSpinFromPad(e); });
spinPad.addEventListener('pointermove', e => { if (spinDragging) setSpinFromPad(e); });
spinPad.addEventListener('pointerup', () => spinDragging = false);
$('elevSlider').addEventListener('input', e => {
  spin.elev = parseInt(e.target.value, 10);
  $('elevVal').textContent = `${spin.elev}°`;
  predDirty = true;
});
$('spinReset').addEventListener('click', () => { spin = { a: 0, b: 0, elev: 0 }; syncSpinUI(); predDirty = true; });
$('spinClose').addEventListener('click', () => $('spinBig').classList.add('hidden'));
$('spinBig').addEventListener('pointerdown', e => {
  if (e.target === $('spinBig')) $('spinBig').classList.add('hidden');
});

// ---------- 视角按钮 ----------
function toggleTop() {
  camMode = camMode === 'top' ? 'follow' : 'top';
}
function toggleFree() {
  camMode = camMode === 'free' ? 'follow' : 'free';
}
$('btnTop').addEventListener('click', toggleTop);
$('btnFree').addEventListener('click', toggleFree);
$('btnSound').addEventListener('click', () => {
  const on = !Sfx.isSoundEnabled();
  Sfx.setSoundEnabled(on);
  $('btnSound').textContent = on ? '🔊' : '🔇';
});
$('btnMenu').addEventListener('click', () => {
  leaveOnline();
  phase = 'menu';
  showPanel('menu');
});
$('retryBtn').addEventListener('click', () => {
  if (mode === 'challenge') startGame('challenge', { level: challengeIdx });
});

// ---------- 菜单 ----------
$('btnPractice').addEventListener('click', () => startGame('practice'));
$('btnAI').addEventListener('click', () => startGame('ai', { breaker: 0 }));
$('btnLocal').addEventListener('click', () => startGame('local2p', { breaker: 0 }));
$('btnChallenge').addEventListener('click', () => {
  const list = $('levelList');
  list.innerHTML = '';
  CHALLENGES.forEach((lv, i) => {
    const btn = document.createElement('button');
    btn.className = 'lvbtn';
    btn.innerHTML = `第 ${i + 1} 关 · ${lv.name}<small>${lv.desc}</small>`;
    btn.addEventListener('click', () => startGame('challenge', { level: i }));
    list.appendChild(btn);
  });
  showPanel('challengePanel');
});
$('btnOnline').addEventListener('click', () => {
  $('roomStatus').textContent = '';
  $('roomCodeShow').classList.add('hidden');
  showPanel('onlinePanel');
});
$('btnOnlineBack').addEventListener('click', () => { leaveOnline(); showPanel('menu'); });
$('btnChallengeBack').addEventListener('click', () => showPanel('menu'));

// ---------- 结算面板 ----------
$('btnEndMenu').addEventListener('click', () => {
  leaveOnline();
  phase = 'menu';
  showPanel('menu');
});
$('btnNextLevel').addEventListener('click', () => {
  if (challengeIdx < CHALLENGES.length - 1) startGame('challenge', { level: challengeIdx + 1 });
});
$('btnRematch').addEventListener('click', () => {
  if (mode === 'online') {
    myRematch = true;
    net.send({ t: 'rematch' });
    $('endDetail').textContent = '等待对方同意再战…';
    if (peerRematch) restartOnlineGame();
  } else if (mode === 'challenge') {
    startGame('challenge', { level: challengeIdx });
  } else {
    gameCount++;
    startGame(mode, { breaker: gameCount % 2 });
  }
});
function restartOnlineGame() {
  gameCount++;
  startGame('online', { breaker: gameCount % 2 });
}

// ---------- 联机 ----------
function ensureNet() {
  if (net) return net;
  net = createNet({
    onMessage: onNetMessage,
    onDisconnect: () => {
      if (onlineActive) {
        toast('连接已断开', 2500);
        onlineActive = false;
        if (phase !== 'menu') { phase = 'menu'; showPanel('menu'); }
      }
      net = null;
    },
  });
  return net;
}
function leaveOnline() {
  if (net) { net.close(); net = null; }
  onlineActive = false;
}
function onNetMessage(m) {
  switch (m.t) {
    case 'created':
      $('roomStatus').textContent = '房间已创建,把房间码告诉对手:';
      $('roomCodeShow').textContent = m.code;
      $('roomCodeShow').classList.remove('hidden');
      break;
    case 'err':
      $('roomStatus').textContent = '❌ ' + m.msg;
      break;
    case 'start':
      names = [...m.names];
      mySeat = m.you;
      onlineActive = true;
      gameCount = 0;
      toast(`对局开始!你是 ${names[mySeat]},${mySeat === 0 ? '你先开球' : '对方先开球'}`, 2600);
      startGame('online', { breaker: 0 });
      break;
    case 'shot':
      if (phase === 'aim' && rules && rules.shooter !== mySeat) fireShot(m.shot, true);
      else pendingShot = m.shot; // 本地还在回放/结算,先缓存
      break;
    case 'place': {
      const c = cueBall();
      if (c) { c.x = m.x; c.z = m.z; c.on = true; c.resting = true; }
      if (rules) rules.ballInHand = false;
      if (phase === 'place') { phase = 'aim'; refreshHUD(); }
      flushPendingShot();
      break;
    }
    case 'hash':
      remoteHashes.set(m.n, m.h);
      checkHash(m.n);
      break;
    case 'rematch':
      peerRematch = true;
      toast('对方想再来一局');
      if (myRematch) restartOnlineGame();
      break;
    case 'peerLeft':
      toast('对方已离开房间', 3000);
      onlineActive = false;
      if (phase !== 'menu') {
        $('endTitle').textContent = '对方已离开';
        $('endDetail').textContent = '';
        $('btnRematch').classList.add('hidden');
        $('btnNextLevel').classList.add('hidden');
        showPanel('endPanel');
        phase = 'over';
      }
      break;
  }
}
$('btnCreateRoom').addEventListener('click', async () => {
  $('roomStatus').textContent = '连接服务器…';
  try {
    await ensureNet().connect();
    net.send({ t: 'create', name: $('nameInput').value.trim() || '玩家1' });
  } catch (err) {
    $('roomStatus').textContent = '❌ ' + err.message;
  }
});
$('btnJoinRoom').addEventListener('click', async () => {
  const code = $('codeInput').value.trim().toUpperCase();
  if (code.length !== 5) { $('roomStatus').textContent = '❌ 请输入 5 位房间码'; return; }
  $('roomStatus').textContent = '连接服务器…';
  try {
    await ensureNet().connect();
    net.send({ t: 'join', code, name: $('nameInput').value.trim() || '玩家2' });
    $('roomStatus').textContent = '加入中…';
  } catch (err) {
    $('roomStatus').textContent = '❌ ' + err.message;
  }
});

// ---------- 相机 ----------
const camPos = new THREE.Vector3(0, 1.6, 1.9);
const camLook = new THREE.Vector3(0, 0, 0);
const tmpPos = new THREE.Vector3(), tmpLook = new THREE.Vector3();
const trackTmp = new THREE.Vector3(); // 回放跟踪机位的临时向量

function syncOrbitFromCamera() {
  // 用户在走球阶段接管镜头:从当前机位无缝进入轨道视角
  const d = Math.max(camPos.length(), 1.2);
  orbit.dist = clamp(d, 1.2, 5);
  orbit.az = Math.atan2(camPos.z, camPos.x);
  orbit.pol = clamp(Math.acos(clamp(camPos.y / d, -1, 1)), 0.15, 1.35);
}

function updateCamera(dt) {
  const cue = cueBall();
  // 相机升到接近吊灯高度就隐藏吊灯,避免挡视野
  scene3.lamp.visible = camPos.y < 1.05;
  if (phase === 'replay' && replay) {
    tmpPos.copy(replay.camPos);
    tmpLook.copy(replay.camLook);
  } else if (camMode === 'top') {
    tmpPos.set(0, 2.75, 0.0001);
    tmpLook.set(0, 0, 0);
  } else if (phase === 'rolling' && !rollingCamFree && camMode !== 'free') {
    return; // 保持出杆瞬间的机位看完整段走球,不强制切全景(避免眩晕)
  } else if (camMode === 'free' || phase === 'rolling' || phase === 'over' || (phase !== 'menu' && !isMyTurn() && mode !== 'local2p')) {
    tmpPos.set(
      Math.sin(orbit.pol) * Math.cos(orbit.az) * orbit.dist,
      Math.cos(orbit.pol) * orbit.dist,
      Math.sin(orbit.pol) * Math.sin(orbit.az) * orbit.dist
    );
    tmpLook.set(0, 0, 0);
  } else if ((phase === 'aim' || phase === 'place') && cue) {
    const fx = Math.cos(aimYaw), fz = Math.sin(aimYaw);
    const back = followDist * Math.cos(followPitch);
    const up = followDist * Math.sin(followPitch) + 0.06;
    tmpPos.set(cue.x - fx * back, R + up, cue.z - fz * back);
    tmpLook.set(cue.x + fx * 0.55, R, cue.z + fz * 0.55);
  } else {
    return;
  }
  const k = 1 - Math.exp(-9 * dt);
  camPos.lerp(tmpPos, k);
  camLook.lerp(tmpLook, k);
  scene3.camera.position.copy(camPos);
  scene3.camera.lookAt(camLook);
}

// ---------- 球杆摆位 ----------
function updateCueStick() {
  const cue = cueBall();
  let showCue = (phase === 'aim' || (phase === 'rolling' && cueFire)) && cue && cue.on && mode !== null;
  // 联机时对手瞄准阶段不显示我方球杆(我们不知道对方实时瞄准方向)
  if (mode === 'online' && rules && rules.shooter !== mySeat && !cueFire) showCue = false;
  scene3.cue.visible = !!showCue;
  if (!scene3.cue.visible) return;
  const fx = Math.cos(aimYaw), fz = Math.sin(aimYaw);
  const rx = -fz, rz = fx;
  // 视觉抬杆:真人持杆尾部天然抬高 ~7°,用户抬杆角在此之上
  const er = Math.max(spin.elev * Math.PI / 180, 0.12);
  let pull = 0.03 + power * 0.17;
  if (cueFire) {
    const t = cueFire.t / cueFire.dur;
    pull = (0.03 + cueFire.shot.power * 0.17) * (1 - t) - 0.01 * t;
  }
  // 杆尖停在加塞点后方,杆身沿(前方向下压 er)的轴线,尾部高于杆尖
  const tipX = cue.x - fx * (R + pull) * Math.cos(er) + rx * spin.a * R * 0.8;
  const tipY = R + spin.b * R * 0.8 + (R + pull) * Math.sin(er);
  const tipZ = cue.z - fz * (R + pull) * Math.cos(er) + rz * spin.a * R * 0.8;
  scene3.cue.position.set(tipX, tipY, tipZ);
  scene3.cue.rotation.order = 'YZX';
  scene3.cue.rotation.y = -aimYaw;
  scene3.cue.rotation.z = -er; // 负号:杆尖朝下压向球,杆尾抬起
}

// ---------- 主循环 ----------
let lastT = performance.now();
let frameNo = 0;
function loop() {
  requestAnimationFrame(loop);
  const now = performance.now();
  const dt = Math.min((now - lastT) / 1000, 0.1);
  lastT = now;
  if (!window.__paused) frame(dt); // __paused:测试时由 __tick 手动推帧
}
function frame(dt) {
  frameNo++;

  if (phase === 'rolling') {
    if (cueFire) {
      cueFire.t += dt;
      if (cueFire.t >= cueFire.dur) {
        const cue = cueBall();
        applyStrike(cue, cueFire.shot);
        cueFire = null;
        power = 0; setPowerUI(0);
        spin = { a: 0, b: 0, elev: 0 }; syncSpinUI();
      }
    } else {
      advanceSim(dt);
    }
  } else if (phase === 'replay' && replay) {
    // 慢动作重演到落袋后一小段,再停留让下坠动画播完
    replay.acc += dt * replay.speed;
    const evBuf = [];
    while (replay.acc >= DT && replay.step < replay.endStep) {
      replay.acc -= DT;
      evBuf.length = 0;
      stepPhysics(replay.balls, evBuf);
      replay.step++;
      const now = performance.now();
      for (const e of evBuf) {
        if (e.type === 'hit' && now - lastHitSfx > 30) { Sfx.sfxBallHit(e.speed); lastHitSfx = now; }
        else if (e.type === 'cushion' && e.speed > 0.15 && now - lastCushSfx > 40) { Sfx.sfxCushion(e.speed); lastCushSfx = now; }
        else if (e.type === 'pocket') Sfx.sfxPocket();
      }
    }
    if (replay.step >= replay.endStep) {
      // 慢放结束 → 镜头跟着最后进袋的球走回球轨道,直到滚进托盘
      if (!replay.track) {
        const last = pocketRecords[pocketRecords.length - 1];
        replay.track = { id: last ? last.id : -1, hold: 0.9, timeout: 8 };
      }
      const tk = replay.track;
      tk.timeout -= dt;
      const info = tk.id >= 0 ? scene3.dropInfo(tk.id) : null;
      if (!info || tk.timeout <= 0) {
        // 无动画可跟(异常兜底)或超时:按原节奏收尾
        replay.hold -= dt;
        if (replay.hold <= 0 || !info) finishReplay();
      } else {
        // 球还在袋口:沿用袋口机位;沉入漏斗后硬切到桌下跟踪镜头
        // (平滑下潜会扫穿桌体木结构,切镜是转播式处理)
        const under = info.y < -0.125 || info.done;
        if (under && !tk.cut) {
          tk.cut = true;
          replay.camPos.set(info.x - 0.55, -0.34, info.z + 0.78);
        }
        const k = 1 - Math.exp(-3.2 * dt);
        // 球接近轨道尾端/已入托盘 → 机位转到桌尾外侧的托盘观赏位
        // (侧跟机位在最后一段会被桌腿挡住)
        const atTray = info.done || info.x > 1.02;
        if (atTray) {
          trackTmp.set(2.3, -0.06, 0.85);
        } else if (under) {
          trackTmp.set(info.x - 0.5, Math.min(info.y + 0.2, -0.24), info.z + 0.7);
        } else {
          trackTmp.set(info.x - 0.38, info.y + 0.22, info.z + 0.55);
        }
        replay.camPos.lerp(trackTmp, k);
        if (atTray) trackTmp.set(1.48, -0.46, 0);   // 看整个托盘(已收的球都在里面)
        else trackTmp.set(info.x, info.y, info.z);
        replay.camLook.lerp(trackTmp, k);
        if (info.done) {
          tk.hold -= dt;          // 到托盘后再看一小会
          if (tk.hold <= 0) finishReplay();
        }
      }
    }
  }

  // 空格蓄力
  if (charging && phase === 'aim') {
    power += chargeDir * dt * 0.75;
    if (power >= 1) { power = 1; chargeDir = -1; }
    if (power <= 0) { power = 0; chargeDir = 1; }
    setPowerUI(power);
  }

  // 瞄准预测线(节流:脏了才算,且隔帧)
  if (phase === 'aim' && isMyTurn() && !aiBusy && predDirty && frameNo - lastPredFrame > 1) {
    lastPredFrame = frameNo;
    predDirty = false;
    const shot = buildMyShot();
    if (shot.power < 0.06) shot.power = 0.42; // 预览默认力度
    const pred = predictShot(balls, shot);
    scene3.setAim(pred);
  }
  if ((phase !== 'aim' || !isMyTurn() || aiBusy) && frameNo % 15 === 0) {
    scene3.setAim(null);
  }

  updateCamera(dt);
  updateCueStick();
  scene3.updateBalls(phase === 'replay' && replay ? replay.balls : balls, dt);
  scene3.renderer.render(scene3.scene, scene3.camera);
}

// ---------- 尺寸 ----------
function onResize() {
  scene3.resize(window.innerWidth, window.innerHeight);
  syncSpinUI();
}
window.addEventListener('resize', onResize);
onResize();

// 后台标签兜底:rAF 被浏览器暂停时用定时器继续推进模拟(联机时对方不能被卡住)
let bgLastT = performance.now();
setInterval(() => {
  if (window.__noBg) { bgLastT = performance.now(); return; } // 调试:关闭后台兜底
  if (!document.hidden) { bgLastT = performance.now(); return; }
  const now = performance.now();
  const dt = Math.min((now - bgLastT) / 1000, 0.25);
  bgLastT = now;
  if (phase === 'replay') { finishReplay(); return; } // 后台不播回放,直接结算
  if (phase !== 'rolling') return;
  if (cueFire) {
    cueFire.t += dt;
    if (cueFire.t >= cueFire.dur) {
      applyStrike(cueBall(), cueFire.shot);
      cueFire = null;
      power = 0; setPowerUI(0);
      spin = { a: 0, b: 0, elev: 0 }; syncSpinUI();
    }
  } else {
    advanceSim(dt);
  }
}, 60);

// 调试钩子(不影响游戏)
window.__aim = (yaw) => { aimYaw = yaw; predDirty = true; };
window.__shoot = (yaw, pow) => {
  if (phase !== 'aim') return 'phase=' + phase;
  if (typeof yaw === 'number') aimYaw = yaw;
  power = typeof pow === 'number' ? pow : 0.5;
  fireShot(buildMyShot(), false);
  return 'fired';
};
// 手动推帧(标签页隐藏时 rAF 暂停,测试用)
window.__tick = (n, dt) => {
  const step = dt || 1 / 60;
  for (let i = 0; i < (n || 1); i++) frame(step);
  return window.__dbg();
};
// 导出当前画面截图(测试用)
window.__snap = (w, q) => {
  frame(0.001);
  const gl = canvas;
  const cw = w || 720, ch = Math.round(cw * gl.height / gl.width);
  const cv = document.createElement('canvas');
  cv.width = cw; cv.height = ch;
  cv.getContext('2d').drawImage(gl, 0, 0, cw, ch);
  return cv.toDataURL('image/jpeg', q || 0.6);
};
window.__dbg = () => JSON.stringify({
  phase, mode, camMode,
  replay: replay ? {
    step: replay.step, end: replay.endStep, hold: +replay.hold.toFixed(2),
    cue: (b => b ? { on: b.on, x: +b.x.toFixed(3), z: +b.z.toFixed(3) } : null)(replay.balls.find(b => b.id === 0)),
  } : null,
  hash: stateHash(balls),
  rules,
  onCount: balls.filter(b => b.on).length,
  pockets: shotEvents.filter(e => e.type === 'pocket').map(e => e.id),
  moving: balls.filter(b => b.on && !b.resting).map(b => ({
    id: b.id, x: +b.x.toFixed(4), z: +b.z.toFixed(4),
    v: [+b.vx.toFixed(5), +b.vz.toFixed(5)],
    w: [+b.wx.toFixed(3), +b.wy.toFixed(3), +b.wz.toFixed(3)],
  })),
});

// 初始:菜单背景摆一副球看着好看
balls = rackEightBall();
phase = 'menu';
showPanel('menu');
loop();
