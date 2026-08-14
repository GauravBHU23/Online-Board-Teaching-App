import crypto from 'node:crypto';

/**
 * Shared-password gate.
 *
 * One password for the whole instance, handed out to whoever should have
 * access. On success the server issues a signed cookie; there is no user
 * database and no per-user identity — names are still just display names.
 *
 * The cookie is an HMAC over an expiry timestamp, so it can be verified
 * without server-side session storage and cannot be forged without SECRET.
 */

const COOKIE = 'board_auth';
const DEFAULT_TTL_DAYS = 30;

/** Auth is only enforced when a password is configured. */
export const PASSWORD = process.env.BOARD_PASSWORD || '';
export const authEnabled = PASSWORD.length > 0;

/**
 * Signing key. A stable SESSION_SECRET keeps logins valid across restarts;
 * without one we generate a random key, which is safe but logs everyone out
 * whenever the process restarts.
 */
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (authEnabled && !process.env.SESSION_SECRET) {
  console.warn('[auth] SESSION_SECRET is not set — sessions will not survive a restart.');
}

const TTL_MS = Number(process.env.SESSION_TTL_DAYS || DEFAULT_TTL_DAYS) * 24 * 60 * 60 * 1000;

function sign(value) {
  return crypto.createHmac('sha256', SECRET).update(value).digest('base64url');
}

/** Compare without leaking length or content through timing. */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function checkPassword(input) {
  if (!authEnabled) return true;
  if (typeof input !== 'string' || !input) return false;
  // Hash both sides first so the comparison is fixed-length regardless of
  // how long the submitted password is.
  const a = crypto.createHash('sha256').update(input).digest();
  const b = crypto.createHash('sha256').update(PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

export function issueToken() {
  const expires = Date.now() + TTL_MS;
  return `${expires}.${sign(String(expires))}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  const dot = token.lastIndexOf('.');
  if (dot === -1) return false;

  const expires = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!safeEqual(mac, sign(expires))) return false;

  const ts = Number(expires);
  return Number.isFinite(ts) && ts > Date.now();
}

/** Minimal cookie parser — avoids a dependency for one header. */
export function readCookie(header, name = COOKIE) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

export function cookieHeader(token, { secure }) {
  const attrs = [
    `${COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(TTL_MS / 1000)}`,
  ];
  // Secure would make the cookie unusable over plain-HTTP local testing.
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export function clearCookieHeader() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function isAuthed(req) {
  if (!authEnabled) return true;
  return verifyToken(readCookie(req.headers?.cookie));
}

/**
 * Throttle password guesses per IP. In-memory is enough here: a single
 * instance owns all traffic, and a restart clearing the counters is not a
 * meaningful bypass given the lockout is only seconds long.
 */
const attempts = new Map();
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 10 * 60 * 1000;

export function rateLimited(ip) {
  const rec = attempts.get(ip);
  if (!rec) return false;
  if (Date.now() > rec.until) { attempts.delete(ip); return false; }
  return rec.count >= MAX_ATTEMPTS;
}

export function noteFailure(ip) {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now > rec.until) {
    attempts.set(ip, { count: 1, until: now + WINDOW_MS });
  } else {
    rec.count += 1;
  }
}

export function clearFailures(ip) {
  attempts.delete(ip);
}

// Keep the attempt map from growing without bound on a long-lived server.
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of attempts) if (now > rec.until) attempts.delete(ip);
}, 5 * 60 * 1000).unref?.();
