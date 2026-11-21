// Share to Lichess — recognition worker.
// Runs fenshot in a dedicated Web Worker so the main thread stays
// responsive. GitHub Pages has no COOP/COEP, so crossOriginIsolated is
// false and SharedArrayBuffer is unavailable: numThreads is forced to 1.
// If this worker cannot load, the main thread falls back to in-page
// recognition. All imports here are relative paths, no import map.
import { createRecognizer } from "./vendor/fenshot/index.js";

let recognizer = null;

async function getRecognizer() {
  if (!recognizer) {
    const ort = await import("./ort/ort.wasm.min.mjs");
    ort.env.wasm.numThreads = 1;
    recognizer = createRecognizer({
      modelUrl: new URL("./models/chess-tiles-v2.onnx", self.location.href).href,
      wasmPaths: new URL("./ort/", self.location.href).href,
    });
  }
  return recognizer;
}

self.onmessage = async (event) => {
  const { id, blob } = event.data || {};
  try {
    const rec = await getRecognizer();
    const scan = await rec.recognize(blob);
    self.postMessage({ id, type: "result", scan });
  } catch (err) {
    self.postMessage({
      id,
      type: "error",
      message: err && err.message ? err.message : String(err),
    });
  }
};
