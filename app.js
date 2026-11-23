// Share to Lichess — PWA front end.
// Scanner: @scoriiu/fenshot (MIT) + onnxruntime-web, vendored locally.
// The image is scanned in this browser only. Nothing is uploaded.
// The FEN goes to Lichess in the link URL when you tap Open in Lichess;
// the image itself never leaves your device.
import {
  createRecognizer,
  resolveOrientation,
  inferCastling,
  CONFIDENCE_FLOOR,
} from "./vendor/fenshot/index.js";
import {
  detectHighlight,
  orientSquare,
  validateLastMove,
  lastMoveCastlingRights,
  squareName as hlSquareName,
} from "./highlight.js";

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const boardEl = $("board");
const paletteEl = $("palette");
const reviewBoardEl = $("review-board");

const PIECES = ["K", "Q", "R", "B", "N", "P", "k", "q", "r", "b", "n", "p"];
const SAMPLE_FEN = "r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 0 1";
const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const EMPTY_FEN = "8/8/8/8/8/8/8/8 w - - 0 1";
const SCAN_TIMEOUT_MS = 15000;

// Board state: 64 entries, index = rankIndex*8 + file, rankIndex 0 = rank 8.
let board = new Array(64).fill("");
let flipped = false; // true = Black at the bottom
let turn = "w";
let lowConfSquares = new Set();
let currentBlob = null;
let currentBlobUrl = null;
let selectedPal = null;
let selectedSquare = -1;
let recognizer = null; // main-thread fallback recognizer
let scanInfo = null; // last scan: {minConfidence, meanConfidence, reliable, orientation, corners, frame}
let confirmed = false; // user explicitly confirmed the board after review
let cropRect = null; // {x,y,w,h} in natural image pixels, or null
let highlightSquares = new Set(); // oriented square names of the last-move highlight
let castlingAssumed = false; // castling shown came from home squares, never proven

function pieceSvg(code) {
  const color = code === code.toUpperCase() ? "w" : "b";
  return `./pieces/${color}${code.toUpperCase()}.svg`;
}
function setStatus(msg) { statusEl.textContent = msg; }
function squareName(idx) { return "abcdefgh"[idx % 8] + (8 - Math.floor(idx / 8)); }
function idxOf(file, rank) { return (8 - rank) * 8 + file; } // rank 1..8

function placementFromBoard() {
  const ranks = [];
  for (let r = 0; r < 8; r++) {
    let row = "", empty = 0;
    for (let f = 0; f < 8; f++) {
      const p = board[r * 8 + f];
      if (!p) empty++;
      else { if (empty) { row += empty; empty = 0; } row += p; }
    }
    if (empty) row += empty;
    ranks.push(row);
  }
  return ranks.join("/");
}
function castlingFromBoxes() {
  let rights = "";
  for (const c of ["K", "Q", "k", "q"]) if ($(`castle-${c}`).checked) rights += c;
  return rights || "-";
}
function epFromSelect() { return $("ep-select").value || "-"; }
function fenFromState() {
  return `${placementFromBoard()} ${turn} ${castlingFromBoxes()} ${epFromSelect()} 0 1`;
}
function lichessAnalysisUrl(fen) {
  // Engine off on arrival: the plain analysis link loads with Lichess's
  // local engine toggle OFF on web (verified live Nov 20, 2026), so no
  // engine parameter is used — ?engine=off is not a Lichess parameter
  // and the malformed form loses the FEN entirely. Color orients the
  // board: black when Black is at the bottom or Black is to move.
  const color = flipped || turn === "b" ? "black" : "white";
  return "https://lichess.org/analysis/standard/" + fen.replace(/ /g, "_") + "?color=" + color;
}
function lichessEditorUrl(fen) {
  return "https://lichess.org/editor/" + fen.replace(/ /g, "_");
}

// ---- legality + check sanity (Gemini/Mistral gate) ----
function countPieces() {
  let w = 0, b = 0, wK = 0, bK = 0, pawnsBad = [];
  for (let i = 0; i < 64; i++) {
    const p = board[i];
    if (!p) continue;
    const rank = 8 - Math.floor(i / 8);
    if (p === p.toUpperCase()) { w++; if (p === "K") wK++; }
    else { b++; if (p === "k") bK++; }
    if ((p === "P" || p === "p") && (rank === 1 || rank === 8)) pawnsBad.push(squareName(i));
  }
  return { w, b, wK, bK, pawnsBad };
}
function legalityIssues() {
  const c = countPieces();
  const issues = [];
  if (c.wK !== 1) issues.push(`White has ${c.wK} king(s), expected exactly 1.`);
  if (c.bK !== 1) issues.push(`Black has ${c.bK} king(s), expected exactly 1.`);
  if (c.w > 16) issues.push(`White has ${c.w} pieces, max 16.`);
  if (c.b > 16) issues.push(`Black has ${c.b} pieces, max 16.`);
  if (c.pawnsBad.length) issues.push(`Pawn on rank 1/8: ${c.pawnsBad.join(", ")}.`);
  return issues;
}
function isAttacked(targetIdx, byWhite) {
  const tr = Math.floor(targetIdx / 8), tf = targetIdx % 8;
  // Pawns: a white pawn attacks from one rank below the target.
  const pr = byWhite ? tr + 1 : tr - 1;
  for (const df of [-1, 1]) {
    const f = tf + df;
    if (pr >= 0 && pr < 8 && f >= 0 && f < 8 && board[pr * 8 + f] === (byWhite ? "P" : "p")) return true;
  }
  // Knights and king.
  for (const [dr, df, kind] of [[-2, -1, "N"], [-2, 1, "N"], [-1, -2, "N"], [-1, 2, "N"], [1, -2, "N"], [1, 2, "N"], [2, -1, "N"], [2, 1, "N"]]) {
    const r = tr + dr, f = tf + df;
    if (r >= 0 && r < 8 && f >= 0 && f < 8 && board[r * 8 + f] === (byWhite ? "N" : "n")) return true;
  }
  for (let dr = -1; dr <= 1; dr++) for (let df = -1; df <= 1; df++) {
    if (!dr && !df) continue;
    const r = tr + dr, f = tf + df;
    if (r >= 0 && r < 8 && f >= 0 && f < 8 && board[r * 8 + f] === (byWhite ? "K" : "k")) return true;
  }
  // Sliders: rook/queen on ranks/files, bishop/queen on diagonals.
  const rays = [
    { dirs: [[-1, 0], [1, 0], [0, -1], [0, 1]], piece: "R" },
    { dirs: [[-1, -1], [-1, 1], [1, -1], [1, 1]], piece: "B" },
  ];
  for (const { dirs, piece } of rays) {
    for (const [dr, df] of dirs) {
      let r = tr + dr, f = tf + df;
      while (r >= 0 && r < 8 && f >= 0 && f < 8) {
        const p = board[r * 8 + f];
        if (p) {
          const want = byWhite ? piece : piece.toLowerCase();
          const queen = byWhite ? "Q" : "q";
          if (p === want || p === queen) return true;
          break;
        }
        r += dr; f += df;
      }
    }
  }
  return false;
}
function kingInCheck(white) {
  const king = white ? "K" : "k";
  const idx = board.indexOf(king);
  if (idx < 0) return false;
  return isAttacked(idx, !white);
}
function pawnCount() {
  return board.filter((p) => p === "P" || p === "p").length;
}

// ---- rendering ----
function renderBoardInto(el, interactive) {
  el.innerHTML = "";
  const order = [];
  for (let r = 0; r < 8; r++)
    for (let f = 0; f < 8; f++)
      order.push(flipped ? (7 - r) * 8 + (7 - f) : r * 8 + f);
  for (const idx of order) {
    const r = Math.floor(idx / 8), f = idx % 8;
    const cell = interactive ? document.createElement("button") : document.createElement("div");
    if (interactive) cell.type = "button";
    cell.className = "square " + ((r + f) % 2 === 0 ? "light" : "dark");
    cell.setAttribute("aria-label", squareName(idx) + (board[idx] ? " " + board[idx] : " empty"));
    if (interactive && idx === selectedSquare) cell.classList.add("selected");
    if (lowConfSquares.has(squareName(idx))) cell.classList.add("lowconf");
    if (highlightSquares.has(squareName(idx))) cell.classList.add("highlight");
    if (board[idx]) {
      const img = document.createElement("img");
      img.src = pieceSvg(board[idx]);
      img.alt = board[idx];
      cell.appendChild(img);
    }
    // Coordinates: file letters on the bottom rank, rank numbers on the left file.
    const dispRank = flipped ? r + 1 : 8 - r; // rank shown at this visual row's left edge
    const dispFile = flipped ? 7 - f : f;
    if ((flipped ? r === 7 : r === 7)) {
      const coord = document.createElement("span");
      coord.className = "coord file";
      coord.textContent = "abcdefgh"[dispFile];
      cell.appendChild(coord);
    }
    if ((flipped ? f === 7 : f === 0)) {
      const coord = document.createElement("span");
      coord.className = "coord rank";
      coord.textContent = String(dispRank);
      cell.appendChild(coord);
    }
    if (interactive) cell.addEventListener("click", () => onSquareClick(idx));
    el.appendChild(cell);
  }
}
function renderBoard() { renderBoardInto(boardEl, true); renderBoardInto(reviewBoardEl, false); }

function renderPalette() {
  paletteEl.innerHTML = "";
  for (const code of PIECES) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pal" + (selectedPal === code ? " active" : "");
    b.setAttribute("aria-label", "Place " + code);
    const img = document.createElement("img");
    img.src = pieceSvg(code);
    img.alt = code;
    b.appendChild(img);
    b.addEventListener("click", () => { selectedPal = code; selectedSquare = -1; syncTools(); });
    paletteEl.appendChild(b);
  }
}
function syncTools() {
  $("tool-move").classList.toggle("active", selectedPal === null);
  $("tool-erase").classList.toggle("active", selectedPal === "erase");
  renderPalette();
  renderBoard();
}

// ---- pre-flight strip + gating ----
function updateCastlingMask() {
  // Only geometrically possible rights can be enabled.
  const mask = {
    K: board[idxOf(4, 1)] === "K" && board[idxOf(7, 1)] === "R",
    Q: board[idxOf(4, 1)] === "K" && board[idxOf(0, 1)] === "R",
    k: board[idxOf(4, 8)] === "k" && board[idxOf(7, 8)] === "r",
    q: board[idxOf(4, 8)] === "k" && board[idxOf(0, 8)] === "r",
  };
  for (const c of ["K", "Q", "k", "q"]) {
    const box = $(`castle-${c}`);
    box.disabled = !mask[c];
    if (!mask[c]) box.checked = false;
    box.closest("label").classList.toggle("masked", !mask[c]);
  }
  const rights = castlingFromBoxes();
  $("castling-chip").textContent = rights === "-" ? "Off (–)" : rights + (castlingAssumed ? " (assumed)" : "");
}
function updateEpOptions() {
  const sel = $("ep-select");
  const keep = sel.value;
  sel.innerHTML = "";
  const none = document.createElement("option");
  none.value = "-"; none.textContent = "None (–)";
  sel.appendChild(none);
  // Geometrically possible en passant squares only.
  // White to capture: a black pawn just double-stepped to rank 5, a white
  // pawn stands on rank 5 next to it, target is rank 6. Black to capture:
  // a white pawn just double-stepped to rank 4, a black pawn stands on
  // rank 4 next to it, target is rank 3.
  const squares = [];
  if (turn === "w") {
    for (let f = 0; f < 8; f++) {
      if (board[idxOf(f, 5)] !== "p") continue;
      for (const df of [-1, 1]) {
        const nf = f + df;
        if (nf >= 0 && nf < 8 && board[idxOf(nf, 5)] === "P") squares.push(squareName(idxOf(f, 6)));
      }
    }
  } else {
    for (let f = 0; f < 8; f++) {
      if (board[idxOf(f, 4)] !== "P") continue;
      for (const df of [-1, 1]) {
        const nf = f + df;
        if (nf >= 0 && nf < 8 && board[idxOf(nf, 4)] === "p") squares.push(squareName(idxOf(f, 3)));
      }
    }
  }
  for (const s of [...new Set(squares)]) {
    const o = document.createElement("option");
    o.value = s; o.textContent = s;
    sel.appendChild(o);
  }
  sel.value = [...sel.options].some((o) => o.value === keep) ? keep : "-";
}
function update() {
  const fen = fenFromState();
  const issues = legalityIssues();
  const legal = issues.length === 0;
  $("fen-out").textContent = fen;
  if (document.activeElement !== $("fen-input")) $("fen-input").value = fen;
  $("turn-white").classList.toggle("active", turn === "w");
  $("turn-black").classList.toggle("active", turn === "b");
  $("orientation-out").textContent = flipped ? "Black at bottom" : "White at bottom";
  updateCastlingMask();
  updateEpOptions();
  // Legality + confidence status.
  const legEl = $("legality-status");
  if (legal) { legEl.textContent = "Position is legal: one king each side, piece counts OK, no pawns on ranks 1/8."; legEl.className = "ok"; }
  else { legEl.textContent = "Illegal position: " + issues.join(" "); legEl.className = "bad"; }
  const confEl = $("confidence");
  if (scanInfo) {
    confEl.hidden = false;
    confEl.textContent = `Scan confidence: mean ${scanInfo.meanConfidence.toFixed(2)}, weakest square ${scanInfo.minConfidence.toFixed(2)}.` +
      (scanInfo.reliable ? "" : " Below the 0.70 reliability floor: check every piece.") +
      ` Board read as ${scanInfo.orientation === "black" ? "Black" : "White"} at the bottom.`;
  }
  // Turn sanity: a king in check means that side must be to move.
  const turnWarn = $("turn-warning");
  turnWarn.hidden = true;
  if (legal) {
    if (kingInCheck(true) && turn === "b") {
      turnWarn.hidden = false;
      turnWarn.textContent = "White is in check, so White is probably to move. ";
      const btn = document.createElement("button");
      btn.type = "button"; btn.textContent = "Switch to White to move";
      btn.addEventListener("click", () => { turn = "w"; confirmed = false; update(); });
      turnWarn.appendChild(btn);
    } else if (kingInCheck(false) && turn === "w") {
      turnWarn.hidden = false;
      turnWarn.textContent = "Black is in check, so Black is probably to move. ";
      const btn = document.createElement("button");
      btn.type = "button"; btn.textContent = "Switch to Black to move";
      btn.addEventListener("click", () => { turn = "b"; confirmed = false; update(); });
      turnWarn.appendChild(btn);
    }
  }
  // Orientation warning for pawnless / sparse-pawn endgames.
  const orientWarn = $("orientation-warning");
  if (scanInfo && pawnCount() <= 2) {
    orientWarn.hidden = false;
    orientWarn.textContent = "Verify board orientation: very few pawns, so the pawn-direction clue is weak and the board may be flipped. Use Flip 180 if the position looks upside down.";
  } else orientWarn.hidden = true;
  // Gate: Lichess opens only after an explicit confirm tap, on a legal board.
  const gate = $("gate-note");
  const openBtn = $("lichess-open-btn");
  const editorLink = $("editor-link");
  editorLink.href = lichessEditorUrl(fen);
  if (!legal) {
    openBtn.disabled = true;
    openBtn.textContent = "Open in Lichess Editor instead (position is illegal)";
    gate.textContent = "This position is illegal, so it cannot open in analysis. Fix it, or open it in the Lichess Editor.";
    editorLink.classList.add("big");
  } else {
    editorLink.classList.remove("big");
    openBtn.textContent = "Open in Lichess";
    if (confirmed) {
      openBtn.disabled = false;
      gate.textContent = "Board confirmed. Tap Open in Lichess when ready.";
    } else {
      openBtn.disabled = true;
      gate.textContent = "Compare the photo with the reconstructed board below, fix any wrong square, then tap “I checked this board”.";
    }
  }
  renderBoard();
}
function invalidateConfirm() { confirmed = false; update(); }

function setTurnSource(text, assumed) {
  $("turn-source").textContent = text;
  $("turn-source-2").textContent = text;
  $("turn-white").classList.toggle("assumed", !!assumed);
  $("turn-black").classList.toggle("assumed", !!assumed);
}

// Sample the last-move highlight from the scanned image, in fenshot's
// frame coordinates. Returns {found, squares, diagnostics} in read coords.
async function highlightFromBlob(blob, scan) {
  const img = new Image();
  const url = URL.createObjectURL(blob);
  try {
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = url; });
    const w = (scan.frame && scan.frame.width) || img.naturalWidth;
    const h = (scan.frame && scan.frame.height) || img.naturalHeight;
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const imageData = ctx.getImageData(0, 0, w, h);
    return detectHighlight({ data: imageData.data, width: w, height: h }, scan.corners);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Decide side to move after a scan. Order (Chess Best Move):
// highlight, then starting position, then in-check sanity, then the
// player at the bottom, marked assumed. Never silent: the source is shown.
function decideTurnAfterScan(placement, orientation, hlValid) {
  const START_PLACEMENT = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR";
  if (placement === START_PLACEMENT) {
    turn = "w";
    setTurnSource("White to move — game has not started.", false);
    return;
  }
  if (hlValid) {
    turn = hlValid.white ? "b" : "w";
    setTurnSource(`${turn === "w" ? "White" : "Black"} to move — from last-move highlight (${hlValid.white ? "White" : "Black"} ${hlValid.notation}).`, false);
    // In-check sanity: if the side NOT chosen is in check, flip.
    if (turn === "w" && kingInCheck(false)) {
      turn = "b";
      setTurnSource("Black to move — from check (Black is in check).", false);
    } else if (turn === "b" && kingInCheck(true)) {
      turn = "w";
      setTurnSource("White to move — from check (White is in check).", false);
    }
    return;
  }
  // No usable highlight: check sanity first, then assumed bottom player.
  if (turn === "w" && kingInCheck(false)) {
    turn = "b";
    setTurnSource("Black to move — from check (Black is in check).", false);
    return;
  }
  if (turn === "b" && kingInCheck(true)) {
    turn = "w";
    setTurnSource("White to move — from check (White is in check).", false);
    return;
  }
  turn = flipped ? "b" : "w";
  setTurnSource(`${turn === "w" ? "White" : "Black"} to move — assumed you are at the bottom. Tap to change.`, true);
}

// ---- editor actions ----
function onSquareClick(idx) {
  lowConfSquares.clear();
  if (selectedPal === "erase") board[idx] = "";
  else if (selectedPal) board[idx] = selectedPal;
  else if (selectedSquare === -1) { if (board[idx]) selectedSquare = idx; }
  else if (selectedSquare === idx) selectedSquare = -1;
  else { board[idx] = board[selectedSquare]; board[selectedSquare] = ""; selectedSquare = -1; }
  invalidateConfirm();
}
function loadFenString(fen) {
  const parts = fen.trim().split(/\s+/);
  if (!parts[0]) return false;
  const rows = parts[0].split("/");
  if (rows.length !== 8) return false;
  const next = new Array(64).fill("");
  for (let r = 0; r < 8; r++) {
    let f = 0;
    for (const ch of rows[r]) {
      if (/\d/.test(ch)) f += +ch;
      else if (/[kqrbnpKQRBNP]/.test(ch)) { next[r * 8 + f] = ch; f++; }
      else return false;
    }
    if (f !== 8) return false;
  }
  board = next;
  turn = parts[1] === "b" ? "b" : "w";
  const castling = parts[2] && parts[2] !== "-" ? parts[2] : "";
  for (const c of ["K", "Q", "k", "q"]) $(`castle-${c}`).checked = castling.includes(c);
  const ep = parts[3] || "-";
  lowConfSquares.clear();
  highlightSquares.clear();
  castlingAssumed = false;
  setTurnSource(parts[1] ? "Side to move from the loaded FEN." : "", false);
  scanInfo = null;
  $("confidence").hidden = true;
  update();
  // En passant select is rebuilt by update(); restore the value if valid.
  const sel = $("ep-select");
  if ([...sel.options].some((o) => o.value === ep)) sel.value = ep;
  update();
  return true;
}
function flipBoard180() {
  // Rotate the position 180 degrees (what Flip 180 means for the board).
  const next = new Array(64).fill("");
  for (let i = 0; i < 64; i++) next[63 - i] = board[i];
  board = next;
  flipped = !flipped;
  invalidateConfirm();
}

// ---- recognition: worker first, main-thread fallback ----
function scanInWorker(blob) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker("./worker.js", { type: "module" });
    } catch (err) { reject(err); return; }
    const id = Math.random().toString(36).slice(2);
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error("Scan timed out after 15 seconds in the worker."));
    }, SCAN_TIMEOUT_MS);
    worker.onmessage = (e) => {
      if (!e.data || e.data.id !== id) return;
      clearTimeout(timer);
      worker.terminate();
      if (e.data.type === "result") resolve({ scan: e.data.scan, via: "worker" });
      else reject(new Error(e.data.message || "Worker scan failed."));
    };
    worker.onerror = (e) => {
      clearTimeout(timer);
      worker.terminate();
      reject(new Error(e.message || "Worker failed to load."));
    };
    worker.postMessage({ id, blob });
  });
}
async function scanMainThread(blob) {
  if (!recognizer) {
    recognizer = createRecognizer({
      modelUrl: new URL("./models/chess-tiles-v2.onnx", document.baseURI).href,
      wasmPaths: new URL("./ort/", document.baseURI).href,
    });
  }
  return { scan: await recognizer.recognize(blob), via: "main thread" };
}
async function recognizeBlob(blob) {
  try {
    return await scanInWorker(blob);
  } catch (workerErr) {
    console.warn("Worker scan failed, falling back to main thread:", workerErr);
    try {
      return await scanMainThread(blob);
    } catch (mainErr) {
      throw new Error(`Scan failed in worker (${workerErr.message}) and on main thread (${mainErr.message}).`);
    }
  }
}

// ---- scan flow ----
function showPreview(blob) {
  if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl);
  currentBlobUrl = URL.createObjectURL(blob);
  const img = $("preview");
  img.onload = () => { if (currentBlobUrl) { URL.revokeObjectURL(currentBlobUrl); currentBlobUrl = null; } };
  img.src = currentBlobUrl;
  $("preview-wrap").hidden = false;
  $("review").hidden = false;
  $("scan-btn").disabled = false;
}
async function scanBlob(blob, label, direct) {
  if (!blob) return;
  currentBlob = blob;
  showPreview(blob);
  cropRect = null;
  setStatus(`Scanning ${label || "image"}… (first scan loads the 1.3 MB model and the on-device engine; later scans are fast.)`);
  $("fallback").hidden = true;
  try {
    const { scan, via } = await recognizeBlob(blob);
    if (!scan) {
      setStatus("No chessboard found in that image.");
      showFallback("no-board", null);
      return;
    }
    await applyScan(scan, via);
    // Manual upload, direct to Lichess: a confident, legal read opens
    // Lichess straight away, no editor stop. Anything doubtful stays
    // here in the editor instead. A plain navigation (not window.open)
    // so the browser cannot block it as a popup after the async scan.
    if (direct && scan.reliable) {
      const w = scan.corners.x1 - scan.corners.x0, h = scan.corners.y1 - scan.corners.y0;
      const aspectDev = Math.abs(w - h) / Math.max(w, h);
      const tilePx = Math.min(w, h) / 8;
      if (aspectDev <= 0.08 && tilePx >= 32 && legalityIssues().length === 0) {
        setStatus("Position read. Opening in Lichess…");
        location.assign(lichessAnalysisUrl(fenFromState()));
      }
    }
  } catch (err) {
    console.error(err);
    setStatus(`Scan failed: ${err && err.message ? err.message : err}. The photo is shown next to the editor below: set the position by hand, or try the retries.`);
    showFallback("error", err && err.message ? err.message : String(err));
  }
}
async function applyScan(scan, via) {
  const { placement, orientation } = resolveOrientation(scan.placement);
  scanInfo = {
    minConfidence: scan.minConfidence,
    meanConfidence: scan.meanConfidence,
    reliable: scan.reliable,
    orientation,
    corners: scan.corners,
  };
  if (!loadFenString(`${placement} w - - 0 1`)) {
    setStatus("The board was read but the position could not be loaded. Please set it by hand.");
    showFallback("error", null);
    return;
  }
  // Side to move, castling and en passant from the last-move highlight.
  // A photo cannot prove castling: rights below are inferred/assumed
  // from home squares, adjusted by the last move, and labelled assumed.
  flipped = orientation === "black";
  if (orientation === "black") $("orientation-prompt").hidden = false;
  else $("orientation-prompt").hidden = true;
  let hlValid = null;
  try {
    const hl = await highlightFromBlob(currentBlob, scan);
    if (hl.found) {
      const oriented = hl.squares.map((s) => orientSquare(s.file, s.rank, orientation));
      const pieceAtOriented = (sq) => board[(8 - sq.rank) * 8 + sq.file];
      const from = oriented.find((s) => !pieceAtOriented(s));
      const to = oriented.find((s) => pieceAtOriented(s));
      if (from && to) {
        const v = validateLastMove(placement, from, to);
        if (v.ok) {
          hlValid = v;
          highlightSquares = new Set(oriented.map((s) => hlSquareName(s.file, s.rank)));
          const rights = lastMoveCastlingRights(placement, from, to, v.mover);
          for (const c of ["K", "Q", "k", "q"]) $(`castle-${c}`).checked = rights !== "-" && rights.includes(c);
          castlingAssumed = rights !== "-";
        } else {
          setStatus(`Board scanned, but the highlight pair (${oriented.map((s) => hlSquareName(s.file, s.rank)).join(", ")}) is not a legal last move (${v.reason}). Side to move was not auto-set from it.`);
        }
      }
    }
  } catch (err) {
    console.warn("Highlight detection failed:", err);
  }
  if (!hlValid) {
    // No usable highlight: no castling by default; the user can tap
    // "Use inferred castling (assumed)" in the pre-flight strip.
    for (const c of ["K", "Q", "k", "q"]) $(`castle-${c}`).checked = false;
    castlingAssumed = false;
  }
  decideTurnAfterScan(placement, orientation, hlValid);
  update();
  // En passant: auto-set only for a double step with an enemy pawn
  // next to the destination rank that could capture it.
  if (hlValid && hlValid.isDoubleStep && hlValid.epAuto) {
    const sel = $("ep-select");
    if ([...sel.options].some((o) => o.value === hlValid.epTarget)) {
      sel.value = hlValid.epTarget;
      $("ep-source").textContent = `from last-move highlight (${hlValid.notation} double step)`;
      update();
    }
  }
  // Low-confidence squares, flagged on the board.
  lowConfSquares = new Set();
  const low = [];
  const conf = scan.confidences; // A1..H8 order
  for (let rank = 1; rank <= 8; rank++)
    for (let file = 0; file < 8; file++) {
      if (conf[(rank - 1) * 8 + file] < CONFIDENCE_FLOOR) low.push("abcdefgh"[file] + rank);
    }
  low.forEach((s) => lowConfSquares.add(s));
  const lowEl = $("low-confidence");
  if (low.length) {
    lowEl.hidden = false;
    lowEl.textContent = `Low-confidence squares (outlined in red, please check): ${low.join(", ")}.`;
  } else lowEl.hidden = true;
  confirmed = false;
  update();
  // Fallback triggers: unreliable read, squashed board, tiny tiles.
  const w = scan.corners.x1 - scan.corners.x0, h = scan.corners.y1 - scan.corners.y0;
  const aspectDev = Math.abs(w - h) / Math.max(w, h);
  const tilePx = Math.min(w, h) / 8;
  if (!scan.reliable || aspectDev > 0.08 || tilePx < 32) {
    showFallback("low-confidence", null);
  }
  const viaNote = via === "worker" ? " (in a background worker)" : " (on the main thread; the worker was unavailable)";
  if (!scan.reliable) {
    setStatus(`Scan finished${viaNote}, but confidence is below the 0.70 floor. Check every piece against the photo, use the retries below, or fix the board by hand.`);
  } else {
    setStatus(`Board scanned${viaNote}. Compare the photo with the reconstructed board, fix any wrong square, then tap “I checked this board”.`);
  }
}
function showFallback(reason, detail) {
  const fb = $("fallback");
  fb.hidden = false;
  const why = $("fallback-why");
  if (reason === "no-board") {
    why.textContent = "No board was found. Common causes on WhatsApp photos: the board is cropped so a rank or file is cut off, the photo is rotated, it is a 3D piece set, or arrows / annotations cover pieces. Partial boards, 90° rotations, opaque arrows and 3D sets are not supported: crop to the full board, rotate it upright, and retry, or set the position by hand in the editor.";
  } else if (reason === "low-confidence") {
    why.textContent = "Confidence is low or the board looks squashed / small. Common causes: a rotated or cropped board, 3D pieces, arrows obscuring pieces, or a photo taken at an angle. Try the retries below, or fix the flagged squares by hand.";
  } else {
    why.textContent = "The scan failed" + (detail ? `: ${detail}.` : ".") + " The photo is shown next to the editor: set the position by hand, paste a FEN, or try a retry below.";
  }
  $("crop-scan-btn").disabled = !cropRect;
}
async function blobFromCanvas(canvas) {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}
async function scanWithTransform(kind) {
  if (!currentBlob) return;
  const img = new Image();
  const url = URL.createObjectURL(currentBlob);
  try {
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = url; });
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (kind === "rotate90") {
      canvas.width = img.naturalHeight; canvas.height = img.naturalWidth;
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
    } else if (kind === "contrast") {
      canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
      ctx.filter = "contrast(1.35) brightness(1.08) saturate(1.1)";
      ctx.drawImage(img, 0, 0);
    } else if (kind === "crop" && cropRect) {
      canvas.width = cropRect.w; canvas.height = cropRect.h;
      ctx.drawImage(img, cropRect.x, cropRect.y, cropRect.w, cropRect.h, 0, 0, cropRect.w, cropRect.h);
    }
    const out = await blobFromCanvas(canvas);
    if (out) {
      currentBlob = out;
      await scanBlob(out, kind === "rotate90" ? "rotated image" : kind === "contrast" ? "contrast-boosted image" : "cropped image");
    }
  } catch (err) {
    setStatus(`Retry failed: ${err && err.message ? err.message : err}.`);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---- shared image handoff (unique key, delete on read) ----
async function loadSharedImage() {
  const params = new URLSearchParams(location.search);
  if (!params.has("shared")) return;
  const key = params.get("shared");
  history.replaceState(null, "", "./");
  if (key === "empty") {
    setStatus("The share arrived with no photo (a known Android / Chrome share bug can send an empty body). Choose an image below, or paste one, and it will be scanned the same way.");
    $("file-input").focus();
    return;
  }
  if (key === "error") {
    setStatus("The shared photo could not be accepted (wrong file type or too large). Choose an image below, or paste one.");
    return;
  }
  if (!/^shared-\d+-[a-z0-9]+$/.test(key)) {
    setStatus("That share link looks invalid. Choose an image below, or paste one.");
    return;
  }
  try {
    const cache = await caches.open("share-to-lichess");
    const entryUrl = new URL(key, location.href).href;
    const res = await cache.match(entryUrl);
    if (!res) {
      setStatus("Shared photo not found (it may have expired after 60 seconds). Share it again, or choose an image below.");
      return;
    }
    const blob = await res.blob();
    // Delete immediately, before inference finishes: Cache Storage is
    // origin-scoped, so a leftover share could be read by another page.
    await cache.delete(entryUrl);
    await scanBlob(blob, "shared photo");
  } catch (err) {
    console.error(err);
    setStatus("Could not read the shared photo. Choose an image below, or paste one.");
  }
}

// ---- wiring ----
$("file-input").addEventListener("change", (e) => {
  const f = e.target.files && e.target.files[0];
  if (f) void scanBlob(f, "uploaded image", true);
});
const dz = $("dropzone");
["dragover", "dragenter"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("drag"); }));
["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("drag"); }));
dz.addEventListener("drop", (e) => {
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) void scanBlob(f, "dropped image", true);
});
document.addEventListener("paste", (e) => {
  const items = (e.clipboardData && e.clipboardData.items) || [];
  for (const item of items) {
    if (item.type && item.type.startsWith("image/")) {
      const f = item.getAsFile();
      if (f) void scanBlob(f, "pasted image", true);
      break;
    }
  }
});
$("scan-btn").addEventListener("click", () => { if (currentBlob) void scanBlob(currentBlob, "image", true); });
$("tool-move").addEventListener("click", () => { selectedPal = null; selectedSquare = -1; syncTools(); });
$("tool-erase").addEventListener("click", () => { selectedPal = "erase"; selectedSquare = -1; syncTools(); });
$("flip-btn").addEventListener("click", () => { flipBoard180(); });
$("rotate90-btn").addEventListener("click", () => { void scanWithTransform("rotate90"); });
$("flip180-btn").addEventListener("click", () => { flipBoard180(); });
$("clear-btn").addEventListener("click", () => { board = new Array(64).fill(""); lowConfSquares.clear(); invalidateConfirm(); });
$("start-btn").addEventListener("click", () => { loadFenString(START_FEN); invalidateConfirm(); });
$("sample-btn").addEventListener("click", () => { loadFenString(SAMPLE_FEN); invalidateConfirm(); });
$("turn-white").addEventListener("click", () => { turn = "w"; invalidateConfirm(); });
$("turn-black").addEventListener("click", () => { turn = "b"; invalidateConfirm(); });
for (const c of ["K", "Q", "k", "q"]) $(`castle-${c}`).addEventListener("change", invalidateConfirm);
$("ep-select").addEventListener("change", invalidateConfirm);
$("inferred-castling-btn").addEventListener("click", () => {
  const inferred = inferCastling(placementFromBoard());
  if (inferred === "-") { setStatus("No castling can be inferred: king and rook are not both on their home squares."); return; }
  for (const c of ["K", "Q", "k", "q"]) $(`castle-${c}`).checked = inferred.includes(c);
  castlingAssumed = true;
  setStatus(`Castling set from the board as inferred (${inferred}). This is a guess from home squares only: uncheck it if the king or rook has already moved.`);
  invalidateConfirm();
});
$("fen-load-btn").addEventListener("click", () => {
  if (!loadFenString($("fen-input").value)) setStatus("That FEN did not parse. It needs 8 ranks, e.g. " + START_FEN);
  else { setStatus("FEN loaded."); invalidateConfirm(); }
});
$("copy-fen-btn").addEventListener("click", async () => {
  const fen = fenFromState();
  try { await navigator.clipboard.writeText(fen); setStatus("FEN copied."); }
  catch { $("fen-input").select(); setStatus("Copy blocked by the browser; the FEN is selected in the box above, copy it with Ctrl+C."); }
});
$("confirm-btn").addEventListener("click", () => {
  if (legalityIssues().length) { setStatus("Fix the illegal position first: " + legalityIssues().join(" ")); return; }
  confirmed = true;
  setStatus("Board confirmed by you. Tap Open in Lichess when ready.");
  update();
});
$("lichess-open-btn").addEventListener("click", () => {
  if ($("lichess-open-btn").disabled) return;
  const fen = fenFromState();
  const url = lichessAnalysisUrl(fen);
  window.open(url, "_blank", "noopener,noreferrer");
});
$("orientation-black-move").addEventListener("click", () => { turn = "b"; $("orientation-prompt").hidden = true; invalidateConfirm(); });
$("orientation-keep-white").addEventListener("click", () => { $("orientation-prompt").hidden = true; });
$("rotate-scan-btn").addEventListener("click", () => { void scanWithTransform("rotate90"); });
$("contrast-scan-btn").addEventListener("click", () => { void scanWithTransform("contrast"); });
$("crop-scan-btn").addEventListener("click", () => { void scanWithTransform("crop"); });

// Drag-to-crop on the preview image.
(function setupCrop() {
  const wrap = $("preview-wrap");
  const overlay = $("crop-overlay");
  let start = null;
  const toNatural = (e) => {
    const img = $("preview");
    const r = img.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * img.naturalWidth;
    const y = ((e.clientY - r.top) / r.height) * img.naturalHeight;
    return { x: Math.max(0, Math.min(img.naturalWidth, x)), y: Math.max(0, Math.min(img.naturalHeight, y)) };
  };
  wrap.addEventListener("pointerdown", (e) => { start = toNatural(e); wrap.setPointerCapture(e.pointerId); });
  wrap.addEventListener("pointermove", (e) => {
    if (!start) return;
    const cur = toNatural(e);
    const img = $("preview");
    const r = img.getBoundingClientRect();
    const x0 = Math.min(start.x, cur.x) / img.naturalWidth * r.width;
    const y0 = Math.min(start.y, cur.y) / img.naturalHeight * r.height;
    const w = Math.abs(cur.x - start.x) / img.naturalWidth * r.width;
    const h = Math.abs(cur.y - start.y) / img.naturalHeight * r.height;
    overlay.style.display = "block";
    overlay.style.left = x0 + "px"; overlay.style.top = y0 + "px";
    overlay.style.width = w + "px"; overlay.style.height = h + "px";
  });
  wrap.addEventListener("pointerup", (e) => {
    if (!start) return;
    const cur = toNatural(e);
    const w = Math.abs(cur.x - start.x), h = Math.abs(cur.y - start.y);
    if (w > 40 && h > 40) {
      cropRect = { x: Math.round(Math.min(start.x, cur.x)), y: Math.round(Math.min(start.y, cur.y)), w: Math.round(w), h: Math.round(h) };
      $("crop-scan-btn").disabled = false;
      setStatus("Crop selected. Tap “Scan cropped area” to re-scan just that part of the photo.");
    }
    start = null;
  });
})();

// Service worker (share target). Relative scope so the app works under
// any base path, e.g. /share-to-lichess/ on GitHub Pages.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js", { scope: "./" })
    .then((reg) => {
      $("sw-status").textContent = `Service worker: registered (scope ${reg.scope}). After installing the app, it will appear in the Android share sheet.`;
    })
    .catch((err) => {
      $("sw-status").textContent = "Service worker: not registered (" + err.message + "). Sharing to this app needs it; the file picker scan still works.";
    });
} else {
  $("sw-status").textContent = "Service worker: not supported in this browser. The file picker scan still works.";
}
if (navigator.storage && navigator.storage.persist) {
  navigator.storage.persist().catch(() => {});
}

loadFenString(EMPTY_FEN);
syncTools(); // render the piece palette on load; before this it only appeared after tapping Move / Erase.
void loadSharedImage();
