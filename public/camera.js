/**
 * Viewport transform. All shapes live in "world" coordinates that never change;
 * the camera maps them to screen pixels, so zoom/pan never mutates stored data.
 */
export const camera = { x: 0, y: 0, scale: 1 };

export const MIN_SCALE = 0.05;
export const MAX_SCALE = 8;

export function screenToWorld(sx, sy) {
  return { x: (sx - camera.x) / camera.scale, y: (sy - camera.y) / camera.scale };
}

export function worldToScreen(wx, wy) {
  return { x: wx * camera.scale + camera.x, y: wy * camera.scale + camera.y };
}

/** Zoom about a fixed screen point so the pixel under the cursor stays put. */
export function zoomAt(screenX, screenY, factor) {
  const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, camera.scale * factor));
  if (next === camera.scale) return;
  const before = screenToWorld(screenX, screenY);
  camera.scale = next;
  const after = screenToWorld(screenX, screenY);
  camera.x += (after.x - before.x) * camera.scale;
  camera.y += (after.y - before.y) * camera.scale;
}

export function setZoom(scale, cx, cy) {
  zoomAt(cx, cy, scale / camera.scale);
}

export function pan(dx, dy) {
  camera.x += dx;
  camera.y += dy;
}

/** Move the camera so `bounds` fills the viewport with a little breathing room. */
export function fitTo(bounds, viewW, viewH, padding = 80) {
  if (!bounds) return;
  const w = Math.max(bounds.maxX - bounds.minX, 1);
  const h = Math.max(bounds.maxY - bounds.minY, 1);
  const scale = Math.min(
    (viewW - padding * 2) / w,
    (viewH - padding * 2) / h,
    MAX_SCALE,
  );
  camera.scale = Math.max(MIN_SCALE, scale);
  camera.x = viewW / 2 - ((bounds.minX + bounds.maxX) / 2) * camera.scale;
  camera.y = viewH / 2 - ((bounds.minY + bounds.maxY) / 2) * camera.scale;
}

export function resetZoom(viewW, viewH) {
  setZoom(1, viewW / 2, viewH / 2);
}
