/**
 * Shape geometry helpers: bounds, hit-testing and the drawing routines.
 * Every shape stores world coordinates; the renderer applies the camera.
 */

export function shapeBounds(shape) {
  switch (shape.type) {
    case 'path': {
      if (!shape.points?.length) return null;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [x, y] of shape.points) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      const pad = (shape.size || 2) / 2;
      return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
    }
    case 'line':
    case 'arrow':
      return {
        minX: Math.min(shape.x1, shape.x2), minY: Math.min(shape.y1, shape.y2),
        maxX: Math.max(shape.x1, shape.x2), maxY: Math.max(shape.y1, shape.y2),
      };
    case 'rect':
    case 'ellipse':
    case 'image':
    case 'note':
      return { minX: shape.x, minY: shape.y, maxX: shape.x + shape.w, maxY: shape.y + shape.h };
    case 'text': {
      // Text bounds are approximated from the font metrics we know up front;
      // good enough for selection and fit-to-screen.
      const lines = String(shape.text || '').split('\n');
      const lineH = (shape.size || 18) * 1.3;
      const w = Math.max(...lines.map((l) => l.length)) * (shape.size || 18) * 0.55;
      return { minX: shape.x, minY: shape.y, maxX: shape.x + w, maxY: shape.y + lines.length * lineH };
    }
    default:
      return null;
  }
}

export function boundsOfAll(shapes) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let found = false;
  for (const s of shapes) {
    const b = shapeBounds(s);
    if (!b) continue;
    found = true;
    if (b.minX < minX) minX = b.minX;
    if (b.minY < minY) minY = b.minY;
    if (b.maxX > maxX) maxX = b.maxX;
    if (b.maxY > maxY) maxY = b.maxY;
  }
  return found ? { minX, minY, maxX, maxY } : null;
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  // Degenerate segment: fall back to point distance.
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  const nx = x1 + t * dx, ny = y1 + t * dy;
  return Math.hypot(px - nx, py - ny);
}

/** True if a world-space point is on/inside the shape, with `slop` px of tolerance. */
export function hitTest(shape, px, py, slop = 6) {
  const b = shapeBounds(shape);
  if (!b) return false;
  // Cheap rejection first: anything far outside the box cannot hit.
  if (px < b.minX - slop || px > b.maxX + slop || py < b.minY - slop || py > b.maxY + slop) return false;

  switch (shape.type) {
    case 'path': {
      const tol = slop + (shape.size || 2) / 2;
      for (let i = 1; i < shape.points.length; i++) {
        const [x1, y1] = shape.points[i - 1];
        const [x2, y2] = shape.points[i];
        if (distToSegment(px, py, x1, y1, x2, y2) <= tol) return true;
      }
      // A single-point dot still deserves a hit.
      if (shape.points.length === 1) {
        const [x, y] = shape.points[0];
        return Math.hypot(px - x, py - y) <= tol;
      }
      return false;
    }
    case 'line':
    case 'arrow':
      return distToSegment(px, py, shape.x1, shape.y1, shape.x2, shape.y2) <= slop + (shape.size || 2) / 2;
    case 'rect': {
      if (shape.fill) return true; // filled: the whole box is clickable
      const inner = slop + (shape.size || 2);
      const insideOuter = px >= b.minX - slop && px <= b.maxX + slop && py >= b.minY - slop && py <= b.maxY + slop;
      const insideInner = px > b.minX + inner && px < b.maxX - inner && py > b.minY + inner && py < b.maxY - inner;
      return insideOuter && !insideInner; // stroke-only: only the border hits
    }
    case 'ellipse': {
      const rx = shape.w / 2, ry = shape.h / 2;
      const cx = shape.x + rx, cy = shape.y + ry;
      if (rx <= 0 || ry <= 0) return false;
      const norm = ((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2;
      if (shape.fill) return norm <= 1.05;
      // Stroke-only: accept a ring around the outline.
      const tol = (slop + (shape.size || 2)) / Math.min(rx, ry);
      return Math.abs(norm - 1) <= tol * 2;
    }
    case 'text':
    case 'image':
    case 'note':
      return true; // bounding-box rejection above is the whole test
    default:
      return false;
  }
}

/** Shapes fully enclosed by a world-space rectangle (marquee selection). */
export function shapesInRect(shapes, rect) {
  const minX = Math.min(rect.x1, rect.x2), maxX = Math.max(rect.x1, rect.x2);
  const minY = Math.min(rect.y1, rect.y2), maxY = Math.max(rect.y1, rect.y2);
  return shapes.filter((s) => {
    const b = shapeBounds(s);
    return b && b.minX >= minX && b.maxX <= maxX && b.minY >= minY && b.maxY <= maxY;
  });
}

/** Shift a shape by a world-space delta, returning a new object. */
export function translateShape(shape, dx, dy) {
  const next = { ...shape };
  switch (shape.type) {
    case 'path':
      next.points = shape.points.map(([x, y]) => [x + dx, y + dy]);
      break;
    case 'line':
    case 'arrow':
      next.x1 += dx; next.y1 += dy; next.x2 += dx; next.y2 += dy;
      break;
    default:
      next.x += dx; next.y += dy;
  }
  return next;
}

/**
 * Chaikin-style smoothing: draw a polyline as quadratic curves through the
 * midpoints of each segment. Turns jittery pointer samples into a clean stroke.
 */
export function strokePath(ctx, points) {
  if (points.length < 2) {
    if (points.length === 1) {
      const [x, y] = points[0];
      ctx.moveTo(x, y);
      ctx.lineTo(x + 0.01, y); // a lone tap still renders as a dot
    }
    return;
  }
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length - 1; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[i + 1];
    ctx.quadraticCurveTo(x1, y1, (x1 + x2) / 2, (y1 + y2) / 2);
  }
  const last = points[points.length - 1];
  ctx.lineTo(last[0], last[1]);
}

/** Drop points closer than `min` world units apart to keep payloads small. */
export function simplify(points, min = 1.2) {
  if (points.length < 3) return points;
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const [lx, ly] = out[out.length - 1];
    const [x, y] = points[i];
    if (Math.hypot(x - lx, y - ly) >= min) out.push(points[i]);
  }
  out.push(points[points.length - 1]);
  return out;
}
