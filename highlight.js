// Last-move highlight inference — pure functions, no DOM.
// After fenshot finds the board (corners, white-at-bottom read), sample
// each square's background tint and look for exactly two squares that
// deviate from their light/dark base in the same direction. Those are the
// last-move highlight squares. Works for any theme: Lichess/Chess.com use
// yellow/green and other themes differ, so no colour is hard-coded.
// A check highlight is a single square and a selected square is single,
// so neither can pass the exactly-two test. Arrows are strokes, not
// full-square tints, and are sampled only on the square border ring.

export function squareName(file, rank) {
  return "abcdefgh"[file] + rank;
}

// Read coordinates: file 0..7 left-to-right in the image, rank 1..8 with
// rank 8 at the top of the image. fenshot reads white-at-bottom, so these
// are the coordinates of its placement before resolveOrientation.
function ringMean(px, width, height, x0, y0, x1, y1) {
  // Mean RGB over a border ring (outer 14% of the square). Pieces sit in
  // the centre, so the ring is almost always bare board.
  const w = x1 - x0, h = y1 - y0;
  const insetX = w * 0.14, insetY = h * 0.14;
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = Math.max(0, Math.floor(y0)); y < Math.min(height, Math.ceil(y1)); y++) {
    for (let x = Math.max(0, Math.floor(x0)); x < Math.min(width, Math.ceil(x1)); x++) {
      const dx = Math.min(x - x0, x1 - x);
      const dy = Math.min(y - y0, y1 - y);
      if (dx > insetX && dy > insetY) continue; // centre: skip (piece)
      const o = (y * width + x) * 4;
      r += px[o]; g += px[o + 1]; b += px[o + 2]; n++;
    }
  }
  if (!n) return null;
  return [r / n, g / n, b / n];
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export function detectHighlight(pixels, corners) {
  const { data, width, height } = pixels;
  const bw = corners.x1 - corners.x0, bh = corners.y1 - corners.y0;
  const sw = bw / 8, sh = bh / 8;
  const squares = [];
  for (let file = 0; file < 8; file++) {
    for (let rank = 1; rank <= 8; rank++) {
      // Top row in the image is rank 8 in read coordinates.
      const x0 = corners.x0 + file * sw;
      const x1 = x0 + sw;
      const y0 = corners.y0 + (8 - rank) * sh;
      const y1 = y0 + sh;
      const mean = ringMean(data, width, height, x0, y0, x1, y1);
      if (!mean) continue;
      const light = (file + rank) % 2 === 0; // a1 is dark
      squares.push({ file, rank, light, mean });
    }
  }
  const base = {};
  for (const light of [true, false]) {
    const group = squares.filter((s) => s.light === light);
    base[light] = [0, 1, 2].map((c) => median(group.map((s) => s.mean[c])));
  }
  const mags = [];
  for (const s of squares) {
    const b = base[s.light];
    s.dev = [s.mean[0] - b[0], s.mean[1] - b[1], s.mean[2] - b[2]];
    s.mag = Math.hypot(...s.dev);
    mags.push(s.mag);
  }
  const medianMag = median(mags);
  const threshold = Math.max(25, 2.2 * medianMag);
  const candidates = squares
    .filter((s) => s.mag >= threshold)
    .sort((a, b) => b.mag - a.mag);
  const diagnostics = {
    medianMag: +medianMag.toFixed(1),
    threshold: +threshold.toFixed(1),
    topMags: squares.map((s) => ({ sq: squareName(s.file, s.rank), mag: +s.mag.toFixed(1) }))
      .sort((a, b) => b.mag - a.mag).slice(0, 6),
    baseLight: base[true].map((v) => Math.round(v)),
    baseDark: base[false].map((v) => Math.round(v)),
  };
  if (candidates.length !== 2) {
    return { found: false, reason: `expected exactly 2 highlighted squares, found ${candidates.length}`, diagnostics };
  }
  const [a, b] = candidates;
  const dot = a.dev[0] * b.dev[0] + a.dev[1] * b.dev[1] + a.dev[2] * b.dev[2];
  const cosine = dot / (a.mag * b.mag);
  const ratio = Math.max(a.mag, b.mag) / Math.min(a.mag, b.mag);
  if (cosine < 0.8 || ratio > 2.5) {
    return { found: false, reason: `two tinted squares do not share a direction (cosine ${cosine.toFixed(2)}, ratio ${ratio.toFixed(2)})`, diagnostics };
  }
  return { found: true, squares: candidates, diagnostics };
}

// Map a read-coordinate square to oriented (real chess) coordinates.
export function orientSquare(file, rank, orientation) {
  if (orientation === "black") return { file: 7 - file, rank: 9 - rank };
  return { file, rank };
}

// ---- placement helpers (oriented coordinates) ----
export function expandPlacement(placement) {
  const b = new Array(64).fill("");
  const rows = placement.split("/");
  for (let r = 0; r < 8; r++) {
    let f = 0;
    for (const ch of rows[r]) {
      if (/\d/.test(ch)) f += +ch;
      else { b[r * 8 + f] = ch; f++; }
    }
  }
  return b; // index r*8+f, r=0 is rank 8
}
function pieceAt(b, file, rank) { return b[(8 - rank) * 8 + file]; }

export function inferCastling(placement) {
  const b = expandPlacement(placement);
  let rights = "";
  if (pieceAt(b, 4, 1) === "K") {
    if (pieceAt(b, 7, 1) === "R") rights += "K";
    if (pieceAt(b, 0, 1) === "R") rights += "Q";
  }
  if (pieceAt(b, 4, 8) === "k") {
    if (pieceAt(b, 7, 8) === "r") rights += "k";
    if (pieceAt(b, 0, 8) === "r") rights += "q";
  }
  return rights || "-";
}

function pathClear(b, from, to) {
  const df = Math.sign(to.file - from.file), dr = Math.sign(to.rank - from.rank);
  let f = from.file + df, r = from.rank + dr;
  while (f !== to.file || r !== to.rank) {
    if (pieceAt(b, f, r)) return false;
    f += df; r += dr;
  }
  return true;
}

// Validate a highlight pair against the oriented placement.
// from: origin square (should be empty now), to: destination (mover sits there).
export function validateLastMove(placement, from, to) {
  const b = expandPlacement(placement);
  const mover = pieceAt(b, to.file, to.rank);
  if (!mover) return { ok: false, reason: `destination ${squareName(to.file, to.rank)} is empty` };
  if (pieceAt(b, from.file, from.rank)) {
    return { ok: false, reason: `origin ${squareName(from.file, from.rank)} is occupied` };
  }
  const white = mover === mover.toUpperCase();
  const dir = white ? 1 : -1;
  const df = to.file - from.file, dr = to.rank - from.rank;
  const adf = Math.abs(df), adr = Math.abs(dr);
  const type = mover.toUpperCase();
  let isDoubleStep = false, isEnPassant = false;
  if (type === "P") {
    const homeRank = white ? 2 : 7;
    if (df === 0 && dr === dir) { /* one step */ }
    else if (df === 0 && dr === 2 * dir && from.rank === homeRank && !pieceAt(b, from.file, from.rank + dir)) isDoubleStep = true;
    else if (adf === 1 && dr === dir) {
      // Diagonal: a capture, or en passant (destination was empty of an
      // enemy piece; the captured pawn sits beside the destination).
      const victim = pieceAt(b, to.file, from.rank);
      const enemyPawn = white ? "p" : "P";
      if (victim === enemyPawn) isEnPassant = true;
      // A plain diagonal capture is also geometrically fine; the board
      // cannot tell them apart, so accept and let the EP check below decide.
    } else return { ok: false, reason: `pawn cannot move ${squareName(from.file, from.rank)} to ${squareName(to.file, to.rank)}` };
  } else if (type === "N") {
    if (!((adf === 1 && adr === 2) || (adf === 2 && adr === 1))) {
      return { ok: false, reason: `knight cannot move ${squareName(from.file, from.rank)} to ${squareName(to.file, to.rank)}` };
    }
  } else if (type === "B") {
    if (!(adf === adr && adf > 0 && pathClear(b, from, to))) {
      return { ok: false, reason: `bishop cannot move ${squareName(from.file, from.rank)} to ${squareName(to.file, to.rank)}` };
    }
  } else if (type === "R") {
    if (!((df === 0) !== (dr === 0) && pathClear(b, from, to))) {
      return { ok: false, reason: `rook cannot move ${squareName(from.file, from.rank)} to ${squareName(to.file, to.rank)}` };
    }
  } else if (type === "Q") {
    const straight = (df === 0) !== (dr === 0);
    const diagonal = adf === adr && adf > 0;
    if (!((straight || diagonal) && pathClear(b, from, to))) {
      return { ok: false, reason: `queen cannot move ${squareName(from.file, from.rank)} to ${squareName(to.file, to.rank)}` };
    }
  } else if (type === "K") {
    if (!((Math.max(adf, adr) === 1) || (dr === 0 && adf === 2))) {
      return { ok: false, reason: `king cannot move ${squareName(from.file, from.rank)} to ${squareName(to.file, to.rank)}` };
    }
  }
  const isCapture = type === "P" ? adf === 1 : false;
  const notation = `${squareName(from.file, from.rank)}${isCapture ? "x" : "-"}${squareName(to.file, to.rank)}`;
  // En passant target: the square behind a pawn that just double-stepped.
  let epTarget = "-";
  let epAuto = false;
  if (isDoubleStep) {
    epTarget = squareName(to.file, to.rank - dir);
    // Auto-set only if an enemy pawn on an adjacent file could capture it.
    for (const nf of [to.file - 1, to.file + 1]) {
      if (nf < 0 || nf > 7) continue;
      const enemy = pieceAt(b, nf, to.rank);
      if (enemy === (white ? "p" : "P")) { epAuto = true; break; }
    }
  }
  return { ok: true, mover, piece: type, white, isCapture, isDoubleStep, isEnPassant, epTarget, epAuto, notation };
}

// Castling rights after the last move: start from placement inference,
// then clear rights the last move spent.
export function lastMoveCastlingRights(placement, from, to, mover) {
  const b = expandPlacement(placement);
  let rights = inferCastling(placement);
  const clear = (c) => { rights = rights.replace(c, ""); };
  const white = mover === mover.toUpperCase();
  if (mover.toUpperCase() === "K") {
    if (white) { clear("K"); clear("Q"); } else { clear("k"); clear("q"); }
  }
  if (mover.toUpperCase() === "R") {
    if (from.file === 7 && from.rank === 1) clear("K");
    if (from.file === 0 && from.rank === 1) clear("Q");
    if (from.file === 7 && from.rank === 8) clear("k");
    if (from.file === 0 && from.rank === 8) clear("q");
  }
  // A rook captured on its home square loses that right.
  const home = [
    { file: 7, rank: 1, piece: "R", right: "K" },
    { file: 0, rank: 1, piece: "R", right: "Q" },
    { file: 7, rank: 8, piece: "r", right: "k" },
    { file: 0, rank: 8, piece: "r", right: "q" },
  ];
  for (const h of home) {
    if (to.file === h.file && to.rank === h.rank && mover !== h.piece) clear(h.right);
  }
  return rights || "-";
}
