import { camera } from './camera.js';
import { strokePath, shapeBounds } from './shapes.js';
import { drawSlideFrame, drawSlideShadow, SLIDE_W, SLIDE_H } from './slides.js';

// Decoded <img> elements keyed by shape id. Canvas cannot draw a data URL
// directly, and re-decoding every frame would tank the framerate.
const imageCache = new Map();

function getImage(shape, onLoad) {
  const cached = imageCache.get(shape.id);
  if (cached) return cached.complete && cached.naturalWidth ? cached : null;
  const img = new Image();
  img.onload = onLoad;
  img.src = shape.src;
  imageCache.set(shape.id, img);
  return null;
}

export function dropImage(id) { imageCache.delete(id); }

/** Paint the grid, clipped to the slide page so off-slide space stays plain. */
function drawGrid(ctx, w, h, color) {
  // Step up the grid spacing as we zoom out so lines never turn into mush.
  let step = 40;
  while (step * camera.scale < 12) step *= 5;
  while (step * camera.scale > 160) step /= 5;

  const startX = Math.floor(-camera.x / camera.scale / step) * step;
  const startY = Math.floor(-camera.y / camera.scale / step) * step;
  const endX = startX + w / camera.scale + step;
  const endY = startY + h / camera.scale + step;

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, SLIDE_W, SLIDE_H);
  ctx.clip();

  ctx.strokeStyle = color;
  ctx.lineWidth = 1 / camera.scale;
  ctx.beginPath();
  for (let x = startX; x <= endX; x += step) { ctx.moveTo(x, startY); ctx.lineTo(x, endY); }
  for (let y = startY; y <= endY; y += step) { ctx.moveTo(startX, y); ctx.lineTo(endX, y); }
  ctx.stroke();
  ctx.restore();
}

function applyStroke(ctx, shape) {
  ctx.strokeStyle = shape.color || '#000';
  ctx.lineWidth = shape.size || 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalAlpha = shape.opacity ?? 1;
}

export function drawShape(ctx, shape, onImageLoad) {
  ctx.save();
  applyStroke(ctx, shape);

  switch (shape.type) {
    case 'path': {
      // Highlighter reads as ink laid over the page, not paint on top of it.
      if (shape.highlighter) {
        ctx.globalCompositeOperation = 'multiply';
        ctx.lineCap = 'butt';
      }
      ctx.beginPath();
      strokePath(ctx, shape.points);
      ctx.stroke();
      break;
    }
    case 'line':
    case 'arrow': {
      ctx.beginPath();
      ctx.moveTo(shape.x1, shape.y1);
      ctx.lineTo(shape.x2, shape.y2);
      ctx.stroke();
      if (shape.type === 'arrow') {
        const angle = Math.atan2(shape.y2 - shape.y1, shape.x2 - shape.x1);
        // Head scales with stroke weight so thick arrows don't look pin-headed.
        const head = Math.max(10, (shape.size || 2) * 3.5);
        ctx.beginPath();
        ctx.moveTo(shape.x2, shape.y2);
        ctx.lineTo(shape.x2 - head * Math.cos(angle - Math.PI / 7), shape.y2 - head * Math.sin(angle - Math.PI / 7));
        ctx.moveTo(shape.x2, shape.y2);
        ctx.lineTo(shape.x2 - head * Math.cos(angle + Math.PI / 7), shape.y2 - head * Math.sin(angle + Math.PI / 7));
        ctx.stroke();
      }
      break;
    }
    case 'rect': {
      ctx.beginPath();
      const r = Math.min(shape.radius ?? 4, Math.abs(shape.w) / 2, Math.abs(shape.h) / 2);
      ctx.roundRect(shape.x, shape.y, shape.w, shape.h, r);
      if (shape.fill) { ctx.fillStyle = shape.fill; ctx.fill(); }
      ctx.stroke();
      break;
    }
    case 'ellipse': {
      ctx.beginPath();
      ctx.ellipse(shape.x + shape.w / 2, shape.y + shape.h / 2, Math.abs(shape.w) / 2, Math.abs(shape.h) / 2, 0, 0, Math.PI * 2);
      if (shape.fill) { ctx.fillStyle = shape.fill; ctx.fill(); }
      ctx.stroke();
      break;
    }
    case 'text': {
      ctx.fillStyle = shape.color || '#000';
      const size = shape.size || 18;
      ctx.font = `${size}px ui-sans-serif, system-ui, sans-serif`;
      ctx.textBaseline = 'top';
      String(shape.text || '').split('\n').forEach((line, i) => {
        ctx.fillText(line, shape.x, shape.y + i * size * 1.3);
      });
      break;
    }
    case 'note': {
      ctx.fillStyle = shape.fill || '#fde68a';
      ctx.beginPath();
      ctx.roundRect(shape.x, shape.y, shape.w, shape.h, 4);
      ctx.fill();
      // A soft edge reads as paper without a heavy border.
      ctx.strokeStyle = 'rgba(0,0,0,.12)';
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.fillStyle = shape.color || '#1f2937';
      const size = shape.size || 16;
      ctx.font = `${size}px ui-sans-serif, system-ui, sans-serif`;
      ctx.textBaseline = 'top';
      wrapText(ctx, String(shape.text || ''), shape.x + 10, shape.y + 10, shape.w - 20, size * 1.35);
      break;
    }
    case 'image': {
      const img = getImage(shape, onImageLoad);
      if (img) {
        ctx.drawImage(img, shape.x, shape.y, shape.w, shape.h);
      } else {
        // Placeholder keeps layout stable while the bitmap decodes.
        ctx.fillStyle = 'rgba(128,128,128,.15)';
        ctx.fillRect(shape.x, shape.y, shape.w, shape.h);
      }
      break;
    }
  }
  ctx.restore();
}

/** Word-wrap for sticky notes, clipped to the note's height. */
function wrapText(ctx, text, x, y, maxW, lineH) {
  let cursorY = y;
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(' ')) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > maxW && line) {
        ctx.fillText(line, x, cursorY);
        cursorY += lineH;
        line = word;
      } else {
        line = test;
      }
    }
    if (line) { ctx.fillText(line, x, cursorY); cursorY += lineH; }
  }
}

/** Full board repaint. Cheap enough at these shape counts to avoid dirty-rect bookkeeping. */
export function renderBoard(canvas, ctx, shapes, opts) {
  const { width: w, height: h } = canvas;
  const dpr = opts.dpr;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w / dpr, h / dpr);

  ctx.save();
  ctx.translate(camera.x, camera.y);
  ctx.scale(camera.scale, camera.scale);

  // The slide page sits under everything, so the exportable area is obvious.
  drawSlideShadow(ctx, camera.scale);
  drawSlideFrame(ctx, camera.scale, opts.theme);

  if (opts.grid) drawGrid(ctx, w / dpr, h / dpr, opts.gridColor);

  // Skip anything entirely off-screen — this is what keeps large boards smooth.
  const viewMinX = -camera.x / camera.scale;
  const viewMinY = -camera.y / camera.scale;
  const viewMaxX = viewMinX + (w / dpr) / camera.scale;
  const viewMaxY = viewMinY + (h / dpr) / camera.scale;

  for (const shape of shapes) {
    const b = shapeBounds(shape);
    if (b && (b.maxX < viewMinX || b.minX > viewMaxX || b.maxY < viewMinY || b.minY > viewMaxY)) continue;
    drawShape(ctx, shape, opts.onImageLoad);
  }
  ctx.restore();
}

/** Overlay pass: other people's cursors, live strokes, selection UI. */
export function renderOverlay(canvas, ctx, state) {
  const dpr = state.dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);

  ctx.save();
  ctx.translate(camera.x, camera.y);
  ctx.scale(camera.scale, camera.scale);

  // Strokes other people are drawing right now (not yet committed).
  for (const shape of state.remoteDrafts.values()) drawShape(ctx, shape, null);
  if (state.draft) drawShape(ctx, state.draft, null);

  // Selection outlines, drawn at constant screen thickness.
  if (state.selection?.length) {
    ctx.strokeStyle = '#4f46e5';
    ctx.lineWidth = 1.5 / camera.scale;
    ctx.setLineDash([5 / camera.scale, 4 / camera.scale]);
    for (const s of state.selection) {
      const b = shapeBounds(s);
      if (!b) continue;
      const pad = 4 / camera.scale;
      ctx.strokeRect(b.minX - pad, b.minY - pad, b.maxX - b.minX + pad * 2, b.maxY - b.minY + pad * 2);
    }
    ctx.setLineDash([]);
  }

  // Marquee box.
  if (state.marquee) {
    const m = state.marquee;
    ctx.fillStyle = 'rgba(79,70,229,.10)';
    ctx.strokeStyle = '#4f46e5';
    ctx.lineWidth = 1 / camera.scale;
    const x = Math.min(m.x1, m.x2), y = Math.min(m.y1, m.y2);
    ctx.fillRect(x, y, Math.abs(m.x2 - m.x1), Math.abs(m.y2 - m.y1));
    ctx.strokeRect(x, y, Math.abs(m.x2 - m.x1), Math.abs(m.y2 - m.y1));
  }
  ctx.restore();

  // Cursors are drawn in screen space so they stay readable at any zoom.
  for (const c of state.cursors.values()) {
    const sx = c.x * camera.scale + camera.x;
    const sy = c.y * camera.scale + camera.y;
    ctx.save();
    ctx.fillStyle = c.color;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx, sy + 16);
    ctx.lineTo(sx + 4.5, sy + 12);
    ctx.lineTo(sx + 11, sy + 11.5);
    ctx.closePath();
    ctx.fill();

    ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
    const label = c.name;
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = c.color;
    ctx.beginPath();
    ctx.roundRect(sx + 12, sy + 14, tw + 12, 18, 9);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillText(label, sx + 18, sy + 26);
    ctx.restore();
  }
}
