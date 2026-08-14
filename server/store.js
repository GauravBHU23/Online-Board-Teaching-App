import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Where boards live. Hosts that offer a persistent disk mount it at a fixed
 * path (Render uses /var/data), so DATA_DIR points there in production and
 * falls back to a local folder for development.
 */
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');

// How many shapes a single room may hold. Guards against a runaway client
// filling the disk with a multi-megabyte board file.
const MAX_SHAPES_PER_ROOM = 20000;
// Slides per deck. Also bounds how much a single PPTX import can add.
const MAX_SLIDES = 200;
// Undo/redo depth kept per room, shared across everyone in it.
const MAX_HISTORY = 200;
// Rooms are flushed to disk at most this often, so a burst of strokes
// results in one write instead of hundreds.
const SAVE_DEBOUNCE_MS = 1500;

// Fail fast on an unwritable data dir: silently losing every board on restart
// is far worse than refusing to start with a clear message.
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.accessSync(DATA_DIR, fs.constants.W_OK);
  console.log(`[store] boards directory: ${DATA_DIR}`);
} catch (err) {
  console.error(`[store] data directory is not writable: ${DATA_DIR}\n  ${err.message}`);
  console.error('  Set DATA_DIR to a writable path, or mount a disk there.');
  process.exit(1);
}

/** Room ids come from URLs, so keep them to a safe charset before touching the fs. */
export function isValidRoomId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

function roomFile(roomId) {
  return path.join(DATA_DIR, `${roomId}.json`);
}

/** In-memory rooms. Disk is the backup; this map is the source of truth while running. */
const rooms = new Map();
const saveTimers = new Map();

let slideSeq = 0;
export function newSlideId() {
  slideSeq += 1;
  return `sl-${Date.now().toString(36)}-${slideSeq.toString(36)}`;
}

export function emptySlide(name = 'Slide 1') {
  return { id: newSlideId(), name, shapes: [], background: null };
}

function emptyRoom(id) {
  return {
    id,
    // A room is an ordered deck. Each slide owns its own shape list, so
    // z-order stays per-slide and switching slides is just an index change.
    slides: [emptySlide()],
    undoStack: [],    // committed operations available to undo
    redoStack: [],
    users: new Map(), // socketId -> { id, name, color, cursor, slideId }
    chat: [],         // last N chat messages
    createdAt: Date.now(),
  };
}

/**
 * Accept both the current deck format and the original single-board format
 * (a bare `shapes` array), so boards saved before slides existed still open.
 */
function hydrate(room, saved) {
  if (Array.isArray(saved.slides) && saved.slides.length) {
    room.slides = saved.slides.map((s, i) => ({
      id: typeof s.id === 'string' ? s.id : newSlideId(),
      name: typeof s.name === 'string' ? s.name : `Slide ${i + 1}`,
      shapes: Array.isArray(s.shapes) ? s.shapes : [],
      background: s.background ?? null,
    }));
  } else if (Array.isArray(saved.shapes)) {
    // Legacy board: everything it had becomes slide 1.
    room.slides = [{ ...emptySlide(), shapes: saved.shapes }];
  }
  if (Array.isArray(saved.chat)) room.chat = saved.chat;
  if (typeof saved.createdAt === 'number') room.createdAt = saved.createdAt;
}

export function getRoom(roomId) {
  if (rooms.has(roomId)) return rooms.get(roomId);

  const room = emptyRoom(roomId);
  const file = roomFile(roomId);
  if (fs.existsSync(file)) {
    try {
      hydrate(room, JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (err) {
      // A corrupt file must not take the whole room down; start clean and
      // keep the bad copy around for inspection.
      console.error(`[store] could not read room ${roomId}:`, err.message);
      try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`); } catch {}
    }
  }
  rooms.set(roomId, room);
  return room;
}

/** Look up a slide by id, falling back to the first one. */
export function getSlide(room, slideId) {
  return room.slides.find((s) => s.id === slideId) || room.slides[0];
}

export function totalShapes(room) {
  return room.slides.reduce((n, s) => n + s.shapes.length, 0);
}

export function scheduleSave(roomId) {
  if (saveTimers.has(roomId)) return;
  const timer = setTimeout(() => {
    saveTimers.delete(roomId);
    saveRoom(roomId);
  }, SAVE_DEBOUNCE_MS);
  timer.unref?.();
  saveTimers.set(roomId, timer);
}

export function saveRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const payload = JSON.stringify({
    id: room.id,
    version: 2,
    slides: room.slides,
    chat: room.chat.slice(-100),
    createdAt: room.createdAt,
    savedAt: Date.now(),
  });
  const file = roomFile(roomId);
  try {
    // Write to a temp file first so a crash mid-write cannot truncate the board.
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, payload);
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error(`[store] could not save room ${roomId}:`, err.message);
  }
}

export function saveAllRooms() {
  for (const id of rooms.keys()) saveRoom(id);
}

/** Drop rooms with nobody in them so long-running servers don't grow unbounded. */
export function evictEmptyRooms() {
  for (const [id, room] of rooms) {
    if (room.users.size === 0) {
      saveRoom(id);
      rooms.delete(id);
    }
  }
}

export function roomIsFull(room) {
  return totalShapes(room) >= MAX_SHAPES_PER_ROOM;
}

/**
 * Record an operation so it can be undone. Ops are inverse-describable:
 * { type: 'add', shapes } | { type: 'remove', shapes } | { type: 'update', before, after }
 */
export function pushHistory(room, op) {
  room.undoStack.push(op);
  if (room.undoStack.length > MAX_HISTORY) room.undoStack.shift();
  room.redoStack.length = 0; // a fresh action invalidates the redo branch
}

export { MAX_SHAPES_PER_ROOM, MAX_SLIDES };
