// ============================================================
// 花式挑战关卡:预设球型 + 一杆内可机判的目标
// 目标类型:
//   potAll      - 一杆打进列出的所有球(母球不落袋)
//   drawPot     - 打进目标球且母球缩回指定区域(低杆挑战)
//   bankPot     - 目标球先吃库再进袋(翻袋)
//   cushionFirst- 母球先吃 N 库再碰到目标球(解球走位)
//   comboPot    - 先碰 via 球,由它传进 target 球(组合球)
// ============================================================
import { makeBall } from 'm/physics';

export const CHALLENGES = [
  {
    name: '直线开胡',
    desc: '最基础的一杆:把 1 号球沿直线送进右上角袋。',
    cue: { x: 0.08, z: 0.01 },
    balls: [{ id: 1, x: 0.7, z: 0.35 }],
    goal: { type: 'potAll', ids: [1] },
  },
  {
    name: '一杆双响',
    desc: '9 号球贴在袋口,1 号球在它身后。一杆把两颗球都送进右上角袋!',
    cue: { x: 0.38, z: -0.23 },
    balls: [
      { id: 9, x: 1.2, z: 0.57 },
      { id: 1, x: 1.1, z: 0.47 },
    ],
    goal: { type: 'potAll', ids: [1, 9] },
  },
  {
    name: '缩杆回家',
    desc: '把 5 号球打进中袋,并用低杆让母球缩回到开球线后方(白线左侧)。',
    cue: { x: 0, z: -0.12 },
    balls: [{ id: 5, x: 0, z: 0.42 }],
    goal: { type: 'drawPot', id: 5, cueZone: { axis: 'z', lt: -0.05 } },
    hint: '瞄准点选在母球下方(低杆),大力出杆',
  },
  {
    name: '翻袋艺术',
    desc: '10 号球无法直接进袋——让它先撞下库反弹,翻进上方中袋。',
    cue: { x: -0.35, z: 0.15 },
    balls: [
      { id: 10, x: 0.25, z: -0.2 },
      { id: 2, x: 0.62, z: 0.3 },
    ],
    goal: { type: 'bankPot', id: 10 },
    hint: '把袋口对着下库做镜像,瞄准镜像点',
  },
  {
    name: '三库解球',
    desc: '黑八被防守球墙挡住了。让母球先吃两库以上,绕过球墙碰到黑八。',
    cue: { x: -0.9, z: 0 },
    balls: [
      { id: 8, x: 1.0, z: 0 },
      { id: 1, x: 0.72, z: -0.13 },
      { id: 2, x: 0.75, z: 0 },
      { id: 3, x: 0.72, z: 0.13 },
    ],
    goal: { type: 'cushionFirst', id: 8, minCushions: 2 },
    hint: '利用侧塞改变吃库后的反弹角',
  },
  {
    name: '连锁反应',
    desc: '组合球:先打 4 号球,由它把 12 号球撞进右上角袋。',
    cue: { x: -0.6, z: -0.05 },
    balls: [
      { id: 4, x: 0.18, z: 0.12 },
      { id: 12, x: 0.72, z: 0.38 },
    ],
    goal: { type: 'comboPot', via: 4, target: 12 },
  },
];

export function buildChallengeBalls(level) {
  const balls = [makeBall(0, level.cue.x, level.cue.z)];
  for (const b of level.balls) balls.push(makeBall(b.id, b.x, b.z));
  return balls;
}

// 一杆结束后判定。events 按时间序,ballsAfter 为最终状态
export function judgeChallenge(level, events, ballsAfter) {
  const g = level.goal;
  const pocketed = [];
  let firstContact = null;
  let cueCushionsBeforeContact = 0;
  const cushionsByBall = {};
  for (const e of events) {
    if (e.type === 'hit' && (e.a === 0 || e.b === 0) && firstContact === null) {
      firstContact = e.a === 0 ? e.b : e.a;
    }
    if (e.type === 'cushion') {
      if (e.id === 0 && firstContact === null) cueCushionsBeforeContact++;
      cushionsByBall[e.id] = (cushionsByBall[e.id] || 0) + 1;
      if (e.id !== 0) {
        // 记录该球在进袋前是否吃过库(bankPot 用)
      }
    }
    if (e.type === 'pocket') pocketed.push(e.id);
  }
  const scratch = pocketed.includes(0);

  switch (g.type) {
    case 'potAll': {
      if (scratch) return { success: false, msg: '母球落袋了!' };
      const ok = g.ids.every(id => pocketed.includes(id));
      return ok ? { success: true, msg: '漂亮!全部入袋!' }
        : { success: false, msg: `还差 ${g.ids.filter(id => !pocketed.includes(id)).join('、')} 号球` };
    }
    case 'drawPot': {
      if (scratch) return { success: false, msg: '母球落袋了!' };
      if (!pocketed.includes(g.id)) return { success: false, msg: `${g.id} 号球没进袋` };
      const cue = ballsAfter.find(b => b.id === 0);
      const v = g.cueZone.axis === 'z' ? cue.z : cue.x;
      const inZone = g.cueZone.lt !== undefined ? v < g.cueZone.lt : v > g.cueZone.gt;
      return inZone ? { success: true, msg: '完美低杆!母球乖乖回家!' }
        : { success: false, msg: '球进了,但母球没缩回来——低杆再狠一点' };
    }
    case 'bankPot': {
      if (scratch) return { success: false, msg: '母球落袋了!' };
      if (!pocketed.includes(g.id)) return { success: false, msg: `${g.id} 号球没进袋` };
      const banked = (cushionsByBall[g.id] || 0) >= 1;
      return banked ? { success: true, msg: '漂亮的翻袋!' }
        : { success: false, msg: '直接进袋不算——必须先吃库翻进' };
    }
    case 'cushionFirst': {
      if (firstContact !== g.id) {
        return { success: false, msg: firstContact === null ? '母球没碰到任何球' : '先碰到了别的球' };
      }
      return cueCushionsBeforeContact >= g.minCushions
        ? { success: true, msg: `${cueCushionsBeforeContact} 库解球成功!` }
        : { success: false, msg: `碰到了,但只吃了 ${cueCushionsBeforeContact} 库(需要 ${g.minCushions} 库)` };
    }
    case 'comboPot': {
      if (scratch) return { success: false, msg: '母球落袋了!' };
      if (firstContact !== g.via) return { success: false, msg: `必须先碰 ${g.via} 号球` };
      return pocketed.includes(g.target)
        ? { success: true, msg: '连锁反应成功!' }
        : { success: false, msg: `${g.target} 号球没进袋` };
    }
  }
  return { success: false, msg: '' };
}
