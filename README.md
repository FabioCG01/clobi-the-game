# TUX SMASH ROYALE — Clobi's Arena

> An 8-bit web **character creator and open-source cosmetic marketplace** where pixel-art penguins
> (and the odd humanoid) get built, painted, and shared. Built as a respectful — and slightly
> unhinged — **tribute to Clobi**, the legendary IT teacher who taught a generation Linux, open
> source, `vim`, and LibreOffice; ran on a steady supply of Fisherman's Friend menthol lozenges; and
> was *militantly* anti-Microsoft. This is the comedy he deserves, not a sentimental love letter.

The whole thing is **one statically-linked Go binary** in a single Docker container. The backend is
pure Go standard library plus two tiny dependencies (`go.etcd.io/bbolt` for the embedded database and
`golang.org/x/crypto/bcrypt` for password hashing — no cgo, no external DB service). The frontend is
plain browser JavaScript with no build step. Clobi would approve.

> **The Arena is W.I.P.** The realtime PvP gamemodes (*Tux Smash* and *Distro Royale*) have been
> chained up while the workshop gets built out — the menu shows them locked behind dramatic pixel
> chains. The belly-bashing returns later; for now the creative tools are wide open.

---

## What you can do

### Build a character — the universal Tux / Humanoid editor

One editor, one character. A body-type toggle flips between **Tux** (an 8-bit penguin) and
**Humanoid** (an 8-bit person) with a big live pixel preview. Colours (body / belly / feet / skin /
hair / beard / pants / cape / iris / mouth), styles (hair, beard, shirt, pants, shoes, hat, eyes,
eyebrows, mouth, accessory, cape), build (thin → fat) and **per-part transforms** (move / resize /
rotate any face/head part by direct manipulation) all live here. Randomize / Reset / Save. Sign in to
sync your character to your account so it follows you across devices.

### Paint your own cosmetics — the Paint Studio (Create)

Draw your **own textures** and wear them. A texture is a small grid stored as a **grayscale value**
(so the wearer's colour still tints it like every built-in part), an **alpha** channel
(transparency / translucency), and a **glow** mask rendered in a secondary colour with a chunky,
**pixelated** glow halo. Paint in two modes that share the exact same canonical grid:

- **Raw** — paint on the flat texture grid (with a faint character ghost for alignment).
- **On model** — paint directly on the live character wearing the texture.

Brush / eraser / fill / glow tools, a base colour + shade ramp, opacity and glow controls, brush
size, undo/redo, and a live worn preview. **Save & wear** keeps it private in your library;
**Publish** shares it on the marketplace (always free). Every texture record carries its author,
creation time, and remix lineage for traceability.

### Share & discover — the open-source Marketplace

Everything published is **always free**. Browse a grid of cards with live worn thumbnails, then on
any item you can:

- **Try it on** your current character, or **Download** it to your library
- **Rate** it (1–5 stars, **half-stars** supported)
- **Comment**, with **threaded replies**
- **Report** it — or vouch that a report is a **false report**
- **Remix** a texture (opens the Paint Studio seeded from it)
- **Publish your whole character**, with the custom textures it wears bundled in so it renders for
  everyone

Search by name / author / tag; sort by newest, oldest, rating (high/low) or downloads (high/low);
filter by type (texture / character) and by part.

#### Crowdsourced moderation (Reddit-style)

A net score drives soft moderation so a popular item can't be buried by a handful of bad-faith flags:

- **Report** raises the score; a **"this is a false report"** vouch lowers it.
- At **+5 net reports** an item is **auto-censored** — blurred for everyone, and its pixels are
  **withheld server-side** from non-authors so they can't be worn or seen — pending review.
- At **−5 net** (the community out-votes the reports) the dispute **auto-clears**.
- **Admins** make the final call: **ban** (permanent takedown) or **revoke** (reset the dispute).
- You can always **cancel** your own report, and everyone can **see the report count**.

#### Keeping it (mostly) clean

Publishing runs a **best-effort** NSFW guard: a profanity wordlist on the title/tags plus a
conservative phallic-silhouette heuristic on the texture's shape. A hit only **flags** an item
(auto-censored pending an admin), so false positives are recoverable. From a grayscale texture you
can't reliably detect intent, so the **community report/vouch system is the real safety net** — this
is honest about its limits on purpose.

---

## The "Activate Windows" gag

The crown jewel of the tribute lives on as an easter egg in the **About** dialog. Press the button
you are explicitly told not to press, and your screen sprouts the infamous translucent **Activate
Windows** watermark in the bottom-right —

> **Activate Windows**
> Go to Settings to activate Windows.

— in the authentic semi-transparent light-grey style (kept in English on purpose, exactly like the
real thing). It desaturates and dims the whole page, jitters and flickers, and there is no "activate"
button. There never is. A penguin that has tasted freedom, momentarily nagged back into the
proprietary dark ages.

---

## Accounts (optional, never nagged) + admin defaults

Accounts are entirely optional with **zero forced-signup nags** — a subtle "Sign in" lives in the
top-right. Register or log in and your character (and the credit on anything you publish) syncs to
your account. Passwords are hashed with **bcrypt** (never stored in plaintext).

An **admin** can set the **global default look** that brand-new players start with — **one per body
type**: *Tux*, *Male*, and *Female*. Edit a character, then use **Set as global default** in the
editor's Saves tab; the server stores it for that body-type slot, and players see it on a fresh
character and when they press **Reset**.

---

## Running it

### Option A — Docker (recommended, self-hosted)

```bash
docker build -t tux-smash-royale .
docker run --rm -p 1337:1337 tux-smash-royale
```

Then open **http://localhost:1337**. To **persist data** (accounts + the marketplace) across restarts,
mount the data directory:

```bash
docker run --rm -p 1337:1337 -v "$(pwd)/data:/app/data" tux-smash-royale
```

The container runs as a **non-root** user and ships only the static binary plus the `web/` assets.
Configurable via environment variables:

| Variable     | Default      | Purpose                                            |
| ------------ | ------------ | -------------------------------------------------- |
| `PORT`       | `1337`       | TCP port the server listens on                     |
| `WEB_DIR`    | `/app/web`   | Directory of static client assets served           |
| `DATA_DIR`   | `/app/data`  | Where the bbolt database (`clobi.db`) is stored    |
| `ADMIN_USER` | `fabiocg`    | Username granted admin (global defaults + market)  |

### Option B — Local Go (no Docker)

Requires **Go 1.22+**.

```bash
go run ./cmd/server
# or build the static binary the Docker image uses:
CGO_ENABLED=0 go build -ldflags="-s -w" -o clobi ./cmd/server && ./clobi
```

Override defaults with env vars, e.g. `PORT=8080 WEB_DIR=./web DATA_DIR=./data go run ./cmd/server`.

### Option C — Docker Compose (recommended for a server; autostarts on reboot)

```bash
docker compose up -d     # build + run in the background
docker compose logs -f   # follow logs
docker compose down      # stop and remove
```

It publishes port `1337`, persists `./data`, and sets `restart: unless-stopped`.

> ⚠️ **Data directory permissions.** The container runs as a non-root user (`uid 100`, `gid 101`).
> When you bind-mount `./data`, make it writable by that user once: `sudo chown -R 100:101 data`.
> Otherwise the server can't open the database and will crash-loop on startup.

---

## Languages

The whole UI is localized into **five languages** — **English** (default), **Deutsch**, **Français**,
**Português**, and **Lëtzebuergesch**. On your first visit an 8-bit language popup lets you choose
(English highlighted as the default); a small switcher in the top-right changes it anytime. The
product name *Tux Smash Royale* and the *Activate Windows* gag text are intentionally never translated.

---

## How it's built (the "do not deviate" stack)

- **Backend: Go 1.22**, a single static binary (`CGO_ENABLED=0`). The standard library `net/http`
  serves both the static client **and** the REST API (accounts, character sync, per-body-type
  defaults, and the full marketplace). Storage is the embedded **bbolt** transactional key/value
  database (one `clobi.db` file: accounts + settings + marketplace items); passwords via bcrypt.
- **Frontend:** plain browser JavaScript via `<script>` tags — **no frameworks, no ES modules, no
  build step**; each module assigns exactly one global. Canvas 2D rendering, **Press Start 2P** font,
  and `image-rendering: pixelated` everywhere. Character art is built from **grayscale PNG masks
  tinted at runtime** (and composited with user-painted custom textures); the paint tool exports its
  textures as compact packed PNGs.

### Project layout

```
.
├── cmd/server/         # main.go — reads PORT/WEB_DIR/DATA_DIR, calls server.Run
├── internal/
│   ├── protocol/       # the shared Character contract (mirrors the JS client)
│   ├── accounts/       # bcrypt account store + per-body-type defaults (bbolt)
│   ├── market/         # the open-source marketplace store (bbolt) + NSFW guard
│   └── server/         # HTTP + REST wiring (accounts, defaults, marketplace, static)
├── web/                # browser client (index.html, css, js modules via <script>)
│   ├── js/editor.js    # the Tux / Humanoid character editor
│   ├── js/paint.js     # the Paint Studio (Create) — draw custom textures
│   ├── js/market.js    # the Marketplace screen
│   ├── js/textures.js  # tint + composite pipeline (built-in + custom textures)
│   └── js/i18n*.js      # localization (5 languages)
├── data/               # runtime data (clobi.db) — created on first use
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
