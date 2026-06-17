// =====================================================================
// ATELIER · PATTERN STUDIO
// 3D 의류(마네킹이 입은 옷) ↔ 평면 패턴(옷본) 전개 시각화 도구
// =====================================================================
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ---------------------------------------------------------------------
// 0. 신체 치수 상수 (meters) — 마네킹/래핑 함수가 공유하는 기준값
// ---------------------------------------------------------------------
const BODY = {
  floor: 0,
  ankle: 0.07,
  knee: 0.45,
  crotch: 0.80,
  hip: 0.88,
  waist: 1.02,
  bust: 1.20,
  shoulder: 1.42,
  neckBase: 1.46,
  headTop: 1.63,
  shoulderHalf: 0.165,   // 척추~어깨끝 수평거리
  hipHalf: 0.155,        // 척추~다리 부착점 수평거리
};

// 토르소 단면 반지름 프로파일 (키 -> 반지름), 어깨~엉덩이
const TORSO_RADIUS_PTS = [
  [BODY.shoulder, 0.122],
  [BODY.bust,     0.150],
  [BODY.waist,    0.122],
  [BODY.hip,      0.158],
  [0.55,          0.185],   // 원피스 밑단 플레어 참고용 (엉덩이 아래)
  [0.20,          0.205],
];

// 다리(앞/뒤) 단면 반지름 프로파일 — 엉덩이 소켓으로부터의 along 거리(m) 기준
const LEG_RADIUS_PTS = [
  [0.00, 0.150],                          // hip
  [BODY.hip - BODY.crotch, 0.118],        // crotch
  [BODY.hip - BODY.knee,   0.095],        // knee
  [BODY.hip - BODY.ankle,  0.068],        // ankle
];

// 팔 단면 반지름 프로파일 (어깨 -> 손목, alongArm 거리 기준 0~)
const ARM_RADIUS_PTS = [
  [0.00, 0.118],
  [0.18, 0.092],
  [0.36, 0.078],
];

// ---------------------------------------------------------------------
// 1. 수학 / 보간 헬퍼
// ---------------------------------------------------------------------
function lerp(a, b, t) { return a + (b - a) * t; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function easeInOutCubic(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }

// 분단선형 보간: pts = [[x0,y0],[x1,y1],...] (x 오름차순/내림차순 모두 허용)
function piecewiseLerp(pts, x) {
  const ascending = pts[0][0] < pts[pts.length - 1][0];
  const arr = ascending ? pts : pts.slice().reverse();
  if (x <= arr[0][0]) return arr[0][1];
  if (x >= arr[arr.length - 1][0]) return arr[arr.length - 1][1];
  for (let i = 0; i < arr.length - 1; i++) {
    const [x0, y0] = arr[i];
    const [x1, y1] = arr[i + 1];
    if (x >= x0 && x <= x1) {
      const t = (x - x0) / (x1 - x0);
      return lerp(y0, y1, t);
    }
  }
  return arr[arr.length - 1][1];
}

function torsoRadiusAt(y) { return piecewiseLerp(TORSO_RADIUS_PTS, y); }
function legRadiusAt(y) { return piecewiseLerp(LEG_RADIUS_PTS, y); }
function armRadiusAt(alongArm) { return piecewiseLerp(ARM_RADIUS_PTS, alongArm); }

// axis에 직교하는 정규직교 기저 두 축을 반환
function orthoBasis(axis) {
  const upRef = Math.abs(axis.y) > 0.92 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(axis, upRef).normalize();
  const out = new THREE.Vector3().crossVectors(right, axis).normalize();
  return { right, out };
}

// ---------------------------------------------------------------------
// 2. 신체 부위별 "입체 래핑(wrap)" 함수
//    패턴 평면 좌표 (px, py) -> 마네킹 표면 위의 3D 월드 좌표
//    px: 중심선(앞/뒤 중심 또는 팔/다리 중심축) 기준 좌우 거리 (+ = 오른쪽/바깥)
//    py: 기준선(어깨선 등) 기준 아래쪽으로의 거리 (항상 0 이하, 내려갈수록 음수)
// ---------------------------------------------------------------------

// 토르소(앞판/뒤판): 어깨선(y=0, body Y=BODY.shoulder)을 기준으로 아래로 펼쳐짐
function wrapTorso(px, py, side) {
  const bodyY = BODY.shoulder + py;
  const r = torsoRadiusAt(bodyY);
  const angle = clamp(px / Math.max(r, 0.04), -1.45, 1.45);
  const x = r * Math.sin(angle);
  const z = side === 'front' ? r * Math.cos(angle) * 1.0 : -r * Math.cos(angle) * 1.0;
  // 등/가슴 곡률을 살리기 위해 살짝 보정: 앞판은 약간 앞으로, 뒤판은 약간 평평하게
  const zBias = side === 'front' ? 0.012 : -0.004;
  return new THREE.Vector3(x, bodyY, z + zBias);
}

// 팔/다리처럼 기울어진 실린더에 래핑하는 범용 함수
// center: 기준 시작점(어깨/엉덩이 소켓), axis: 축 방향(정규화), radiusFn: along 거리 -> 반지름
// along: 기준점에서 축을 따라 내려간 거리, px: 원주각 계산용 가로 좌표
// frontBack: 'front'|'back'|null (null이면 전체 원주의 한 면만 사용하는 단일 패널, 예: 소매)
function wrapCylinder(center, axis, radiusFn, along, px, frontBack) {
  const { right, out } = orthoBasis(axis);
  const r = Math.max(radiusFn(along), 0.03);
  let angle = px / r;
  if (frontBack === 'front') angle = clamp(angle, -1.4, 1.4);
  if (frontBack === 'back') angle = clamp(angle, -1.4, 1.4);
  const dirSign = frontBack === 'back' ? -1 : 1;
  const localOffset = right.clone().multiplyScalar(r * Math.sin(angle))
    .add(out.clone().multiplyScalar(r * Math.cos(angle) * dirSign));
  const centerPt = center.clone().add(axis.clone().multiplyScalar(along));
  return centerPt.add(localOffset);
}

// 오른팔/왼팔 축 정의
function armAxis(sideSign) {
  // sideSign: +1 = 오른팔(+x), -1 = 왼팔(-x)
  return new THREE.Vector3(sideSign * 0.46, -0.875, 0.08).normalize();
}
function armSocket(sideSign) {
  return new THREE.Vector3(sideSign * BODY.shoulderHalf, BODY.shoulder - 0.01, 0.015);
}

// 오른다리/왼다리 축 정의
function legAxis(sideSign) {
  return new THREE.Vector3(sideSign * 0.085, -1.0, 0.02).normalize();
}
function legSocket(sideSign) {
  return new THREE.Vector3(sideSign * BODY.hipHalf, BODY.hip - 0.02, 0.0);
}

function wrapSleeve(px, py, sideSign) {
  // py: capTop 부근이 약 +0.06 (0보다 큼), 손목쪽이 음수로 내려감
  const along = clamp(0.06 - py, 0, 0.45);
  return wrapCylinder(armSocket(sideSign), armAxis(sideSign), armRadiusAt, along, px, null);
}

function wrapLeg(px, py, sideSign, frontBack) {
  const along = clamp(-py, 0, 1.0);
  // buildLegShape는 좌우 비대칭(인심/아웃심이 다름) 모양이므로,
  // 왼쪽 다리에서는 px를 반전시켜 인심/아웃심이 올바른 쪽으로 향하게 한다.
  const localPx = sideSign < 0 ? -px : px;
  return wrapCylinder(legSocket(sideSign), legAxis(sideSign), legRadiusAt, along, localPx, frontBack);
}

// ---------------------------------------------------------------------
// 3. 패턴 조각(Shape) 정의 — THREE.Shape 윤곽선을 패턴 좌표(m)로 직접 작도
//    좌표계: x=0 이 중심선(앞/뒤 중심 또는 좌우대칭축), y=0 이 기준 가로선
//    (어깨선 / 소매캡 상단 / 허리선 등), y는 아래로 갈수록 음수
// ---------------------------------------------------------------------

// 바디스(앞판/뒤판) 윤곽 — 목둘레 깊이와 밑단 길이/플레어를 매개변수로 받음
function buildBodiceShape({ neckDepth, neckWidth, shoulderW, underarmDrop, chestW, hemW, length, sideCurveOutAt }) {
  const shape = new THREE.Shape();
  // 우측 절반을 따라가다 좌측 절반으로 대칭 복귀
  const cNeck = new THREE.Vector2(0, -neckDepth);
  const neckShoulderR = new THREE.Vector2(neckWidth, 0);
  const shoulderTipR = new THREE.Vector2(shoulderW, -0.008);
  const underarmR = new THREE.Vector2(chestW, -underarmDrop);
  const sideHemR = new THREE.Vector2(hemW, -length);
  const centerHem = new THREE.Vector2(0, -length);

  shape.moveTo(cNeck.x, cNeck.y);
  shape.quadraticCurveTo(neckWidth * 0.55, 0, neckShoulderR.x, neckShoulderR.y);
  shape.lineTo(shoulderTipR.x, shoulderTipR.y);
  shape.quadraticCurveTo(chestW + 0.045, -underarmDrop * 0.55, underarmR.x, underarmR.y);
  shape.lineTo(sideHemR.x, sideHemR.y);
  shape.lineTo(centerHem.x, centerHem.y);
  // 좌측 (대칭)
  shape.lineTo(-sideHemR.x, -length);
  shape.lineTo(-underarmR.x, underarmR.y);
  shape.quadraticCurveTo(-(chestW + 0.045), -underarmDrop * 0.55, -shoulderTipR.x, shoulderTipR.y);
  shape.lineTo(-neckShoulderR.x, neckShoulderR.y);
  shape.quadraticCurveTo(-neckWidth * 0.55, 0, cNeck.x, cNeck.y);

  return shape;
}

// 소매 윤곽 — 소매캡(둥근 위쪽 곡선) + 사다리꼴 아래쪽
function buildSleeveShape({ capWidth, capHeight, underarmY, hemWidth, length }) {
  const shape = new THREE.Shape();
  const capL = new THREE.Vector2(-capWidth, -underarmY * 0.25);
  const capTop = new THREE.Vector2(0, capHeight);
  const capR = new THREE.Vector2(capWidth, -underarmY * 0.25);
  const hemR = new THREE.Vector2(hemWidth, -length);
  const hemL = new THREE.Vector2(-hemWidth, -length);

  shape.moveTo(capL.x, capL.y);
  shape.quadraticCurveTo(-capWidth * 0.45, capHeight * 1.05, capTop.x, capTop.y);
  shape.quadraticCurveTo(capWidth * 0.45, capHeight * 1.05, capR.x, capR.y);
  shape.quadraticCurveTo(capWidth * 1.02, -underarmY * 0.9, hemR.x, hemR.y);
  shape.lineTo(hemL.x, hemL.y);
  shape.quadraticCurveTo(-capWidth * 1.02, -underarmY * 0.9, capL.x, capL.y);
  return shape;
}

// 다리(앞/뒤) 윤곽 — 위쪽 허리/크로치 곡선 + 테이퍼진 다리
function buildLegShape({ waistW, hipW, crotchDrop, kneeW, hemW, length, riseStyle }) {
  const shape = new THREE.Shape();
  // riseStyle 'front' | 'back' — back은 크로치 곡선이 더 깊고 허리쪽이 더 높이 올라감
  const waistOut = new THREE.Vector2(waistW, 0);
  const waistIn = new THREE.Vector2(waistW * 0.18, -0.01);
  const crotch = new THREE.Vector2(waistW * 0.12, -crotchDrop);
  const kneeOut = new THREE.Vector2(kneeW, -length * 0.62);
  const hemOut = new THREE.Vector2(hemW, -length);
  const hemIn = new THREE.Vector2(-hemW * 0.92, -length);
  const kneeIn = new THREE.Vector2(-kneeW * 0.92, -length * 0.62);

  shape.moveTo(waistIn.x, waistIn.y);
  shape.lineTo(waistOut.x, waistOut.y);
  shape.lineTo(hipW, -crotchDrop * 0.42);
  shape.quadraticCurveTo(kneeW * 1.05, -crotchDrop * 0.75, kneeOut.x, kneeOut.y);
  shape.lineTo(hemOut.x, hemOut.y);
  shape.lineTo(hemIn.x, hemIn.y);
  shape.lineTo(kneeIn.x, kneeIn.y);
  shape.quadraticCurveTo(-hipW * 0.78, -crotchDrop * 0.7, crotch.x, crotch.y);
  shape.quadraticCurveTo(waistW * 0.02, -crotchDrop * 0.18, waistIn.x, waistIn.y);
  return shape;
}

// ---------------------------------------------------------------------
// 4. 패널 메쉬 빌더 — Shape -> Geometry, worn/flat 두 좌표 계산, 외곽선/시접선/
//    식서방향/라벨까지 한 세트로 구성하는 PatternPanel 클래스
// ---------------------------------------------------------------------

const SEAM_ALLOWANCE = 0.013; // 시접 폭 (m), 시각적 표현용

function safeNormalize(v, fallback) {
  if (v.lengthSq() < 1e-10) return fallback.clone();
  return v.normalize();
}

function outwardOffsetPolygon(points2D, dist) {
  const n = points2D.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const prev = points2D[(i - 1 + n) % n];
    const cur = points2D[i];
    const next = points2D[(i + 1) % n];
    const fallback = new THREE.Vector2(1, 0);
    const e1 = safeNormalize(new THREE.Vector2().subVectors(cur, prev), fallback);
    const e2 = safeNormalize(new THREE.Vector2().subVectors(next, cur), fallback);
    const n1 = new THREE.Vector2(e1.y, -e1.x);
    const n2 = new THREE.Vector2(e2.y, -e2.x);
    const avg = safeNormalize(new THREE.Vector2().addVectors(n1, n2), n1);
    out.push(new THREE.Vector2(cur.x + avg.x * dist, cur.y + avg.y * dist));
  }
  return out;
}

function makeLabelSprite(text, accentColor) {
  const canvas = document.createElement('canvas');
  const W = 512, H = 160;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  // 카드형 배경
  ctx.fillStyle = 'rgba(244,241,233,0.94)';
  ctx.strokeStyle = accentColor;
  ctx.lineWidth = 5;
  const pad = 10;
  roundRect(ctx, pad, pad, W - pad * 2, H - pad * 2, 18);
  ctx.fill(); ctx.stroke();

  ctx.fillStyle = '#2c2419';
  ctx.font = '600 52px "Work Sans", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, W / 2, H / 2 - 4);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(0.34, 0.34 * (H / W), 1);
  return sprite;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

class PatternPanel {
  /**
   * @param {THREE.Shape} shape  패턴 좌표계로 작도된 윤곽
   * @param {(px:number, py:number)=>THREE.Vector3} wrapFn  worn 위치 계산 함수
   * @param {{x:number,z:number}} slot  flat 상태일 때 테이블 위 배치 위치
   * @param {string} label  라벨 텍스트
   * @param {number} color  패널 색상(hex)
   * @param {{x0:number,x1:number,y:number}} [grain]  식서방향 세그먼트(패턴 로컬좌표)
   */
  constructor(shape, wrapFn, slot, label, color, grain) {
    this.shape = shape;
    this.wrapFn = wrapFn;
    this.slot = slot;
    this.label = label;
    this.color = color;
    this.group = new THREE.Group();

    this._buildFill();
    this._buildOutline();
    this._buildSeamAllowance();
    this._buildGrainline(grain);
    this._buildLabel();

    this.setT(0);
  }

  _flatPos(px, py) {
    // 패턴 평면(x,y) -> 테이블 위 평면(x, tableY, z) 로 눕혀서 배치
    return new THREE.Vector3(px + this.slot.x, 0.018, -py + this.slot.z);
  }

  _buildFill() {
    const geo = new THREE.ShapeGeometry(this.shape, 24);
    geo.computeBoundingBox();
    const posAttr = geo.attributes.position;
    const count = posAttr.count;
    const worn = new Float32Array(count * 3);
    const flat = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const px = posAttr.getX(i);
      const py = posAttr.getY(i);
      const w = this.wrapFn(px, py);
      worn[i * 3] = w.x; worn[i * 3 + 1] = w.y; worn[i * 3 + 2] = w.z;
      const f = this._flatPos(px, py);
      flat[i * 3] = f.x; flat[i * 3 + 1] = f.y; flat[i * 3 + 2] = f.z;
    }
    geo.setAttribute('wornPosition', new THREE.BufferAttribute(worn, 3));
    geo.setAttribute('flatPosition', new THREE.BufferAttribute(flat, 3));
    geo.setAttribute('position', new THREE.BufferAttribute(worn.slice(), 3));

    const mat = new THREE.MeshStandardMaterial({
      color: this.color,
      roughness: 0.82,
      metalness: 0.02,
      side: THREE.DoubleSide,
      flatShading: false,
    });
    this.fillMesh = new THREE.Mesh(geo, mat);
    this.fillMesh.castShadow = true;
    this.fillMesh.receiveShadow = true;
    this.group.add(this.fillMesh);
  }

  // 외곽선(절단선) — Shape의 경계 포인트를 별도 라인으로 그려 또렷한 윤곽 제공
  _buildOutline() {
    let pts2D = this.shape.getPoints(24);
    // 폐곡선이라 마지막 점이 첫 점과 거의 같은 경우 제거 (법선 계산 시 0벡터 방지)
    if (pts2D.length > 1 && pts2D[0].distanceTo(pts2D[pts2D.length - 1]) < 1e-5) {
      pts2D = pts2D.slice(0, -1);
    }
    this._boundaryPts = pts2D;
    const worn = [];
    const flat = [];
    for (const p of pts2D) {
      const w = this.wrapFn(p.x, p.y);
      worn.push(w);
      flat.push(this._flatPos(p.x, p.y));
    }
    this._outlineWorn = worn;
    this._outlineFlat = flat;

    const geo = new THREE.BufferGeometry().setFromPoints(worn);
    const mat = new THREE.LineBasicMaterial({ color: 0x2c2419, linewidth: 1, transparent: true, opacity: 0.85 });
    this.outlineLine = new THREE.LineLoop(geo, mat);
    this.group.add(this.outlineLine);
  }

  _buildSeamAllowance() {
    const offsetPts = outwardOffsetPolygon(this._boundaryPts, SEAM_ALLOWANCE);
    const worn = [];
    const flat = [];
    for (const p of offsetPts) {
      worn.push(this.wrapFn(p.x, p.y));
      flat.push(this._flatPos(p.x, p.y));
    }
    this._seamWorn = worn;
    this._seamFlat = flat;
    const geo = new THREE.BufferGeometry().setFromPoints(worn);
    const mat = new THREE.LineDashedMaterial({ color: 0xc2883f, dashSize: 0.012, gapSize: 0.008, transparent: true, opacity: 0.95 });
    this.seamLine = new THREE.LineLoop(geo, mat);
    this.seamLine.computeLineDistances();
    this.group.add(this.seamLine);
  }

  _buildGrainline(grain) {
    if (!grain) { this.grainLine = null; return; }
    const { x, y0, y1 } = grain;
    const arrowW = 0.012;
    const localPts = [
      new THREE.Vector2(x, y0 + arrowW), new THREE.Vector2(x, y0),
      new THREE.Vector2(x - arrowW, y0 + arrowW * 1.6), new THREE.Vector2(x, y0),
      new THREE.Vector2(x + arrowW, y0 + arrowW * 1.6), new THREE.Vector2(x, y0),
      new THREE.Vector2(x, y1),
      new THREE.Vector2(x - arrowW, y1 - arrowW * 1.6), new THREE.Vector2(x, y1),
      new THREE.Vector2(x + arrowW, y1 - arrowW * 1.6), new THREE.Vector2(x, y1),
    ];
    this._grainLocal = localPts;
    const worn = localPts.map(p => this.wrapFn(p.x, p.y));
    const flat = localPts.map(p => this._flatPos(p.x, p.y));
    this._grainWorn = worn;
    this._grainFlat = flat;
    const geo = new THREE.BufferGeometry().setFromPoints(worn);
    const mat = new THREE.LineBasicMaterial({ color: 0x46413a, transparent: true, opacity: 0.9 });
    this.grainLine = new THREE.Line(geo, mat);
    this.group.add(this.grainLine);
  }

  _buildLabel() {
    this.sprite = makeLabelSprite(this.label, '#' + this.color.toString(16).padStart(6, '0'));
    this.group.add(this.sprite);
    const box = new THREE.Box2();
    this._boundaryPts.forEach(p => box.expandByPoint(p));
    this._labelLocal = box.getCenter(new THREE.Vector2());
  }

  setT(t) {
    this.t = t;
    // fill
    const posAttr = this.fillMesh.geometry.attributes.position;
    const wornAttr = this.fillMesh.geometry.attributes.wornPosition;
    const flatAttr = this.fillMesh.geometry.attributes.flatPosition;
    for (let i = 0; i < posAttr.count; i++) {
      posAttr.setX(i, lerp(wornAttr.getX(i), flatAttr.getX(i), t));
      posAttr.setY(i, lerp(wornAttr.getY(i), flatAttr.getY(i), t));
      posAttr.setZ(i, lerp(wornAttr.getZ(i), flatAttr.getZ(i), t));
    }
    posAttr.needsUpdate = true;
    this.fillMesh.geometry.computeVertexNormals();

    // outline
    this._setLinePoints(this.outlineLine, this._outlineWorn, this._outlineFlat, t);
    // seam allowance
    this._setLinePoints(this.seamLine, this._seamWorn, this._seamFlat, t, true);
    // grainline
    if (this.grainLine) this._setLinePoints(this.grainLine, this._grainWorn, this._grainFlat, t);

    // label position: lerp worn-projected centroid vs flat centroid, float slightly above
    const wCenter = this.wrapFn(this._labelLocal.x, this._labelLocal.y);
    const fCenter = this._flatPos(this._labelLocal.x, this._labelLocal.y);
    const liftWorn = wCenter.clone();
    const normalLift = 0.05;
    // 입은 상태에서는 표면에서 약간 띄워서(법선 방향 대략 z/x 바깥쪽으로) 보기 좋게
    const dir = new THREE.Vector3(liftWorn.x, 0, liftWorn.z).normalize();
    liftWorn.addScaledVector(dir.lengthSq() > 0 ? dir : new THREE.Vector3(0, 0, 1), normalLift);
    const liftFlat = fCenter.clone(); liftFlat.y += 0.045;
    this.sprite.position.copy(liftWorn).lerp(liftFlat, t);
    const baseScale = 0.30 + 0.10 * t;
    this.sprite.scale.set(baseScale, baseScale * (160 / 512), 1);
  }

  _setLinePoints(line, wornPts, flatPts, t, withDash) {
    const arr = line.geometry.attributes.position.array;
    for (let i = 0; i < wornPts.length; i++) {
      arr[i * 3] = lerp(wornPts[i].x, flatPts[i].x, t);
      arr[i * 3 + 1] = lerp(wornPts[i].y, flatPts[i].y, t);
      arr[i * 3 + 2] = lerp(wornPts[i].z, flatPts[i].z, t);
    }
    line.geometry.attributes.position.needsUpdate = true;
    line.geometry.computeBoundingSphere();
    if (withDash) line.computeLineDistances();
  }

  setVisible({ seam, grain, label }) {
    this.seamLine.visible = seam;
    if (this.grainLine) this.grainLine.visible = grain;
    this.sprite.visible = label;
  }

  dispose() {
    this.fillMesh.geometry.dispose();
    this.fillMesh.material.dispose();
    this.outlineLine.geometry.dispose();
    this.outlineLine.material.dispose();
    this.seamLine.geometry.dispose();
    this.seamLine.material.dispose();
    if (this.grainLine) { this.grainLine.geometry.dispose(); this.grainLine.material.dispose(); }
    this.sprite.material.map.dispose();
    this.sprite.material.dispose();
  }
}

// ---------------------------------------------------------------------
// 5. 의상 정의 — 패널 구성 데이터
// ---------------------------------------------------------------------

const COLORS = {
  tshirt: 0xb5654a,
  tshirtBack: 0xa85940,
  sleeve: 0xae5d44,
  dress: 0x3c6e64,
  dressBack: 0x335d54,
  pants: 0x33425a,
  pantsBack: 0x2c3850,
};

function buildTshirtPanels() {
  const length = 0.46;
  const bodice = {
    neckDepth: 0.075, neckWidth: 0.075, shoulderW: 0.165,
    underarmDrop: 0.20, chestW: 0.205, hemW: 0.225, length,
  };
  const bodiceBack = { ...bodice, neckDepth: 0.028 };

  const front = new PatternPanel(
    buildBodiceShape(bodice),
    (px, py) => wrapTorso(px, py, 'front'),
    { x: -0.42, z: 0.46 },
    '앞판 FRONT',
    COLORS.tshirt,
    { x: 0, y0: -0.045, y1: -length + 0.04 }
  );
  const back = new PatternPanel(
    buildBodiceShape(bodiceBack),
    (px, py) => wrapTorso(px, py, 'back'),
    { x: 0.42, z: 0.46 },
    '뒤판 BACK',
    COLORS.tshirtBack,
    { x: 0, y0: -0.045, y1: -length + 0.04 }
  );
  const sleeveDef = { capWidth: 0.165, capHeight: 0.075, underarmY: 0.06, hemWidth: 0.125, length: 0.30 };
  const sleeveR = new PatternPanel(
    buildSleeveShape(sleeveDef),
    (px, py) => wrapSleeve(px, py, +1),
    { x: -0.30, z: -0.30 },
    '소매 SLEEVE · R',
    COLORS.sleeve,
    { x: 0, y0: 0.04, y1: -0.26 }
  );
  const sleeveL = new PatternPanel(
    buildSleeveShape(sleeveDef),
    (px, py) => wrapSleeve(px, py, -1),
    { x: 0.30, z: -0.30 },
    '소매 SLEEVE · L',
    COLORS.sleeve,
    { x: 0, y0: 0.04, y1: -0.26 }
  );
  return [front, back, sleeveR, sleeveL];
}

function buildDressPanels() {
  const length = 0.92;
  const bodice = {
    neckDepth: 0.09, neckWidth: 0.075, shoulderW: 0.16,
    underarmDrop: 0.20, chestW: 0.20, hemW: 0.40, length,
  };
  const bodiceBack = { ...bodice, neckDepth: 0.05, hemW: 0.39 };

  const front = new PatternPanel(
    buildBodiceShape(bodice),
    (px, py) => wrapTorso(px, py, 'front'),
    { x: -0.56, z: 0.50 },
    '앞판 FRONT',
    COLORS.dress,
    { x: 0, y0: -0.05, y1: -length + 0.06 }
  );
  const back = new PatternPanel(
    buildBodiceShape(bodiceBack),
    (px, py) => wrapTorso(px, py, 'back'),
    { x: 0.56, z: 0.50 },
    '뒤판 BACK',
    COLORS.dressBack,
    { x: 0, y0: -0.05, y1: -length + 0.06 }
  );
  return [front, back];
}

function buildPantsPanels() {
  const legDef = (riseStyle) => ({
    waistW: 0.155, hipW: 0.175, crotchDrop: riseStyle === 'back' ? 0.30 : 0.24,
    kneeW: 0.105, hemW: 0.092, length: 0.97, riseStyle,
  });

  const mk = (sideSign, frontBack, slot, label, color) => new PatternPanel(
    buildLegShape(legDef(frontBack)),
    (px, py) => wrapLeg(px, py, sideSign, frontBack),
    slot, label, color,
    { x: 0, y0: -0.08, y1: -0.85 }
  );

  const frontR = mk(+1, 'front', { x: -0.34, z: 0.55 }, '앞판 R FRONT', COLORS.pants);
  const backR = mk(+1, 'back', { x: -0.34, z: -0.55 }, '뒤판 R BACK', COLORS.pantsBack);
  const frontL = mk(-1, 'front', { x: 0.34, z: 0.55 }, '앞판 L FRONT', COLORS.pants);
  const backL = mk(-1, 'back', { x: 0.34, z: -0.55 }, '뒤판 L BACK', COLORS.pantsBack);
  return [frontR, backR, frontL, backL];
}

const GARMENTS = {
  tshirt: {
    name: '티셔츠', build: buildTshirtPanels,
    mannequin: { arms: true, legs: false },
    fabric: '1.4m', panelColors: [COLORS.tshirt, COLORS.tshirtBack, COLORS.sleeve],
    panelNames: ['앞판', '뒤판', '소매 ×2'],
  },
  dress: {
    name: '원피스', build: buildDressPanels,
    mannequin: { arms: false, legs: false },
    fabric: '2.1m', panelColors: [COLORS.dress, COLORS.dressBack],
    panelNames: ['앞판', '뒤판'],
  },
  pants: {
    name: '바지', build: buildPantsPanels,
    mannequin: { arms: false, legs: true },
    fabric: '1.8m', panelColors: [COLORS.pants, COLORS.pantsBack],
    panelNames: ['앞판 ×2', '뒤판 ×2'],
  },
};

// ---------------------------------------------------------------------
// 6. 마네킹(드레스폼) 빌더 — 토르소는 토르소 반지름 프로파일을 따르는 Lathe로
//    제작해 의상이 항상 정확히 밀착되어 보이도록 함
// ---------------------------------------------------------------------

function buildMannequin() {
  const group = new THREE.Group();
  const matBody = new THREE.MeshStandardMaterial({ color: 0xe9dcc0, roughness: 0.92, metalness: 0.0 });
  const matStand = new THREE.MeshStandardMaterial({ color: 0x6b5a42, roughness: 0.6, metalness: 0.25 });

  // 토르소 (Lathe) — hip 아래로 살짝 더 내려서 자연스럽게 마감
  const lathePts = [];
  const yTop = BODY.shoulder + 0.012;
  const yBottom = BODY.hip - 0.10;
  const steps = 28;
  for (let i = 0; i <= steps; i++) {
    const y = lerp(yTop, yBottom, i / steps);
    const r = torsoRadiusAt(Math.max(y, BODY.hip)) * (y < BODY.hip ? lerp(1, 0.92, (BODY.hip - y) / (BODY.hip - yBottom)) : 1);
    lathePts.push(new THREE.Vector2(Math.max(r, 0.01), y));
  }
  const torsoGeo = new THREE.LatheGeometry(lathePts, 40);
  const torso = new THREE.Mesh(torsoGeo, matBody);
  torso.castShadow = true; torso.receiveShadow = true;
  group.add(torso);

  // 목 + 머리 (얼굴 없는 단순 토르소 인형 머리)
  const neckGeo = new THREE.CylinderGeometry(0.042, 0.05, BODY.neckBase - BODY.shoulder + 0.02, 16);
  const neck = new THREE.Mesh(neckGeo, matBody);
  neck.position.y = BODY.shoulder + (BODY.neckBase - BODY.shoulder) / 2;
  neck.castShadow = true;
  group.add(neck);

  const headGeo = new THREE.SphereGeometry(0.072, 24, 18);
  headGeo.scale(0.92, 1.12, 0.97);
  const head = new THREE.Mesh(headGeo, matBody);
  head.position.y = BODY.neckBase + 0.058;
  head.castShadow = true;
  group.add(head);

  // 스탠드(지지대)
  const poleGeo = new THREE.CylinderGeometry(0.014, 0.014, yBottom - 0.02, 12);
  const pole = new THREE.Mesh(poleGeo, matStand);
  pole.position.y = (yBottom - 0.02) / 2;
  group.add(pole);
  const baseGeo = new THREE.CylinderGeometry(0.16, 0.19, 0.025, 28);
  const base = new THREE.Mesh(baseGeo, matStand);
  base.position.y = 0.0125;
  base.castShadow = true; base.receiveShadow = true;
  group.add(base);

  // 팔 (선택적으로 표시) — 어깨 소켓에서 손목까지 테이퍼 실린더
  function buildLimb(socket, axis, radiusFn, totalLen, segs = 14) {
    const pts = [];
    for (let i = 0; i <= segs; i++) {
      const along = (i / segs) * totalLen;
      pts.push(new THREE.Vector2(Math.max(radiusFn(along), 0.012), -along));
    }
    const geo = new THREE.LatheGeometry(pts, 16);
    const mesh = new THREE.Mesh(geo, matBody);
    // lathe 기본 형태는 +y에서 -y로 내려가는 형태이므로, axis 방향(소켓->손목/발목)에 맞춰 회전
    const baseDir = new THREE.Vector3(0, -1, 0);
    mesh.quaternion.copy(new THREE.Quaternion().setFromUnitVectors(baseDir, axis));
    mesh.position.copy(socket);
    mesh.castShadow = true;
    return mesh;
  }

  const armR = buildLimb(armSocket(+1), armAxis(+1), armRadiusAt, 0.40);
  const armL = buildLimb(armSocket(-1), armAxis(-1), armRadiusAt, 0.40);
  armR.name = 'limb-arm'; armL.name = 'limb-arm';
  group.add(armR, armL);

  const legR = buildLimb(legSocket(+1), legAxis(+1), legRadiusAt, BODY.hip - BODY.ankle + 0.03);
  const legL = buildLimb(legSocket(-1), legAxis(-1), legRadiusAt, BODY.hip - BODY.ankle + 0.03);
  legR.name = 'limb-leg'; legL.name = 'limb-leg';
  group.add(legR, legL);

  group.traverse(o => { if (o.isMesh) o.material = o.material.clone(); });

  return {
    group, torso, head, neck, base, pole,
    arms: [armR, armL], legs: [legR, legL],
    setArmsVisible(v) { armR.visible = v; armL.visible = v; },
    setLegsVisible(v) { legR.visible = v; legL.visible = v; },
    setOpacity(op) {
      group.traverse(o => {
        if (o.isMesh) {
          o.material.transparent = op < 1;
          o.material.opacity = op;
          o.material.depthWrite = op > 0.06;
        }
      });
    },
  };
}

// ---------------------------------------------------------------------
// 7. 씬 / 렌더러 / 카메라 / 조명 셋업
// ---------------------------------------------------------------------

const viewportEl = document.getElementById('viewport');

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
viewportEl.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x1b1611, 0.32);

const camera = new THREE.PerspectiveCamera(42, 1, 0.05, 30);
const DEFAULT_CAM_POS = new THREE.Vector3(1.05, 1.35, 1.55);
const DEFAULT_TARGET = new THREE.Vector3(0, 0.95, 0);
camera.position.copy(DEFAULT_CAM_POS);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(DEFAULT_TARGET);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 0.6;
controls.maxDistance = 4.5;
controls.maxPolarAngle = Math.PI * 0.92;
controls.update();

// 조명: 3점 조명 + 부드러운 림라이트로 원단 질감 강조
const ambient = new THREE.AmbientLight(0xfff0dc, 0.55);
scene.add(ambient);

const keyLight = new THREE.DirectionalLight(0xffe9c7, 2.0);
keyLight.position.set(1.6, 2.6, 1.8);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(1024, 1024);
keyLight.shadow.bias = -0.0015;
keyLight.shadow.camera.near = 0.1;
keyLight.shadow.camera.far = 8;
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0xb9d4ff, 0.55);
fillLight.position.set(-1.8, 1.2, -0.8);
scene.add(fillLight);

const rimLight = new THREE.PointLight(0xffb877, 0.9, 6, 2);
rimLight.position.set(-0.6, 1.7, -1.6);
scene.add(rimLight);

// 바닥(스튜디오 테이블/마룻바닥)
const floorGeo = new THREE.CircleGeometry(2.6, 64);
const floorMat = new THREE.MeshStandardMaterial({ color: 0x2a2117, roughness: 0.95 });
const floor = new THREE.Mesh(floorGeo, floorMat);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

// 패턴이 펼쳐질 "커팅 테이블" 표시 (크라프트지 색 원형 매트, t에 따라 페이드 인)
const tableGeo = new THREE.CircleGeometry(1.55, 64);
const tableMat = new THREE.MeshStandardMaterial({ color: 0xd9c8a3, roughness: 0.96, transparent: true, opacity: 0 });
const table = new THREE.Mesh(tableGeo, tableMat);
table.rotation.x = -Math.PI / 2;
table.position.y = 0.008;
table.receiveShadow = true;
scene.add(table);

function resize() {
  const w = viewportEl.clientWidth, h = viewportEl.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------------
// 8. 상태 관리 — 의상 전환 / 슬라이더 / 토글
// ---------------------------------------------------------------------

const mannequin = buildMannequin();
scene.add(mannequin.group);

let currentPanels = [];
let currentGarmentKey = null;
let targetT = 0;
let displayT = 0;

const els = {
  slider: document.getElementById('patternSlider'),
  tapeFill: document.getElementById('tapeFill'),
  lblWorn: document.getElementById('lblWorn'),
  lblFlat: document.getElementById('lblFlat'),
  toggleSeam: document.getElementById('toggleSeam'),
  toggleGrain: document.getElementById('toggleGrain'),
  toggleLabel: document.getElementById('toggleLabel'),
  toggleMannequin: document.getElementById('toggleMannequin'),
  statPanels: document.getElementById('statPanels'),
  statFabric: document.getElementById('statFabric'),
  panelList: document.getElementById('panelList'),
  garmentTabs: document.getElementById('garmentTabs'),
  btnTopView: document.getElementById('btnTopView'),
  btnResetView: document.getElementById('btnResetView'),
};

function clearGarment() {
  currentPanels.forEach(p => { scene.remove(p.group); p.dispose(); });
  currentPanels = [];
}

function loadGarment(key) {
  clearGarment();
  currentGarmentKey = key;
  const def = GARMENTS[key];
  currentPanels = def.build();
  currentPanels.forEach(p => scene.add(p.group));

  mannequin.setArmsVisible(def.mannequin.arms);
  mannequin.setLegsVisible(def.mannequin.legs);

  els.statPanels.textContent = currentPanels.length;
  els.statFabric.textContent = def.fabric;
  els.panelList.innerHTML = '';
  def.panelNames.forEach((name, i) => {
    const row = document.createElement('div');
    row.className = 'panel-chip';
    const dot = document.createElement('span');
    dot.className = 'swatch-dot';
    dot.style.background = '#' + def.panelColors[i % def.panelColors.length].toString(16).padStart(6, '0');
    row.appendChild(dot);
    const txt = document.createElement('span');
    txt.textContent = name;
    row.appendChild(txt);
    els.panelList.appendChild(row);
  });

  applyToggles();
  applyT(displayT, true);
}

function applyToggles() {
  const seam = els.toggleSeam.checked;
  const grain = els.toggleGrain.checked;
  const label = els.toggleLabel.checked;
  currentPanels.forEach(p => p.setVisible({ seam, grain, label }));
}

function applyT(t, instant) {
  currentPanels.forEach(p => p.setT(t));
  const showMannequin = els.toggleMannequin.checked;
  const opacity = showMannequin ? lerp(1, 0.08, easeInOutCubic(clamp(t * 1.15, 0, 1))) : lerp(1, 0, t) * (showMannequin ? 1 : 1);
  mannequin.setOpacity(showMannequin ? opacity : lerp(1, 0, t));
  table.material.opacity = easeInOutCubic(clamp(t * 1.3, 0, 1)) * 0.92;

  els.tapeFill.style.width = (t * 100).toFixed(1) + '%';
  if (t < 0.5) { els.lblWorn.classList.add('active-label'); els.lblFlat.classList.remove('active-label'); }
  else { els.lblFlat.classList.add('active-label'); els.lblWorn.classList.remove('active-label'); }
}

// 슬라이더 입력 (목표값만 갱신, 실제 적용은 애니메이션 루프에서 부드럽게)
els.slider.addEventListener('input', () => {
  targetT = clamp(parseFloat(els.slider.value) / 100, 0, 1);
});

[els.toggleSeam, els.toggleGrain, els.toggleLabel].forEach(el => el.addEventListener('change', applyToggles));
els.toggleMannequin.addEventListener('change', () => applyT(displayT));

// 의상 탭 전환
els.garmentTabs.querySelectorAll('.garment-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    els.garmentTabs.querySelectorAll('.garment-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    loadGarment(tab.dataset.garment);
  });
});

// 탑뷰 / 리셋 버튼
els.btnTopView.addEventListener('click', () => {
  animateCamera(new THREE.Vector3(0.001, 2.6, 0.001), new THREE.Vector3(0, 0.05, 0));
});
els.btnResetView.addEventListener('click', () => {
  animateCamera(DEFAULT_CAM_POS, DEFAULT_TARGET);
});

let camAnim = null;
function animateCamera(pos, target) {
  camAnim = {
    fromPos: camera.position.clone(), toPos: pos.clone(),
    fromTarget: controls.target.clone(), toTarget: target.clone(),
    t: 0,
  };
}

// ---------------------------------------------------------------------
// 9. 메인 루프
// ---------------------------------------------------------------------
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);

  if (Math.abs(targetT - displayT) > 0.0008) {
    displayT += (targetT - displayT) * Math.min(1, dt * 7.5);
    applyT(displayT);
  } else if (displayT !== targetT) {
    displayT = targetT;
    applyT(displayT);
  }

  if (camAnim) {
    camAnim.t += dt * 1.6;
    const e = easeInOutCubic(clamp(camAnim.t, 0, 1));
    camera.position.lerpVectors(camAnim.fromPos, camAnim.toPos, e);
    controls.target.lerpVectors(camAnim.fromTarget, camAnim.toTarget, e);
    if (camAnim.t >= 1) camAnim = null;
  }

  controls.update();
  renderer.render(scene, camera);
}

loadGarment('tshirt');
animate();
