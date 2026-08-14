# 🎨 Online Board

A real-time collaborative whiteboard **and slide deck editor**. Multiple people
draw on the same slides at once, with live cursors, chat, shared undo/redo and
automatic saving — and you can open a `.pptx` file, edit it, and export it back.

## Chalane ke liye (Getting started)

```bash
npm install
npm start
```

Browser me `http://localhost:3000` kholein. Aapko automatically ek naye board pe
bhej diya jayega, jaise `/board/k3m9x2pq`.

Dusre logon ko bulane ke liye — top bar me room chip pe click karein, link copy
ho jayega. Wahi link jisko bhi bhejenge, wo seedha aapke board me aa jayega.

Agar port 3000 busy ho to server apne aap agla free port le lega. Fix karna ho to:

```bash
PORT=8080 npm start
```

Local pe by default koi password nahi lagta. Lagana ho to `.env.example` ko
`.env` copy karein, `BOARD_PASSWORD` bharein, aur `npm run dev` chalayein.

## Deploy karna (Render.com)

Aapko ek GitHub repo aur ek Render account chahiye. Poora process ~10 minute.

**1. Code GitHub pe daalein**

```bash
cd d:\OnlineBoard
git init
git add .
git commit -m "Online Board"
git branch -M main
git remote add origin https://github.com/<aapka-username>/online-board.git
git push -u origin main
```

`.gitignore` `data/` aur `.env` ko already exclude karta hai, to koi board data
ya secret repo me nahi jayega.

**2. Ek password socho**

Jo bhi board use karega usko yahi password milega. Kuch lamba aur random rakhein
— ye aapke board ka ekmatra taala hai.

**3. Render pe deploy karein**

1. [dashboard.render.com](https://dashboard.render.com) → **New** → **Blueprint**
2. Apna GitHub repo select karein — Render `render.yaml` khud padh lega
3. `BOARD_PASSWORD` maangega → step 2 wala password daalein
4. **Apply** dabayein

Render `SESSION_SECRET` khud generate karega aur `/var/data` pe 1 GB disk mount
karega. 2-3 minute me live URL mil jayega, jaise
`https://online-board-xxxx.onrender.com`.

**4. Check karein**

URL kholein → login page aana chahiye. Password daalein → board khul jayega.
Wahi link doosre logon ko bhejein; unhe bhi password chahiye hoga.

### Plan ke baare me

`render.yaml` me `plan: starter` (~$7/month) set hai, `free` nahi — kyunki
Render ke free instances **disk mount nahi kar sakte**, matlab har redeploy pe
saare boards mit jayenge, aur 15 minute inactivity ke baad wo sleep bhi ho jate
hain (agla visitor ~30 second wait karega).

Agar free pe try karna hai to `render.yaml` me `plan: free` karein aur poora
`disk:` block hata dein — board chalega par data temporary rahega.

### Baad me password badalna

Render dashboard → service → **Environment** → `BOARD_PASSWORD` edit karein.
Save karte hi service restart hoti hai. Purane logins tab bhi chalte rahenge
(wo cookie pe depend karte hain) — sabko turant logout karna ho to
`SESSION_SECRET` bhi badal dein.

### Doosre hosts

`Dockerfile` bhi included hai, to Fly.io / Railway / Cloud Run pe bhi chalega.
Bas ye env vars set karein: `BOARD_PASSWORD`, `SESSION_SECRET`,
`DATA_DIR=/var/data`, `NODE_ENV=production` — aur `DATA_DIR` pe ek volume mount
karein. Note: main Docker image build karke test nahi kar paaya, sirf Node
path (jo Render use karta hai) verify kiya hai.

## Features

**Slides & PowerPoint**
- Har slide ka apna canvas — bottom strip se add, delete, duplicate, rename,
  aur drag karke reorder karein. Live thumbnails update hote rehte hain.
- `.pptx` file kholein (📂 button) — text, rectangles, ellipses, lines, arrows
  aur images **editable shapes** ban jate hain, sirf picture nahi.
- Export: PowerPoint (`.pptx`), current slide PNG, ya raw JSON.
- Presentation mode (`F5`) — fullscreen, arrow keys se slides badlein.
- 16:9 slide frame dikhta hai taaki pata rahe kya export hoga.

**Drawing tools**
- Pen, highlighter (multiply blend), eraser
- Line, arrow, rectangle, ellipse — `Shift` se perfect square/circle/45° line
- Text boxes aur sticky notes (double-click karke edit karein)
- Images — file picker, clipboard paste, ya drag-and-drop

**Canvas**
- Infinite pan aur zoom (5% – 800%), pinch-zoom bhi
- Adaptive grid jo zoom ke saath adjust hoti hai
- Off-screen shapes render nahi hote — bade boards pe bhi smooth
- Fit-to-screen, HiDPI/retina sharp rendering

**Collaboration**
- Live strokes — doosron ko aapka stroke banta hua dikhta hai
- Naam ke saath live cursors (sirf usi slide pe jispe wo hain)
- Slide strip pe colored dots — kaun kis slide pe hai wo dikhta hai
- Room-wide shared undo/redo (multi-shape drag = ek hi undo step)
- Built-in chat + presence avatars
- Decks disk pe save hote hain, server restart ke baad bhi bache rehte hain

**Editing**
- Select, multi-select, marquee (drag) selection
- Move, duplicate (`Ctrl+D`), delete, arrow-key nudge
- Selected shapes ka color/size/opacity/fill live change karein

**Aur bhi**
- Dark mode (yaad rakhta hai)
- PNG export (poora board, chahe screen pe kuch bhi dikh raha ho)
- Mobile aur touch support

## Keyboard shortcuts

| Key | Action | Key | Action |
|---|---|---|---|
| `V` | Select | `T` | Text |
| `P` | Pen | `N` | Sticky note |
| `H` | Highlighter | `I` | Image |
| `E` | Eraser | `G` | Grid toggle |
| `L` | Line | `D` | Dark mode |
| `A` | Arrow | `C` | Chat |
| `R` | Rectangle | `Space` (hold) | Pan |
| `O` | Ellipse | `Shift+1` | Fit to screen |
| `Ctrl+Z` | Undo | `Ctrl+Shift+Z` | Redo |
| `Ctrl+A` | Select all | `Ctrl+D` | Duplicate |
| `Ctrl` `+`/`-`/`0` | Zoom in / out / reset | `Delete` | Delete selection |
| `Ctrl+M` | New slide | `Ctrl+PgUp/PgDn` | Previous / next slide |
| `F5` | Present | `Esc` | Exit presentation |

Mouse: wheel = scroll, `Ctrl`+wheel = zoom, middle-drag = pan.
Presentation mode: arrows / space / click = next, `Esc` = exit.

## Project structure

```
server/
  index.js      Express + Socket.IO — events, validation, undo/redo
  store.js      Deck state, atomic disk persistence, v1->v2 migration
  auth.js       Shared-password gate, signed cookies, rate limiting
public/
  index.html    Layout
  login.html    Password page
  style.css     Theming (light/dark tokens)
  app.js        Input handling, tools, slides, networking
  camera.js     Pan/zoom transform
  shapes.js     Geometry, hit-testing, bounds
  render.js     Canvas drawing
  slides.js     Slide frame geometry + unit conversion
  pptx.js       PowerPoint import/export
  vendor/       Vendored pptxgenjs + JSZip (ESM, no CDN)
render.yaml     Render deployment blueprint
Dockerfile      Portable image for other hosts
.env.example    Config template
data/           Saved decks (auto-created, one JSON per room)
```

## Notes on design

- **Shapes store world coordinates**, never screen ones — zoom and pan are purely
  a view transform, so everyone sees the same board at their own zoom level.
- **Undo/redo is per-room, not per-user.** With one shared shape list, per-user
  stacks would let one person's undo resurrect a shape someone else had moved.
- **The server never trusts the client**: room ids are charset-checked before
  touching the filesystem, and every shape is validated and size-capped.
- **Saves are debounced and atomic** (temp file + rename), so a burst of strokes
  costs one write and a crash mid-write cannot truncate a board.
- **`state.shapes` is a getter** onto the active slide, so every drawing and
  selection routine stayed slide-agnostic when slides were added.
- **Old single-board files still open**: `hydrate()` accepts both the v1 bare
  `shapes` array and the v2 `slides` array, converting v1 into a one-slide deck.

## PowerPoint interop: what carries over

**Import** (`.pptx` → editable shapes): text boxes, rectangles, ellipses, lines,
arrows, images, grouped shapes, and solid fills/strokes. Theme colours are
approximated from a built-in map.

**Not imported** (skipped without breaking the rest of the slide): SmartArt,
charts, tables, animations, transitions, gradients, speaker notes, slide masters,
embedded video/audio, and WordArt effects. A 1:1 PowerPoint clone is out of scope
— the goal is that the content you can *edit on the board* comes across.

**Export** maps board shapes to native PPT shapes, so the result stays editable
in PowerPoint. Freehand pen strokes are the exception: PowerPoint has no freehand
primitive here, so each stroke is approximated as a run of short line segments
(subsampled for long strokes to keep file size sane).

## Security model — what the password does and doesn't do

The password is a **shared gate**, not user accounts. Everyone who has it gets
the same full access: read, edit, and delete any board on the instance. Names
are display labels only — anyone can type any name.

What is protected:
- Every page and asset sits behind the gate; only `/api/health` is public.
- **WebSockets are checked too.** The HTTP gate alone would leave the board
  wide open over sockets, so the handshake verifies the same cookie.
- Sessions are HMAC-signed cookies (HttpOnly, SameSite=Lax, Secure in prod).
  They cannot be forged without `SESSION_SECRET`.
- Password comparison is timing-safe, and login attempts are rate limited to
  8 per IP per 10 minutes.
- `?next=` only accepts same-site paths, so it can't be used as an open redirect.

What is **not** covered — be aware before sharing widely:
- **No per-user identity.** You cannot tell who drew what, or revoke one person
  without changing the password for everyone.
- **No encryption at rest.** Boards are plain JSON on the host's disk.
- **No audit log.** A deleted board is gone (undo only helps within a session).
- Anyone with the password can clear any board. Room ids are unguessable-ish,
  but that is obscurity, not a permission boundary.

If you need per-person accounts or per-board permissions, this design needs to
grow a real user store — it is not a config change.

## Limits

Per room: 200 slides, 20,000 shapes total, 3 MB per image, 200 undo steps,
200 chat messages. Empty rooms are flushed to disk and evicted every 5 minutes.

## A note on `npm audit`

`npm audit` reports a high-severity advisory in `image-size`, a transitive
dependency of pptxgenjs (DoS via malformed ICNS/JXL/HEIF images). It is not
reachable here: pptxgenjs maps `image-size` to `false` for browsers, and this
project only calls pptxgenjs client-side — the server never imports it. The
advisory's `npm audit fix --force` would downgrade pptxgenjs 4.x → 1.x, a
breaking change, so it is deliberately not applied.
