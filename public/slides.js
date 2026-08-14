/**
 * Slide geometry. A slide is a fixed 16:9 window onto the world coordinate
 * space, anchored at the origin. Shapes still live in world coordinates, so
 * drawing outside the frame is allowed — it just won't survive PPTX export.
 */

// 10in x 5.625in at 96dpi. Matches pptxgenjs LAYOUT_16x9, so exported
// positions map 1:1 to inches by dividing by PX_PER_INCH.
export const SLIDE_W = 960;
export const SLIDE_H = 540;
export const PX_PER_INCH = 96;

export const SLIDE_RECT = { x: 0, y: 0, w: SLIDE_W, h: SLIDE_H };

export function pxToInches(px) {
  return px / PX_PER_INCH;
}

export function inchesToPx(inches) {
  return inches * PX_PER_INCH;
}

/** EMU is PowerPoint's internal unit: 914400 per inch. */
export const EMU_PER_INCH = 914400;

export function emuToPx(emu) {
  return (emu / EMU_PER_INCH) * PX_PER_INCH;
}

/** Draw the printable-area frame so users know what will export. */
export function drawSlideFrame(ctx, scale, theme) {
  ctx.save();

  // Everything outside the slide is dimmed rather than hidden, so off-slide
  // scratch work stays visible but clearly marked as excluded.
  ctx.fillStyle = theme === 'dark' ? '#0b1120' : '#ffffff';
  ctx.fillRect(0, 0, SLIDE_W, SLIDE_H);

  ctx.strokeStyle = theme === 'dark' ? '#3d4a68' : '#c3ccdb';
  ctx.lineWidth = 1.5 / scale;
  ctx.strokeRect(0, 0, SLIDE_W, SLIDE_H);

  ctx.restore();
}

/** A soft shadow behind the slide so it reads as a page on the canvas. */
export function drawSlideShadow(ctx, scale) {
  ctx.save();
  ctx.shadowColor = 'rgba(15,23,42,.22)';
  ctx.shadowBlur = 24 / scale;
  ctx.shadowOffsetY = 6 / scale;
  ctx.fillStyle = 'rgba(0,0,0,.001)'; // paint only the shadow
  ctx.fillRect(0, 0, SLIDE_W, SLIDE_H);
  ctx.restore();
}
