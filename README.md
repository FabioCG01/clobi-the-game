# TUX SMASH ROYALE — Clobi's Arena

> An 8-bit online PvP web game where pixel-art penguins (and the odd humanoid) belly-bash each
> other into oblivion. Built as a respectful — and slightly unhinged — **tribute to Clobi**, the
> legendary IT teacher who taught a generation Linux, open source, `vim`, and LibreOffice; ran on a
> steady supply of Fisherman's Friend menthol lozenges; and was *militantly* anti-Microsoft. This
> is the comedy he deserves, not a sentimental love letter.

The whole thing is **one statically-linked Go binary** in a single Docker container. The backend is
pure Go standard library plus two tiny dependencies (`gorilla/websocket` for the realtime channel
and `golang.org/x/crypto/bcrypt` for password hashing). No database — accounts live in a single
mutex-guarded JSON file. The art is procedural 8-bit pixel art drawn with `fillRect`, so there
isn't a single binary image asset in the repo. Clobi would approve.

---

## Two modes, one game, one universal character

Pick the mode when you create a room. Your character — penguin or person — is **cross-compatible
across both modes**.

### Tux Smash

Top-down sumo-smash on a platform surrounded by **void**. Shove your rivals **off the edge** — a
ring-out is an instant elimination. Smash-style **damage percent** builds up the more you get hit
and amplifies the knockback you take, so a fresh penguin barely budges but a battered one sails into
the abyss. **2 to 4 players.** No shrinking zone — just you, them, and gravity's little brother.

### Distro Royale

An enclosed arena where a shrinking minty **Menthol Zone** (Fisherman's fog) closes in around a
random point. Step outside it and a **BSOD storm** drains your HP — the only acceptable use of a
blue screen. Last penguin/human standing wins. **Up to 16 players.**

Both modes share **one combat engine**: the same entities, `vim` specials, pickups, and the dreaded
**Activate Windows** debuff. Empty slots are filled with **CPU bots** (they seek the nearest target,
attack, and dodge the storm/edge) so a match is always playable — from 1 player against bots all the
way up to a 16-penguin royale.

---

## Running it

### Option A — Docker (recommended, self-hosted)

```bash
# From the project root:
docker build -t tux-smash-royale .
docker run --rm -p 1337:1337 tux-smash-royale
```

Then open **http://localhost:1337** in your browser.

To **persist accounts** across container restarts, mount the data directory:

```bash
docker run --rm -p 1337:1337 -v "$(pwd)/data:/app/data" tux-smash-royale
```

The container runs as a **non-root** user and ships only the static binary plus the `web/` assets —
no Go toolchain, no shell scripting, nothing extra. Configurable via environment variables:

| Variable   | Default      | Purpose                                  |
| ---------- | ------------ | ---------------------------------------- |
| `PORT`     | `1337`       | TCP port the server listens on           |
| `WEB_DIR`  | `/app/web`   | Directory of static client assets served |
| `DATA_DIR` | `/app/data`  | Where `accounts.json` is read/written    |

Use a different port like this (remember to map it too):

```bash
docker run --rm -e PORT=8080 -p 8080:8080 tux-smash-royale
```

### Option B — Local Go (no Docker)

Requires **Go 1.22+**.

```bash
go run ./cmd/server
```

Then open **http://localhost:1337**. Override the defaults with environment variables, for example:

```bash
PORT=8080 WEB_DIR=./web DATA_DIR=./data go run ./cmd/server
```

To build a standalone binary the same way the Docker image does:

```bash
CGO_ENABLED=0 go build -ldflags="-s -w" -o clobi ./cmd/server
./clobi
```

Runtime data (the account store, `data/accounts.json`) is created automatically on first use inside
the `DATA_DIR` directory.

---

## Controls

Everything is keyboard-driven. Movement keys are ignored while the `vim` command line is focused.

| Action              | Keys                        |
| ------------------- | --------------------------- |
| Move (8 directions) | **WASD** or **Arrow keys**  |
| Belly-bash (melee)  | **Space** or **J**          |
| Throw frisbee       | **K**                       |
| Belly-slide dash    | **Shift**                   |
| Open `vim` line     | **/**                       |

### `vim` specials (typed into the command line, then submit)

Open the little 8-bit command overlay with **/**, type a command, and hit submit. True to form, real
`vim` muscle memory pays off:

- **`:wq`** — *write & quit*: blink in your facing direction (a teleport dash).
- **`dd`** — *delete line*: destroy nearby incoming projectiles and gain a brief moment of
  invulnerability.
- **`sudo`** — *with great power*: an AoE radial knockback blast, gated behind a charge meter. Use
  it when it counts.

---

## Pickups

Items spawn across the arena over the course of a match — grab them mid-fight:

- **Fisherman** (menthol) — a speed **and** damage boost. The real performance enhancer.
- **Fork** — spawns a short-lived friendly **AI clone** of you (`fork()`, naturally).
- **LibreOffice** — throwing ammo / charge for the frisbee.
- **Windows** — your **next melee hit** brands the victim with the *Activate Windows* gag for 10
  seconds. See below.

---

## The universal Tux / Humanoid editor

One editor, one character, used in **both** modes. A body-type toggle at the top flips between
**Tux** (an 8-bit penguin) and **Humanoid** (an 8-bit person) with a big live pixel preview. The
shared parts — body / belly / feet colors, hat, eyes, accessory, cape — apply to whichever body you
pick, so your style follows you across the toggle. Mix it all with prev/next arrows and color
swatches, give it a name, then **Randomize / Reset / Save**. The classic black-and-white **Tux** is
the default, naturally. Everything is chunky `fillRect` pixel art — no image files anywhere.

Save it locally, or sign in to sync your character to the server so it follows your account.

---

## The "Activate Windows" gag

The crown jewel of the tribute. Grab the **`windows` pickup** and your **next melee hit** brands the
victim: for the next 10 seconds, *their* screen sprouts the infamous translucent watermark in the
bottom-right corner —

> **Activate Windows**
> Go to Settings to activate Windows.

— rendered in the authentic semi-transparent light-grey style (and it stays in English on purpose,
exactly like the real thing). It is **deliberately annoying**: it can't be dismissed until it
expires, it desaturates and dims the whole page, the watermark periodically **jitters** a few pixels
and flickers its opacity, and a stray drifting duplicate or two may wander across the screen. There
is no "activate" button. There never is.

A penguin that has tasted freedom, momentarily nagged back into the proprietary dark ages. Clobi
would have laughed, then handed you a Fisherman's Friend.

---

## Languages

The whole UI is localized into **five languages**:

- **English** (default)
- **Deutsch** (German)
- **Français** (French)
- **Português** (Portuguese)
- **Lëtzebuergesch** (Luxembourgish)

On your **first visit** an 8-bit language popup appears so you can choose (English is highlighted as
the default); your pick is remembered for next time, and a small language switcher in the top-right
lets you change it whenever you like. The product name *Tux Smash Royale* and the *Activate Windows*
gag text are intentionally never translated.

---

## Accounts (optional, never nagged)

Accounts are entirely optional and there are **zero forced-signup nags**. A subtle "Sign in" button
lives in the top-right corner. Register or log in and your saved character syncs to the server and
follows you to any browser. Passwords are hashed with **bcrypt** (never stored in plaintext);
accounts are persisted to a single mutex-guarded `accounts.json` — no database required.

---

## How it's built (the "do not deviate" stack)

- **Backend: Go 1.22**, a single static binary (`CGO_ENABLED=0`). The standard library `net/http`
  serves both the static client **and** the REST API. WebSockets via `gorilla/websocket`, password
  hashing via `golang.org/x/crypto/bcrypt`. Accounts persist to a mutex-guarded **JSON file** — no
  database, no cgo. The simulation is **authoritative at 30 ticks/second**.
- **Frontend:** plain browser JavaScript via `<script>` tags — **no frameworks, no ES modules, no
  build step**; each module assigns exactly one global. Canvas 2D rendering, procedural 8-bit pixel
  art, the **Press Start 2P** font with a monospace fallback, and `image-rendering: pixelated`
  everywhere.
- Clients send input and **interpolate** between server snapshots for smooth motion.

### Project layout

```
.
├── cmd/server/         # main.go — reads PORT/WEB_DIR/DATA_DIR, calls server.Run
├── internal/
│   ├── protocol/       # the shared wire contract (mirrors web/js/protocol.js)
│   ├── accounts/       # bcrypt account store backed by a JSON file
│   ├── game/           # pure authoritative simulation (both modes, no networking)
│   ├── rooms/          # the WebSocket hub, lobbies, and per-room game loops
│   └── server/         # HTTP + REST + WebSocket wiring
├── web/                # browser client (index.html, css, js modules via <script>)
├── data/               # runtime data (accounts.json) — created on first use
├── go.mod / go.sum
├── Dockerfile
└── README.md
```

---

## License

Use it, fork it, run it on Linux. Especially on Linux.

---

*In loving (and very competitive) memory of the menthol-fueled, vim-wielding, Windows-loathing
spirit of Clobi.*
