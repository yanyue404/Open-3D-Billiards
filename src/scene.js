// ============================================================
// Three.js 渲染层:球桌、球、灯光、球杆、瞄准辅助线
// 渲染与模拟完全解耦——本文件不含任何游戏逻辑
// ============================================================
import * as THREE from 'm/three';
import { TABLE, POCKETS } from 'm/physics';
import { ART_PHOTO, ART_PHOTO_ASPECT } from 'm/artphoto';

const R = TABLE.R;

// 标准台球配色
export const BALL_COLORS = {
  0: '#f6f2ea', 1: '#f4b400', 2: '#1b53b8', 3: '#d1301e', 4: '#5e2a8a',
  5: '#e6720f', 6: '#177245', 7: '#8d2b1a', 8: '#151515',
  9: '#f4b400', 10: '#1b53b8', 11: '#d1301e', 12: '#5e2a8a',
  13: '#e6720f', 14: '#177245', 15: '#8d2b1a',
};

// ---------- 球面贴图(等距圆柱投影,canvas 生成) ----------
function makeBallTexture(id) {
  const W = 512, H = 256;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  const color = BALL_COLORS[id];
  const stripe = id >= 9;
  if (id === 0) {
    g.fillStyle = '#f6f2ea'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#c94a3a';
    g.beginPath(); g.arc(W * 0.25, H * 0.5, 7, 0, 7); g.fill();
  } else if (stripe) {
    g.fillStyle = '#f6f2ea'; g.fillRect(0, 0, W, H);
    g.fillStyle = color; g.fillRect(0, H * 0.28, W, H * 0.44);
  } else {
    g.fillStyle = color; g.fillRect(0, 0, W, H);
  }
  if (id !== 0) {
    for (const u of [0.25, 0.75]) {
      const cx = W * u, cy = H * 0.5;
      g.fillStyle = '#f6f2ea';
      g.beginPath(); g.arc(cx, cy, 26, 0, 7); g.fill();
      g.fillStyle = '#222';
      g.font = 'bold 30px Arial';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(String(id), cx, cy + 2);
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// ---------- 噪点织物纹理 ----------
function makeFeltTexture(base, variation, size) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size || 256;
  const g = cv.getContext('2d');
  g.fillStyle = base; g.fillRect(0, 0, cv.width, cv.height);
  const img = g.getImageData(0, 0, cv.width, cv.height);
  const d = img.data;
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < d.length; i += 4) {
    const n = (rnd() - 0.5) * variation;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeWoodTexture() {
  const cv = document.createElement('canvas');
  cv.width = 512; cv.height = 512;
  const g = cv.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 512, 0);
  grad.addColorStop(0, '#4a2c17'); grad.addColorStop(0.5, '#5d3a1f'); grad.addColorStop(1, '#452a15');
  g.fillStyle = grad; g.fillRect(0, 0, 512, 512);
  let seed = 777;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < 90; i++) {
    const y = rnd() * 512;
    g.strokeStyle = `rgba(${20 + rnd() * 40},${10 + rnd() * 20},5,${0.08 + rnd() * 0.12})`;
    g.lineWidth = 1 + rnd() * 3;
    g.beginPath();
    g.moveTo(0, y);
    for (let x = 0; x <= 512; x += 64) g.lineTo(x, y + (rnd() - 0.5) * 18);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------- 环境贴图(手搓小房间,给球体高光反射) ----------
function makeEnvironment(renderer) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0a0e);
  const room = new THREE.Mesh(
    new THREE.BoxGeometry(10, 6, 10),
    new THREE.MeshBasicMaterial({ color: 0x181820, side: THREE.BackSide })
  );
  room.position.y = 2.5;
  scene.add(room);
  const lampGeo = new THREE.PlaneGeometry(2.2, 0.7);
  const lampMat = new THREE.MeshBasicMaterial({ color: 0xfff2d8 });
  const lamp = new THREE.Mesh(lampGeo, lampMat);
  lamp.position.set(0, 4.5, 0); lamp.rotation.x = Math.PI / 2;
  scene.add(lamp);
  for (const [x, z, c] of [[-4, 0, 0x334], [4, 0, 0x433], [0, -4, 0x343]]) {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 2.2), new THREE.MeshBasicMaterial({ color: c }));
    p.position.set(x, 2.4, z);
    p.lookAt(0, 2, 0);
    scene.add(p);
  }
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envMap = pmrem.fromScene(scene, 0.02).texture;
  pmrem.dispose();
  return envMap;
}

// ---------- 球桌建模 ----------
const CUSHION_H = 0.040;       // 库边高
const CUSHION_DEPTH = 0.05;    // 库边厚(向外)
const RAIL_W = 0.14;           // 木框宽
const HALF_L = TABLE.L / 2, HALF_W = TABLE.W / 2;

// ---------- 回球轨道几何(纯渲染,球落袋后沿轨道滚进托盘) ----------
// 汇总轨道:桌底中线一根斜轨,从左端 SPINE_X0 一路降到右端托盘入口 SPINE_X1
const SPINE_X0 = -(HALF_L - 0.10);
const SPINE_X1 = HALF_L + 0.13;
const SPINE_Y0 = -0.26, SPINE_Y1 = -0.44;
const SPINE_XM = 0.12;              // 中袋支轨汇入点
const SPINE_XR = HALF_L - 0.10;     // 右角袋支轨汇入点
const spineY = x => SPINE_Y0 + (x - SPINE_X0) / (SPINE_X1 - SPINE_X0) * (SPINE_Y1 - SPINE_Y0);
const FUNNEL_Y = -0.205;            // 袋底漏斗出口(球心高度)
const TRAY_FLOOR = -0.52;           // 托盘底面
function traySlotPos(slot) {
  const row = Math.floor(slot / 8), col = slot % 8;
  return { x: HALF_L + 0.185 + row * 0.065, y: TRAY_FLOOR + R, z: -0.21 + col * 0.06 };
}
// 每个袋的回球路径(球心折线):漏斗出口 → 汇入点 → 托盘入口
function chutePathFor(pk) {
  const jx = pk.corner ? (pk.x < 0 ? SPINE_X0 : SPINE_XR) : SPINE_XM;
  return [
    [pk.x, FUNNEL_Y, pk.z],
    [jx, spineY(jx), 0],
    [SPINE_X1, SPINE_Y1, 0],
  ];
}

function buildTable(feltTex, woodTex) {
  const group = new THREE.Group();

  // 台呢底面:带 6 个真实开孔的挤出体(袋口是真洞,任何角度可见)
  const bedMat = new THREE.MeshStandardMaterial({ map: feltTex, roughness: 0.95, metalness: 0 });
  feltTex.repeat.set(2, 2);
  const bx = HALF_L + CUSHION_DEPTH + RAIL_W, bz = HALF_W + CUSHION_DEPTH + RAIL_W;
  // 外轮廓与木框一致的圆角矩形:直角尖会在低角度下从木框圆角外露出绿毡
  const bedShape = new THREE.Shape();
  const brc = 0.09;
  bedShape.moveTo(-bx + brc, -bz);
  bedShape.lineTo(bx - brc, -bz); bedShape.quadraticCurveTo(bx, -bz, bx, -bz + brc);
  bedShape.lineTo(bx, bz - brc); bedShape.quadraticCurveTo(bx, bz, bx - brc, bz);
  bedShape.lineTo(-bx + brc, bz); bedShape.quadraticCurveTo(-bx, bz, -bx, bz - brc);
  bedShape.lineTo(-bx, -bz + brc); bedShape.quadraticCurveTo(-bx, -bz, -bx + brc, -bz);
  bedShape.closePath();
  for (const p of POCKETS) {
    const h = new THREE.Path();
    h.absarc(p.x, p.z, p.r, 0, Math.PI * 2, true); // 孔径=物理捕获半径,球到洞即落
    bedShape.holes.push(h);
  }
  const bedGeo = new THREE.ExtrudeGeometry(bedShape, { depth: 0.035, bevelEnabled: false });
  // 材质[顶面, 侧面]:袋孔内壁用深色,不然洞里露出一圈绿毡
  const bedSideMat = new THREE.MeshStandardMaterial({ color: 0x17130f, roughness: 0.9 });
  const bed = new THREE.Mesh(bedGeo, [bedMat, bedSideMat]);
  bed.rotation.x = Math.PI / 2; // 面朝上,孔位 z=shape.y 不镜像
  bed.receiveShadow = true;
  // 必须投影,否则灯光穿过台面把球影投到地板上,桌子看着像透明的
  bed.castShadow = true;
  group.add(bed);

  // 库边(6 段,袋口端斜切);带绒布纹理,纯色在灯下会亮成塑料感色块
  const cushTex = makeFeltTexture('#0c5c38', 26, 128);
  cushTex.repeat.set(3, 3);
  const cushMat = new THREE.MeshStandardMaterial({ map: cushTex, roughness: 0.92 });
  const CC = TABLE.CORNER_CUT, SC = TABLE.SIDE_CUT;
  const JAW_C = 0.050; // 角袋端斜颚(≈45°,参考真实球台角袋切角)
  const JAW_S = 0.026; // 中袋端斜颚(更陡,真实中袋口两颚接近垂直)
  function cushionShape(len, jaw0, jaw1) {
    // 以库边内侧线为 x 轴,向外为 +y;两端斜颚向外收窄
    // (真实球台袋口越往外越开阔),不遮挡袋洞
    const s = new THREE.Shape();
    s.moveTo(0, 0);
    s.lineTo(len, 0);
    s.lineTo(len - jaw1, CUSHION_DEPTH);
    s.lineTo(jaw0, CUSHION_DEPTH);
    s.closePath();
    return s;
  }
  function addCushion(len, jaw0, jaw1, px, pz, rotY) {
    const geo = new THREE.ExtrudeGeometry(cushionShape(len, jaw0, jaw1), { depth: CUSHION_H, bevelEnabled: false });
    const m = new THREE.Mesh(geo, cushMat);
    m.rotation.x = Math.PI / 2;
    m.rotation.z = rotY;
    m.position.set(px, CUSHION_H, pz);
    m.castShadow = true; m.receiveShadow = true;
    group.add(m);
  }
  // 长库每段:从角袋切口到中袋切口(此前长度多算了 2*SC,盖住了中袋口)
  const LONG_LEN = HALF_L - CC - SC;
  // 长库 z=+HALF_W(两段),内侧线 z=HALF_W,向外 +z
  addCushion(LONG_LEN, JAW_C, JAW_S, -HALF_L + CC, HALF_W, 0);
  addCushion(LONG_LEN, JAW_S, JAW_C, SC, HALF_W, 0);
  // 长库 z=-HALF_W:旋转 180°,x 反向
  addCushion(LONG_LEN, JAW_C, JAW_S, HALF_L - CC, -HALF_W, Math.PI);
  addCushion(LONG_LEN, JAW_S, JAW_C, -SC, -HALF_W, Math.PI);
  // 短库 x=+HALF_L:旋转 -90°(沿 z)
  addCushion(TABLE.W - CC * 2, JAW_C, JAW_C, HALF_L, HALF_W - CC, -Math.PI / 2);
  // 短库 x=-HALF_L
  addCushion(TABLE.W - CC * 2, JAW_C, JAW_C, -HALF_L, -HALF_W + CC, Math.PI / 2);

  // 木框(带内孔的挤出体)
  const railMat = new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.45, metalness: 0.1 });
  const outer = new THREE.Shape();
  const oL = HALF_L + CUSHION_DEPTH + RAIL_W, oW = HALF_W + CUSHION_DEPTH + RAIL_W, rc = 0.09;
  outer.moveTo(-oL + rc, -oW);
  outer.lineTo(oL - rc, -oW); outer.quadraticCurveTo(oL, -oW, oL, -oW + rc);
  outer.lineTo(oL, oW - rc); outer.quadraticCurveTo(oL, oW, oL - rc, oW);
  outer.lineTo(-oL + rc, oW); outer.quadraticCurveTo(-oL, oW, -oL, oW - rc);
  outer.lineTo(-oL, -oW + rc); outer.quadraticCurveTo(-oL, -oW, -oL + rc, -oW);
  // 木框内缘:矩形 + 6 个袋口弧形开口(真实球台木框在袋口处有半圆缺口)
  // 缺口圆心/半径直接取物理 POCKETS,保证口子与台面凹槽完全同心
  const hole = new THREE.Path();
  const iL = HALF_L + CUSHION_DEPTH, iW = HALF_W + CUSHION_DEPTH;
  const pkC = POCKETS.find(p => p.corner && p.x > 0 && p.z > 0);
  const pkS = POCKETS.find(p => !p.corner && p.z > 0);
  const rc2 = pkC.r; // 缺口半径与台面孔一致,不露毡缝
  const rs2 = pkS.r;
  const pcx = pkC.x, pcy = pkC.z, psy = pkS.z;
  const offx = iL - pcx, offy = iW - pcy;
  const chT = Math.sqrt(rc2 * rc2 - offy * offy); // 角袋沿上下边的半弦
  const chS = Math.sqrt(rc2 * rc2 - offx * offx); // 角袋沿左右边的半弦
  const hs = Math.sqrt(rs2 * rs2 - (iW - psy) * (iW - psy)); // 中袋半弦
  const arcCut = (cx, cy, r, x1, y1, x2, y2) => {
    hole.lineTo(x1, y1);
    hole.absarc(cx, cy, r, Math.atan2(y1 - cy, x1 - cx), Math.atan2(y2 - cy, x2 - cx), false);
  };
  hole.moveTo(-0.6, -iW);
  arcCut(0, -psy, rs2, -hs, -iW, hs, -iW);                    // 下中袋
  arcCut(pcx, -pcy, rc2, pcx - chT, -iW, iL, -pcy + chS);     // 右下角袋
  arcCut(pcx, pcy, rc2, iL, pcy - chS, pcx - chT, iW);        // 右上角袋
  arcCut(0, psy, rs2, hs, iW, -hs, iW);                       // 上中袋
  arcCut(-pcx, pcy, rc2, -pcx + chT, iW, -iL, pcy - chS);     // 左上角袋
  arcCut(-pcx, -pcy, rc2, -iL, -pcy + chS, -pcx + chT, -iW);  // 左下角袋
  hole.closePath();
  outer.holes.push(hole);
  const railGeo = new THREE.ExtrudeGeometry(outer, { depth: 0.055, bevelEnabled: true, bevelThickness: 0.008, bevelSize: 0.008, bevelSegments: 2 });
  const rail = new THREE.Mesh(railGeo, railMat);
  rail.rotation.x = -Math.PI / 2;
  // rotation -π/2 时挤出方向朝上,木框底面必须贴着台呢(此前浮空 5.5cm)
  rail.position.y = 0.004;
  rail.castShadow = true; rail.receiveShadow = true;
  group.add(rail);

  // 袋筒(洞内壁,底部开口通向回球漏斗)与贴地皮革包边
  const cupMat = new THREE.MeshStandardMaterial({ color: 0x141210, roughness: 1, side: THREE.DoubleSide });
  const rimMat = new THREE.MeshStandardMaterial({ color: 0x241710, roughness: 0.55 });
  for (const p of POCKETS) {
    // 袋杯加深,给落袋动画留下坠空间;底部不封,球穿过漏斗进回球轨道
    const wall = new THREE.Mesh(new THREE.CylinderGeometry(p.r, p.r * 0.8, 0.12, 28, 1, true), cupMat);
    wall.position.set(p.x, -0.06, p.z);
    group.add(wall);
    const funnel = new THREE.Mesh(new THREE.CylinderGeometry(p.r * 0.82, 0.042, 0.09, 22, 1, true), cupMat);
    funnel.position.set(p.x, -0.16, p.z);
    group.add(funnel);
    // 袋口护套:只包外圈弧段(真实球台的皮圈/铁圈钉在木框上,不伸进台面)
    const arc = p.corner ? Math.PI * 1.35 : Math.PI * 1.15;
    const rimGeo = new THREE.TorusGeometry(p.r + 0.010, 0.011, 10, 36, arc);
    rimGeo.rotateX(Math.PI / 2);
    const rim = new THREE.Mesh(rimGeo, rimMat);
    const outAng = p.corner
      ? Math.atan2(Math.sign(p.z), Math.sign(p.x))
      : (p.z > 0 ? Math.PI / 2 : -Math.PI / 2);
    rim.rotation.y = arc / 2 - outAng; // 弧段中心对准袋口外侧方向
    rim.scale.set(1, 0.5, 1);
    // 贴着台呢放:既是袋口衬圈,又盖住木框缺口下方露出的毡面
    rim.position.set(p.x, 0.007, p.z);
    group.add(rim);
  }

  // 木框上的镶钻定位点
  const dotMat = new THREE.MeshStandardMaterial({ color: 0xf0e8d8, roughness: 0.3, metalness: 0.5 });
  const dotY = 0.004 + 0.055 + 0.009; // 木框顶面(含倒角)之上一点
  const railMid = HALF_W + CUSHION_DEPTH + RAIL_W / 2;
  const railMidL = HALF_L + CUSHION_DEPTH + RAIL_W / 2;
  for (let i = 1; i <= 7; i++) {
    if (i === 4) continue;
    const x = -HALF_L + (TABLE.L * i) / 8;
    for (const sz of [-1, 1]) {
      const d = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.007, 0.004, 12), dotMat);
      d.position.set(x, dotY, sz * railMid);
      group.add(d);
    }
  }
  for (let i = 1; i <= 3; i++) {
    const z = -HALF_W + (TABLE.W * i) / 4;
    for (const sx of [-1, 1]) {
      const d = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.007, 0.004, 12), dotMat);
      d.position.set(sx * railMidL, dotY, z);
      group.add(d);
    }
  }

  // 桌腿
  const legMat = new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.5 });
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.75, 0.14), legMat);
    // 内收避开角袋正下方,否则从袋洞里能看到桌腿
    leg.position.set(sx * (HALF_L - 0.18), -0.75 / 2 - 0.03, sz * (HALF_W - 0.04));
    leg.castShadow = true;
    group.add(leg);
  }

  // 裙边(木框下方一圈围板,真实球台的箱体)
  const bx2 = HALF_L + CUSHION_DEPTH + RAIL_W, bz2 = HALF_W + CUSHION_DEPTH + RAIL_W;
  const apronH = 0.10, apronY = -0.035 - apronH / 2;
  for (const [w, d, px, pz] of [
    [bx2 * 2 - 0.06, 0.035, 0, bz2 - 0.02],
    [bx2 * 2 - 0.06, 0.035, 0, -(bz2 - 0.02)],
    [0.035, bz2 * 2 - 0.06, bx2 - 0.02, 0],
    [0.035, bz2 * 2 - 0.06, -(bx2 - 0.02), 0],
  ]) {
    const a = new THREE.Mesh(new THREE.BoxGeometry(w, apronH, d), legMat);
    a.position.set(px, apronY, pz);
    a.castShadow = true; a.receiveShadow = true;
    group.add(a);
  }

  // ---------- 回球轨道:双钢轨从各袋汇到桌尾托盘 ----------
  const railTrackMat = new THREE.MeshStandardMaterial({ color: 0x3a3a42, metalness: 0.7, roughness: 0.35 });
  const GAUGE = 0.021;   // 双轨各偏离球心线的水平距离
  const TUBE_R = 0.007;  // 轨条半径
  const upVec = new THREE.Vector3(0, 1, 0);
  function addTrackSeg(x1, y1, z1, x2, y2, z2) {
    const dir = new THREE.Vector3(x2 - x1, y2 - y1, z2 - z1);
    const len = dir.length();
    if (len < 1e-6) return;
    dir.normalize();
    // 水平面内的垂向(左右分轨)
    const perp = new THREE.Vector3(-dir.z, 0, dir.x);
    if (perp.lengthSq() < 1e-6) perp.set(1, 0, 0); else perp.normalize();
    for (const side of [-1, 1]) {
      const geo = new THREE.CylinderGeometry(TUBE_R, TUBE_R, len + 0.02, 8);
      const m = new THREE.Mesh(geo, railTrackMat);
      m.quaternion.setFromUnitVectors(upVec, dir);
      m.position.set(
        (x1 + x2) / 2 + perp.x * GAUGE * side,
        (y1 + y2) / 2 - 0.018,  // 轨面略低于球心线,球看着卡在双轨之间
        (z1 + z2) / 2 + perp.z * GAUGE * side
      );
      group.add(m);
    }
  }
  // 汇总斜轨(直线:y 随 x 线性)
  addTrackSeg(SPINE_X0, SPINE_Y0, 0, SPINE_X1, SPINE_Y1, 0);
  // 六条支轨:漏斗出口 → 汇入点
  for (const p of POCKETS) {
    const [w0, w1] = chutePathFor(p);
    addTrackSeg(w0[0], w0[1], w0[2], w1[0], w1[1], w1[2]);
  }
  // 吊架:马镫式(两侧立杆 + 轨下横担),避开球的通过空间
  for (const hx of [-0.75, 0.05, 0.85]) {
    const yBot = spineY(hx) - 0.033;
    for (const sz of [-1, 1]) {
      const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, -0.035 - yBot, 8), railTrackMat);
      rod.position.set(hx, (-0.035 + yBot) / 2, sz * 0.042);
      group.add(rod);
    }
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.012, 0.1), railTrackMat);
    bar.position.set(hx, yBot, 0);
    group.add(bar);
  }

  // 托盘(桌尾木盒,球滚进来排队;朝台面一侧开口)
  const trayCx = HALF_L + 0.215, trayHalfX = 0.115, trayHalfZ = 0.28;
  const trayWallH = 0.085, trayWallT = 0.018;
  const trayFloor = new THREE.Mesh(new THREE.BoxGeometry(trayHalfX * 2, 0.018, trayHalfZ * 2), legMat);
  trayFloor.position.set(trayCx, TRAY_FLOOR - 0.009, 0);
  trayFloor.receiveShadow = true;
  group.add(trayFloor);
  for (const [w, d, px, pz] of [
    [trayHalfX * 2 + trayWallT * 2, trayWallT, trayCx, trayHalfZ + trayWallT / 2],
    [trayHalfX * 2 + trayWallT * 2, trayWallT, trayCx, -(trayHalfZ + trayWallT / 2)],
    [trayWallT, trayHalfZ * 2, trayCx + trayHalfX + trayWallT / 2, 0],
  ]) {
    const wll = new THREE.Mesh(new THREE.BoxGeometry(w, trayWallH, d), legMat);
    wll.position.set(px, TRAY_FLOOR + trayWallH / 2 - 0.018, pz);
    wll.castShadow = true;
    group.add(wll);
  }
  // 托盘吊带(贴着托盘外侧壁,挂到裙边底)
  for (const sz of [-1, 1]) {
    const strap = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.315, 0.014), railTrackMat);
    strap.position.set(bx2 - 0.02, -0.2925, sz * (trayHalfZ + trayWallT + 0.007));
    strap.castShadow = true;
    group.add(strap);
  }

  // 开球线
  const lineMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.18 });
  const lineGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-TABLE.L / 4, 0.001, -HALF_W),
    new THREE.Vector3(-TABLE.L / 4, 0.001, HALF_W),
  ]);
  group.add(new THREE.Line(lineGeo, lineMat));

  return group;
}

// ---------- 房间环境:木地板 + 墙面 + 天花板 + 陈设 ----------
function makePlankTexture() {
  const S = 512;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  let seed = 4242;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const ROWS = 8, RH = S / ROWS;
  for (let r = 0; r < ROWS; r++) {
    // 每块板一个基色(暗棕胡桃色系)
    const off = rnd();
    for (let seg = 0; seg < 2; seg++) {
      const t = 30 + rnd() * 26;
      g.fillStyle = `rgb(${t + 30},${t + 12},${t * 0.55 | 0})`;
      g.fillRect(0, r * RH, S, RH);
    }
    // 木纹长条
    for (let i = 0; i < 14; i++) {
      const y = r * RH + rnd() * RH;
      g.strokeStyle = `rgba(${16 + rnd() * 30 | 0},${10 + rnd() * 16 | 0},4,${0.10 + rnd() * 0.14})`;
      g.lineWidth = 0.6 + rnd() * 1.6;
      g.beginPath();
      g.moveTo(0, y);
      for (let x = 0; x <= S; x += 64) g.lineTo(x, y + (rnd() - 0.5) * 5);
      g.stroke();
    }
    // 板缝(横)与错缝竖接头
    g.fillStyle = 'rgba(0,0,0,0.55)';
    g.fillRect(0, r * RH, S, 2);
    const jx = ((r * 0.37 + off) % 1) * S;
    g.fillRect(jx, r * RH, 2, RH);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function makeWallTexture() {
  const S = 512;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  let seed = 9090;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const SPLIT = S * 0.72; // 上:深绿墙布 下:木墙裙(层高拉高后墙裙占比缩小,保持约 1.1m)
  g.fillStyle = '#33503d';
  g.fillRect(0, 0, S, SPLIT);
  for (let i = 0; i < 2600; i++) {
    const n = rnd() * 26 - 13;
    g.fillStyle = `rgba(${52 + n | 0},${76 + n | 0},${60 + n | 0},0.5)`;
    g.fillRect(rnd() * S, rnd() * SPLIT, 2, 2);
  }
  // 腰线
  g.fillStyle = '#6d4a26';
  g.fillRect(0, SPLIT - 8, S, 10);
  g.fillStyle = 'rgba(255,220,160,0.18)';
  g.fillRect(0, SPLIT - 8, S, 2);
  // 墙裙:竖板
  const grad = g.createLinearGradient(0, SPLIT, 0, S);
  grad.addColorStop(0, '#5a3a20');
  grad.addColorStop(1, '#472c17');
  g.fillStyle = grad;
  g.fillRect(0, SPLIT + 2, S, S - SPLIT);
  for (let x = 0; x < S; x += 64) {
    g.fillStyle = 'rgba(0,0,0,0.4)';
    g.fillRect(x, SPLIT + 2, 3, S - SPLIT);
    g.fillStyle = 'rgba(255,200,140,0.05)';
    g.fillRect(x + 3, SPLIT + 2, 2, S - SPLIT);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const ROOM_X = 5.2, ROOM_Z = 4.2;     // 房间半宽
const FLOOR_Y = -0.78, CEIL_Y = 3.25; // 层高约 4m

function buildRoom(woodTex) {
  const g = new THREE.Group();

  // 地板
  const plankTex = makePlankTexture();
  plankTex.repeat.set(5, 5);
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(ROOM_X * 2, ROOM_Z * 2),
    // envMapIntensity 压低:环境贴图里的彩色板会在掠射角被反成地板上的色斑
    new THREE.MeshStandardMaterial({ map: plankTex, roughness: 0.68, metalness: 0.02, envMapIntensity: 0.15 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = FLOOR_Y;
  floor.receiveShadow = true;
  g.add(floor);

  // 四面墙(内朝向)
  const wallTex = makeWallTexture();
  const wallMat = new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.9 });
  const H = CEIL_Y - FLOOR_Y, MID_Y = (CEIL_Y + FLOOR_Y) / 2;
  const mkWall = (w, px, pz, ry) => {
    const tex2 = wallTex.clone();
    tex2.needsUpdate = true;
    tex2.repeat.set(Math.max(1, Math.round(w / 3.2)), 1);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, H),
      new THREE.MeshStandardMaterial({ map: tex2, roughness: 0.9 }));
    m.position.set(px, MID_Y, pz);
    m.rotation.y = ry;
    m.receiveShadow = true;
    g.add(m);
  };
  mkWall(ROOM_X * 2, 0, -ROOM_Z, 0);
  mkWall(ROOM_X * 2, 0, ROOM_Z, Math.PI);
  mkWall(ROOM_Z * 2, -ROOM_X, 0, Math.PI / 2);
  mkWall(ROOM_Z * 2, ROOM_X, 0, -Math.PI / 2);

  // 天花板
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_X * 2, ROOM_Z * 2),
    new THREE.MeshStandardMaterial({ color: 0x35291d, roughness: 1 }));
  ceil.rotation.x = Math.PI / 2;
  ceil.position.y = CEIL_Y;
  g.add(ceil);

  // 踢脚线
  const skirtMat = new THREE.MeshStandardMaterial({ color: 0x2a1a0d, roughness: 0.6 });
  for (const [w, d, px, pz] of [
    [ROOM_X * 2, 0.04, 0, -ROOM_Z + 0.02], [ROOM_X * 2, 0.04, 0, ROOM_Z - 0.02],
    [0.04, ROOM_Z * 2, -ROOM_X + 0.02, 0], [0.04, ROOM_Z * 2, ROOM_X - 0.02, 0],
  ]) {
    const s = new THREE.Mesh(new THREE.BoxGeometry(w, 0.12, d), skirtMat);
    s.position.set(px, FLOOR_Y + 0.06, pz);
    g.add(s);
  }

  // 壁挂杆架(一面墙上一排备用球杆)
  const rackBoard = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.09, 0.03),
    new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.5 }));
  rackBoard.position.set(-1.6, 0.9, -ROOM_Z + 0.03);
  g.add(rackBoard);
  const rackBoard2 = rackBoard.clone();
  rackBoard2.position.y = -0.25;
  g.add(rackBoard2);
  const cueShaftMat = new THREE.MeshStandardMaterial({ color: 0xc9a06a, roughness: 0.4 });
  const cueButtMat = new THREE.MeshStandardMaterial({ color: 0x3a2415, roughness: 0.45 });
  for (let i = 0; i < 5; i++) {
    const x = -2.2 + i * 0.3;
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.010, 0.85, 10), cueShaftMat);
    shaft.position.set(x, 0.75, -ROOM_Z + 0.045);
    g.add(shaft);
    const butt = new THREE.Mesh(new THREE.CylinderGeometry(0.010, 0.014, 0.55, 10), cueButtMat);
    butt.position.set(x, 0.05, -ROOM_Z + 0.045);
    g.add(butt);
  }
  // 杆架照明:与画灯同款的灯条 + 宽角聚光,把整排球杆打亮
  const rackBar = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 1.5, 10),
    new THREE.MeshStandardMaterial({ color: 0x8a7040, roughness: 0.35, metalness: 0.7 }));
  rackBar.rotation.z = Math.PI / 2;
  rackBar.position.set(-1.6, 1.3, -ROOM_Z + 0.07);
  g.add(rackBar);
  const rackLight = new THREE.SpotLight(0xffd9a0, 7.5, 3, 0.72, 0.5, 1.5);
  rackLight.position.set(-1.6, 1.28, -ROOM_Z + 0.25);
  rackLight.target.position.set(-1.6, 0.35, -ROOM_Z);
  g.add(rackLight);
  g.add(rackLight.target);

  // 相框:-z 墙挂用户照片(竖幅),侧墙挂一幅程序化抽象画
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x201409, roughness: 0.4, metalness: 0.2 });
  const photoTex = new THREE.TextureLoader().load(ART_PHOTO);
  photoTex.colorSpace = THREE.SRGBColorSpace;
  photoTex.anisotropy = 4;
  const artTex2 = makeFeltTexture('#5e4430', 60, 128);
  const PHOTO_H = 0.92, PHOTO_W = PHOTO_H * ART_PHOTO_ASPECT; // 层高拉高后相框加大
  const PHOTO_Y = 1.5;
  for (const [px, py, pz, ry, tex, w, h] of [
    [1.8, PHOTO_Y, -ROOM_Z + 0.03, 0, photoTex, PHOTO_W, PHOTO_H],
    [-ROOM_X + 0.03, 1.25, -1.2, Math.PI / 2, artTex2, 0.6, 0.4],
  ]) {
    const fr = new THREE.Mesh(new THREE.BoxGeometry(w + 0.1, h + 0.1, 0.035), frameMat);
    fr.position.set(px, py, pz);
    fr.rotation.y = ry;
    g.add(fr);
    const art = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85 }));
    art.position.set(px, py, pz);
    art.rotation.y = ry;
    art.translateZ(0.02);
    g.add(art);
  }
  // 照片上方的画灯:金属灯条 + 聚光灯只打在画面上(不散到整面墙)
  const picBar = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, PHOTO_W + 0.06, 10),
    new THREE.MeshStandardMaterial({ color: 0x8a7040, roughness: 0.35, metalness: 0.7 }));
  picBar.rotation.z = Math.PI / 2;
  picBar.position.set(1.8, PHOTO_Y + PHOTO_H / 2 + 0.12, -ROOM_Z + 0.07);
  g.add(picBar);
  const picLight = new THREE.SpotLight(0xffd9a0, 7, 2.4, 0.5, 0.45, 1.6);
  picLight.position.set(1.8, PHOTO_Y + PHOTO_H / 2 + 0.08, -ROOM_Z + 0.22);
  picLight.target.position.set(1.8, PHOTO_Y - 0.08, -ROOM_Z);
  g.add(picLight);
  g.add(picLight.target);

  // 壁灯:发光片 + 真实点光源 + 墙上光晕,把墙面照出层次
  const sconceGlow = new THREE.MeshBasicMaterial({ color: 0xffe6b8 });
  const sconceMat = new THREE.MeshStandardMaterial({ color: 0x33261a, roughness: 0.5, metalness: 0.4 });
  // 光晕贴图:径向渐变,加法混合贴在墙上
  const haloCv = document.createElement('canvas');
  haloCv.width = haloCv.height = 128;
  const hg = haloCv.getContext('2d');
  // 光晕要克制:大而亮会像镜头眩光没压住,只留贴灯一小圈
  const grd = hg.createRadialGradient(64, 64, 4, 64, 64, 62);
  grd.addColorStop(0, 'rgba(255,214,150,0.30)');
  grd.addColorStop(0.4, 'rgba(255,190,120,0.10)');
  grd.addColorStop(1, 'rgba(255,180,110,0)');
  hg.fillStyle = grd;
  hg.fillRect(0, 0, 128, 128);
  const haloTex = new THREE.CanvasTexture(haloCv);
  haloTex.colorSpace = THREE.SRGBColorSpace;
  const haloMat = new THREE.MeshBasicMaterial({
    map: haloTex, transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, fog: false,
  });
  for (const [px, pz, ry] of [
    [-3.4, ROOM_Z - 0.04, Math.PI], [3.4, ROOM_Z - 0.04, Math.PI],
    [ROOM_X - 0.04, -1.6, -Math.PI / 2], [ROOM_X - 0.04, 1.6, -Math.PI / 2],
  ]) {
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(0.10, 0.2), sconceGlow);
    glow.position.set(px, 1.55, pz);
    glow.rotation.y = ry;
    g.add(glow);
    const shade = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.05, 0.06), sconceMat);
    shade.position.set(px, 1.68, pz);
    shade.rotation.y = ry;
    shade.translateZ(-0.015);
    g.add(shade);
    // 贴墙光晕(小而淡,只衬托灯体)
    const halo = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.7), haloMat);
    halo.position.set(px, 1.53, pz);
    halo.rotation.y = ry;
    halo.translateZ(0.012);
    g.add(halo);
    // 点光源:照亮附近墙面与地板(无阴影,省性能)
    const pl = new THREE.PointLight(0xffc98a, 5.0, 3.4, 2);
    pl.position.set(px, 1.58, pz);
    pl.translateOnAxis(new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(0, 1, 0), ry), 0.22);
    g.add(pl);
  }

  return g;
}

// ---------- 吊灯 ----------
function buildLamp() {
  const g = new THREE.Group();
  const shadeMat = new THREE.MeshStandardMaterial({ color: 0x14401e, roughness: 0.5, metalness: 0.3, side: THREE.DoubleSide });
  const glowMat = new THREE.MeshBasicMaterial({ color: 0xfff0c8 });
  for (const x of [-0.7, 0, 0.7]) {
    const shade = new THREE.Mesh(new THREE.ConeGeometry(0.19, 0.16, 24, 1, true), shadeMat);
    shade.position.set(x, 1.25, 0);
    g.add(shade);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 8), glowMat);
    bulb.position.set(x, 1.2, 0);
    g.add(bulb);
    const wire = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 1.95, 6), shadeMat);
    wire.position.set(x, 2.3, 0); // 接到 3.25 的天花板
    g.add(wire);
  }
  return g;
}

// ---------- 球杆 ----------
function buildCue() {
  const g = new THREE.Group();
  const len = 1.45;
  const shaftMat = new THREE.MeshStandardMaterial({ color: 0xc9a06a, roughness: 0.4 });
  const buttMat = new THREE.MeshStandardMaterial({ color: 0x3a2415, roughness: 0.45 });
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.0055, 0.010, len * 0.6, 16), shaftMat);
  shaft.rotation.z = Math.PI / 2;
  shaft.position.x = -len * 0.3;
  g.add(shaft);
  const butt = new THREE.Mesh(new THREE.CylinderGeometry(0.010, 0.014, len * 0.4, 16), buttMat);
  butt.rotation.z = Math.PI / 2;
  butt.position.x = -len * 0.6 - len * 0.2;
  g.add(butt);
  const ferrule = new THREE.Mesh(new THREE.CylinderGeometry(0.0053, 0.0055, 0.012, 12), new THREE.MeshStandardMaterial({ color: 0xf5f0e0, roughness: 0.3 }));
  ferrule.rotation.z = Math.PI / 2;
  ferrule.position.x = 0.006 - 0.006;
  g.add(ferrule);
  const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.0053, 0.006, 12), new THREE.MeshStandardMaterial({ color: 0x2255aa, roughness: 0.8 }));
  tip.rotation.z = Math.PI / 2;
  tip.position.x = 0.009;
  g.add(tip);
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  // 约定:杆尖朝 +x,击球方向为 -x → 使用时整体旋转
  return g;
}

// ---------- 主入口 ----------
export function initScene(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x14110d);
  // 雾色调成暖暗色且推远:纯黑雾会把几米外的墙面直接压成黑
  scene.fog = new THREE.Fog(0x14110d, 10, 24);
  scene.environment = makeEnvironment(renderer);

  const camera = new THREE.PerspectiveCamera(55, 1, 0.05, 50);
  camera.position.set(0, 1.6, 1.9);
  camera.lookAt(0, 0, 0);

  // 灯光:主光打台面(最亮),壁灯暖光点缀墙面,半球光垫底——主次分明
  const key = new THREE.DirectionalLight(0xfff4e0, 2.2);
  key.position.set(0.4, 2.6, 0.3);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -1.8; key.shadow.camera.right = 1.8;
  key.shadow.camera.top = 1.2; key.shadow.camera.bottom = -1.2;
  key.shadow.camera.near = 0.5; key.shadow.camera.far = 6;
  key.shadow.bias = -0.0004;
  key.shadow.radius = 5; // 软化影缘,不然球影边缘太硬
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xcfd8ff, 0.5);
  fill.position.set(-1.2, 1.6, -0.8);
  scene.add(fill);
  // 顶部柔光洒满全屋("开灯"的底亮):半球光(天花板暖白→地面暖棕)+ 环境光
  scene.add(new THREE.HemisphereLight(0xd8cbb0, 0x4a3826, 0.95));
  scene.add(new THREE.AmbientLight(0xfff0da, 0.30));

  const woodTex = makeWoodTexture();
  scene.add(buildTable(makeFeltTexture('#0f7a46', 22, 256), woodTex));
  scene.add(buildRoom(woodTex));
  const lamp = buildLamp();
  scene.add(lamp);

  // 球
  const ballMeshes = new Map();
  const ballGeo = new THREE.SphereGeometry(R, 40, 28);
  for (let id = 0; id <= 15; id++) {
    const mat = new THREE.MeshPhysicalMaterial({
      map: makeBallTexture(id),
      roughness: 0.12,
      clearcoat: 0.9,
      clearcoatRoughness: 0.12,
      envMapIntensity: 0.9,
    });
    const mesh = new THREE.Mesh(ballGeo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.visible = false;
    scene.add(mesh);
    ballMeshes.set(id, { mesh, quat: new THREE.Quaternion(), drop: null });
  }

  const cue = buildCue();
  cue.visible = false;
  scene.add(cue);

  // ---------- 瞄准辅助线:贴地虚线块(可控粗细/颜色/虚实) ----------
  const dashGeo = new THREE.PlaneGeometry(1, 1);
  dashGeo.rotateX(-Math.PI / 2); // 平铺于 XZ,local +x 为线方向
  const aimMat = new THREE.MeshBasicMaterial({ color: 0x8fe3ff, transparent: true, opacity: 0.95, depthWrite: false });
  const scratchMat = new THREE.MeshBasicMaterial({ color: 0xff5544, transparent: true, opacity: 0.95, depthWrite: false });
  const postMat = new THREE.MeshBasicMaterial({ color: 0x66aaff, transparent: true, opacity: 0.4, depthWrite: false });
  const objMat = new THREE.MeshBasicMaterial({ color: 0xffd54a, transparent: true, opacity: 0.95, depthWrite: false });
  const DASH_N = 160;
  const dashPool = [];
  const dashGroup = new THREE.Group();
  dashGroup.renderOrder = 5;
  for (let i = 0; i < DASH_N; i++) {
    const m = new THREE.Mesh(dashGeo, aimMat);
    m.visible = false;
    dashPool.push(m);
    dashGroup.add(m);
  }
  scene.add(dashGroup);
  let dashCursor = 0;
  const LINE_Y = 0.0018;

  // 沿折线铺虚线段;返回线尾方向(供箭头用)
  function layDashes(pts, mat, width, dashLen, gapLen, skipStart) {
    if (!pts || pts.length < 2) return null;
    // 折线累计长度
    let total = 0;
    const seg = [];
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i].x - pts[i - 1].x, dz = pts[i].z - pts[i - 1].z;
      const L = Math.sqrt(dx * dx + dz * dz);
      seg.push(L);
      total += L;
    }
    if (total < skipStart + dashLen) return null;
    const step = dashLen + gapLen;
    let lastDir = null;
    for (let s = skipStart; s + dashLen <= total && dashCursor < DASH_N; s += step) {
      const mid = s + dashLen / 2;
      // 定位 mid 所在折线段
      let acc = 0, i = 0;
      while (i < seg.length && acc + seg[i] < mid) { acc += seg[i]; i++; }
      if (i >= seg.length) break;
      const t = seg[i] > 1e-9 ? (mid - acc) / seg[i] : 0;
      const x = pts[i].x + (pts[i + 1].x - pts[i].x) * t;
      const z = pts[i].z + (pts[i + 1].z - pts[i].z) * t;
      const dx = pts[i + 1].x - pts[i].x, dz = pts[i + 1].z - pts[i].z;
      const ang = Math.atan2(dz, dx);
      const m = dashPool[dashCursor++];
      m.material = mat;
      m.position.set(x, LINE_Y, z);
      m.rotation.y = -ang;
      m.scale.set(dashLen, 1, width);
      m.visible = true;
      lastDir = { x: dx, z: dz, ang };
    }
    return lastDir;
  }

  // 目标球走向:实心粗线 + 箭头
  const objQuad = new THREE.Mesh(dashGeo, objMat);
  objQuad.visible = false;
  scene.add(objQuad);
  const arrowShape = new THREE.Shape();
  arrowShape.moveTo(0, -0.5); arrowShape.lineTo(1, 0); arrowShape.lineTo(0, 0.5); arrowShape.closePath();
  const arrowGeo = new THREE.ShapeGeometry(arrowShape);
  arrowGeo.rotateX(-Math.PI / 2);
  const objArrow = new THREE.Mesh(arrowGeo, objMat);
  objArrow.visible = false;
  scene.add(objArrow);

  const ghost = new THREE.Mesh(
    new THREE.SphereGeometry(R, 20, 14),
    new THREE.MeshBasicMaterial({ color: 0xaef0ff, transparent: true, opacity: 0.35, depthWrite: false })
  );
  ghost.visible = false;
  scene.add(ghost);
  // 自由球放置指示
  const placeMarker = new THREE.Mesh(
    new THREE.RingGeometry(R * 1.1, R * 1.5, 24),
    new THREE.MeshBasicMaterial({ color: 0x44ff88, transparent: true, opacity: 0.7, side: THREE.DoubleSide })
  );
  placeMarker.rotation.x = -Math.PI / 2;
  placeMarker.position.y = 0.002;
  placeMarker.visible = false;
  scene.add(placeMarker);

  const tmpQ = new THREE.Quaternion();
  const tmpAxis = new THREE.Vector3();

  // ---------- 落袋动画(纯视觉):带入袋速度滚过袋沿→重力下坠→撞袋壁→落底 ----------
  function startDrop(m, b) {
    let pk = POCKETS[0], bd = Infinity;
    for (const p of POCKETS) {
      const dx = b.x - p.x, dz = b.z - p.z, d2 = dx * dx + dz * dz;
      if (d2 < bd) { bd = d2; pk = p; }
    }
    let vx = b.vx, vz = b.vz;
    const sp = Math.sqrt(vx * vx + vz * vz);
    const cap = 1.8;
    if (sp > cap) { vx = vx / sp * cap; vz = vz / sp * cap; }
    if (sp < 0.25) {
      // 太慢(边界兜底捕获等):朝袋心滑入
      const dx = pk.x - b.x, dz = pk.z - b.z, d = Math.sqrt(dx * dx + dz * dz) || 1;
      vx = dx / d * 0.5; vz = dz / d * 0.5;
    }
    m.drop = {
      x: b.x, z: b.z, y: m.mesh.position.y,
      vx, vz, vy: 0, wx: b.wx, wz: b.wz, pk, t: 0,
    };
  }
  function stepDrop(m, dt) {
    const d = m.drop, pk = d.pk;
    d.t += dt;
    // 越过袋沿后向袋心的轻微引导 + 重力
    d.vx += (pk.x - d.x) * 6 * dt;
    d.vz += (pk.z - d.z) * 6 * dt;
    d.vy -= 9.81 * dt;
    d.x += d.vx * dt; d.z += d.vz * dt; d.y += d.vy * dt;
    // 袋壁约束:球心不出袋杯,撞壁沿切向滑落
    const lim = pk.r - R * 0.62;
    const dx = d.x - pk.x, dz = d.z - pk.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist > lim && dist > 1e-6) {
      const nx = dx / dist, nz = dz / dist;
      d.x = pk.x + nx * lim; d.z = pk.z + nz * lim;
      const vr = d.vx * nx + d.vz * nz;
      if (vr > 0) { d.vx -= vr * 1.4 * nx; d.vz -= vr * 1.4 * nz; }
    }
    // 袋底弹跳
    const floorY = -0.088;
    if (d.y < floorY) {
      d.y = floorY;
      d.vy = d.vy < -0.4 ? -d.vy * 0.32 : 0;
      d.vx *= 0.82; d.vz *= 0.82;
    }
    m.mesh.position.set(d.x, d.y, d.z);
    // 残余旋转继续转动
    const wm = Math.sqrt(d.wx * d.wx + d.wz * d.wz);
    if (wm > 0.05) {
      tmpAxis.set(d.wx / wm, 0, d.wz / wm);
      tmpQ.setFromAxisAngle(tmpAxis, wm * dt);
      m.quat.premultiply(tmpQ);
      m.mesh.quaternion.copy(m.quat);
      d.wx *= 0.96; d.wz *= 0.96;
    }
    // 静置后转入回球滑道(穿过漏斗 → 支轨 → 汇总轨 → 托盘)
    if (d.t > 0.9 && !d.chute) {
      const pts = [[d.x, d.y, d.z], ...chutePathFor(pk)];
      const seg = [];
      let total = 0;
      for (let i = 1; i < pts.length; i++) {
        const dx = pts[i][0] - pts[i - 1][0], dy = pts[i][1] - pts[i - 1][1], dz = pts[i][2] - pts[i - 1][2];
        const L = Math.sqrt(dx * dx + dy * dy + dz * dz);
        seg.push(L); total += L;
      }
      d.chute = { pts, seg, total, s: 0, v: 0.45, settle: null };
    }
  }

  // ---------- 托盘登记:id -> 槽位 ----------
  const trayReg = new Map();
  function freeTraySlot() {
    const used = new Set(trayReg.values());
    let k = 0;
    while (used.has(k)) k++;
    return k;
  }
  function placeAtTray(m, id) {
    const sp = traySlotPos(trayReg.get(id));
    m.mesh.visible = true;
    m.mesh.scale.setScalar(1);
    m.mesh.position.set(sp.x, sp.y, sp.z);
  }

  // 滑道推进:沿折线匀加速滚动,末端过渡进托盘槽位
  function stepChute(m, id, dt) {
    const d = m.drop, c = d.chute;
    if (c.settle) {
      // 入盘缓动
      c.settle.t += dt;
      const k = Math.min(c.settle.t / 0.3, 1);
      const e = 1 - (1 - k) * (1 - k);
      const sp = c.settle.to;
      m.mesh.position.set(
        c.settle.from[0] + (sp.x - c.settle.from[0]) * e,
        c.settle.from[1] + (sp.y - c.settle.from[1]) * e,
        c.settle.from[2] + (sp.z - c.settle.from[2]) * e
      );
      if (k >= 1) { m.drop = null; }
      return;
    }
    c.v = Math.min(c.v + 1.5 * dt, 1.5);
    c.s += c.v * dt;
    if (c.s >= c.total) {
      // 到达托盘入口:分配槽位
      const slot = freeTraySlot();
      trayReg.set(id, slot);
      const last = c.pts[c.pts.length - 1];
      c.settle = { t: 0, from: [last[0], last[1], last[2]], to: traySlotPos(slot) };
      return;
    }
    // 定位 s 所在折线段
    let acc = 0, i = 0;
    while (i < c.seg.length && acc + c.seg[i] < c.s) { acc += c.seg[i]; i++; }
    const t = c.seg[i] > 1e-9 ? (c.s - acc) / c.seg[i] : 0;
    const p0 = c.pts[i], p1 = c.pts[i + 1];
    const x = p0[0] + (p1[0] - p0[0]) * t;
    const y = p0[1] + (p1[1] - p0[1]) * t;
    const z = p0[2] + (p1[2] - p0[2]) * t;
    m.mesh.position.set(x, y, z);
    // 沿轨滚动的自转(轴 = 水平面内速度方向的垂向)
    const vx = p1[0] - p0[0], vz = p1[2] - p0[2];
    const hl = Math.sqrt(vx * vx + vz * vz);
    if (hl > 1e-6) {
      tmpAxis.set(-vz / hl, 0, vx / hl);
      tmpQ.setFromAxisAngle(tmpAxis, c.v / R * dt);
      m.quat.premultiply(tmpQ);
      m.mesh.quaternion.copy(m.quat);
    }
  }

  return {
    renderer, scene, camera, cue, ghost, placeMarker, lamp,

    resize(w, h) {
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    },

    // 每帧同步球位(含旋转积分与落袋动画)
    updateBalls(balls, dtRender) {
      const dt = Math.min(dtRender, 0.05);
      for (const b of balls) {
        const m = ballMeshes.get(b.id);
        if (!m) continue;
        if (!b.on) {
          if (m.drop) {
            // 落袋动画进行中:袋内下坠 或 回球滑道
            if (m.drop.chute) stepChute(m, b.id, dt);
            else stepDrop(m, dt);
          } else if (trayReg.has(b.id)) {
            placeAtTray(m, b.id);          // 已收进托盘,摆在槽位上
          } else if (m.mesh.visible) {
            startDrop(m, b);               // 刚离场 → 启动落袋动画(带入袋速度)
            stepDrop(m, dt);
          }
          continue;
        }
        trayReg.delete(b.id);              // 重新上台(自由球/黑八重置)→ 离开托盘
        m.drop = null;
        m.mesh.visible = true;
        m.mesh.scale.setScalar(1);
        m.mesh.position.set(b.x, R, b.z);
        // 旋转积分(仅视觉)
        const wmag = Math.sqrt(b.wx * b.wx + b.wy * b.wy + b.wz * b.wz);
        if (wmag > 0.01) {
          tmpAxis.set(b.wx / wmag, b.wy / wmag, b.wz / wmag);
          tmpQ.setFromAxisAngle(tmpAxis, wmag * dtRender);
          m.quat.premultiply(tmpQ);
          m.mesh.quaternion.copy(m.quat);
        }
      }
    },

    resetDropAnims() {
      // 回放切换/新开一局:隐藏全部球(下一帧 updateBalls 只点亮在场的球)并复位动画。
      // 进行中的落袋/滑道动画直接"收进托盘",不然球会凭空消失
      for (const [id, m] of ballMeshes) {
        if (m.drop && !trayReg.has(id)) trayReg.set(id, freeTraySlot());
        m.drop = null;
        m.mesh.scale.setScalar(1);
        m.mesh.visible = false;
      }
    },

    clearTray() {
      trayReg.clear();
    },

    // 查询某球落袋动画的当前位置(回放跟踪机位用)
    // 返回 null=无动画且不在托盘;done=true 表示已在托盘槽位
    dropInfo(id) {
      const m = ballMeshes.get(id);
      if (!m) return null;
      if (m.drop) {
        const p = m.mesh.position;
        return { x: p.x, y: p.y, z: p.z, done: false };
      }
      if (trayReg.has(id)) {
        const sp = traySlotPos(trayReg.get(id));
        return { x: sp.x, y: sp.y, z: sp.z, done: true };
      }
      return null;
    },

    // 瞄准可视化。pred 为 physics.predictShot 的结果或 null
    setAim(pred) {
      for (let i = 0; i < dashCursor; i++) dashPool[i].visible = false;
      dashCursor = 0;
      if (!pred) {
        ghost.visible = objQuad.visible = objArrow.visible = false;
        return;
      }
      // 母球路径:粗虚线(洗袋警告变红),从球沿前方一点距离开始铺
      const mainMat = pred.scratch ? scratchMat : aimMat;
      layDashes(pred.path, mainMat, 0.011, 0.032, 0.024, R * 1.4);
      // 接触后母球去向:细淡虚线
      layDashes(pred.postPath, postMat, 0.007, 0.02, 0.02, R * 1.2);
      if (pred.contact) {
        ghost.position.set(pred.contact.x, R, pred.contact.z);
        ghost.visible = true;
      } else ghost.visible = false;
      if (pred.contact && pred.objectDir) {
        const len = Math.min(0.1 + pred.objectDir.speed * 0.1, 0.5);
        const ox = pred.contact.x + pred.objectDir.x * R;
        const oz = pred.contact.z + pred.objectDir.z * R;
        const ang = Math.atan2(pred.objectDir.z, pred.objectDir.x);
        objQuad.position.set(ox + pred.objectDir.x * len / 2, LINE_Y + 0.0004, oz + pred.objectDir.z * len / 2);
        objQuad.rotation.y = -ang;
        objQuad.scale.set(len, 1, 0.012);
        objQuad.visible = true;
        objArrow.position.set(ox + pred.objectDir.x * len, LINE_Y + 0.0004, oz + pred.objectDir.z * len);
        objArrow.rotation.y = -ang;
        objArrow.scale.set(0.035, 1, 0.035);
        objArrow.visible = true;
      } else { objQuad.visible = objArrow.visible = false; }
    },
  };
}
