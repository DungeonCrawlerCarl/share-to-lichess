// Acceptance test 2: Merwyn's real WhatsApp photo.
// Board is Black point of view (White at top, Black at bottom, files h..a
// left to right, ranks 1..8 top to bottom). Highlighted squares a6 (empty,
// origin) and b5 (black pawn, destination).
// Expected: placement 1rbqk2r/5ppp/2np1b2/1p2p3/4P3/N5P1/PP3P1P/R1BQKB1R
//   last move Black pawn a6xb5 (a capture, not a double step, so EP -)
//   side to move White, from last-move highlight
//   castling KQk (inferred/assumed; Black rook is on b8, not a8)
//   FEN 1rbqk2r/5ppp/2np1b2/1p2p3/4P3/N5P1/PP3P1P/R1BQKB1R w KQk - 0 1
//   Lichess https://lichess.org/analysis/standard/1rbqk2r/5ppp/2np1b2/1p2p3/4P3/N5P1/PP3P1P/R1BQKB1R_w_KQk_-_0_1
// Run: node test/recognize-whatsapp.mjs [png-path]
// (The original is a JPEG; convert it to PNG first with PIL so pngjs can
// decode it. The PWA itself decodes the JPEG in the browser via canvas.)
import fs from "node:fs";
import { PNG } from "pngjs";
import ort from "onnxruntime-node";
import {
  recognizeGray,
  resolveOrientation,
} from "../vendor/fenshot/index.js";
import { rgbaToGray, extractTiles } from "../vendor/fenshot/tiles.js";
import { probsToPlacement } from "../vendor/fenshot/fen.js";
import {
  detectHighlight,
  orientSquare,
  validateLastMove,
  lastMoveCastlingRights,
  expandPlacement,
  squareName,
} from "../highlight.js";

const IMAGE = process.argv[2] || "test/whatsapp.png";
const EXPECTED_PLACEMENT = "1rbqk2r/5ppp/2np1b2/1p2p3/4P3/N5P1/PP3P1P/R1BQKB1R";
const EXPECTED_FEN = `${EXPECTED_PLACEMENT} w KQk - 0 1`;
const EXPECTED_LICHESS =
  "https://lichess.org/analysis/standard/1rbqk2r/5ppp/2np1b2/1p2p3/4P3/N5P1/PP3P1P/R1BQKB1R_w_KQk_-_0_1?color=black";

const png = PNG.sync.read(fs.readFileSync(IMAGE));
const gray = rgbaToGray(png.data, png.width, png.height);
console.log(`image: ${IMAGE} ${png.width}x${png.height}`);

const session = await ort.InferenceSession.create(
  "models/chess-tiles-v2.onnx",
  { executionProviders: ["cpu"] },
);
const classify = async (corners) => {
  const tiles = extractTiles(gray, corners);
  const out = await session.run({
    tiles: new ort.Tensor("float32", tiles, [64, 1024]),
  });
  return probsToPlacement(out.probs.data);
};

const scan = await recognizeGray(gray, classify);
if (!scan) { console.log("RESULT: NO BOARD FOUND"); process.exit(2); }
console.log("raw placement:  ", scan.placement);
console.log("minConfidence:  ", scan.minConfidence.toFixed(3),
  "| meanConfidence:", scan.meanConfidence.toFixed(3),
  "| reliable:", scan.reliable, "| plausible:", scan.plausible);
console.log("corners:        ", JSON.stringify(scan.corners));
const { placement, orientation } = resolveOrientation(scan.placement);
console.log("oriented:       ", placement, "| orientation:", orientation);
console.log("expected:       ", EXPECTED_PLACEMENT);
console.log("placement MATCH:", placement === EXPECTED_PLACEMENT ? "YES" : "NO");
if (placement !== EXPECTED_PLACEMENT) {
  const expand = (p) => p.split("/").map((r) => r.replace(/\d/g, (d) => ".".repeat(+d)).split(""));
  const exp = expand(EXPECTED_PLACEMENT), got = expand(placement);
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++)
    if (exp[r][f] !== got[r][f])
      console.log(`  diff ${"abcdefgh"[f]}${8 - r}: expected '${exp[r][f]}' got '${got[r][f]}'`);
}

// Highlight detection on the same pixels, in read coordinates.
const hl = detectHighlight({ data: png.data, width: png.width, height: png.height }, scan.corners);
console.log("highlight found:", hl.found, hl.found ? "" : `(${hl.reason})`);
console.log("highlight diagnostics:", JSON.stringify(hl.diagnostics));
let turn = "w", turnSource = "assumed you are at the bottom";
let castling = "-", ep = "-";
if (hl.found) {
  const oriented = hl.squares.map((s) => orientSquare(s.file, s.rank, orientation));
  console.log("highlight squares (oriented):",
    oriented.map((s) => squareName(s.file, s.rank)).join(", "));
  // Origin = the empty square, destination = the occupied one.
  const board = expandPlacement(placement);
  const pieceAt = (sq) => board[(8 - sq.rank) * 8 + sq.file];
  const from = oriented.find((s) => !pieceAt(s));
  const to = oriented.find((s) => pieceAt(s));
  if (from && to) {
    const v = validateLastMove(placement, from, to);
    console.log("last-move validation:", JSON.stringify(v));
    if (v.ok) {
      turn = v.white ? "b" : "w";
      turnSource = `from last-move highlight (${v.white ? "White" : "Black"} ${v.notation})`;
      castling = lastMoveCastlingRights(placement, from, to, v.mover);
      if (v.isDoubleStep && v.epAuto) ep = v.epTarget;
      console.log("turn:", turn === "w" ? "White" : "Black", "| source:", turnSource);
      console.log("castling (inferred/assumed, last-move adjusted):", castling);
      console.log("en passant:", ep, v.isDoubleStep ? `(double step, auto=${v.epAuto})` : "(not a double step)");
    } else {
      console.log("highlight pair failed validation; turn NOT auto-set.");
    }
  } else {
    console.log("highlight pair is not one-empty/one-occupied; turn NOT auto-set.");
  }
}
const fen = `${placement} ${turn} ${castling} ${ep} 0 1`;
const lichess = "https://lichess.org/analysis/standard/" + fen.replace(/ /g, "_") + "?color=black"; // Black at the bottom in this photo
console.log("recognised FEN: ", fen);
console.log("expected FEN:   ", EXPECTED_FEN);
console.log("FEN MATCH:      ", fen === EXPECTED_FEN ? "YES — exact" : "NO");
console.log("Lichess:        ", lichess);
console.log("Lichess MATCH:  ", lichess === EXPECTED_LICHESS ? "YES" : "NO");
process.exit(fen === EXPECTED_FEN && lichess === EXPECTED_LICHESS ? 0 : 1);
