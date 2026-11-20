# Share to Lichess — installable PWA

Share a chess puzzle photo from WhatsApp (or any app) on Android, scan the
board on the device, and open the position on the Lichess analysis board.

**Free. No account. No upload: the image never leaves the device. No scan
limit.** The only thing sent to Lichess is the FEN, inside the link URL,
when you tap **Open in Lichess**.

## Deploy (GitHub Pages, project site)

This directory is a complete static site. Deploy it as a GitHub Pages
**project site** at `https://<user>.github.io/share-to-lichess/`:

```sh
# from this directory — deploy ONLY these files (not node_modules, .venv)
git init && git add index.html styles.css app.js worker.js highlight.js \
  sw.js share.html manifest.webmanifest models ort vendor pieces icons \
  test README.md .gitignore
git commit -m "Share to Lichess PWA"
# create the repo `share-to-lichess` on GitHub, then:
git remote add origin git@github.com:<user>/share-to-lichess.git
git push -u origin main
# Repo Settings -> Pages -> Source: Deploy from a branch, main, / (root)
```

All paths are relative (`./...`), so the app works under the
`/share-to-lichess/` base path. `manifest.webmanifest` and `sw.js` sit at
the site root, as a share target requires.

On Android, open the deployed URL in Chrome, menu → **Add to Home
screen** / **Install app**. It then appears in the Android share sheet as
**Lichess Share**. In WhatsApp: long-press a puzzle photo → Share →
Lichess Share.

## How it works

- **Share target** (`manifest.webmanifest` + `sw.js`): the service worker
  intercepts the POST to the exact `./share` pathname, validates the file
  (image MIME + magic bytes, ≤ 25 MB), stores it in Cache Storage under a
  unique key `shared-<millis>-<random>`, caps to one entry, sweeps entries
  older than 60 s, and 303-redirects to `./?shared=<key>`. The page reads
  that exact entry and **deletes it immediately, before inference**.
  Empty share bodies (the unconfirmed Android 17 / Chrome 153 bug) redirect
  to `./?shared=empty`, which prompts Choose image / Paste instead.
- **Scanner**: `@scoriiu/fenshot` 0.1.6 (MIT) + onnxruntime-web 1.31.1,
  model `chess-tiles-v2.onnx` (1.3 MB), all vendored locally in `models/`,
  `ort/`, `vendor/fenshot/`. Nothing is fetched from a CDN. Recognition
  runs in a dedicated Web Worker (`worker.js`, `numThreads = 1`, 15 s
  timeout; GitHub Pages has no COOP/COEP so `SharedArrayBuffer` is
  unavailable) with a main-thread fallback. Works best on 2D screenshots
  and diagrams; photos of real boards at an angle are hit and miss.
- **Last-move highlight**: after detection, each square's border ring is
  sampled and compared to its light/dark base. Exactly two squares sharing
  the same tint deviation are the last-move highlight (any theme colour,
  not just yellow). The pair is validated as a geometrically legal move
  (origin empty, destination occupied by the mover); if it fails, the turn
  is not auto-set. Turn order: highlight → starting position → in-check
  sanity → assumed bottom player (dashed border, forced confirm).
  En passant is auto-set only for a double step with an adjacent enemy
  pawn that could capture it. Castling is inferred/assumed from king and
  rook on home squares, adjusted by the last move, and labelled assumed.
- **Engine off on arrival (web)**: the analysis link is `https://lichess.org/analysis/standard/<FEN>?color=white|black` with no engine parameter — verified live Nov 20, 2026, the local engine toggle is OFF on arrival on the web board (no eval bar, score, or best-move arrow until you tap the toggle). The mobile app was not tested for this. Do not add `?engine=off`: it is not a Lichess parameter and the malformed form loses the FEN.
- **Gating**: Lichess never opens by itself. The big button stays disabled
  until the position is legal (exactly one king per side, ≤ 16 pieces per
  side, no pawns on ranks 1/8) **and** you tap **I checked this board**
  after comparing the photo with the reconstructed board. Low-confidence
  squares are outlined in red. Illegal positions route to the Lichess
  Editor instead of analysis. `?color=black` is appended when Black is at
  the bottom.
- **Fallbacks**: file picker, drag-and-drop, paste; Rotate 90° and
  re-scan, contrast boost and re-scan, drag-to-crop and re-scan; full
  board editor (palette, move/erase, flip 180, coordinates, castling
  chips masked to geometrically possible rights, en passant picker limited
  to geometrically possible squares, paste-FEN).

## Files

Deploy files (sizes from `find . -type f` — see the acceptance-test log
for the full list): `index.html`, `styles.css`, `app.js`, `worker.js`,
`highlight.js`, `sw.js`, `share.html`, `manifest.webmanifest`,
`models/chess-tiles-v2.onnx` (1.3 MB), `ort/ort.wasm.min.mjs` (54 KB),
`ort/ort-wasm-simd-threaded.mjs` (25 KB),
`ort/ort-wasm-simd-threaded.wasm` (14.8 MB), `vendor/fenshot/*.js`,
`pieces/*.svg` (Lichess cburnett), `icons/icon-192.png`,
`icons/icon-512.png`, `test/` (test boards + Node test scripts).
`node_modules/`, `.venv/` and `package*.json` are build/test tooling only
and must not be deployed.

## Tests run (Nov 20, 2026)

All run from this directory. Node recognizer tests use fenshot's
platform-independent core + onnxruntime-node (CPU) + pngjs; only the ONNX
runtime and rasterizer differ from the browser path.

- `node test/recognize-node.mjs test/test-board.png` — synthetic board
  rendered from Lichess cburnett SVGs, FEN
  `r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 0 1`
  (after 1.e4 e5 2.Bc4 Nc6 3.Qh5). **PASS, exact match, 0/64 tile diffs,
  minConfidence 0.913, mean 0.956, reliable, 237 ms.**
- `node test/recognize-whatsapp.mjs test/whatsapp.png` — Merwyn's real
  WhatsApp photo (Black point of view, highlighted a6/b5).
  **PASS, exact match: placement, last move Black a6xb5, White to move
  from last-move highlight, castling KQk, EP -, FEN
  `1rbqk2r/5ppp/2np1b2/1p2p3/4P3/N5P1/PP3P1P/R1BQKB1R w KQk - 0 1`,
  Lichess URL exact, including `?color=black` (Black at the bottom). Highlight magnitudes 80.5 / 71.9 vs median 1.7.**
- `node test/highlight-units.mjs` — double-step EP auto-set (e2-e4, EP
  e3) and not auto-set with no adjacent pawn; king move clears castling;
  rook captured on a1 clears Q; illegal knight move rejected; no false
  highlight on the clean board. **ALL PASSED.**
- `node --check` on `app.js`, `highlight.js`, `sw.js`, `worker.js` — all
  pass. Manifest parses as JSON and contains `share_target`.
- Local serve (`python3 -m http.server`): every deploy file returns
  HTTP 200, including the model and wasm files.
- Headless-browser test of the live page: **not completed** — Playwright
  Chromium download failed twice (first attempt: download failure;
  retry still downloading at time of writing). The Node tests above use
  the same model and detection code; the browser path (import map,
  worker, service worker share flow) still needs a real-device check
  after deploy: share one photo from WhatsApp and confirm the board,
  turn source label, and Lichess link.

## Known limits (stated on the page too)

- 2D screenshots/diagrams only. 3D piece sets, partial boards, 90°
  rotations, and opaque arrows covering pieces are unsupported until
  tested; the manual editor is the fallback.
- Pawnless / sparse-pawn endgames: orientation is flagged "verify board
  orientation" because the pawn-direction clue is weak.
- A photo cannot prove side to move or castling. The app infers them
  (highlight, then check, then assumed bottom) and labels the source.
