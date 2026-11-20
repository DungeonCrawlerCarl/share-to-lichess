// Unit checks for highlight.js: double-step EP, king-move castling clear,
// rook-capture castling clear, and no-highlight on a clean board.
// Run: node test/highlight-units.mjs
import fs from "node:fs";
import { PNG } from "pngjs";
import ort from "onnxruntime-node";
import { recognizeGray } from "../vendor/fenshot/index.js";
import { rgbaToGray, extractTiles } from "../vendor/fenshot/tiles.js";
import { probsToPlacement } from "../vendor/fenshot/fen.js";
import {
  detectHighlight,
  validateLastMove,
  lastMoveCastlingRights,
  inferCastling,
} from "../highlight.js";

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  if (!cond) failures++;
}

// 1. Double step: White pawn e2->e4, black pawn on d4. EP target e3, auto-set.
{
  const placement = "rnbqkbnr/ppp1pppp/8/8/3pP3/8/PPPP1PPP/RNBQKBNR";
  const v = validateLastMove(placement, { file: 4, rank: 2 }, { file: 4, rank: 4 });
  check("double step valid", v.ok, JSON.stringify(v));
  check("double step EP target e3", v.epTarget === "e3", v.epTarget);
  check("double step EP auto-set (black pawn on d4)", v.epAuto === true, String(v.epAuto));
  check("double step notation e2-e4", v.notation === "e2-e4", v.notation);
}
// 1b. Double step with NO adjacent enemy pawn: EP target exists but not auto.
{
  const placement = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR";
  const v = validateLastMove(placement, { file: 4, rank: 2 }, { file: 4, rank: 4 });
  check("double step, no enemy adjacent: EP target e3", v.epTarget === "e3", v.epTarget);
  check("double step, no enemy adjacent: NOT auto-set", v.epAuto === false, String(v.epAuto));
}
// 2. King move clears castling: king now on e2, rooks home, inferred KQ before.
{
  const placement = "r3k2r/pppppppp/8/8/8/8/PPPPKPPP/RNBQ1BNR";
  check("inferred before king move is KQkq", inferCastling("r3k2r/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR") === "KQkq", inferCastling("r3k2r/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR"));
  const rights = lastMoveCastlingRights(placement, { file: 4, rank: 1 }, { file: 4, rank: 2 }, "K");
  check("king move clears White castling only", rights === "kq", rights);
}
// 3. Rook captured on a1: black queen now on a1, White queenside lost.
{
  const placement = "r3k2r/pppppppp/8/8/8/8/PPPPPPPP/qNBQKBNR";
  const rights = lastMoveCastlingRights(placement, { file: 3, rank: 8 }, { file: 0, rank: 1 }, "q");
  check("queen captures rook on a1 clears Q only", rights === "Kkq", rights);
}
// 4. Illegal highlight rejected: knight cannot move a6->b5.
{
  const placement = "1rbqk2r/5ppp/2np1b2/1p2p3/4P3/N5P1/PP3P1P/R1BQKB1R";
  const v = validateLastMove(placement, { file: 0, rank: 6 }, { file: 1, rank: 5 });
  // mover is the black pawn on b5, so this is actually legal; use a knight-shaped pair instead:
  check("pawn a6xb5 validates (sanity)", v.ok === true, JSON.stringify(v));
  const bad = validateLastMove("rnbqkbnr/pppppppp/8/8/8/5N2/PPPPPPPP/RNBQKB1R",
    { file: 5, rank: 3 }, { file: 5, rank: 5 });
  check("knight f3->f5 rejected", bad.ok === false, bad.reason || "");
}
// 5. No highlight on the clean synthetic board (no false positive).
{
  const png = PNG.sync.read(fs.readFileSync("test/test-board.png"));
  const gray = rgbaToGray(png.data, png.width, png.height);
  const session = await ort.InferenceSession.create("models/chess-tiles-v2.onnx", { executionProviders: ["cpu"] });
  const classify = async (corners) => {
    const tiles = extractTiles(gray, corners);
    const out = await session.run({ tiles: new ort.Tensor("float32", tiles, [64, 1024]) });
    return probsToPlacement(out.probs.data);
  };
  const scan = await recognizeGray(gray, classify);
  const hl = detectHighlight({ data: png.data, width: png.width, height: png.height }, scan.corners);
  check("clean board: no highlight found", hl.found === false, hl.reason || "");
  console.log("  clean-board diagnostics:", JSON.stringify(hl.diagnostics));
}

console.log(failures === 0 ? "ALL UNIT CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
