// ============================================================
// 八球规则裁判(中式八球简化规程)
// - 开球:进球继续,黑八开球落袋重置,母球落袋=犯规
// - 开放台面:首次合法打进的球决定分组(黑八除外)
// - 犯规:母球落袋 / 首触非法 / 空杆 / 无进球且无球碰库 → 对手自由球
// - 黑八:清完本组后打进=胜;提前进黑八或进黑八犯规=负
// ============================================================

export const SOLIDS = [1, 2, 3, 4, 5, 6, 7];
export const STRIPES = [9, 10, 11, 12, 13, 14, 15];

export function groupOf(id) {
  if (id >= 1 && id <= 7) return 'solid';
  if (id >= 9 && id <= 15) return 'stripe';
  return null; // 0 或 8
}

export function newMatch(breaker) {
  return {
    shooter: breaker,          // 当前击球方 0/1
    groups: [null, null],      // 每方分组 'solid'|'stripe'|null
    open: true,                // 开放台面
    breakShot: true,           // 本杆是否开球
    ballInHand: false,         // 当前击球方是否自由球
    gameOver: null,            // {winner, reason}
    pre: null,
  };
}

export function remainingOf(balls, group) {
  let n = 0;
  for (const b of balls) if (b.on && groupOf(b.id) === group) n++;
  return n;
}

export function targetCleared(rules, balls, seat) {
  const g = rules.groups[seat];
  return g !== null && remainingOf(balls, g) === 0;
}

// 出杆前快照
export function beginShot(rules, balls) {
  const g = rules.groups[rules.shooter];
  rules.pre = {
    cleared: g !== null && remainingOf(balls, g) === 0,
  };
}

// 出杆结束结算。可能修改 balls(黑八重置)。
// 返回 { messages, foul, turnChanged, gameOver, respot8 }
export function endShot(rules, balls, events, findFreeSpot) {
  const shooter = rules.shooter;
  const opponent = 1 - shooter;
  const messages = [];
  let foul = false, foulReason = '';

  // 事件解析(events 按时间顺序)
  let firstContact = null;
  let cushionAfterContact = false;
  let anyCushion = false;
  const pocketed = [];
  for (const e of events) {
    if (e.type === 'hit' && (e.a === 0 || e.b === 0) && firstContact === null) {
      firstContact = e.a === 0 ? e.b : e.a;
    }
    if (e.type === 'cushion') {
      anyCushion = true;
      if (firstContact !== null) cushionAfterContact = true;
    }
    if (e.type === 'pocket') pocketed.push(e.id);
  }
  const scratch = pocketed.includes(0);
  const potted8 = pocketed.includes(8);
  const pottedObjects = pocketed.filter(id => id !== 0 && id !== 8);

  // ---- 黑八开球落袋:重置 ----
  let respot8 = false;
  if (rules.breakShot && potted8) {
    const b8 = balls.find(b => b.id === 8);
    const spot = findFreeSpot(balls, 0.635, 0);
    b8.on = true; b8.resting = true;
    b8.x = spot.x; b8.z = spot.z;
    b8.vx = b8.vz = b8.wx = b8.wy = b8.wz = 0;
    respot8 = true;
    messages.push('黑八开球落袋,重置到置球点');
  }

  // ---- 犯规判定 ----
  if (firstContact === null) {
    foul = true; foulReason = '未碰到任何球';
  } else if (!rules.breakShot) {
    // 首触合法性
    const g = rules.groups[shooter];
    if (rules.open) {
      if (firstContact === 8) { foul = true; foulReason = '开放台面首触黑八'; }
    } else if (g !== null) {
      const cleared = rules.pre && rules.pre.cleared;
      const legalFirst = cleared ? firstContact === 8 : groupOf(firstContact) === g;
      if (!legalFirst) { foul = true; foulReason = '首触非本组球'; }
    }
  }
  if (!foul && scratch) { foul = true; foulReason = '母球落袋'; }
  if (!foul && pocketed.length === 0 && !cushionAfterContact && firstContact !== null) {
    foul = true; foulReason = '无进球且无球碰库';
  }
  if (!foul && rules.breakShot && !anyCushion && pocketed.length === 0) {
    foul = true; foulReason = '开球无效';
  }

  // ---- 黑八胜负 ----
  if (potted8 && !rules.breakShot) {
    const cleared = rules.pre && rules.pre.cleared;
    if (cleared && !foul) {
      rules.gameOver = { winner: shooter, reason: '清台后打进黑八获胜!' };
    } else if (cleared && foul) {
      rules.gameOver = { winner: opponent, reason: '打进黑八但犯规(' + foulReason + '),判负' };
    } else {
      rules.gameOver = { winner: opponent, reason: '提前打进黑八,判负' };
    }
    rules.breakShot = false;
    return { messages, foul, turnChanged: false, gameOver: rules.gameOver, respot8 };
  }

  // ---- 分组判定(非开球、开放台面、合法进球时) ----
  if (rules.open && !rules.breakShot && !foul && pottedObjects.length > 0) {
    const g = groupOf(pottedObjects[0]);
    rules.groups[shooter] = g;
    rules.groups[opponent] = g === 'solid' ? 'stripe' : 'solid';
    rules.open = false;
    messages.push(`分组确定:${seatName(shooter)} → ${groupName(g)}`);
  }

  // ---- 轮转 ----
  let turnChanged;
  if (foul) {
    turnChanged = true;
    rules.shooter = opponent;
    rules.ballInHand = true;
    messages.push(`犯规:${foulReason},对方自由球`);
  } else {
    let continueTurn = false;
    if (rules.breakShot) {
      continueTurn = pottedObjects.length > 0;
    } else if (rules.open) {
      continueTurn = pottedObjects.length > 0;
    } else {
      const g = rules.groups[shooter];
      continueTurn = pottedObjects.some(id => groupOf(id) === g);
    }
    turnChanged = !continueTurn;
    if (turnChanged) rules.shooter = opponent;
    rules.ballInHand = false;
  }

  rules.breakShot = false;
  return { messages, foul, turnChanged, gameOver: null, respot8 };
}

export function seatName(seat) {
  return seat === 0 ? '玩家1' : '玩家2';
}
export function groupName(g) {
  return g === 'solid' ? '全色(1-7)' : g === 'stripe' ? '花色(9-15)' : '未定';
}
