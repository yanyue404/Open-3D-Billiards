// ============================================================
// 人机 AI:几何选杆(ghost ball)+ 真实物理模拟验证
// 1. 枚举合法目标球 × 袋口,几何可行性 + 路径遮挡检查
// 2. 按难度打分排序,取前若干候选跑完整模拟验证
// 3. 无可行进攻 → 安全球(轻推最近合法球)
// ============================================================
import { TABLE, POCKETS, simulateShot, isValidPlacement, quantizeShot } from 'm/physics';
import { groupOf } from 'm/rules';

const R = TABLE.R;

function legalTargets(rules, balls) {
  const seat = rules.shooter;
  const g = rules.groups[seat];
  const ids = [];
  for (const b of balls) {
    if (!b.on || b.id === 0) continue;
    if (rules.open) { if (b.id !== 8) ids.push(b.id); }
    else if (g) {
      const cleared = balls.every(x => !x.on || groupOf(x.id) !== g);
      if (cleared) { if (b.id === 8) ids.push(8); }
      else if (groupOf(b.id) === g) ids.push(b.id);
    }
  }
  // 分组已定且清完 → 只剩 8
  if (ids.length === 0) {
    const b8 = balls.find(b => b.id === 8 && b.on);
    if (b8) ids.push(8);
  }
  return ids;
}

// 线段与圆的相交(路径遮挡)
function pathBlocked(balls, x0, z0, x1, z1, excludeIds) {
  const dx = x1 - x0, dz = z1 - z0;
  const len2 = dx * dx + dz * dz;
  if (len2 < 1e-9) return false;
  for (const b of balls) {
    if (!b.on || excludeIds.includes(b.id)) continue;
    const t = Math.max(0, Math.min(1, ((b.x - x0) * dx + (b.z - z0) * dz) / len2));
    const px = x0 + t * dx, pz = z0 + t * dz;
    const ddx = b.x - px, ddz = b.z - pz;
    if (ddx * ddx + ddz * ddz < (2 * R * 0.96) * (2 * R * 0.96)) return true;
  }
  return false;
}

function candidateShots(rules, balls) {
  const cue = balls.find(b => b.id === 0);
  const targets = legalTargets(rules, balls);
  const cands = [];
  for (const tid of targets) {
    const T = balls.find(b => b.id === tid);
    for (const p of POCKETS) {
      const tpx = p.x - T.x, tpz = p.z - T.z;
      const dTP = Math.sqrt(tpx * tpx + tpz * tpz);
      if (dTP < 1e-6) continue;
      const ux = tpx / dTP, uz = tpz / dTP;
      // ghost ball 位置
      const gx = T.x - ux * 2 * R, gz = T.z - uz * 2 * R;
      const cgx = gx - cue.x, cgz = gz - cue.z;
      const dCG = Math.sqrt(cgx * cgx + cgz * cgz);
      if (dCG < R) continue;
      const fx = cgx / dCG, fz = cgz / dCG;
      // 切角:母球行进方向与目标球去向夹角
      const cosCut = fx * ux + fz * uz;
      if (cosCut < 0.08) continue; // 切角过大打不进
      // 遮挡检查
      if (pathBlocked(balls, cue.x, cue.z, gx, gz, [0, tid])) continue;
      if (pathBlocked(balls, T.x, T.z, p.x, p.z, [0, tid])) continue;
      // 打分:切角、距离、袋型
      const pocketBonus = p.corner ? 1.0 : 0.75;
      const score = cosCut * cosCut * pocketBonus / (1 + dCG * 0.6) / (1 + dTP * 0.8);
      // 力度估计:目标球需要的滚动初速 + 切角损耗
      const vObj = Math.sqrt(2 * 0.011 * 9.81 * dTP) + 0.35;
      const vCue = vObj / Math.max(cosCut, 0.2) + Math.sqrt(2 * 0.011 * 9.81 * dCG) * 0.5;
      let power = Math.min(vCue / 4.2, 1);
      power = Math.max(power, 0.18);
      cands.push({ fx, fz, power, score, tid, pocket: POCKETS.indexOf(p) });
    }
  }
  cands.sort((a, b) => b.score - a.score);
  return cands;
}

function makeShot(fx, fz, power, a, b) {
  return quantizeShot({ fx, fz, power, a: a || 0, b: b || 0, sinE: 0, cosE: 1 });
}

// 主入口:决定 AI 出杆。返回量化后的 shot
export function aiChooseShot(rules, balls, difficulty) {
  const diff = difficulty || 0.6; // 0..1,越高越准
  const cue = balls.find(b => b.id === 0);
  const cands = candidateShots(rules, balls);
  // 模拟验证前若干候选
  const tryN = Math.min(cands.length, 7);
  for (let i = 0; i < tryN; i++) {
    const c = cands[i];
    for (const powAdj of [1, 1.25, 0.85]) {
      const shot = makeShot(c.fx, c.fz, Math.min(c.power * powAdj, 1), 0, -0.12);
      const { balls: after, events } = simulateShot(balls, shot, 15);
      let pottedTarget = false, scratch = false, potted8Early = false;
      for (const e of events) {
        if (e.type === 'pocket') {
          if (e.id === c.tid) pottedTarget = true;
          if (e.id === 0) scratch = true;
          if (e.id === 8 && c.tid !== 8) potted8Early = true;
        }
      }
      if (pottedTarget && !scratch && !potted8Early) {
        return addError(shot, diff);
      }
    }
  }
  // 进攻无解 → 安全球:轻推最近合法目标,尽量贴库
  const targets = legalTargets(rules, balls);
  let best = null, bd = Infinity;
  for (const tid of targets) {
    const T = balls.find(b => b.id === tid);
    const dx = T.x - cue.x, dz = T.z - cue.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bd && !pathBlocked(balls, cue.x, cue.z, T.x - dx / Math.sqrt(d2) * 2 * R, T.z - dz / Math.sqrt(d2) * 2 * R, [0, tid])) {
      bd = d2; best = T;
    }
  }
  if (!best) {
    // 全被遮挡:朝最近目标硬打(可能犯规,但没办法)
    for (const tid of targets) {
      const T = balls.find(b => b.id === tid);
      const dx = T.x - cue.x, dz = T.z - cue.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bd) { bd = d2; best = T; }
    }
  }
  if (!best) return makeShot(1, 0, 0.3, 0, 0);
  const dx = best.x - cue.x, dz = best.z - cue.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  const pow = Math.min(0.16 + d * 0.12, 0.5);
  return addError(makeShot(dx / d, dz / d, pow, 0, -0.1), diff);
}

// 按难度加入瞄准误差(AI 仅离线模式使用,可用 Math.random)
function addError(shot, diff) {
  const errMax = (1 - diff) * 0.012 + 0.0012; // 弧度
  const err = (Math.random() * 2 - 1) * errMax;
  const cos = Math.cos(err), sin = Math.sin(err);
  const fx = shot.fx * cos - shot.fz * sin;
  const fz = shot.fx * sin + shot.fz * cos;
  return quantizeShot({ ...shot, fx, fz });
}

// AI 自由球摆放:沿最佳目标-袋口延长线找直球位
export function aiPlaceCueBall(rules, balls) {
  const targets = legalTargets(rules, balls);
  let best = null;
  for (const tid of targets) {
    const T = balls.find(b => b.id === tid);
    for (const p of POCKETS) {
      const ux = T.x - p.x, uz = T.z - p.z;
      const d = Math.sqrt(ux * ux + uz * uz);
      if (d < 1e-6) continue;
      const nx = ux / d, nz = uz / d;
      for (const back of [0.35, 0.5, 0.7, 0.25]) {
        const x = T.x + nx * back, z = T.z + nz * back;
        if (!isValidPlacement(balls, x, z, false)) continue;
        if (pathBlocked(balls, x, z, T.x - nx * 2 * R, T.z - nz * 2 * R, [0, tid])) continue;
        if (pathBlocked(balls, T.x, T.z, p.x, p.z, [0, tid])) continue;
        const score = (p.corner ? 1 : 0.8) / (1 + back);
        if (!best || score > best.score) best = { x, z, score };
      }
    }
  }
  if (best) return { x: best.x, z: best.z };
  // 兜底:桌面中部找空位
  for (const [x, z] of [[-0.6, 0], [0, 0], [-0.4, 0.2], [-0.4, -0.2], [0.3, 0]]) {
    if (isValidPlacement(balls, x, z, false)) return { x, z };
  }
  return { x: -TABLE.L / 4, z: 0 };
}
