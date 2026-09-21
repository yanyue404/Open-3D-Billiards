// ============================================================
// 确定性台球物理引擎(拟真)
// - 固定子步长积分(1/1200s),只用 + - * / sqrt,跨浏览器逐位一致
// - 滑动摩擦 / 滚动摩擦 / 竖轴旋转摩擦三态模型
// - 出杆模型:Leckie-Greenspan 冲量公式(高低杆/左右塞/抬杆扎杆)
// - 球间碰撞:法向恢复系数 + 切向摩擦(throw 效应 + 旋转传递)
// - 库边:恢复系数 + 切向摩擦(侧塞改变反弹角),袋口捕获
// 单位:米、秒、千克。y 轴向上,球心平面 y = R。
// ============================================================

export const TABLE = {
  L: 2.54,            // 台面长(x 方向,±1.27)
  W: 1.27,            // 台面宽(z 方向,±0.635)
  R: 0.028575,        // 球半径
  BALL_MASS: 0.17,
  CUE_MASS: 0.55,
  CORNER_CUT: 0.108,  // 角袋在库边上切掉的长度
  SIDE_CUT: 0.068,    // 中袋半开口
  POCKET_R_CORNER: 0.094,
  POCKET_R_SIDE: 0.068,
};

// 袋口中心(略在台面边界外)。中袋中心比角袋更靠外:
// 真实球台中袋落球孔基本藏在库边线以外,只轻微切进台面
export const POCKETS = [
  { x: -TABLE.L / 2 - 0.028, z: -TABLE.W / 2 - 0.028, r: TABLE.POCKET_R_CORNER, corner: true },
  { x:  TABLE.L / 2 + 0.028, z: -TABLE.W / 2 - 0.028, r: TABLE.POCKET_R_CORNER, corner: true },
  { x: -TABLE.L / 2 - 0.028, z:  TABLE.W / 2 + 0.028, r: TABLE.POCKET_R_CORNER, corner: true },
  { x:  TABLE.L / 2 + 0.028, z:  TABLE.W / 2 + 0.028, r: TABLE.POCKET_R_CORNER, corner: true },
  { x: 0, z: -TABLE.W / 2 - 0.052, r: TABLE.POCKET_R_SIDE, corner: false },
  { x: 0, z:  TABLE.W / 2 + 0.052, r: TABLE.POCKET_R_SIDE, corner: false },
];

const G = 9.81;
const MU_SLIDE = 0.2;      // 布面滑动摩擦
const MU_ROLL = 0.016;     // 滚动阻力
const MU_SPIN = 0.022;     // 竖轴旋转摩擦
const MU_BALL = 0.06;      // 球间摩擦(throw)
const E_BALL = 0.96;       // 球间恢复系数
const E_CUSH = 0.74;       // 库边恢复系数
const MU_CUSH = 0.20;      // 库边切向摩擦
export const DT = 1 / 1200;
const STOP_V = 0.008;      // 速度停判阈值
const SLIDE_EPS = 0.003;   // 滑动/滚动切换阈值

const R = TABLE.R;
const HALF_L = TABLE.L / 2;
const HALF_W = TABLE.W / 2;

function sqrt(x) { return Math.sqrt(x); }

// ---------- 状态 ----------
export function makeBall(id, x, z) {
  return { id, x, z, vx: 0, vz: 0, wx: 0, wy: 0, wz: 0, on: true, resting: true };
}

// 标准八球排列:0=母球,1-7 全色,9-15 花色(条纹),8 黑八
export function rackEightBall() {
  const balls = [];
  balls.push(makeBall(0, -TABLE.L / 4, 0)); // 母球在开球线上
  const footX = TABLE.L / 4;
  const gap = R * 2.0002; // 极小间隙,保证不重叠
  const rowDX = gap * 0.8660254037844386; // sqrt(3)/2,常量字面量保证确定性
  // 顺序:顶点全色,8 在第三排中间,两底角异组
  const order = [1, 9, 2, 10, 8, 3, 11, 4, 12, 13, 5, 14, 6, 15, 7];
  let idx = 0;
  for (let row = 0; row < 5; row++) {
    for (let i = 0; i <= row; i++) {
      const x = footX + row * rowDX;
      const z = (i - row / 2) * gap;
      balls.push(makeBall(order[idx++], x, z));
    }
  }
  balls.sort((a, b) => a.id - b.id);
  return balls;
}

export function cloneBalls(balls) {
  return balls.map(b => ({ ...b }));
}

// ---------- 出杆 ----------
// shot: { fx, fz(瞄准单位向量), power(0..1), a(侧偏 -1..1, +为瞄准方向右侧),
//         b(纵偏 -1..1, +为上=高杆), sinE, cosE(抬杆角 sin/cos, 由发起方量化后传输) }
export const MAX_CUE_SPEED = 6.0;

export function applyStrike(ball, shot) {
  const { fx, fz, a, b, sinE, cosE } = shot;
  const V0 = shot.power * MAX_CUE_SPEED;
  const c2 = 1 - a * a - b * b;
  const c = c2 > 0 ? sqrt(c2) : 0;
  const mM = TABLE.BALL_MASS / TABLE.CUE_MASS;
  const q = b * cosE - c * sinE;
  const D = 1 + mM + 2.5 * (a * a + q * q);
  const Vb = 2 * V0 / D;             // 沿杆方向的球速
  const vh = Vb * cosE;              // 水平分量(垂直分量被台面吸收)
  // 正交系:f=(fx,0,fz) 前,u=(0,1,0) 上,r=f×u=(-fz,0,fx)
  const rx = -fz, rz = fx;
  ball.vx = fx * vh;
  ball.vz = fz * vh;
  // Δω = (5Vb)/(2R) * [ a·sinE·f + a·cosE·u + (c·sinE − b·cosE)·r ]
  const k = 2.5 * Vb / R;
  const wr = k * (c * sinE - b * cosE);
  ball.wx = k * a * sinE * fx + wr * rx;
  ball.wy = k * a * cosE;
  ball.wz = k * a * sinE * fz + wr * rz;
  ball.resting = false;
}

// ---------- 单步积分 ----------
// events 收集: {type:'hit'|'cushion'|'pocket', ...}
export function stepPhysics(balls, events) {
  // 1. 摩擦与运动
  for (const ball of balls) {
    if (!ball.on || ball.resting) continue;
    // 接触点相对布面速度(含旋转)
    const ucx = ball.vx + R * ball.wz;
    const ucz = ball.vz - R * ball.wx;
    const uc = sqrt(ucx * ucx + ucz * ucz);
    if (uc > SLIDE_EPS) {
      // 滑动状态
      const ux = ucx / uc, uz = ucz / uc;
      const dv = MU_SLIDE * G * DT;
      ball.vx -= dv * ux;
      ball.vz -= dv * uz;
      const dw = 2.5 * MU_SLIDE * G / R * DT;
      ball.wx += dw * uz;
      ball.wz -= dw * ux;
    } else {
      // 滚动状态:投影到纯滚动
      ball.wz = -ball.vx / R;
      ball.wx = ball.vz / R;
      const v = sqrt(ball.vx * ball.vx + ball.vz * ball.vz);
      if (v > STOP_V) {
        const dv = MU_ROLL * G * DT;
        const s = dv >= v ? 0 : (v - dv) / v;
        ball.vx *= s;
        ball.vz *= s;
      } else {
        ball.vx = 0; ball.vz = 0; ball.wx = 0; ball.wz = 0;
      }
    }
    // 竖轴旋转衰减
    if (ball.wy !== 0) {
      const dwy = 2.5 * MU_SPIN * G / R * DT;
      if (ball.wy > 0) { ball.wy -= dwy; if (ball.wy < 0) ball.wy = 0; }
      else { ball.wy += dwy; if (ball.wy > 0) ball.wy = 0; }
    }
    // 停判
    if (ball.vx === 0 && ball.vz === 0 && ball.wy === 0 && ball.wx === 0 && ball.wz === 0) {
      ball.resting = true;
      continue;
    }
    // 位移
    ball.x += ball.vx * DT;
    ball.z += ball.vz * DT;
  }

  // 2. 球间碰撞
  for (let i = 0; i < balls.length; i++) {
    const A = balls[i];
    if (!A.on) continue;
    for (let j = i + 1; j < balls.length; j++) {
      const B = balls[j];
      if (!B.on) continue;
      const dx = B.x - A.x, dz = B.z - A.z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= 4 * R * R || d2 === 0) continue;
      const d = sqrt(d2);
      const nx = dx / d, nz = dz / d;
      const rvx = A.vx - B.vx, rvz = A.vz - B.vz;
      const vn = rvx * nx + rvz * nz; // 接近速度(>0 表示靠近)
      // 位置分离
      const overlap = 2 * R - d;
      A.x -= nx * overlap * 0.5; A.z -= nz * overlap * 0.5;
      B.x += nx * overlap * 0.5; B.z += nz * overlap * 0.5;
      if (vn <= 0) continue;
      // 法向冲量(等质量)
      const jn = (1 + E_BALL) * 0.5 * vn;
      A.vx -= jn * nx; A.vz -= jn * nz;
      B.vx += jn * nx; B.vz += jn * nz;
      // 切向摩擦(throw):接触点相对滑动(含两球旋转)
      const tx = -nz, tz = nx;
      // 竖轴旋转对接触点切向速度的贡献(throw 效应来源)
      const surfA = A.wy * R;
      const surfB = B.wy * R;
      const relT = (rvx * tx + rvz * tz) + surfA + surfB;
      const jt0 = MU_BALL * jn;
      let jt = relT * 0.5;
      if (jt > jt0) jt = jt0; else if (jt < -jt0) jt = -jt0;
      A.vx -= jt * tx; A.vz -= jt * tz;
      B.vx += jt * tx; B.vz += jt * tz;
      // 旋转传递(竖轴)
      const dwy = jt * 2.5 / R;
      A.wy -= dwy * 0.5;
      B.wy -= dwy * 0.5;
      A.resting = false; B.resting = false;
      const speed = vn;
      events.push({ type: 'hit', a: A.id, b: B.id, speed, x: (A.x + B.x) / 2, z: (A.z + B.z) / 2 });
    }
  }

  // 3. 库边与袋口
  for (const ball of balls) {
    if (!ball.on || ball.resting) continue;
    collideCushions(ball, events);
    checkPockets(ball, events);
  }
}

function inLongCushionX(x) {
  // 长库(z 方向两侧)有效区段:避开角袋与中袋
  const a0 = -HALF_L + TABLE.CORNER_CUT, a1 = -TABLE.SIDE_CUT;
  const b0 = TABLE.SIDE_CUT, b1 = HALF_L - TABLE.CORNER_CUT;
  return (x >= a0 && x <= a1) || (x >= b0 && x <= b1);
}
function inShortCushionZ(z) {
  return z >= -HALF_W + TABLE.CORNER_CUT && z <= HALF_W - TABLE.CORNER_CUT;
}

function bounce(ball, nx, nz, events) {
  // n 指向台面内
  const vn = ball.vx * nx + ball.vz * nz;
  if (vn >= 0) return;
  const tx = -nz, tz = nx;
  const vt = ball.vx * tx + ball.vz * tz;
  // 接触点在 -n 方向:表面切向速度 = -R·(ω×n) 的切向分量 → ωy 贡献
  const surf = ball.wy * R; // 侧塞:接触点切向速度
  const slip = vt + surf;
  const newVn = -E_CUSH * vn;
  const jImpulse = (1 + E_CUSH) * (-vn);
  let jt = slip * 0.35;
  const jtMax = MU_CUSH * jImpulse;
  if (jt > jtMax) jt = jtMax; else if (jt < -jtMax) jt = -jtMax;
  const newVt = vt - jt;
  ball.vx = newVn * nx + newVt * tx;
  ball.vz = newVn * nz + newVt * tz;
  // 侧塞被库边消耗并反哺角度
  ball.wy -= jt * 2.5 / R;
  // 顶/低旋过库损耗
  ball.wx *= 0.7; ball.wz *= 0.7;
  events.push({ type: 'cushion', id: ball.id, speed: -vn, x: ball.x, z: ball.z });
}

function collideCushions(ball, events) {
  if (ball.z < -HALF_W + R && inLongCushionX(ball.x)) {
    ball.z = -HALF_W + R;
    bounce(ball, 0, 1, events);
  } else if (ball.z > HALF_W - R && inLongCushionX(ball.x)) {
    ball.z = HALF_W - R;
    bounce(ball, 0, -1, events);
  }
  if (ball.x < -HALF_L + R && inShortCushionZ(ball.z)) {
    ball.x = -HALF_L + R;
    bounce(ball, 1, 0, events);
  } else if (ball.x > HALF_L - R && inShortCushionZ(ball.z)) {
    ball.x = HALF_L - R;
    bounce(ball, -1, 0, events);
  }
  // 袋口斜颚(角袋两侧小斜面):简化为点碰撞——超出边界但在袋口区,朝最近袋滑入
}

function checkPockets(ball, events) {
  for (const p of POCKETS) {
    const dx = ball.x - p.x, dz = ball.z - p.z;
    if (dx * dx + dz * dz < p.r * p.r) {
      ball.on = false;
      ball.resting = true;
      events.push({ type: 'pocket', id: ball.id, pocket: POCKETS.indexOf(p), x: ball.x, z: ball.z });
      return;
    }
  }
  // 兜底:球飞出台面边界(袋口区未捕获)→ 归入最近袋
  if (ball.x < -HALF_L - R || ball.x > HALF_L + R || ball.z < -HALF_W - R || ball.z > HALF_W + R) {
    let best = 0, bd = Infinity;
    for (let i = 0; i < POCKETS.length; i++) {
      const dx = ball.x - POCKETS[i].x, dz = ball.z - POCKETS[i].z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bd) { bd = d2; best = i; }
    }
    ball.on = false;
    ball.resting = true;
    events.push({ type: 'pocket', id: ball.id, pocket: best, x: ball.x, z: ball.z });
  }
}

export function allResting(balls) {
  for (const b of balls) if (b.on && !b.resting) return false;
  return true;
}

// ---------- 完整模拟(供 AI / 预测用,不产生渲染) ----------
export function simulateShot(balls, shot, maxT) {
  const sim = cloneBalls(balls);
  const cue = sim.find(b => b.id === 0);
  if (!cue || !cue.on) return { balls: sim, events: [] };
  applyStrike(cue, shot);
  const events = [];
  const maxSteps = ((maxT || 25) / DT) | 0;
  for (let i = 0; i < maxSteps; i++) {
    stepPhysics(sim, events);
    if (allResting(sim)) break;
  }
  return { balls: sim, events };
}

// ---------- 瞄准预测:母球路径 + 首次接触 + 目标球方向 ----------
export function predictShot(balls, shot) {
  const sim = cloneBalls(balls);
  const cue = sim.find(b => b.id === 0);
  if (!cue || !cue.on) return null;
  applyStrike(cue, shot);
  const path = [{ x: cue.x, z: cue.z }];
  let contact = null, objectDir = null, cushions = 0;
  const events = [];
  const maxSteps = (6 / DT) | 0;
  let lastPx = cue.x, lastPz = cue.z;
  for (let i = 0; i < maxSteps; i++) {
    events.length = 0;
    stepPhysics(sim, events);
    // 记录路径(每 12 步取一点)
    if (i % 12 === 0) {
      const dx = cue.x - lastPx, dz = cue.z - lastPz;
      if (dx * dx + dz * dz > 1e-8) {
        path.push({ x: cue.x, z: cue.z });
        lastPx = cue.x; lastPz = cue.z;
      }
    }
    for (const e of events) {
      if (e.type === 'hit' && (e.a === 0 || e.b === 0) && !contact) {
        const otherId = e.a === 0 ? e.b : e.a;
        const other = sim.find(b => b.id === otherId);
        contact = { x: cue.x, z: cue.z, ballId: otherId };
        const sp = sqrt(other.vx * other.vx + other.vz * other.vz);
        if (sp > 1e-6) objectDir = { x: other.vx / sp, z: other.vz / sp, speed: sp };
        path.push({ x: cue.x, z: cue.z });
        // 接触后母球再走一小段
        let post = 0;
        const postPath = [{ x: cue.x, z: cue.z }];
        for (let k = 0; k < 400 && post < 400; k++, post++) {
          const ev2 = [];
          stepPhysics(sim, ev2);
          if (k % 20 === 0) postPath.push({ x: cue.x, z: cue.z });
          let stop = false;
          for (const e2 of ev2) {
            if (e2.type === 'hit' && (e2.a === 0 || e2.b === 0)) stop = true;
            if (e2.type === 'cushion' && e2.id === 0) stop = true;
            if (e2.type === 'pocket' && e2.id === 0) stop = true;
          }
          if (stop || !cue.on || cue.resting) break;
        }
        postPath.push({ x: cue.x, z: cue.z });
        return { path, contact, objectDir, postPath };
      }
      if (e.type === 'cushion' && e.id === 0) {
        path.push({ x: e.x, z: e.z });
        lastPx = e.x; lastPz = e.z;
        cushions++;
        if (cushions >= 3) return { path, contact: null, objectDir: null };
      }
      if (e.type === 'pocket' && e.id === 0) {
        path.push({ x: e.x, z: e.z });
        return { path, contact: null, objectDir: null, scratch: true };
      }
    }
    if (cue.resting) break;
  }
  path.push({ x: cue.x, z: cue.z });
  return { path, contact, objectDir };
}

// ---------- 合法摆球位置检查 ----------
export function isValidPlacement(balls, x, z, kitchenOnly) {
  if (x < -HALF_L + R || x > HALF_L - R || z < -HALF_W + R || z > HALF_W - R) return false;
  if (kitchenOnly && x > -TABLE.L / 4) return false;
  for (const b of balls) {
    if (!b.on || b.id === 0) continue;
    const dx = b.x - x, dz = b.z - z;
    if (dx * dx + dz * dz < 4 * R * R * 1.02) return false;
  }
  return true;
}

// 找一个靠近目标点的合法位置(重生黑八等)
export function findFreeSpot(balls, tx, tz) {
  if (isValidPlacement(balls, tx, tz, false)) return { x: tx, z: tz };
  for (let d = 1; d < 40; d++) {
    const off = d * R * 0.5;
    const cands = [
      { x: tx + off, z: tz }, { x: tx - off, z: tz },
      { x: tx, z: tz + off }, { x: tx, z: tz - off },
    ];
    for (const c of cands) if (isValidPlacement(balls, c.x, c.z, false)) return c;
  }
  return { x: 0, z: 0 };
}

// ---------- 状态哈希(联机不同步检测) ----------
export function stateHash(balls) {
  let h = 2166136261;
  for (const b of balls) {
    const xi = Math.round(b.x * 1e6) | 0;
    const zi = Math.round(b.z * 1e6) | 0;
    const oi = b.on ? 1 : 0;
    h = (h ^ xi) >>> 0; h = (h * 16777619) >>> 0;
    h = (h ^ zi) >>> 0; h = (h * 16777619) >>> 0;
    h = (h ^ oi) >>> 0; h = (h * 16777619) >>> 0;
  }
  return h >>> 0;
}

// ---------- 输入量化(联机确定性) ----------
export function quantizeShot(shot) {
  const q = v => Math.round(v * 1e9) / 1e9;
  return {
    fx: q(shot.fx), fz: q(shot.fz),
    power: q(shot.power),
    a: q(shot.a), b: q(shot.b),
    sinE: q(shot.sinE), cosE: q(shot.cosE),
  };
}
