import { camera, screenToWorld, zoomAt, pan, fitTo, resetZoom } from './camera.js';
import { hitTest, shapesInRect, translateShape, boundsOfAll, shapeBounds, simplify } from './shapes.js';
import { renderBoard, renderOverlay, dropImage, drawShape } from './render.js';
import { SLIDE_W, SLIDE_H } from './slides.js';

const $ = (sel) => document.querySelector(sel);
const boardCanvas = $('#board');
const overlayCanvas = $('#overlay');
const ctx = boardCanvas.getContext('2d');
const octx = overlayCanvas.getContext('2d');

const roomId = location.pathname.split('/').filter(Boolean)[1] || 'lobby';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  slides: [],              // the whole deck
  slideId: null,           // the slide this client is editing
  selection: [],
  draft: null,             // the shape being drawn right now, locally
  remoteDrafts: new Map(), // socketId -> in-progress shape from someone else
  cursors: new Map(),
  marquee: null,
  tool: 'pen',
  color: '#0f172a',
  size: 4,
  opacity: 1,
  fill: false,
  fillColor: '#fde68a',
  grid: true,
  dpr: 1,
  me: null,
  users: [],
};

const PALETTE = [
  '#0f172a', '#64748b', '#dc2626', '#ea580c', '#ca8a04', '#16a34a',
  '#0891b2', '#2563eb', '#7c3aed', '#db2777', '#ffffff', '#a16207',
];

/**
 * `state.shapes` reads and writes the active slide's shape list. Exposing it as
 * a property keeps every drawing/selection routine slide-agnostic — they touch
 * state.shapes exactly as before, and switching slides just repoints it.
 */
Object.defineProperty(state, 'shapes', {
  get() {
    return activeSlide()?.shapes ?? [];
  },
  set(next) {
    const slide = activeSlide();
    if (slide) slide.shapes = next;
  },
});

function activeSlide() {
  return state.slides.find((s) => s.id === state.slideId) || state.slides[0];
}

function slideById(id) {
  return state.slides.find((s) => s.id === id);
}

function slideIndex() {
  return Math.max(0, state.slides.findIndex((s) => s.id === state.slideId));
}

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;

// ---------------------------------------------------------------------------
// Canvas sizing (HiDPI aware)
// ---------------------------------------------------------------------------
function resize() {
  const dpr = window.devicePixelRatio || 1;
  state.dpr = dpr;
  for (const cv of [boardCanvas, overlayCanvas]) {
    cv.width = Math.floor(innerWidth * dpr);
    cv.height = Math.floor(innerHeight * dpr);
  }
  draw();
}
addEventListener('resize', resize);

// ---------------------------------------------------------------------------
// Render loop — coalesce every change into one paint per frame
// ---------------------------------------------------------------------------
let frameQueued = false;
function draw() {
  if (frameQueued) return;
  frameQueued = true;
  requestAnimationFrame(() => {
    frameQueued = false;
    const gridColor = getComputedStyle(document.documentElement).getPropertyValue('--grid').trim();
    renderBoard(boardCanvas, ctx, state.shapes, {
      dpr: state.dpr, grid: state.grid, gridColor, onImageLoad: draw,
      theme: document.documentElement.dataset.theme,
    });
    renderOverlay(overlayCanvas, octx, state);
  });
}

// ---------------------------------------------------------------------------
// Socket wiring
// ---------------------------------------------------------------------------
const socket = io({ transports: ['websocket', 'polling'] });
const connDot = $('#conn-dot');

socket.on('connect', () => {
  connDot.classList.add('online');
  connDot.classList.remove('offline');
  socket.emit('join', { room: roomId, name: myName() }, (res) => {
    if (res?.error) return toast(res.error);
    state.me = res.you;
    state.slides = res.slides || [];
    state.slideId = state.slides[0]?.id ?? null;
    state.users = res.users || [];
    // Only offer sign-out when there is actually a session to end.
    $('#logout-form').hidden = !res.authEnabled;
    // Warn once per session when the server can't persist boards.
    if (res.ephemeral && !sessionStorage.getItem('board:ephemeral-warned')) {
      sessionStorage.setItem('board:ephemeral-warned', '1');
      showEphemeralNotice();
    }
    renderUsers();
    renderSlideStrip();
    (res.chat || []).forEach(addChatMessage);
    // Always frame the slide so everyone starts on the same view.
    fitSlide();
    draw();
  });
});

socket.on('disconnect', () => {
  connDot.classList.remove('online');
  connDot.classList.add('offline');
  toast('Disconnected — reconnecting…');
});

// A rejected handshake means the session cookie expired or was never valid;
// reconnecting would loop forever, so send the user back to the login page.
socket.on('connect_error', (err) => {
  if (/unauthorized/i.test(err?.message || '')) {
    socket.close();
    location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
  }
});

// Remote edits may target a slide this client isn't viewing, so each handler
// resolves the target slide by id and only repaints when it's the active one.
function touchSlide(slideId, mutate) {
  const slide = slideById(slideId) || activeSlide();
  if (!slide) return;
  mutate(slide);
  if (slide.id === state.slideId) draw();
  queueThumb(slide.id);
}

socket.on('shape:add', ({ slideId, shape }) => {
  touchSlide(slideId, (slide) => slide.shapes.push(shape));
});

socket.on('shape:update', ({ slideId, shape }) => {
  touchSlide(slideId, (slide) => {
    const i = slide.shapes.findIndex((s) => s.id === shape.id);
    if (i !== -1) slide.shapes[i] = shape;
  });
  // A committed update supersedes any transient preview for this shape.
  state.remoteDrafts.delete(`t:${shape.id}`);
});

socket.on('shape:transient', ({ slideId, shape }) => {
  state.remoteDrafts.set(`t:${shape.id}`, shape);
  touchSlide(slideId, (slide) => {
    const i = slide.shapes.findIndex((s) => s.id === shape.id);
    if (i !== -1) slide.shapes[i] = shape; // move it live for everyone watching
  });
});

socket.on('shape:delete', ({ slideId, ids }) => {
  const set = new Set(ids);
  touchSlide(slideId, (slide) => {
    slide.shapes = slide.shapes.filter((s) => !set.has(s.id));
  });
  state.selection = state.selection.filter((s) => !set.has(s.id));
  ids.forEach(dropImage);
});

socket.on('shapes:restore', ({ slideId, shapes }) => {
  touchSlide(slideId, (slide) => {
    for (const s of shapes) {
      if (!slide.shapes.some((x) => x.id === s.id)) slide.shapes.push(s);
    }
  });
});

socket.on('board:clear', ({ slideId }) => {
  touchSlide(slideId, (slide) => { slide.shapes = []; });
  state.selection = [];
});

/** The deck changed shape (add/delete/reorder/import) — resync wholesale. */
socket.on('slides:sync', (slides) => {
  state.slides = slides;
  // Stay on the current slide if it survived; otherwise fall back by position.
  if (!slideById(state.slideId)) {
    state.slideId = state.slides[0]?.id ?? null;
    state.selection = [];
    fitSlide();
  }
  renderSlideStrip();
  refreshAllThumbs();
  draw();
});

socket.on('draw:progress', ({ from, payload, slideId }) => {
  // Ignore live strokes happening on a slide we're not looking at.
  if (payload === null || (slideId && slideId !== state.slideId)) {
    state.remoteDrafts.delete(from);
  } else {
    state.remoteDrafts.set(from, payload);
  }
  draw();
});

socket.on('cursor', (c) => {
  if (c.slideId && c.slideId !== state.slideId) {
    state.cursors.delete(c.id);
  } else {
    state.cursors.set(c.id, c);
  }
  draw();
});

socket.on('users', (users) => { state.users = users; renderUsers(); });

socket.on('user:joined', (u) => addChatMessage({ system: true, text: `${u.name} joined` }));

socket.on('user:left', ({ id }) => {
  state.cursors.delete(id);
  state.remoteDrafts.delete(id);
  draw();
});

socket.on('chat', (msg) => {
  addChatMessage(msg);
  if ($('#chat').hidden) $('#chat-badge').hidden = false;
});

// ---------------------------------------------------------------------------
// Pointer input
// ---------------------------------------------------------------------------
let pointer = null;   // active drag session
const activePointers = new Map(); // for pinch-zoom

boardCanvas.addEventListener('pointerdown', (e) => {
  if (e.button === 1 || (e.button === 0 && spaceHeld)) return startPan(e);
  if (e.button !== 0) return;

  boardCanvas.setPointerCapture(e.pointerId);
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (activePointers.size === 2) { pointer = null; return; } // pinch takes over

  const w = screenToWorld(e.clientX, e.clientY);

  switch (state.tool) {
    case 'pan':
      return startPan(e);

    case 'select': {
      const hit = topShapeAt(w.x, w.y);
      if (hit) {
        const already = state.selection.some((s) => s.id === hit.id);
        // Shift extends the selection; a bare click on a new shape replaces it.
        if (e.shiftKey) {
          state.selection = already
            ? state.selection.filter((s) => s.id !== hit.id)
            : [...state.selection, hit];
        } else if (!already) {
          state.selection = [hit];
        }
        pointer = {
          mode: 'move', startW: w, last: w,
          originals: state.selection.map((s) => ({ ...s })),
        };
      } else {
        if (!e.shiftKey) state.selection = [];
        pointer = { mode: 'marquee' };
        state.marquee = { x1: w.x, y1: w.y, x2: w.x, y2: w.y };
      }
      draw();
      return;
    }

    case 'eraser':
      pointer = { mode: 'erase', erased: new Set() };
      eraseAt(w.x, w.y);
      return;

    case 'text':
    case 'note':
      openTextEditor(w.x, w.y, state.tool);
      return;

    case 'image':
      $('#file-input').click();
      return;

    case 'pen':
    case 'highlighter': {
      const highlighter = state.tool === 'highlighter';
      state.draft = {
        id: uid(), type: 'path', points: [[w.x, w.y]],
        color: state.color,
        size: highlighter ? state.size * 3 : state.size,
        opacity: highlighter ? 0.4 : state.opacity,
        highlighter,
      };
      pointer = { mode: 'draw' };
      return;
    }

    default: {
      // line / arrow / rect / ellipse all drag out from an anchor point.
      pointer = { mode: 'shape', startW: w };
      state.draft = makeShapeFrom(state.tool, w, w);
      return;
    }
  }
});

boardCanvas.addEventListener('pointermove', (e) => {
  if (activePointers.has(e.pointerId)) activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (activePointers.size === 2) return handlePinch();

  const w = screenToWorld(e.clientX, e.clientY);
  sendCursor(w);

  if (!pointer) return;

  switch (pointer.mode) {
    case 'pan': {
      pan(e.clientX - pointer.lastX, e.clientY - pointer.lastY);
      pointer.lastX = e.clientX;
      pointer.lastY = e.clientY;
      draw();
      break;
    }
    case 'draw': {
      const pts = state.draft.points;
      const [lx, ly] = pts[pts.length - 1];
      // Skip sub-pixel samples: fewer points means smaller payloads and
      // a smoother curve once the midpoint smoothing runs.
      if (Math.hypot(w.x - lx, w.y - ly) * camera.scale < 1.5) return;
      pts.push([w.x, w.y]);
      throttledProgress(state.draft);
      draw();
      break;
    }
    case 'shape': {
      // Shift constrains to squares / circles / 45° lines.
      state.draft = makeShapeFrom(state.tool, pointer.startW, w, e.shiftKey);
      state.draft.id = state.draft.id || uid();
      throttledProgress(state.draft);
      draw();
      break;
    }
    case 'move': {
      const dx = w.x - pointer.last.x;
      const dy = w.y - pointer.last.y;
      pointer.last = w;
      state.selection = state.selection.map((sel) => {
        const idx = state.shapes.findIndex((s) => s.id === sel.id);
        const moved = translateShape(state.shapes[idx], dx, dy);
        state.shapes[idx] = moved;
        socket.emit('shape:transient', { slideId: state.slideId, shape: moved });
        return moved;
      });
      draw();
      break;
    }
    case 'marquee': {
      state.marquee.x2 = w.x;
      state.marquee.y2 = w.y;
      draw();
      break;
    }
    case 'erase':
      eraseAt(w.x, w.y);
      break;
  }
});

function endPointer(e) {
  activePointers.delete(e.pointerId);
  if (!pointer) return;

  if (pointer.mode === 'draw' && state.draft) {
    state.draft.points = simplify(state.draft.points);
    commitShape(state.draft);
    socket.emit('draw:progress', null);
    state.draft = null;
  } else if (pointer.mode === 'shape' && state.draft) {
    const b = shapeBounds(state.draft);
    // Discard accidental zero-size drags from a click that didn't move.
    const big = b && (b.maxX - b.minX > 2 || b.maxY - b.minY > 2);
    if (big) commitShape(state.draft);
    socket.emit('draw:progress', null);
    state.draft = null;
  } else if (pointer.mode === 'move') {
    // Commit the whole drag as one batch so it undoes in a single step.
    if (state.selection.length) socket.emit('shape:update:batch', { slideId: state.slideId, shapes: state.selection });
  } else if (pointer.mode === 'marquee') {
    const picked = shapesInRect(state.shapes, state.marquee);
    state.selection = e.shiftKey
      ? [...state.selection, ...picked.filter((p) => !state.selection.some((s) => s.id === p.id))]
      : picked;
    state.marquee = null;
  } else if (pointer.mode === 'erase' && pointer.erased.size) {
    socket.emit('shape:delete', { slideId: state.slideId, ids: [...pointer.erased] });
  } else if (pointer.mode === 'pan') {
    boardCanvas.classList.remove('panning');
  }

  pointer = null;
  draw();
}

boardCanvas.addEventListener('pointerup', endPointer);
boardCanvas.addEventListener('pointercancel', endPointer);
boardCanvas.addEventListener('pointerleave', (e) => { if (pointer) endPointer(e); });

function startPan(e) {
  pointer = { mode: 'pan', lastX: e.clientX, lastY: e.clientY };
  boardCanvas.classList.add('panning');
  boardCanvas.setPointerCapture(e.pointerId);
}

/** Two-finger pinch: zoom about the midpoint and pan with it. */
let pinchPrev = null;
function handlePinch() {
  const [a, b] = [...activePointers.values()];
  const dist = Math.hypot(a.x - b.x, a.y - b.y);
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  if (pinchPrev) {
    zoomAt(mid.x, mid.y, dist / pinchPrev.dist);
    pan(mid.x - pinchPrev.mid.x, mid.y - pinchPrev.mid.y);
    updateZoomLabel();
    draw();
  }
  pinchPrev = { dist, mid };
}
addEventListener('pointerup', () => { if (activePointers.size < 2) pinchPrev = null; });

// Wheel: ctrl/⌘ or pinch-gesture zooms, plain wheel scrolls the board.
boardCanvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
    updateZoomLabel();
  } else {
    pan(-e.deltaX, -e.deltaY);
  }
  draw();
}, { passive: false });

// ---------------------------------------------------------------------------
// Shape construction & commit
// ---------------------------------------------------------------------------
function makeShapeFrom(tool, a, b, constrain = false) {
  let { x: x2, y: y2 } = b;

  if (constrain) {
    if (tool === 'line' || tool === 'arrow') {
      // Snap the direction to the nearest 45°.
      const dx = x2 - a.x, dy = y2 - a.y;
      const len = Math.hypot(dx, dy);
      const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      x2 = a.x + Math.cos(angle) * len;
      y2 = a.y + Math.sin(angle) * len;
    } else {
      const side = Math.max(Math.abs(x2 - a.x), Math.abs(y2 - a.y));
      x2 = a.x + Math.sign(x2 - a.x || 1) * side;
      y2 = a.y + Math.sign(y2 - a.y || 1) * side;
    }
  }

  const base = {
    id: state.draft?.id || uid(),
    color: state.color,
    size: state.size,
    opacity: state.opacity,
  };

  if (tool === 'line' || tool === 'arrow') {
    return { ...base, type: tool, x1: a.x, y1: a.y, x2, y2 };
  }
  return {
    ...base,
    type: tool,
    x: Math.min(a.x, x2), y: Math.min(a.y, y2),
    w: Math.abs(x2 - a.x), h: Math.abs(y2 - a.y),
    fill: state.fill ? state.fillColor : null,
  };
}

function commitShape(shape) {
  const slideId = state.slideId;
  state.shapes.push(shape);
  socket.emit('shape:add', { slideId, shape }, (res) => {
    if (res?.error) {
      // Server rejected it — roll the local copy back so views stay in sync.
      const slide = slideById(slideId);
      if (slide) slide.shapes = slide.shapes.filter((s) => s.id !== shape.id);
      toast(res.error);
      draw();
    }
  });
  queueThumb(slideId);
  draw();
}

function topShapeAt(x, y) {
  // Later shapes render on top, so search back-to-front.
  for (let i = state.shapes.length - 1; i >= 0; i--) {
    if (hitTest(state.shapes[i], x, y, 6 / camera.scale)) return state.shapes[i];
  }
  return null;
}

function eraseAt(x, y) {
  const hit = topShapeAt(x, y);
  if (hit && !pointer.erased.has(hit.id)) {
    pointer.erased.add(hit.id);
    // Hide it immediately; the delete is batched until pointerup.
    state.shapes = state.shapes.filter((s) => s.id !== hit.id);
    draw();
  }
}

// Cap network chatter to roughly one message per frame.
function throttle(fn, ms) {
  let last = 0, timer = null, pending = null;
  return (...args) => {
    pending = args;
    const now = performance.now();
    if (now - last >= ms) { last = now; fn(...pending); return; }
    if (!timer) {
      timer = setTimeout(() => {
        timer = null; last = performance.now(); fn(...pending);
      }, ms - (now - last));
    }
  };
}

const throttledProgress = throttle((shape) => socket.emit('draw:progress', shape), 40);
const sendCursor = throttle((w) => socket.emit('cursor', { x: w.x, y: w.y }), 50);

// ---------------------------------------------------------------------------
// Text & sticky notes — edited in a real DOM element, then baked to canvas
// ---------------------------------------------------------------------------
function openTextEditor(wx, wy, kind, existing = null) {
  const layer = $('#text-layer');
  const el = document.createElement('textarea');
  el.className = `floating-editor${kind === 'note' ? ' note' : ''}`;

  const size = kind === 'note' ? 16 : Math.max(14, state.size * 4);
  const screen = { x: wx * camera.scale + camera.x, y: wy * camera.scale + camera.y };

  el.style.left = `${screen.x}px`;
  el.style.top = `${screen.y}px`;
  el.style.fontSize = `${size * camera.scale}px`;
  el.style.color = kind === 'note' ? '#1f2937' : state.color;
  if (kind === 'note') {
    el.style.width = `${200 * camera.scale}px`;
    el.style.height = `${160 * camera.scale}px`;
    el.style.background = state.fillColor;
  }
  el.value = existing?.text || '';
  el.rows = 1;
  layer.appendChild(el);
  el.focus();

  const autoGrow = () => {
    if (kind === 'note') return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
    el.style.width = `${Math.max(120, el.scrollWidth + 10)}px`;
  };
  el.addEventListener('input', autoGrow);
  autoGrow();

  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    const text = el.value.trim();
    el.remove();

    if (save && text) {
      const shape = existing
        ? { ...existing, text }
        : kind === 'note'
          ? { id: uid(), type: 'note', x: wx, y: wy, w: 200, h: 160, text, color: '#1f2937', fill: state.fillColor, size: 16 }
          : { id: uid(), type: 'text', x: wx, y: wy, text, color: state.color, size };

      if (existing) {
        const i = state.shapes.findIndex((s) => s.id === existing.id);
        if (i !== -1) state.shapes[i] = shape;
        socket.emit('shape:update', { slideId: state.slideId, shape });
        draw();
      } else {
        commitShape(shape);
      }
    } else if (existing && !text) {
      // Emptying an existing text box deletes it.
      socket.emit('shape:delete', { slideId: state.slideId, ids: [existing.id] });
    }
    setTool('select');
  };

  el.addEventListener('blur', () => finish(true));
  el.addEventListener('keydown', (e) => {
    e.stopPropagation(); // keep board shortcuts from firing while typing
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    // Enter commits single-line text; notes and Shift+Enter insert newlines.
    if (e.key === 'Enter' && !e.shiftKey && kind === 'text') { e.preventDefault(); finish(true); }
  });
}

// Double-click an existing text/note to edit it in place.
boardCanvas.addEventListener('dblclick', (e) => {
  const w = screenToWorld(e.clientX, e.clientY);
  const hit = topShapeAt(w.x, w.y);
  if (hit && (hit.type === 'text' || hit.type === 'note')) {
    openTextEditor(hit.x, hit.y, hit.type, hit);
  }
});

// ---------------------------------------------------------------------------
// Images: file picker, paste and drag-drop
// ---------------------------------------------------------------------------
const MAX_IMAGE_BYTES = 3_000_000;

function insertImage(file, at) {
  if (!file || !file.type.startsWith('image/')) return;
  if (file.size > MAX_IMAGE_BYTES) return toast('Image is too large (max 3 MB)');

  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      // Scale big photos down to something that fits comfortably on screen.
      const max = 480;
      const ratio = Math.min(1, max / Math.max(img.width, img.height));
      const w = img.width * ratio, h = img.height * ratio;
      const center = at || screenToWorld(innerWidth / 2, innerHeight / 2);
      commitShape({
        id: uid(), type: 'image', src: reader.result,
        x: center.x - w / 2, y: center.y - h / 2, w, h,
      });
      setTool('select');
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

$('#file-input').addEventListener('change', (e) => {
  insertImage(e.target.files[0]);
  e.target.value = ''; // allow re-picking the same file
});

addEventListener('paste', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  const file = [...(e.clipboardData?.items || [])]
    .find((i) => i.type.startsWith('image/'))?.getAsFile();
  if (file) { e.preventDefault(); insertImage(file); }
});

addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (file) insertImage(file, screenToWorld(e.clientX, e.clientY));
});

// ---------------------------------------------------------------------------
// Tools & style panel
// ---------------------------------------------------------------------------
function setTool(tool) {
  state.tool = tool;
  if (tool !== 'select') state.selection = [];
  document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  boardCanvas.className = `tool-${tool}`;
  draw();
}

document.querySelectorAll('.tool').forEach((btn) => {
  btn.addEventListener('click', () => setTool(btn.dataset.tool));
});

// Colour swatches
const swatchWrap = $('#swatches');
PALETTE.forEach((color) => {
  const b = document.createElement('button');
  b.className = 'swatch';
  b.style.background = color;
  b.title = color;
  b.addEventListener('click', () => {
    state.color = color;
    swatchWrap.querySelectorAll('.swatch').forEach((s) => s.classList.remove('active'));
    b.classList.add('active');
    applyStyleToSelection({ color });
  });
  swatchWrap.appendChild(b);
});
swatchWrap.firstChild.classList.add('active');

$('#size').addEventListener('input', (e) => {
  state.size = +e.target.value;
  $('#size-val').textContent = state.size;
  applyStyleToSelection({ size: state.size });
});

$('#opacity').addEventListener('input', (e) => {
  state.opacity = +e.target.value / 100;
  $('#opacity-val').textContent = e.target.value;
  applyStyleToSelection({ opacity: state.opacity });
});

$('#fill').addEventListener('change', (e) => {
  state.fill = e.target.checked;
  applyStyleToSelection({ fill: state.fill ? state.fillColor : null });
});

$('#fill-color').addEventListener('input', (e) => {
  state.fillColor = e.target.value;
  if (state.fill) applyStyleToSelection({ fill: state.fillColor });
});

/** Style controls double as an editor for whatever is selected. */
function applyStyleToSelection(patch) {
  if (!state.selection.length) return;
  state.selection = state.selection.map((sel) => {
    const i = state.shapes.findIndex((s) => s.id === sel.id);
    if (i === -1) return sel;
    const next = { ...state.shapes[i], ...patch };
    state.shapes[i] = next;
    return next;
  });
  socket.emit('shape:update:batch', { slideId: state.slideId, shapes: state.selection });
  draw();
}

// ---------------------------------------------------------------------------
// Top bar actions
// ---------------------------------------------------------------------------
$('#undo').addEventListener('click', () => socket.emit('history:undo'));
$('#redo').addEventListener('click', () => socket.emit('history:redo'));

$('#clear').addEventListener('click', () => {
  if (confirm('Clear this slide for everyone? This can be undone with Ctrl+Z.')) {
    socket.emit('board:clear', state.slideId);
  }
});

function updateZoomLabel() {
  $('#zoom-level').textContent = `${Math.round(camera.scale * 100)}%`;
}

$('#zoom-in').addEventListener('click', () => { zoomAt(innerWidth / 2, innerHeight / 2, 1.2); updateZoomLabel(); draw(); });
$('#zoom-out').addEventListener('click', () => { zoomAt(innerWidth / 2, innerHeight / 2, 1 / 1.2); updateZoomLabel(); draw(); });
$('#zoom-level').addEventListener('click', () => { resetZoom(innerWidth, innerHeight); updateZoomLabel(); draw(); });

/**
 * Fit the slide frame, or the drawing if it spills outside the frame — so
 * off-slide scratch work is still reachable.
 */
function fitBoard() {
  const b = boundsOfAll(state.shapes);
  const outside = b && (b.minX < -20 || b.minY < -20 || b.maxX > SLIDE_W + 20 || b.maxY > SLIDE_H + 20);
  if (!outside) return fitSlide();

  fitTo({
    minX: Math.min(0, b.minX), minY: Math.min(0, b.minY),
    maxX: Math.max(SLIDE_W, b.maxX), maxY: Math.max(SLIDE_H, b.maxY),
  }, innerWidth, innerHeight - 150, 60);
  camera.y -= 34;
  updateZoomLabel();
  draw();
}
$('#fit').addEventListener('click', fitBoard);

$('#grid-toggle').addEventListener('click', (e) => {
  state.grid = !state.grid;
  e.currentTarget.classList.toggle('on', state.grid);
  draw();
});
$('#grid-toggle').classList.add('on');

// Theme, remembered across visits.
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('board:theme', theme);
  // Default ink should stay visible when the background flips.
  if (state.color === '#0f172a' && theme === 'dark') state.color = '#ffffff';
  else if (state.color === '#ffffff' && theme === 'light') state.color = '#0f172a';
  refreshAllThumbs(); // thumbnails bake in the background colour
  draw();
}
$('#theme-toggle').addEventListener('click', () => {
  setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
});
setTheme(localStorage.getItem('board:theme') || 'light');

// Room chip copies the invite link.
$('#room-id').textContent = roomId;
$('#room-chip').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    toast('Invite link copied!');
  } catch {
    toast(location.href);
  }
});

// ---------------------------------------------------------------------------
// Slide strip
// ---------------------------------------------------------------------------
const slideList = $('#slide-list');

function gotoSlide(id, { emit = true } = {}) {
  if (!slideById(id) || id === state.slideId) return;
  state.slideId = id;
  state.selection = [];
  state.marquee = null;
  state.cursors.clear();     // cursors are per-slide
  state.remoteDrafts.clear();
  if (emit) socket.emit('slide:goto', id);
  renderSlideStrip();
  fitSlide();
  draw();
}

function renderSlideStrip() {
  slideList.innerHTML = '';
  state.slides.forEach((slide, i) => {
    const item = document.createElement('div');
    item.className = `slide-item${slide.id === state.slideId ? ' active' : ''}`;
    item.draggable = true;
    item.dataset.id = slide.id;
    item.setAttribute('role', 'tab');
    item.title = slide.name;

    const cv = document.createElement('canvas');
    cv.width = 264; cv.height = 168; // 2x for crispness
    item.appendChild(cv);

    const num = document.createElement('span');
    num.className = 'slide-num';
    num.textContent = i + 1;
    item.appendChild(num);

    // Dots showing who else is on this slide.
    const peers = state.users.filter((u) => u.slideId === slide.id && u.id !== state.me?.id);
    if (peers.length) {
      const wrap = document.createElement('div');
      wrap.className = 'slide-peers';
      for (const p of peers.slice(0, 5)) {
        const dot = document.createElement('i');
        dot.style.background = p.color;
        dot.title = p.name;
        wrap.appendChild(dot);
      }
      item.appendChild(wrap);
    }

    const menu = document.createElement('button');
    menu.className = 'slide-menu';
    menu.textContent = '⋯';
    menu.title = 'Slide options';
    menu.addEventListener('click', (e) => {
      e.stopPropagation();
      openSlideMenu(slide, item);
    });
    item.appendChild(menu);

    item.addEventListener('click', () => gotoSlide(slide.id));

    // Drag to reorder.
    item.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', slide.id);
      e.dataTransfer.effectAllowed = 'move';
      item.classList.add('dragging');
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      slideList.querySelectorAll('.slide-item').forEach((el) => el.classList.remove('drag-over'));
    });
    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      item.classList.add('drag-over');
    });
    item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
    item.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      item.classList.remove('drag-over');
      const draggedId = e.dataTransfer.getData('text/plain');
      if (!draggedId || draggedId === slide.id) return;

      const order = state.slides.map((s) => s.id);
      const from = order.indexOf(draggedId);
      const to = order.indexOf(slide.id);
      if (from === -1 || to === -1) return;
      order.splice(to, 0, order.splice(from, 1)[0]);
      socket.emit('slide:reorder', order);
    });

    slideList.appendChild(item);
    paintThumb(slide, cv);
  });
}

/** Render a slide into a thumbnail canvas, scaled to fit the 16:9 frame. */
function paintThumb(slide, cv) {
  const c = cv.getContext('2d');
  const scale = cv.width / SLIDE_W;

  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, cv.width, cv.height);
  c.fillStyle = document.documentElement.dataset.theme === 'dark' ? '#0b1120' : '#ffffff';
  c.fillRect(0, 0, cv.width, cv.height);

  c.save();
  c.scale(scale, scale);
  for (const shape of slide.shapes) {
    try { drawShape(c, shape, () => queueThumb(slide.id)); } catch {}
  }
  c.restore();
}

// Thumbnails are cheap but not free; repaint at most once per frame per slide.
const pendingThumbs = new Set();
let thumbQueued = false;
function queueThumb(slideId) {
  if (!slideId) return;
  pendingThumbs.add(slideId);
  if (thumbQueued) return;
  thumbQueued = true;
  requestAnimationFrame(() => {
    thumbQueued = false;
    for (const id of pendingThumbs) {
      const slide = slideById(id);
      const cv = slideList.querySelector(`.slide-item[data-id="${id}"] canvas`);
      if (slide && cv) paintThumb(slide, cv);
    }
    pendingThumbs.clear();
  });
}

function refreshAllThumbs() {
  state.slides.forEach((s) => queueThumb(s.id));
}

function openSlideMenu(slide, anchor) {
  document.querySelector('.slide-context')?.remove();
  const menu = document.createElement('div');
  menu.className = 'dropdown slide-context';
  menu.style.position = 'fixed';

  const rect = anchor.getBoundingClientRect();
  menu.style.left = `${rect.left}px`;
  menu.style.bottom = `${innerHeight - rect.top + 6}px`;

  const act = (label, fn) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', () => { menu.remove(); fn(); });
    menu.appendChild(b);
  };

  act('Duplicate', () => socket.emit('slide:duplicate', slide.id, (r) => {
    if (r?.error) toast(r.error);
    else if (r?.slideId) gotoSlide(r.slideId);
  }));
  act('Rename…', () => {
    const name = prompt('Slide name', slide.name);
    if (name?.trim()) socket.emit('slide:rename', { slideId: slide.id, name: name.trim() });
  });
  act('Delete', () => {
    if (state.slides.length <= 1) return toast('A deck needs at least one slide.');
    if (confirm(`Delete "${slide.name}"?`)) {
      socket.emit('slide:delete', slide.id, (r) => r?.error && toast(r.error));
    }
  });

  document.body.appendChild(menu);
  // Close on the next click anywhere else.
  setTimeout(() => {
    addEventListener('click', function close() {
      menu.remove();
      removeEventListener('click', close);
    }, { once: true });
  }, 0);
}

$('#slide-add').addEventListener('click', () => {
  socket.emit('slide:add', state.slideId, (r) => {
    if (r?.error) toast(r.error);
    else if (r?.slideId) gotoSlide(r.slideId);
  });
});

/** Frame the 16:9 slide in the viewport, leaving room for the strip. */
function fitSlide() {
  fitTo({ minX: 0, minY: 0, maxX: SLIDE_W, maxY: SLIDE_H },
    innerWidth, innerHeight - 150, 60);
  // Nudge up so the slide sits above the strip rather than behind it.
  camera.y -= 34;
  updateZoomLabel();
  draw();
}

// ---------------------------------------------------------------------------
// Presentation mode
// ---------------------------------------------------------------------------
const presentEl = $('#present-mode');
const presentCanvas = $('#present-canvas');
let presenting = false;

function renderPresentSlide() {
  const slide = activeSlide();
  if (!slide) return;

  // Render at the display's pixel density, capped so huge screens don't
  // allocate an enormous backing store.
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const scale = Math.min(innerWidth / SLIDE_W, innerHeight / SLIDE_H);
  presentCanvas.width = Math.floor(SLIDE_W * scale * dpr);
  presentCanvas.height = Math.floor(SLIDE_H * scale * dpr);
  presentCanvas.style.width = `${SLIDE_W * scale}px`;
  presentCanvas.style.height = `${SLIDE_H * scale}px`;

  const c = presentCanvas.getContext('2d');
  c.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
  c.fillStyle = slide.background
    || (document.documentElement.dataset.theme === 'dark' ? '#0b1120' : '#ffffff');
  c.fillRect(0, 0, SLIDE_W, SLIDE_H);

  for (const shape of slide.shapes) {
    try { drawShape(c, shape, renderPresentSlide); } catch {}
  }
  $('#present-count').textContent = `${slideIndex() + 1} / ${state.slides.length}`;
}

function stepSlide(delta) {
  const next = state.slides[slideIndex() + delta];
  if (!next) return;
  gotoSlide(next.id);
  if (presenting) renderPresentSlide();
}

function startPresenting() {
  presenting = true;
  presentEl.hidden = false;
  renderPresentSlide();
  document.documentElement.requestFullscreen?.().catch(() => {});
}

function stopPresenting() {
  presenting = false;
  presentEl.hidden = true;
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
}

$('#present').addEventListener('click', startPresenting);
$('#present-exit').addEventListener('click', stopPresenting);
$('#present-prev').addEventListener('click', () => stepSlide(-1));
$('#present-next').addEventListener('click', () => stepSlide(1));
presentCanvas.addEventListener('click', () => stepSlide(1));
addEventListener('resize', () => presenting && renderPresentSlide());

// ---------------------------------------------------------------------------
// PPTX import / export
// ---------------------------------------------------------------------------
function setBusy(text) {
  const el = $('#busy');
  if (!text) { el.hidden = true; return; }
  $('#busy-text').textContent = text;
  el.hidden = false;
}

$('#import-pptx').addEventListener('click', () => $('#pptx-input').click());

$('#pptx-input').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = ''; // let the same file be picked again
  if (!file) return;

  const hasContent = state.slides.some((s) => s.shapes.length);
  const mode = hasContent
    ? (confirm('Replace the current deck with this file?\n\nOK = replace   Cancel = add slides to the end')
        ? 'replace' : 'append')
    : 'replace';

  setBusy('Reading presentation…');
  try {
    const { importPptx, normalizeImported } = await import('./pptx.js');
    const slides = normalizeImported(
      await importPptx(file, (n, total) => setBusy(`Reading slide ${n} of ${total}…`)),
    );
    setBusy('Uploading…');
    socket.emit('deck:import', { slides, mode }, (r) => {
      setBusy(null);
      if (r?.error) toast(r.error);
      else toast(`Imported ${r.count} slide${r.count === 1 ? '' : 's'}`);
    });
  } catch (err) {
    setBusy(null);
    toast(err.message || 'Could not read that file');
    console.error('[import]', err);
  }
});

// Export dropdown
const exportMenu = $('#export-menu');
$('#export').addEventListener('click', (e) => {
  e.stopPropagation();
  exportMenu.hidden = !exportMenu.hidden;
});
addEventListener('click', () => { exportMenu.hidden = true; });
exportMenu.addEventListener('click', (e) => e.stopPropagation());

exportMenu.addEventListener('click', async (e) => {
  const kind = e.target.dataset?.export;
  if (!kind) return;
  exportMenu.hidden = true;

  if (kind === 'pptx') {
    setBusy('Building PowerPoint…');
    try {
      const { exportPptx } = await import('./pptx.js');
      await exportPptx(state.slides, `board-${roomId}`, document.documentElement.dataset.theme);
      toast('PPTX downloaded');
    } catch (err) {
      toast('Export failed — see console');
      console.error('[export]', err);
    } finally {
      setBusy(null);
    }
    return;
  }

  if (kind === 'json') {
    const blob = new Blob([JSON.stringify({ slides: state.slides }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `board-${roomId}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('JSON downloaded');
    return;
  }

  exportSlidePng();
});

/** PNG of the current slide's frame, at 2x for a crisp image. */
function exportSlidePng() {
  const slide = activeSlide();
  if (!slide) return;
  const scale = 2;
  const out = document.createElement('canvas');
  out.width = SLIDE_W * scale;
  out.height = SLIDE_H * scale;
  const c = out.getContext('2d');

  c.fillStyle = slide.background
    || (document.documentElement.dataset.theme === 'dark' ? '#0b1120' : '#ffffff');
  c.fillRect(0, 0, out.width, out.height);
  c.scale(scale, scale);
  for (const shape of slide.shapes) {
    try { drawShape(c, shape, null); } catch {}
  }

  const a = document.createElement('a');
  a.download = `${slide.name.replace(/\s+/g, '-')}.png`;
  a.href = out.toDataURL('image/png');
  a.click();
  toast('PNG downloaded');
}

// ---------------------------------------------------------------------------
// Users & chat
// ---------------------------------------------------------------------------
function renderUsers() {
  const wrap = $('#avatars');
  wrap.innerHTML = '';
  for (const u of state.users.slice(0, 6)) {
    const el = document.createElement('div');
    el.className = 'avatar';
    el.style.background = u.color;
    el.textContent = u.name.slice(0, 2).toUpperCase();
    el.title = u.id === state.me?.id ? `${u.name} (you)` : u.name;
    wrap.appendChild(el);
  }
  if (state.users.length > 6) {
    const more = document.createElement('div');
    more.className = 'avatar';
    more.style.background = '#64748b';
    more.textContent = `+${state.users.length - 6}`;
    wrap.appendChild(more);
  }
}

function addChatMessage(msg) {
  const log = $('#chat-log');
  const el = document.createElement('div');
  el.className = msg.system ? 'msg system' : 'msg';
  if (msg.system) {
    el.textContent = msg.text;
  } else {
    const time = new Date(msg.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const who = document.createElement('span');
    who.className = 'who';
    who.style.color = msg.color;
    who.textContent = msg.name;
    el.append(who, document.createTextNode(msg.text));
    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = time;
    el.append(when);
  }
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
}

$('#chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text) return;
  socket.emit('chat', text);
  input.value = '';
});

function toggleChat(show) {
  const panel = $('#chat');
  panel.hidden = show === undefined ? !panel.hidden : !show;
  if (!panel.hidden) { $('#chat-badge').hidden = true; $('#chat-input').focus(); }
}
$('#chat-toggle').addEventListener('click', () => toggleChat());
$('#chat-close').addEventListener('click', () => toggleChat(false));

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------
let spaceHeld = false;

const TOOL_KEYS = {
  v: 'select', p: 'pen', h: 'highlighter', e: 'eraser', l: 'line',
  a: 'arrow', r: 'rect', o: 'ellipse', t: 'text', n: 'note', i: 'image',
};

addEventListener('keydown', (e) => {
  const typing = ['INPUT', 'TEXTAREA'].includes(e.target.tagName);
  if (typing) return;

  // Presentation mode swallows everything except navigation and exit.
  if (presenting) {
    if (e.key === 'Escape') { e.preventDefault(); stopPresenting(); }
    else if (['ArrowRight', 'ArrowDown', ' ', 'PageDown', 'Enter'].includes(e.key)) { e.preventDefault(); stepSlide(1); }
    else if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.key)) { e.preventDefault(); stepSlide(-1); }
    return;
  }

  if (e.key === 'F5') { e.preventDefault(); startPresenting(); return; }

  const mod = e.ctrlKey || e.metaKey;

  // Ctrl+M adds a slide; Ctrl+PageUp/PageDown walk the deck.
  if (mod && e.key.toLowerCase() === 'm') {
    e.preventDefault();
    $('#slide-add').click();
    return;
  }
  if (mod && e.key === 'PageDown') { e.preventDefault(); stepSlide(1); return; }
  if (mod && e.key === 'PageUp') { e.preventDefault(); stepSlide(-1); return; }

  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    socket.emit(e.shiftKey ? 'history:redo' : 'history:undo');
    return;
  }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); socket.emit('history:redo'); return; }
  if (mod && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    setTool('select');
    state.selection = [...state.shapes];
    draw();
    return;
  }
  if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoomAt(innerWidth / 2, innerHeight / 2, 1.2); updateZoomLabel(); draw(); return; }
  if (mod && e.key === '-') { e.preventDefault(); zoomAt(innerWidth / 2, innerHeight / 2, 1 / 1.2); updateZoomLabel(); draw(); return; }
  if (mod && e.key === '0') { e.preventDefault(); resetZoom(innerWidth, innerHeight); updateZoomLabel(); draw(); return; }
  if (mod && e.key.toLowerCase() === 'd' && state.selection.length) {
    // Duplicate, offset slightly so the copy is visible.
    e.preventDefault();
    const copies = state.selection.map((s) => ({ ...translateShape(s, 20, 20), id: uid() }));
    copies.forEach(commitShape);
    state.selection = copies;
    draw();
    return;
  }
  if (mod) return; // leave other browser shortcuts alone

  if (e.key === ' ' && !spaceHeld) { spaceHeld = true; boardCanvas.classList.add('tool-pan'); e.preventDefault(); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (state.selection.length) {
      e.preventDefault();
      socket.emit('shape:delete', { slideId: state.slideId, ids: state.selection.map((s) => s.id) });
      state.selection = [];
      draw();
    }
    return;
  }
  if (e.key === 'Escape') { state.selection = []; state.marquee = null; draw(); return; }
  if (e.key === '!' || (e.shiftKey && e.key === '1')) { fitBoard(); return; }

  const key = e.key.toLowerCase();
  if (TOOL_KEYS[key]) { setTool(TOOL_KEYS[key]); return; }
  if (key === 'g') { $('#grid-toggle').click(); return; }
  if (key === 'd') { $('#theme-toggle').click(); return; }
  if (key === 'c') { toggleChat(); return; }

  // Arrow keys nudge the selection; Shift makes it a bigger step.
  const nudge = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
  if (nudge && state.selection.length) {
    e.preventDefault();
    const step = (e.shiftKey ? 10 : 1);
    state.selection = state.selection.map((sel) => {
      const i = state.shapes.findIndex((s) => s.id === sel.id);
      const moved = translateShape(state.shapes[i], nudge[0] * step, nudge[1] * step);
      state.shapes[i] = moved;
      return moved;
    });
    socket.emit('shape:update:batch', { slideId: state.slideId, shapes: state.selection });
    draw();
  }
});

addEventListener('keyup', (e) => {
  if (e.key === ' ') {
    spaceHeld = false;
    boardCanvas.className = `tool-${state.tool}`;
  }
});

// ---------------------------------------------------------------------------
// Misc UI
// ---------------------------------------------------------------------------
/**
 * Persistent banner for ephemeral hosting. Deliberately not a toast: losing a
 * whole lesson's work is worth an explicit dismissal rather than a 2s flash.
 */
function showEphemeralNotice() {
  const bar = document.createElement('div');
  bar.id = 'ephemeral-notice';
  bar.innerHTML = `
    <span>⚠️ <strong>Boards are temporary on this server</strong> — they are lost
    when it restarts or sleeps. Export anything you want to keep (⬇ menu).</span>
  `;
  const close = document.createElement('button');
  close.textContent = '✕';
  close.setAttribute('aria-label', 'Dismiss');
  close.addEventListener('click', () => bar.remove());
  bar.appendChild(close);
  document.body.appendChild(bar);
}

let toastTimer;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

function myName() { return localStorage.getItem('board:name') || ''; }

// Ask for a name once, then remember it.
const welcome = $('#welcome');
if (myName()) {
  welcome.hidden = true;
} else {
  $('#name-input').focus();
}
$('#welcome-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('#name-input').value.trim();
  if (!name) return;
  localStorage.setItem('board:name', name);
  welcome.hidden = true;
  socket.emit('rename', name);
});

// Warn before navigating away mid-stroke.
addEventListener('beforeunload', (e) => {
  if (state.draft) { e.preventDefault(); e.returnValue = ''; }
});

resize();
updateZoomLabel();
setTool('pen');
