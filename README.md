# Vatworks

A self-hosted resin (MSLA) slicer built for the **Elegoo Saturn 4 Ultra 16K** (15120 × 6230 px, 211.68 × 118.37 × 220 mm).
Load STL / OBJ / 3MF files, orient, arrange, hollow, add drain holes, generate supports, slice to a native `.goo`
file and send it straight to the printer over your LAN.

Everything runs in the browser (slicing happens in web workers on your machine). The Node server only serves the
files and bridges to the printer, because a browser cannot do UDP discovery or talk to the printer's upload port
from a page served elsewhere. Zero runtime dependencies; Node 22 or newer.

## Run it

### From the GitHub-built image (recommended for the homelab)

The repo ships with a GitHub Actions workflow that tests the slicing core and publishes a multi-arch image
(amd64 + arm64) to GitHub Container Registry on every push to `main`, and version-tagged images on tags like
`v1.0.1`. Nothing is built on the homelab; it just pulls.

1. Create an empty repository on GitHub (say `vatworks`), then push this folder to it:

   ```bash
   git init -b main
   git add .
   git commit -m "Vatworks"
   git remote add origin git@github.com:YOUR-USER/vatworks.git
   git push -u origin main
   ```

2. Watch **Actions → Docker image**. The first run takes a few minutes and pushes
   `ghcr.io/YOUR-USER/vatworks:latest`.

3. Make the package public so the homelab can pull it without credentials: your GitHub profile → **Packages** →
   `vatworks` → **Package settings** → *Change visibility*. (Or keep it private and run
   `docker login ghcr.io` on the homelab with a personal access token that has `read:packages`.)

4. On the homelab, in any folder:

   ```bash
   curl -O https://raw.githubusercontent.com/YOUR-USER/vatworks/main/docker-compose.yml
   echo "VATWORKS_IMAGE=ghcr.io/YOUR-USER/vatworks:latest" > .env
   docker compose pull && docker compose up -d        # http://<host>:8090
   ```

   Update later with the same `docker compose pull && docker compose up -d` (or let Watchtower do it). The
   plain-Docker equivalent is
   `docker run -d --name vatworks --network host --restart unless-stopped ghcr.io/YOUR-USER/vatworks:latest`.

Tagging a release (`git tag v1.0.1 && git push --tags`) also runs the **Mac app** workflow, which builds the DMG on
a macOS runner and attaches it to the GitHub release.

### From source

```bash
docker compose up -d --build        # builds the image from this checkout
node server.js                      # or no Docker at all: PORT=8090 by default (Node 22+)
```

`docker-compose.yml` uses `network_mode: host` so the container can hear the printer's UDP discovery replies. If
you prefer a bridge network, swap in the `ports:` block — connecting by IP still works, only "Find printers" stops.
Running Docker inside an unprivileged Proxmox LXC needs the container's *nesting* feature turned on.

If you publish it through Cloudflare Tunnel, put it behind Cloudflare Access (or any login). Anyone who can reach the
page can start a print on your printer.

## Security — who can reach it

Vatworks can upload files to and start/stop prints on your printer, so treat the
web UI like a remote control for the printer.

- **Loopback by default.** The server now listens on `127.0.0.1` (this machine
  only). Nothing on your wider network can reach it unless you opt in.
- **Opening it to your LAN.** To use Vatworks from another device, set
  `HOST=0.0.0.0`. When you do, **set a password** as well:

  ```
  HOST=0.0.0.0
  VATWORKS_USER=admin
  VATWORKS_PASSWORD=something-only-you-know
  ```

  With `VATWORKS_PASSWORD` set, every request needs that login (HTTP Basic). If
  you bind to a network address without a password, Vatworks prints a warning at
  startup.
- **Never expose it to the public internet.** Do not port-forward `8090`. Even
  with a password it is meant for your own trusted network only.

The health check (`/healthz`) is the only path that never requires a login.

## Mac app

The same Vatworks packaged as a native macOS app with Electron: a Dock icon, native Open/Save dialogs,
⌘O / ⌘S / ⌘Return / ⌘P shortcuts, the window header as a draggable title bar, and double-click support for
`.stl`, `.obj`, `.3mf` and `.goo` files. The embedded bridge server listens on `127.0.0.1` only, so nothing on
the network can reach your printer through it. Everything in `desktop/` is the Mac-specific code (about 150 lines).

Build it on your Mac (Node 22+):

```bash
npm install            # pulls Electron + electron-builder (a few hundred MB, one-off)
npm run desktop        # run it straight from the folder
npm run dist:mac       # dist/Vatworks-1.0.0-universal.dmg  (+ .zip)
npm run dist:mac:arm64 # Apple silicon only — a smaller build
```

Drag the app out of the DMG into Applications. Signing: the build script disables Developer-ID lookup, so
electron-builder falls back to an ad-hoc signature, which is all a locally built app needs on your own Mac. If the
app refuses to open, sign it yourself with `codesign --force --deep --sign - "dist/mac-universal/Vatworks.app"`.
Copying the DMG to *another* Mac triggers Gatekeeper (System Settings → Privacy & Security → Open Anyway); handing
it to other people properly needs an Apple Developer ID (`CSC_LINK` / `CSC_KEY_PASSWORD` and drop
`CSC_IDENTITY_AUTO_DISCOVERY=false` from the script).

Verified here by launching the Linux build of the same Electron code headlessly: open a model through the desktop
bridge → slice → save through the native dialog produced a valid `.goo` on disk.

## What it does

| Area | Details |
| --- | --- |
| Import | Binary/ASCII STL, OBJ, 3MF (with components and transforms). Inside-out meshes are flipped automatically. Drag-and-drop onto the vat. |
| Layout | Move / rotate / scale gizmos, numeric size, scale %, rotation, position and lift, mirror X/Y/Z, duplicate, arrange all, auto-orient (minimises supported overhang area), out-of-bounds highlighting. |
| Hollowing | Voxel distance field → exact cavity per layer (no mesh booleans, no cracked shells). Wall thickness in mm, X-ray view shows the cavity. Drain holes placed by clicking; cut at slice time. |
| Supports | Light / medium / heavy presets, adjustable tip, pillar, foot, spacing, overhang angle and raise height. Automatic placement on local minima and overhangs, pillars route around the model, optional braces and chamfered raft. Click to add or remove single supports. |
| Slicing | Streams scanline coverage straight into run-length data — a 16K layer (94 Mpx) never exists as a bitmap. 1×/2×/4×/8× anti-aliasing, multi-threaded, island detection with per-layer markers. |
| Print settings | Layer height, exposures, bottom/transition layers, rest times, lift/retract stages, PWM, resin presets with density and cost. Import parameters from any existing `.goo`. |
| Preview | The layer exactly as the LCD will show it (pan / zoom / scale bar), islands marked, or the 3D model cut at that height. Arrow keys step layers. |
| Output | Elegoo `.goo` v3.0 with thumbnails, print time, volume and cost in the header. Download, or upload to the printer (with optional auto-start) through the SDCP bridge. Open any `.goo` to inspect it. |
| Printer | Discover printers, read attributes and live status, list files, start a print. |

Printer profiles: Saturn 4 Ultra 16K and Saturn 4 Ultra (12K). Add more in `public/js/profiles.js`.

## How it was verified

- `node test/core.test.mjs` — 56 checks on the slicing core: RLE codec round trips (all four run-length classes and
  the diff chunks other slicers emit), header layout (195 477 bytes, matching the reference implementation),
  sliced areas and positions against analytic values (±0.05 mm² on a 400 mm² cube), boolean behaviour through
  winding rules, hollowing wall thickness, island detection, support generation, and a full file round trip.
- The generated files open cleanly in **UVtools** (`UVtoolsCmd print-properties` / `print-issues` decode every layer).
- `node test/ui.test.mjs` drives the real interface in headless Chromium: load, support, hollow, drain, slice,
  export. `node test/bridge.test.mjs` runs the server against a mock SDCP printer (UDP discovery, WebSocket
  commands, 1 MB chunked upload with MD5 check, print start).

What has **not** been done: printing a Vatworks file on a real Saturn 4 Ultra. Print a small test piece first.

## Release settings on the Saturn 4 Ultra — read this before the first print

The Saturn 4 Ultra uses a tilting vat instead of a full Z lift, and reports differ on how its firmware reads the
lift fields in a `.goo` file:

- On the 12K model, files with all lift values set to 0 are widely reported to print correctly (the firmware
  ignores them and tilts).
- Two owners of the **16K** model reported that files with zeroed lift values printed with the Z axis stationary
  (every layer exposed at the same height), while the same models sliced by ChituBox or Elegoo's slicer printed fine.
  Stock Elegoo/ChituBox profiles for this machine are reported to write 0.05 for every lift distance and speed.

Vatworks therefore defaults to **Standard Z lift**: normal, non-zero lift values that any firmware understands. Worst
case that costs a little time per layer; it can never leave the Z axis stuck. Two other presets are on the Print tab
("Tilt marker (all 0.05)" and "All zero"), and **Import settings from a .goo** copies whatever a known-good file
written by ChituBox/Elegoo's slicer contains — the safest way to match your printer's firmware exactly.

## Layout of the code

```
server.js                 static files + SDCP v3 printer bridge (discovery, WebSocket, chunked upload)
Dockerfile, docker-compose.yml, .env.example   container build and deployment
.github/workflows/        docker.yml publishes the image to ghcr.io; mac.yml builds the DMG on release tags
public/index.html         app shell
public/css/app.css        design tokens and layout
public/js/app.js          application logic
public/js/viewport.js     Three.js vat, plate, gizmos, picking, thumbnails
public/js/preview.js      LCD mask renderer
public/js/loaders.js      STL / OBJ / 3MF parsers (run in a worker)
public/js/profiles.js     printer / resin / print-setting profiles and persistence
public/js/core/goo.js     .goo v3.0 reader/writer and RLE codec
public/js/core/raster.js  triangle-plane slicer, winding-rule scanline rasteriser, island detector
public/js/core/voxel.js   voxeliser, Euclidean distance transform, cavity contours, surface nets
public/js/core/supports.js  contact detection, support routing, braces, raft
public/js/core/geom.js    geometry helpers, ray grid, orientation scoring
public/js/workers/        load / slice / support / hollow workers
desktop/main.js           Electron main process (embedded server, menu, dialogs, file associations)
desktop/preload.cjs       the small API exposed to the page (open / save / menu events)
desktop/build/            app icon (.icns / .png)
test/                     core, UI and bridge tests (the UI/bridge tests need puppeteer-core, chromium and ws)
```

Third-party code: [three.js](https://threejs.org) (MIT) vendored under `public/vendor/three`, and the Archivo
typeface (SIL OFL) under `public/fonts`. The `.goo` layout follows Elegoo's published format as implemented in
[UVtools](https://github.com/sn4k3/UVtools); the printer protocol follows ChiTu's published
[SDCP V3.0.0](https://github.com/cbd-tech/SDCP-Smart-Device-Control-Protocol-V3.0.0) specification.
