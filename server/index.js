import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { customAlphabet } from 'nanoid';
import {
  getRoom, getSlide, scheduleSave, saveAllRooms, evictEmptyRooms,
  isValidRoomId, roomIsFull, pushHistory, emptySlide, newSlideId,
  MAX_SHAPES_PER_ROOM, MAX_SLIDES,
} from './store.js';
import {
  authEnabled, checkPassword, issueToken, verifyToken, isAuthed,
  readCookie, cookieHeader, clearCookieHeader,
  rateLimited, noteFailure, clearFailures,
} from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
let attemptedPort = Number(PORT);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const isProd = process.env.NODE_ENV === 'production';

const newRoomId = customAlphabet('abcdefghijkmnopqrstuvwxyz23456789', 8);

const app = express();
// Behind Render/Fly/Heroku's proxy, req.secure and req.ip only read correctly
// once Express is told to trust the forwarding headers.
if (isProd) app.set('trust proxy', 1);

const httpServer = createServer(app);
const io = new Server(httpServer, {
  maxHttpBufferSize: 4e6, // room for a pasted image, not for arbitrary uploads
  // Same-origin only in production; the dev default stays permissive so the
  // test harness can connect from another port.
  cors: isProd ? { origin: false } : { origin: true },
});

// ---- Auth gate ------------------------------------------------------------
// Everything below this point is behind the password when one is configured.

app.get('/api/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.get('/login', (req, res) => {
  if (isAuthed(req)) return res.redirect('/');
  res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});

app.post('/login', express.urlencoded({ extended: false, limit: '4kb' }), (req, res) => {
  const ip = req.ip || 'unknown';
  // Only same-site paths are accepted, so ?next= can't be used as an open redirect.
  const raw = typeof req.body?.next === 'string' ? req.body.next : '/';
  const next = /^\/(?!\/)/.test(raw) ? raw : '/';

  if (rateLimited(ip)) {
    return res.redirect(`/login?err=rate&next=${encodeURIComponent(next)}`);
  }
  if (!checkPassword(req.body?.password)) {
    noteFailure(ip);
    return res.redirect(`/login?err=1&next=${encodeURIComponent(next)}`);
  }

  clearFailures(ip);
  res.setHeader('Set-Cookie', cookieHeader(issueToken(), { secure: isProd }));
  res.redirect(next);
});

app.post('/logout', (_req, res) => {
  res.setHeader('Set-Cookie', clearCookieHeader());
  res.redirect('/login');
});

app.use((req, res, nextFn) => {
  if (isAuthed(req)) return nextFn();
  // Bounce API/XHR callers with a status instead of an HTML redirect.
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  res.redirect(`/login?next=${encodeURIComponent(req.originalUrl || '/')}`);
});

// ---- Protected routes -----------------------------------------------------
app.use(express.static(PUBLIC_DIR, {
  // login.html is served explicitly above; don't expose it as a static asset.
  index: false,
  setHeaders(res, filePath) {
    if (filePath.endsWith('vendor' + path.sep + 'pptxgen.es.js')
      || filePath.endsWith('vendor' + path.sep + 'jszip.umd.js')) {
      // Vendored libraries are versioned by content and never change in place.
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  },
}));

// Landing on the bare host mints a fresh room so a first-time visitor
// always arrives somewhere valid.
app.get('/', (_req, res) => res.redirect(`/board/${newRoomId()}`));

app.get('/board/:roomId', (req, res) => {
  if (!isValidRoomId(req.params.roomId)) return res.redirect(`/board/${newRoomId()}`);
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ---- Socket auth ----------------------------------------------------------
// The HTTP gate does not cover WebSocket upgrades, so check the same cookie
// during the handshake — otherwise the board would be wide open over sockets.
io.use((socket, nextFn) => {
  if (!authEnabled) return nextFn();
  if (verifyToken(readCookie(socket.handshake.headers?.cookie))) return nextFn();
  nextFn(new Error('unauthorized'));
});

const USER_COLORS = [
  '#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6',
  '#3b82f6', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16',
];

/** Trim and cap free text so one client cannot broadcast a novel. */
function clean(str, max) {
  return typeof str === 'string' ? str.slice(0, max).trim() : '';
}

/**
 * Reject anything that is not a plain, sanely-sized shape object.
 * The client is untrusted: everything persisted goes through here.
 */
function sanitizeShape(shape) {
  if (!shape || typeof shape !== 'object' || Array.isArray(shape)) return null;
  if (typeof shape.id !== 'string' || shape.id.length > 64) return null;
  const allowed = new Set(['path', 'rect', 'ellipse', 'line', 'arrow', 'text', 'image', 'note']);
  if (!allowed.has(shape.type)) return null;

  // Serialize-and-measure catches deeply nested or oversized payloads
  // (e.g. a huge pasted image) in one shot.
  let encoded;
  try { encoded = JSON.stringify(shape); } catch { return null; }
  if (!encoded || encoded.length > 2_000_000) return null;

  return JSON.parse(encoded);
}

function publicUsers(room) {
  return [...room.users.values()].map((u) => ({
    id: u.id, name: u.name, color: u.color, slideId: u.slideId,
  }));
}

io.on('connection', (socket) => {
  let roomId = null;

  socket.on('join', ({ room: requestedRoom, name } = {}, ack) => {
    if (!isValidRoomId(requestedRoom)) {
      ack?.({ error: 'Invalid room id' });
      return;
    }
    roomId = requestedRoom;
    const room = getRoom(roomId);

    const user = {
      id: socket.id,
      name: clean(name, 24) || `Guest ${socket.id.slice(0, 4)}`,
      color: USER_COLORS[room.users.size % USER_COLORS.length],
      cursor: null,
      slideId: room.slides[0].id,
    };
    room.users.set(socket.id, user);
    socket.join(roomId);

    // Send the joiner the whole deck; tell everyone else someone arrived.
    ack?.({
      you: { id: user.id, name: user.name, color: user.color },
      slides: room.slides,
      chat: room.chat.slice(-50),
      users: publicUsers(room),
      limits: { maxShapes: MAX_SHAPES_PER_ROOM, maxSlides: MAX_SLIDES },
      authEnabled,
    });
    socket.to(roomId).emit('user:joined', { id: user.id, name: user.name, color: user.color });
    io.to(roomId).emit('users', publicUsers(room));
  });

  /** The slide this socket is currently looking at. */
  function currentSlideId() {
    return roomId ? getRoom(roomId).users.get(socket.id)?.slideId : null;
  }

  /** Guard every board event: must be in a room, and the room must exist. */
  function withRoom(handler) {
    return (...args) => {
      if (!roomId) return;
      const room = getRoom(roomId);
      if (!room.users.has(socket.id)) return;
      handler(room, ...args);
    };
  }

  // ---- Live drawing ------------------------------------------------------
  // In-progress strokes are relayed but never stored; only the finished
  // shape from 'shape:add' is committed to the board.
  socket.on('draw:progress', withRoom((room, payload) => {
    socket.to(room.id).emit('draw:progress', {
      from: socket.id, payload, slideId: currentSlideId(),
    });
  }));

  socket.on('shape:add', withRoom((room, msg, ack) => {
    if (roomIsFull(room)) {
      ack?.({ error: 'Board is full. Clear some shapes to continue.' });
      return;
    }
    // Accept {slideId, shape} but tolerate a bare shape from an older client.
    const { slideId, shape } = msg?.shape ? msg : { slideId: null, shape: msg };
    const clean_ = sanitizeShape(shape);
    if (!clean_) { ack?.({ error: 'Invalid shape' }); return; }

    const slide = getSlide(room, slideId ?? currentSlideId());
    clean_.author = socket.id;
    slide.shapes.push(clean_);
    pushHistory(room, { type: 'add', slideId: slide.id, shapes: [clean_.id] });
    scheduleSave(room.id);

    socket.to(room.id).emit('shape:add', { slideId: slide.id, shape: clean_ });
    ack?.({ ok: true });
  }));

  socket.on('shape:update', withRoom((room, msg) => {
    const { slideId, shape } = msg?.shape ? msg : { slideId: null, shape: msg };
    applyUpdates(room, [shape], slideId);
  }));

  // Moving a multi-shape selection arrives as one batch so undo treats the
  // whole drag as a single step instead of one step per shape.
  socket.on('shape:update:batch', withRoom((room, msg) => {
    const { slideId, shapes } = Array.isArray(msg) ? { slideId: null, shapes: msg } : (msg || {});
    if (Array.isArray(shapes) && shapes.length) applyUpdates(room, shapes.slice(0, 500), slideId);
  }));

  function applyUpdates(room, list, slideId) {
    const slide = getSlide(room, slideId ?? currentSlideId());
    const before = [];
    const after = [];
    for (const updated of list) {
      const clean_ = sanitizeShape(updated);
      if (!clean_) continue;
      const idx = slide.shapes.findIndex((s) => s.id === clean_.id);
      if (idx === -1) continue;

      before.push(slide.shapes[idx]);
      slide.shapes[idx] = { ...clean_, author: slide.shapes[idx].author };
      after.push(slide.shapes[idx]);
    }
    if (!after.length) return;

    pushHistory(room, { type: 'update', slideId: slide.id, before, after });
    scheduleSave(room.id);
    for (const shape of after) socket.to(room.id).emit('shape:update', { slideId: slide.id, shape });
  }

  // Dragging fires continuously; relay the live position without touching
  // history, then let the final 'shape:update' commit it.
  socket.on('shape:transient', withRoom((room, msg) => {
    const { slideId, shape } = msg?.shape ? msg : { slideId: currentSlideId(), shape: msg };
    if (!shape || typeof shape.id !== 'string') return;
    socket.to(room.id).emit('shape:transient', { slideId, shape });
  }));

  socket.on('shape:delete', withRoom((room, msg) => {
    const { slideId, ids } = Array.isArray(msg) ? { slideId: null, ids: msg } : (msg || {});
    if (!Array.isArray(ids)) return;
    const slide = getSlide(room, slideId ?? currentSlideId());
    const idSet = new Set(ids.filter((i) => typeof i === 'string'));
    const removed = slide.shapes.filter((s) => idSet.has(s.id));
    if (removed.length === 0) return;

    slide.shapes = slide.shapes.filter((s) => !idSet.has(s.id));
    pushHistory(room, { type: 'remove', slideId: slide.id, shapes: removed });
    scheduleSave(room.id);
    io.to(room.id).emit('shape:delete', { slideId: slide.id, ids: [...idSet] });
  }));

  // Clears only the slide in view, not the whole deck.
  socket.on('board:clear', withRoom((room, slideId) => {
    const slide = getSlide(room, slideId ?? currentSlideId());
    if (slide.shapes.length === 0) return;
    pushHistory(room, { type: 'remove', slideId: slide.id, shapes: slide.shapes });
    slide.shapes = [];
    scheduleSave(room.id);
    io.to(room.id).emit('board:clear', { slideId: slide.id });
  }));

  // ---- Undo / redo -------------------------------------------------------
  // History is shared per-room rather than per-user: with a single shape list
  // and free-form editing, per-user stacks would let one person's undo
  // resurrect a shape another person already moved.
  function applyInverse(room, op, invert) {
    // Slide-level ops restore the deck itself rather than a shape list.
    if (op.type === 'slide:add') {
      if (invert) {
        room.slides = room.slides.filter((s) => s.id !== op.slide.id);
      } else if (!room.slides.some((s) => s.id === op.slide.id)) {
        room.slides.splice(Math.min(op.index, room.slides.length), 0, op.slide);
      }
      io.to(room.id).emit('slides:sync', room.slides);
      return;
    }
    if (op.type === 'slide:remove') {
      if (invert) {
        if (!room.slides.some((s) => s.id === op.slide.id)) {
          room.slides.splice(Math.min(op.index, room.slides.length), 0, op.slide);
        }
      } else {
        room.slides = room.slides.filter((s) => s.id !== op.slide.id);
      }
      io.to(room.id).emit('slides:sync', room.slides);
      return;
    }
    if (op.type === 'slide:reorder') {
      const order = invert ? op.before : op.after;
      const byId = new Map(room.slides.map((s) => [s.id, s]));
      const next = order.map((id) => byId.get(id)).filter(Boolean);
      if (next.length === room.slides.length) room.slides = next;
      io.to(room.id).emit('slides:sync', room.slides);
      return;
    }

    // Shape ops act on the slide they were recorded against, which may not
    // be the slide the person pressing undo is currently viewing.
    const slide = getSlide(room, op.slideId);
    if (!slide) return;

    if (op.type === 'add') {
      // undo of add === remove; redo === re-add
      if (invert) {
        const ids = new Set(op.shapes);
        op.removed = slide.shapes.filter((s) => ids.has(s.id));
        slide.shapes = slide.shapes.filter((s) => !ids.has(s.id));
        io.to(room.id).emit('shape:delete', { slideId: slide.id, ids: [...ids] });
      } else {
        for (const s of op.removed || []) slide.shapes.push(s);
        io.to(room.id).emit('shapes:restore', { slideId: slide.id, shapes: op.removed || [] });
      }
    } else if (op.type === 'remove') {
      if (invert) {
        for (const s of op.shapes) slide.shapes.push(s);
        io.to(room.id).emit('shapes:restore', { slideId: slide.id, shapes: op.shapes });
      } else {
        const ids = new Set(op.shapes.map((s) => s.id));
        slide.shapes = slide.shapes.filter((s) => !ids.has(s.id));
        io.to(room.id).emit('shape:delete', { slideId: slide.id, ids: [...ids] });
      }
    } else if (op.type === 'update') {
      // before/after are parallel arrays so a batched drag undoes in one step.
      for (const target of invert ? op.before : op.after) {
        const idx = slide.shapes.findIndex((s) => s.id === target.id);
        if (idx !== -1) {
          slide.shapes[idx] = target;
          io.to(room.id).emit('shape:update', { slideId: slide.id, shape: target });
        }
      }
    }
  }

  socket.on('history:undo', withRoom((room) => {
    const op = room.undoStack.pop();
    if (!op) return;
    applyInverse(room, op, true);
    room.redoStack.push(op);
    scheduleSave(room.id);
  }));

  socket.on('history:redo', withRoom((room) => {
    const op = room.redoStack.pop();
    if (!op) return;
    applyInverse(room, op, false);
    room.undoStack.push(op);
    scheduleSave(room.id);
  }));

  // ---- Slides ------------------------------------------------------------
  socket.on('slide:goto', withRoom((room, slideId) => {
    const slide = getSlide(room, slideId);
    const user = room.users.get(socket.id);
    if (!slide || !user) return;
    user.slideId = slide.id;
    // Cursors are per-slide; drop the stale position so a viewer on another
    // slide doesn't see a ghost pointer.
    user.cursor = null;
    io.to(room.id).emit('users', publicUsers(room));
  }));

  socket.on('slide:add', withRoom((room, afterId, ack) => {
    if (room.slides.length >= MAX_SLIDES) {
      ack?.({ error: `Deck is limited to ${MAX_SLIDES} slides.` });
      return;
    }
    const at = room.slides.findIndex((s) => s.id === afterId);
    const index = at === -1 ? room.slides.length : at + 1;
    const slide = emptySlide(`Slide ${room.slides.length + 1}`);
    room.slides.splice(index, 0, slide);

    pushHistory(room, { type: 'slide:add', slide, index });
    scheduleSave(room.id);
    io.to(room.id).emit('slides:sync', room.slides);
    ack?.({ ok: true, slideId: slide.id });
  }));

  socket.on('slide:duplicate', withRoom((room, slideId, ack) => {
    if (room.slides.length >= MAX_SLIDES) {
      ack?.({ error: `Deck is limited to ${MAX_SLIDES} slides.` });
      return;
    }
    const at = room.slides.findIndex((s) => s.id === slideId);
    if (at === -1) return;
    const src = room.slides[at];
    // Fresh ids throughout, or the copy would share identity with the original.
    const copy = {
      id: newSlideId(),
      name: `${src.name} copy`,
      background: src.background,
      shapes: src.shapes.map((s) => ({ ...s, id: `${s.id}-c${Math.random().toString(36).slice(2, 7)}` })),
    };
    room.slides.splice(at + 1, 0, copy);

    pushHistory(room, { type: 'slide:add', slide: copy, index: at + 1 });
    scheduleSave(room.id);
    io.to(room.id).emit('slides:sync', room.slides);
    ack?.({ ok: true, slideId: copy.id });
  }));

  socket.on('slide:delete', withRoom((room, slideId, ack) => {
    // A deck always keeps at least one slide.
    if (room.slides.length <= 1) { ack?.({ error: 'A deck needs at least one slide.' }); return; }
    const index = room.slides.findIndex((s) => s.id === slideId);
    if (index === -1) return;

    const [slide] = room.slides.splice(index, 1);
    pushHistory(room, { type: 'slide:remove', slide, index });

    // Move anyone stranded on the deleted slide to a neighbouring one.
    const fallback = room.slides[Math.min(index, room.slides.length - 1)];
    for (const u of room.users.values()) {
      if (u.slideId === slideId) u.slideId = fallback.id;
    }
    scheduleSave(room.id);
    io.to(room.id).emit('slides:sync', room.slides);
    io.to(room.id).emit('users', publicUsers(room));
    ack?.({ ok: true });
  }));

  socket.on('slide:rename', withRoom((room, { slideId, name } = {}) => {
    const slide = getSlide(room, slideId);
    const next = clean(name, 60);
    if (!slide || !next) return;
    slide.name = next;
    scheduleSave(room.id);
    io.to(room.id).emit('slides:sync', room.slides);
  }));

  socket.on('slide:reorder', withRoom((room, order) => {
    if (!Array.isArray(order) || order.length !== room.slides.length) return;
    const before = room.slides.map((s) => s.id);
    const byId = new Map(room.slides.map((s) => [s.id, s]));
    const next = order.map((id) => byId.get(id)).filter(Boolean);
    // Reject a reorder that would drop or duplicate a slide.
    if (next.length !== room.slides.length) return;

    room.slides = next;
    pushHistory(room, { type: 'slide:reorder', before, after: order });
    scheduleSave(room.id);
    io.to(room.id).emit('slides:sync', room.slides);
  }));

  /** Replace or append a whole deck — used by PPTX import. */
  socket.on('deck:import', withRoom((room, { slides, mode } = {}, ack) => {
    if (!Array.isArray(slides) || !slides.length) {
      ack?.({ error: 'Nothing to import' });
      return;
    }
    const incoming = slides.slice(0, MAX_SLIDES).map((s, i) => ({
      id: newSlideId(),
      name: clean(s?.name, 60) || `Slide ${i + 1}`,
      background: typeof s?.background === 'string' ? s.background : null,
      shapes: (Array.isArray(s?.shapes) ? s.shapes : [])
        .map(sanitizeShape)
        .filter(Boolean)
        .slice(0, 2000),
    }));

    if (mode === 'append') {
      const room_ = room.slides.concat(incoming).slice(0, MAX_SLIDES);
      room.slides = room_;
    } else {
      room.slides = incoming;
    }
    // An import is a wholesale replacement; a partial undo of it would be
    // more confusing than helpful, so the history restarts here.
    room.undoStack.length = 0;
    room.redoStack.length = 0;

    for (const u of room.users.values()) u.slideId = room.slides[0].id;
    scheduleSave(room.id);
    io.to(room.id).emit('slides:sync', room.slides);
    io.to(room.id).emit('users', publicUsers(room));
    ack?.({ ok: true, count: incoming.length });
  }));

  // ---- Presence ----------------------------------------------------------
  socket.on('cursor', withRoom((room, pos) => {
    const user = room.users.get(socket.id);
    if (!user || !pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') return;
    user.cursor = { x: pos.x, y: pos.y };
    // Tag the slide so viewers only render cursors for the slide they're on.
    socket.to(room.id).emit('cursor', {
      id: socket.id, name: user.name, color: user.color,
      x: pos.x, y: pos.y, slideId: user.slideId,
    });
  }));

  socket.on('chat', withRoom((room, text) => {
    const body = clean(text, 500);
    if (!body) return;
    const user = room.users.get(socket.id);
    const msg = { id: `${Date.now()}-${socket.id}`, name: user.name, color: user.color, text: body, at: Date.now() };
    room.chat.push(msg);
    if (room.chat.length > 200) room.chat.shift();
    scheduleSave(room.id);
    io.to(room.id).emit('chat', msg);
  }));

  socket.on('rename', withRoom((room, name) => {
    const user = room.users.get(socket.id);
    const next = clean(name, 24);
    if (!next) return;
    user.name = next;
    io.to(room.id).emit('users', publicUsers(room));
  }));

  socket.on('disconnect', () => {
    if (!roomId) return;
    const room = getRoom(roomId);
    room.users.delete(socket.id);
    io.to(roomId).emit('user:left', { id: socket.id });
    io.to(roomId).emit('users', publicUsers(room));
    if (room.users.size === 0) scheduleSave(roomId);
  });
});

setInterval(evictEmptyRooms, 5 * 60 * 1000).unref();

httpServer.listen(PORT, () => {
  console.log(`\n  Online Board running at http://localhost:${httpServer.address().port}\n`);
});

// Another app may already own the default port; step to the next free one
// instead of dying, unless the user pinned a port explicitly.
httpServer.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') throw err;
  if (process.env.PORT) {
    console.error(`\n  Port ${PORT} is already in use. Set a different PORT and retry.\n`);
    process.exit(1);
  }
  attemptedPort += 1;
  if (attemptedPort > Number(PORT) + 20) {
    console.error('\n  Could not find a free port. Set PORT and retry.\n');
    process.exit(1);
  }
  console.warn(`  Port ${attemptedPort - 1} is busy, trying ${attemptedPort}…`);
  setTimeout(() => httpServer.listen(attemptedPort), 100);
});

// Flush boards to disk before going down so an in-memory room isn't lost.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\nSaving boards...');
    saveAllRooms();
    process.exit(0);
  });
}
