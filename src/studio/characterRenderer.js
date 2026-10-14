/**
 * Minimal original 2D cartoon character renderer (additive module; nothing
 * imports it yet). Draws one character from a character bible's `visual`
 * parameters and a storyboard frame state using only @napi-rs/canvas vector
 * primitives: no fonts, no text, no external images, no network.
 *
 * Deterministic: same (character, state, size) => same pixels.
 * This is a first-pass illustration, not production or cinematic artwork.
 */
import { createCanvas } from '@napi-rs/canvas';

export const DEFAULT_WIDTH = 1280;
export const DEFAULT_HEIGHT = 720;

const INK = '#1a1114';
const LINE = 5;
const SHOT_ZOOM = { wide: 0.78, medium: 1, close: 1.7 };

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const c = (v) => clamp(Math.round(v * f), 0, 255);
  return `rgb(${c(n >> 16)},${c((n >> 8) & 255)},${c(n & 255)})`;
}

function fillStroke(ctx, fill, lw = LINE) {
  ctx.fillStyle = fill; ctx.fill();
  ctx.lineWidth = lw; ctx.strokeStyle = INK; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.stroke();
}
function ellipse(ctx, x, y, rx, ry, fill, lw = LINE) {
  ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); fillStroke(ctx, fill, lw);
}

function drawBackground(ctx, v, W, H) {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, shade(v.curtain, 0.7)); g.addColorStop(0.55, v.curtain); g.addColorStop(1, shade(v.curtain, 0.55));
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  // curtain folds
  const folds = 14;
  for (let i = 0; i < folds; i++) {
    const x0 = (i / folds) * W; const w = W / folds;
    const fg = ctx.createLinearGradient(x0, 0, x0 + w, 0);
    fg.addColorStop(0, 'rgba(0,0,0,0.28)'); fg.addColorStop(0.5, 'rgba(255,255,255,0.07)'); fg.addColorStop(1, 'rgba(0,0,0,0.28)');
    ctx.fillStyle = fg; ctx.fillRect(x0, 0, w, H);
  }
  // spotlight
  const s = ctx.createRadialGradient(W / 2, H * 0.42, 40, W / 2, H * 0.42, H * 0.85);
  s.addColorStop(0, 'rgba(255,240,200,0.38)'); s.addColorStop(1, 'rgba(255,240,200,0)');
  ctx.fillStyle = s; ctx.fillRect(0, 0, W, H);
  // stage floor
  const fy = H * 0.9;
  const fl = ctx.createLinearGradient(0, fy, 0, H);
  fl.addColorStop(0, '#4a3322'); fl.addColorStop(1, '#2a1c12');
  ctx.fillStyle = fl; ctx.fillRect(0, fy, W, H - fy);
  ctx.fillStyle = INK; ctx.fillRect(0, fy - 2, W, 4);
}

/** Arm from shoulder to hand; `p` 0 = relaxed at side, 1 = raised in a gesture. */
function drawArm(ctx, v, sx, sy, side, p) {
  const down = { x: sx + side * 40, y: sy + 230 };
  const up = { x: sx + side * 150, y: sy - 40 };
  const hx = down.x + (up.x - down.x) * p; const hy = down.y + (up.y - down.y) * p;
  const ex = sx + side * (70 + 40 * p); const ey = sy + 120 - 90 * p;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const [w, col] of [[74, INK], [64, v.shirt]]) {
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.quadraticCurveTo(ex, ey, hx, hy);
    ctx.lineWidth = w; ctx.strokeStyle = col; ctx.stroke();
  }
  ellipse(ctx, hx, hy + 10, 34, 38, v.skin);
}

function drawTorso(ctx, v, cx, neckY) {
  const half = v.build * 1.25; const top = neckY + 10; const bottom = neckY + 420;
  ctx.beginPath();
  ctx.moveTo(cx - half * 0.42, top);
  ctx.bezierCurveTo(cx - half * 0.9, top + 10, cx - half, top + 40, cx - half * 1.02, top + 110);
  ctx.lineTo(cx - half * 0.9, bottom); ctx.lineTo(cx + half * 0.9, bottom); ctx.lineTo(cx + half * 1.02, top + 110);
  ctx.bezierCurveTo(cx + half, top + 40, cx + half * 0.9, top + 10, cx + half * 0.42, top);
  ctx.closePath(); fillStroke(ctx, v.shirt);
  // collar V + accent trim
  ctx.beginPath(); ctx.moveTo(cx - 58, top - 4); ctx.lineTo(cx, top + 70); ctx.lineTo(cx + 58, top - 4);
  ctx.lineWidth = 12; ctx.strokeStyle = v.accent; ctx.stroke();
  ctx.lineWidth = LINE; ctx.strokeStyle = INK; ctx.stroke();
  // chest stripe + buttons
  ctx.fillStyle = v.accent; ctx.globalAlpha = 0.9;
  ctx.fillRect(cx - half * 0.95, top + 190, half * 1.9, 22); ctx.globalAlpha = 1;
  for (const y of [top + 110, top + 270]) ellipse(ctx, cx, y, 7, 7, shade(v.shirt, 0.6), 3);
  // belt / trousers hint at bottom
  ctx.fillStyle = v.trousers; ctx.fillRect(cx - half * 0.9, bottom - 28, half * 1.8, 40);
  ctx.strokeStyle = INK; ctx.lineWidth = LINE; ctx.strokeRect(cx - half * 0.9, bottom - 28, half * 1.8, 40);
}

function hairBack(ctx, v, cx, cy, rx, ry) {
  if (v.archetype === 'afro') ellipse(ctx, cx, cy - ry * 0.22, rx * 1.42, ry * 1.22, v.hair);
  else if (v.archetype === 'curly') {
    for (let i = 0; i < 11; i++) {
      const a = Math.PI * (1.02 + (i / 10) * 0.96);
      ellipse(ctx, cx + Math.cos(a) * rx * 1.02, cy - ry * 0.12 + Math.sin(a) * ry * 1.0, rx * 0.28, rx * 0.28, v.hair, 4);
    }
  }
}

function hairFront(ctx, v, cx, cy, rx, ry) {
  ctx.beginPath();
  if (v.archetype === 'afro') {
    ctx.moveTo(cx - rx * 0.98, cy - ry * 0.3);
    ctx.bezierCurveTo(cx - rx * 0.7, cy - ry * 0.78, cx + rx * 0.7, cy - ry * 0.78, cx + rx * 0.98, cy - ry * 0.3);
    ctx.bezierCurveTo(cx + rx * 0.5, cy - ry * 0.62, cx - rx * 0.5, cy - ry * 0.62, cx - rx * 0.98, cy - ry * 0.3);
  } else if (v.archetype === 'short') {
    ctx.moveTo(cx - rx * 1.0, cy - ry * 0.18);
    ctx.bezierCurveTo(cx - rx * 1.12, cy - ry * 1.12, cx + rx * 1.12, cy - ry * 1.12, cx + rx * 1.0, cy - ry * 0.18);
    ctx.bezierCurveTo(cx + rx * 0.6, cy - ry * 0.68, cx - rx * 0.2, cy - ry * 0.66, cx - rx * 1.0, cy - ry * 0.2);
  } else {
    ctx.moveTo(cx - rx * 0.98, cy - ry * 0.22);
    ctx.bezierCurveTo(cx - rx * 1.05, cy - ry * 1.05, cx + rx * 1.05, cy - ry * 1.05, cx + rx * 0.98, cy - ry * 0.22);
    ctx.bezierCurveTo(cx + rx * 0.5, cy - ry * 0.68, cx + rx * 0.1, cy - ry * 0.55, cx - rx * 0.2, cy - ry * 0.68);
    ctx.bezierCurveTo(cx - rx * 0.5, cy - ry * 0.55, cx - rx * 0.8, cy - ry * 0.6, cx - rx * 0.98, cy - ry * 0.22);
  }
  ctx.closePath(); fillStroke(ctx, v.hair);
}

function drawEye(ctx, v, x, y, gaze) {
  const rx = 30; const ry = 24;
  ellipse(ctx, x, y, rx, ry, '#fbf8f2', 4);
  const px = x + clamp(gaze, -1, 1) * 11;
  ellipse(ctx, px, y + 1, 12.5, 14, '#2a1a12', 2);
  ellipse(ctx, px - 4, y - 5, 4, 4, '#ffffff', 0.01);
}

function drawBrow(ctx, v, x, y, side, kind) {
  // side: -1 = viewer-left brow, +1 = viewer-right brow
  const lift = kind === 'raised' ? -16 : 0;
  const tilt = kind === 'smirk' ? (side > 0 ? -12 : 6) : 0;
  ctx.beginPath();
  ctx.moveTo(x - 32, y + lift - tilt * 0.5);
  ctx.quadraticCurveTo(x, y + lift - 14 + tilt, x + 32, y + lift + tilt * 0.5 + (kind === 'raised' ? 0 : 2));
  ctx.lineWidth = 11; ctx.lineCap = 'round'; ctx.strokeStyle = v.hair; ctx.stroke();
}

function drawMouth(ctx, v, cx, y, kind) {
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (kind === 'talk') {
    ctx.beginPath(); ctx.moveTo(cx - 36, y - 4);
    ctx.quadraticCurveTo(cx, y - 10, cx + 36, y - 4);
    ctx.quadraticCurveTo(cx + 28, y + 42, cx, y + 44);
    ctx.quadraticCurveTo(cx - 28, y + 42, cx - 36, y - 4); ctx.closePath();
    ctx.fillStyle = '#4a1418'; ctx.fill(); ctx.lineWidth = 5; ctx.strokeStyle = INK; ctx.stroke();
    ctx.save(); ctx.clip(); ellipse(ctx, cx, y + 40, 22, 14, '#d9626b', 0.01); ctx.restore();
    ctx.fillStyle = '#fbf8f2'; ctx.fillRect(cx - 26, y - 6, 52, 9);
  } else if (kind === 'smirk') {
    ctx.beginPath(); ctx.moveTo(cx - 34, y + 8);
    ctx.quadraticCurveTo(cx + 4, y + 22, cx + 40, y - 8);
    ctx.lineWidth = 6; ctx.strokeStyle = INK; ctx.stroke();
  } else {
    ctx.beginPath(); ctx.moveTo(cx - 32, y + 4);
    ctx.quadraticCurveTo(cx, y + 14, cx + 32, y + 4);
    ctx.lineWidth = 6; ctx.strokeStyle = INK; ctx.stroke();
  }
}

function drawGlasses(ctx, cx, ey, eo) {
  ctx.lineWidth = 6; ctx.strokeStyle = INK;
  for (const sx of [-1, 1]) {
    ctx.beginPath(); ctx.roundRect(cx + sx * eo - 46, ey - 36, 92, 72, 22);
    ctx.fillStyle = 'rgba(200,230,255,0.18)'; ctx.fill(); ctx.stroke();
  }
  ctx.beginPath(); ctx.moveTo(cx - eo + 46, ey - 8); ctx.quadraticCurveTo(cx, ey - 22, cx + eo - 46, ey - 8); ctx.stroke();
  for (const sx of [-1, 1]) { ctx.beginPath(); ctx.moveTo(cx + sx * (eo + 46), ey - 6); ctx.lineTo(cx + sx * (eo + 62), ey - 2); ctx.stroke(); }
}

function drawBeard(ctx, v, cx, cy, rx, ry) {
  ctx.beginPath();
  ctx.moveTo(cx - rx * 0.97, cy + ry * 0.1);
  ctx.bezierCurveTo(cx - rx * 0.95, cy + ry * 1.05, cx + rx * 0.95, cy + ry * 1.05, cx + rx * 0.97, cy + ry * 0.1);
  ctx.bezierCurveTo(cx + rx * 0.7, cy + ry * 0.38, cx + rx * 0.4, cy + ry * 0.36, cx + rx * 0.3, cy + ry * 0.4);
  ctx.quadraticCurveTo(cx, cy + ry * 0.34, cx - rx * 0.3, cy + ry * 0.4);
  ctx.bezierCurveTo(cx - rx * 0.4, cy + ry * 0.36, cx - rx * 0.7, cy + ry * 0.38, cx - rx * 0.97, cy + ry * 0.1);
  ctx.closePath(); fillStroke(ctx, v.hair);
}

/**
 * @param {object} character  bible from generateCharacterBible (uses `.visual`)
 * @param {object} [state]    storyboard step: {shot, zoomQ, p, brow, mouth, gaze}
 * @param {{width?:number,height?:number}} [opts]
 * @returns {Buffer} PNG
 */
export function renderCharacterFrame(character, state = {}, { width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT } = {}) {
  const v = character?.visual;
  if (!v || typeof v.skin !== 'string') throw new Error('character.visual is required (use a character bible)');
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 64 || height < 64) throw new Error('width/height must be integers >= 64');
  const { shot = 'medium', zoomQ = 0, p = 0, brow = 'neutral', mouth = 'closed', gaze = 0 } = state;
  // Validate numeric inputs before any canvas work: a non-numeric value becomes NaN in the
  // geometry below and makes the native Skia path code panic instead of throwing.
  for (const [name, value] of [['p', p], ['zoomQ', zoomQ], ['gaze', gaze]]) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TypeError(`renderCharacterFrame: state.${name} must be a finite number, got ${typeof value} ${typeof value === "string" ? JSON.stringify(value) : String(value)}`);
    }
  }

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.scale(width / DEFAULT_WIDTH, height / DEFAULT_HEIGHT); // design space is 1280x720
  drawBackground(ctx, v, DEFAULT_WIDTH, DEFAULT_HEIGHT);

  // camera: pivot on the head so close shots frame the face
  const zoom = (SHOT_ZOOM[shot] ?? 1) * (1 + 0.02 * clamp(zoomQ, 0, 5));
  const cx = 640; const cy = 290; const rx = v.headRx; const ry = v.headRy;
  const pivotY = shot === 'wide' ? 400 : cy + ry * 0.1;
  ctx.translate(640, shot === 'wide' ? 400 : 360); ctx.scale(zoom, zoom); ctx.translate(-640, -pivotY);

  const neckY = cy + ry + 14;
  const sh = { y: neckY + 60, dx: v.build * 1.2 };
  drawArm(ctx, v, cx - sh.dx, sh.y, -1, 0);
  drawTorso(ctx, v, cx, neckY);
  drawArm(ctx, v, cx + sh.dx, sh.y, 1, clamp(p, 0, 1));

  // neck
  ctx.beginPath(); ctx.roundRect(cx - 50, neckY - 60, 100, 100, 18); fillStroke(ctx, shade(v.skin, 0.92));

  hairBack(ctx, v, cx, cy, rx, ry);
  // ears
  for (const s of [-1, 1]) {
    ellipse(ctx, cx + s * (rx - 2), cy + 14, 26, 38, v.skin);
    ellipse(ctx, cx + s * (rx - 2), cy + 16, 11, 20, shade(v.skin, 0.8), 3);
  }
  // head
  ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); fillStroke(ctx, v.skin);
  // cheeks
  for (const s of [-1, 1]) { ctx.globalAlpha = 0.25; ellipse(ctx, cx + s * rx * 0.55, cy + ry * 0.3, 30, 18, '#d2574a', 0.01); ctx.globalAlpha = 1; }

  if (v.beard) drawBeard(ctx, v, cx, cy, rx, ry);

  const eo = rx * 0.38; const ey = cy - ry * 0.02;
  drawEye(ctx, v, cx - eo, ey, gaze); drawEye(ctx, v, cx + eo, ey, gaze);
  // nose
  ctx.beginPath(); ctx.moveTo(cx - 6, ey + 6); ctx.quadraticCurveTo(cx - 26, cy + ry * 0.3, cx - 14, cy + ry * 0.33);
  ctx.quadraticCurveTo(cx, cy + ry * 0.4, cx + 16, cy + ry * 0.33);
  ctx.lineWidth = 5; ctx.strokeStyle = shade(v.skin, 0.55); ctx.stroke();
  drawMouth(ctx, v, cx, cy + ry * 0.55, mouth);

  hairFront(ctx, v, cx, cy, rx, ry);
  drawBrow(ctx, v, cx - eo, ey - 52, -1, brow); drawBrow(ctx, v, cx + eo, ey - 52, 1, brow);
  if (v.glasses) drawGlasses(ctx, cx, ey, eo);
  ctx.restore();

  return canvas.toBuffer('image/png');
}

export default renderCharacterFrame;
