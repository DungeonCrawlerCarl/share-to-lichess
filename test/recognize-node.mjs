// Node acceptance test for the vendored fenshot recognizer.
// Uses fenshot's platform-independent core (recognizeGray, extractTiles,
// probsToPlacement, resolveOrientation, placementToFen) + onnxruntime-node
// (CPU) + pngjs to decode the PNG. This is the same model and the same
// detection/classification code path the browser PWA uses; only the ONNX
// runtime (node CPU vs web WASM) and the rasterizer (pngjs vs canvas)
// differ. A headless-browser run of the PWA itself is test/serve-test.mjs.
import fs from "node:fs";
import { PNG } from "pngjs";
import ort from "onnxruntime-node";
import {
  recognizeGray,
  resolveOrientation,
  placementToFen,
} from "../vendor/fenshot/index.js";
import { rgbaToGray, extractTiles } from "../vendor/fenshot/tiles.js";
import { probsToPlacement } from "../vendor/fenshot/fen.js";

const IMAGE = process.argv[2] || "test/test-board.png";
const EXPECTED_PLACEMENT =
  "r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR";
const EXPECTED_FEN = `${EXPECTED_PLACEMENT} w KQkq - 0 1`;

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

const t0 = Date.now();
const scan = await recognizeGray(gray, classify);
console.log(`scan took ${Date.now() - t0} ms`);
if (!scan) {
  console.log("RESULT: NO BOARD FOUND");
  process.exit(2);
}
console.log("raw placement:      ", scan.placement);
console.log("minConfidence:      ", scan.minConfidence.toFixed(3));
console.log("meanConfidence:     ", scan.meanConfidence.toFixed(3));
console.log("reliable:           ", scan.reliable, "| plausible:", scan.plausible);
console.log("corners:            ", JSON.stringify(scan.corners));
const { placement, orientation } = resolveOrientation(scan.placement);
console.log("oriented placement: ", placement, "| orientation:", orientation);
const fen = placementToFen(placement, "w");
console.log("recognised FEN:     ", fen);
console.log("expected FEN:       ", EXPECTED_FEN);
console.log("MATCH:", fen === EXPECTED_FEN ? "YES — exact" : "NO");

// Tile-by-tile diff on the placement field
const expand = (p) =>
  p.split("/").map((r) => r.replace(/\d/g, (d) => ".".repeat(+d)).split(""));
const exp = expand(EXPECTED_PLACEMENT);
const got = expand(placement);
let diffs = 0;
for (let r = 0; r < 8; r++) {
  for (let f = 0; f < 8; f++) {
    if (exp[r][f] !== got[r][f]) {
      diffs++;
      const sq = "abcdefgh"[f] + (8 - r);
      console.log(`  diff ${sq}: expected '${exp[r][f]}' got '${got[r][f]}'`);
    }
  }
}
console.log(`tile diffs: ${diffs}/64`);
console.log(
  "confidences (A1..H8):",
  scan.confidences.map((c) => c.toFixed(2)).join(" "),
);
process.exit(fen === EXPECTED_FEN ? 0 : 1);
