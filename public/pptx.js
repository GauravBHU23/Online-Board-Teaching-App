/**
 * PowerPoint interop.
 *
 * Export builds a real .pptx via pptxgenjs, mapping each board shape to a
 * native PPT shape so the result stays editable in PowerPoint.
 *
 * Import unzips a .pptx and parses the slide XML directly (DrawingML), turning
 * text boxes, autoshapes, lines and pictures back into editable board shapes.
 */
import { SLIDE_W, SLIDE_H, PX_PER_INCH, emuToPx } from './slides.js';
import { shapeBounds } from './shapes.js';

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** pptxgenjs wants inches; the board works in px. */
const inch = (px) => +(px / PX_PER_INCH).toFixed(4);

/** '#rrggbb' -> 'RRGGBB', which is what pptxgenjs expects. */
function hex(color, fallback = '000000') {
  if (typeof color !== 'string') return fallback;
  const m = color.trim().match(/^#?([0-9a-f]{6})$/i);
  if (m) return m[1].toUpperCase();
  const short = color.trim().match(/^#?([0-9a-f]{3})$/i);
  if (short) return short[1].split('').map((c) => c + c).join('').toUpperCase();
  return fallback;
}

/** Opacity 0..1 -> pptxgenjs transparency percentage (0 = opaque). */
const transparency = (o) => (typeof o === 'number' && o < 1 ? Math.round((1 - o) * 100) : 0);

function lineOpts(shape) {
  return {
    color: hex(shape.color),
    width: Math.max(0.5, (shape.size || 2) * 0.75), // px -> pt
    transparency: transparency(shape.opacity),
  };
}

/**
 * Add one board shape to a pptxgenjs slide.
 * Coordinates are already slide-relative px; only unit conversion happens here.
 */
function addShapeToSlide(pptx, slide, shape) {
  switch (shape.type) {
    case 'rect':
      slide.addShape(pptx.ShapeType.rect, {
        x: inch(shape.x), y: inch(shape.y), w: inch(shape.w), h: inch(shape.h),
        line: lineOpts(shape),
        fill: shape.fill ? { color: hex(shape.fill), transparency: transparency(shape.opacity) } : { type: 'none' },
        rectRadius: shape.radius ? inch(shape.radius) : undefined,
      });
      break;

    case 'ellipse':
      slide.addShape(pptx.ShapeType.ellipse, {
        x: inch(shape.x), y: inch(shape.y), w: inch(shape.w), h: inch(shape.h),
        line: lineOpts(shape),
        fill: shape.fill ? { color: hex(shape.fill), transparency: transparency(shape.opacity) } : { type: 'none' },
      });
      break;

    case 'line':
    case 'arrow': {
      // pptxgenjs draws a line inside a box; negative w/h expresses direction.
      const x = Math.min(shape.x1, shape.x2);
      const y = Math.min(shape.y1, shape.y2);
      const w = shape.x2 - shape.x1;
      const h = shape.y2 - shape.y1;
      slide.addShape(pptx.ShapeType.line, {
        x: inch(x), y: inch(y), w: inch(Math.abs(w)), h: inch(Math.abs(h)),
        line: {
          ...lineOpts(shape),
          // Flip the box when the drag went right-to-left / bottom-to-top.
          beginArrowType: 'none',
          endArrowType: shape.type === 'arrow' ? 'triangle' : 'none',
        },
        flipH: w < 0,
        flipV: h < 0,
      });
      break;
    }

    case 'text': {
      const size = shape.size || 18;
      const b = shapeBounds(shape);
      slide.addText(String(shape.text || ''), {
        x: inch(shape.x), y: inch(shape.y),
        w: inch(Math.max(40, (b?.maxX ?? shape.x + 200) - shape.x + 20)),
        h: inch(Math.max(20, (b?.maxY ?? shape.y + 30) - shape.y + 8)),
        fontSize: Math.round(size * 0.75), // px -> pt
        color: hex(shape.color),
        align: 'left',
        valign: 'top',
        margin: 0,
        transparency: transparency(shape.opacity),
      });
      break;
    }

    case 'note':
      // A sticky note is a filled rounded rect with text inside it.
      slide.addText(String(shape.text || ''), {
        shape: pptx.ShapeType.roundRect,
        x: inch(shape.x), y: inch(shape.y), w: inch(shape.w), h: inch(shape.h),
        fill: { color: hex(shape.fill, 'FDE68A') },
        line: { color: 'F59E0B', width: 1 },
        fontSize: Math.round((shape.size || 16) * 0.75),
        color: hex(shape.color, '1F2937'),
        align: 'left',
        valign: 'top',
        margin: 6,
      });
      break;

    case 'image':
      if (typeof shape.src === 'string' && shape.src.startsWith('data:')) {
        slide.addImage({
          data: shape.src,
          x: inch(shape.x), y: inch(shape.y), w: inch(shape.w), h: inch(shape.h),
        });
      }
      break;

    case 'path': {
      // PowerPoint has no freehand primitive in pptxgenjs, so approximate the
      // stroke with a run of thin line segments. Long strokes are subsampled
      // to keep the file from exploding.
      const pts = shape.points || [];
      if (pts.length < 2) break;
      const stride = Math.max(1, Math.ceil(pts.length / 220));
      const opts = lineOpts(shape);
      for (let i = stride; i < pts.length; i += stride) {
        const [x1, y1] = pts[i - stride];
        const [x2, y2] = pts[i];
        const w = x2 - x1, h = y2 - y1;
        slide.addShape(pptx.ShapeType.line, {
          x: inch(Math.min(x1, x2)), y: inch(Math.min(y1, y2)),
          w: inch(Math.abs(w)), h: inch(Math.abs(h)),
          line: opts,
          flipH: w < 0,
          flipV: h < 0,
        });
      }
      break;
    }
  }
}

/**
 * Build and download a .pptx from the deck.
 * `slides` is the full deck; each slide's shapes are exported as-is.
 */
export async function exportPptx(slides, filename, theme) {
  const { default: PptxGenJS } = await import('./vendor/pptxgen.es.js');
  const pptx = new PptxGenJS();

  pptx.layout = 'LAYOUT_16x9';
  pptx.title = filename;

  for (const s of slides) {
    const slide = pptx.addSlide();
    slide.background = { color: hex(s.background, theme === 'dark' ? '0B1120' : 'FFFFFF') };

    // Painter's order: the board's array order is the z-order.
    for (const shape of s.shapes) {
      try {
        addShapeToSlide(pptx, slide, shape);
      } catch (err) {
        // One bad shape shouldn't abort the whole export.
        console.warn('[pptx] skipped a shape during export:', err?.message, shape?.type);
      }
    }
  }

  await pptx.writeFile({ fileName: `${filename}.pptx` });
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';

/** Read an <a:solidFill> descendant colour as '#rrggbb', if present. */
function readFill(node) {
  if (!node) return null;
  const solid = node.getElementsByTagNameNS(A_NS, 'solidFill')[0];
  if (!solid) return null;
  const srgb = solid.getElementsByTagNameNS(A_NS, 'srgbClr')[0];
  if (srgb) return `#${srgb.getAttribute('val')}`;
  // Theme colours need the theme part to resolve properly; approximate the
  // common ones so imported shapes aren't invisible.
  const scheme = solid.getElementsByTagNameNS(A_NS, 'schemeClr')[0];
  if (scheme) {
    const map = { dk1: '#000000', dk2: '#44546a', lt1: '#ffffff', lt2: '#e7e6e6',
      tx1: '#000000', tx2: '#44546a', bg1: '#ffffff', bg2: '#e7e6e6',
      accent1: '#4472c4', accent2: '#ed7d31', accent3: '#a5a5a5',
      accent4: '#ffc000', accent5: '#5b9bd5', accent6: '#70ad47' };
    return map[scheme.getAttribute('val')] || '#444444';
  }
  return null;
}

/** Pull <a:off>/<a:ext> out of a shape's transform, converted to px. */
function readTransform(sp) {
  const xfrm = sp.getElementsByTagNameNS(A_NS, 'xfrm')[0];
  if (!xfrm) return null;
  const off = xfrm.getElementsByTagNameNS(A_NS, 'off')[0];
  const ext = xfrm.getElementsByTagNameNS(A_NS, 'ext')[0];
  if (!off || !ext) return null;
  return {
    x: emuToPx(+off.getAttribute('x') || 0),
    y: emuToPx(+off.getAttribute('y') || 0),
    w: emuToPx(+ext.getAttribute('cx') || 0),
    h: emuToPx(+ext.getAttribute('cy') || 0),
    flipH: xfrm.getAttribute('flipH') === '1',
    flipV: xfrm.getAttribute('flipV') === '1',
  };
}

/** Concatenate every <a:t> run into plain text, keeping paragraph breaks. */
function readText(sp) {
  const paras = sp.getElementsByTagNameNS(A_NS, 'p');
  const lines = [];
  for (const p of paras) {
    let line = '';
    for (const t of p.getElementsByTagNameNS(A_NS, 't')) line += t.textContent;
    lines.push(line);
  }
  return lines.join('\n').trim();
}

/** First run's font size (in hundredths of a point) -> px. */
function readFontSize(sp) {
  const rPr = sp.getElementsByTagNameNS(A_NS, 'rPr')[0]
    || sp.getElementsByTagNameNS(A_NS, 'defRPr')[0];
  const sz = rPr?.getAttribute('sz');
  return sz ? Math.round((+sz / 100) / 0.75) : 18; // pt -> px
}

function readTextColor(sp) {
  const rPr = sp.getElementsByTagNameNS(A_NS, 'rPr')[0];
  return readFill(rPr) || '#0f172a';
}

/** Map DrawingML preset geometries onto the board's shape vocabulary. */
function presetToType(preset) {
  if (!preset) return 'rect';
  if (/^(ellipse|circle|oval)$/i.test(preset)) return 'ellipse';
  if (/^(line|straightConnector1)$/i.test(preset)) return 'line';
  if (/arrow/i.test(preset)) return 'arrow';
  return 'rect';
}

/**
 * Parse one slide's XML into board shapes.
 * `rels` maps r:embed ids to data URLs for the slide's images.
 */
function parseSlideXml(xml, rels) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) return [];

  const shapes = [];
  const spTree = doc.getElementsByTagName('p:spTree')[0] || doc.documentElement;

  // Walk direct children so nested group members keep their own order.
  const visit = (node, dx = 0, dy = 0) => {
    for (const child of node.children) {
      const tag = child.localName;

      if (tag === 'grpSp') {
        // Group offsets nest; the child transforms are already absolute in
        // most decks, so recurse without compounding.
        visit(child, dx, dy);
        continue;
      }

      if (tag === 'pic') {
        const t = readTransform(child);
        const blip = child.getElementsByTagNameNS(A_NS, 'blip')[0];
        const embed = blip?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed')
          || blip?.getAttribute('r:embed');
        const src = embed && rels[embed];
        if (t && src) {
          shapes.push({ id: uid(), type: 'image', src, x: t.x + dx, y: t.y + dy, w: t.w, h: t.h });
        }
        continue;
      }

      if (tag === 'sp') {
        const t = readTransform(child);
        if (!t) continue;

        const prstGeom = child.getElementsByTagNameNS(A_NS, 'prstGeom')[0];
        const preset = prstGeom?.getAttribute('prst');
        const text = readText(child);
        const spPr = child.getElementsByTagName('p:spPr')[0];
        const fill = readFill(spPr);
        const ln = spPr?.getElementsByTagNameNS(A_NS, 'ln')[0];
        const lineColor = readFill(ln);
        const lineW = ln?.getAttribute('w');
        const strokeSize = lineW ? Math.max(1, Math.round(emuToPx(+lineW))) : 2;

        const type = presetToType(preset);
        const x = t.x + dx, y = t.y + dy;

        // A shape that carries text becomes a text/note; otherwise geometry.
        if (text) {
          const isNote = !!fill && type === 'rect';
          shapes.push(isNote
            ? { id: uid(), type: 'note', x, y, w: t.w || 200, h: t.h || 160,
                text, fill, color: readTextColor(child), size: readFontSize(child) }
            : { id: uid(), type: 'text', x, y, text,
                color: readTextColor(child), size: readFontSize(child) });
          continue;
        }

        if (type === 'line' || type === 'arrow') {
          // flipH/flipV tell us which diagonal the line runs along.
          const x1 = t.flipH ? x + t.w : x;
          const x2 = t.flipH ? x : x + t.w;
          const y1 = t.flipV ? y + t.h : y;
          const y2 = t.flipV ? y : y + t.h;
          shapes.push({ id: uid(), type, x1, y1, x2, y2,
            color: lineColor || '#0f172a', size: strokeSize });
          continue;
        }

        shapes.push({ id: uid(), type, x, y, w: t.w, h: t.h,
          color: lineColor || '#0f172a', size: strokeSize, fill: fill || null });
      }
    }
  };

  visit(spTree);
  return shapes;
}

/** Numeric order: slide2.xml must come before slide10.xml. */
function slideOrder(name) {
  const m = name.match(/slide(\d+)\.xml$/);
  return m ? +m[1] : 0;
}

/**
 * Read a .pptx File into `[{ name, shapes, background }]`.
 * Throws a human-readable Error if the file isn't a usable presentation.
 */
export async function importPptx(file, onProgress) {
  const { default: JSZip } = await import('./vendor/jszip.es.js');

  let zip;
  try {
    zip = await JSZip.loadAsync(file);
  } catch {
    throw new Error('That file is not a valid .pptx (could not read the archive).');
  }

  const slideFiles = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => slideOrder(a) - slideOrder(b));

  if (!slideFiles.length) {
    throw new Error('No slides found. Is this a PowerPoint file?');
  }

  const out = [];
  for (let i = 0; i < slideFiles.length; i++) {
    const name = slideFiles[i];
    onProgress?.(i + 1, slideFiles.length);

    // Resolve this slide's image relationships to data URLs up front.
    const relPath = name.replace(/slides\/(slide\d+)\.xml$/, 'slides/_rels/$1.xml.rels');
    const rels = {};
    const relFile = zip.file(relPath);
    if (relFile) {
      const relXml = await relFile.async('string');
      const relDoc = new DOMParser().parseFromString(relXml, 'application/xml');
      for (const rel of relDoc.getElementsByTagName('Relationship')) {
        const target = rel.getAttribute('Target') || '';
        if (!/\.(png|jpe?g|gif|bmp|webp)$/i.test(target)) continue;
        const imgPath = `ppt/${target.replace(/^\.\.\//, '')}`;
        const imgFile = zip.file(imgPath);
        if (!imgFile) continue;
        const b64 = await imgFile.async('base64');
        const ext = target.split('.').pop().toLowerCase();
        const mime = ext === 'jpg' ? 'jpeg' : ext;
        rels[rel.getAttribute('Id')] = `data:image/${mime};base64,${b64}`;
      }
    }

    const xml = await zip.file(name).async('string');
    let shapes = [];
    try {
      shapes = parseSlideXml(xml, rels);
    } catch (err) {
      console.warn(`[pptx] could not parse ${name}:`, err?.message);
    }

    out.push({ name: `Slide ${i + 1}`, shapes, background: null });
  }

  return out;
}

/** Clamp imported geometry into the slide frame if a deck used a bigger canvas. */
export function normalizeImported(slides) {
  for (const s of slides) {
    for (const shape of s.shapes) {
      if (shape.type === 'line' || shape.type === 'arrow') {
        shape.x1 = Math.max(-SLIDE_W, Math.min(SLIDE_W * 2, shape.x1));
        shape.x2 = Math.max(-SLIDE_W, Math.min(SLIDE_W * 2, shape.x2));
        shape.y1 = Math.max(-SLIDE_H, Math.min(SLIDE_H * 2, shape.y1));
        shape.y2 = Math.max(-SLIDE_H, Math.min(SLIDE_H * 2, shape.y2));
      }
    }
  }
  return slides;
}
