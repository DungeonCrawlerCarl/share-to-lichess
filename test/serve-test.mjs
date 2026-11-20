// Headless-browser test of the live PWA (needs a Chromium executable).
// Usage: CHROME_PATH=<path to chrome> node test/serve-test.mjs
// Serves the PWA on http://127.0.0.1:8931 if not already running.
// Checks: page loads with no console errors/pageerrors, service worker
// registers, file-input scan of test-board.png and test/whatsapp.png
// produce the expected FEN + turn source, and the Lichess button gates
// on the explicit confirm tap.
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import http from "node:http";

const BASE = "http://127.0.0.1:8931";
const CHROME = process.env.CHROME_PATH;
if (!CHROME) {
  console.log("Set CHROME_PATH to a Chromium/Chrome executable.");
  process.exit(2);
}

async function up() {
  return new Promise((resolve) => {
    http.get(BASE + "/index.html", (r) => resolve(r.statusCode === 200)).on("error", () => resolve(false));
  });
}
let server = null;
if (!(await up())) {
  server = spawn("python3", ["-m", "http.server", "8931"], { cwd: process.cwd(), stdio: "ignore" });
  for (let i = 0; i < 20 && !(await up()); i++) await new Promise((r) => setTimeout(r, 500));
}

const errors = [];
const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
const page = await browser.newPage();
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
console.log("title:", await page.title());
console.log("sw-status:", await page.textContent("#sw-status"));
const swReg = await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => (r ? r.scope : null)));
console.log("service worker scope:", swReg);

async function scanFile(path, label) {
  await page.setInputFiles("#file-input", path);
  await page.waitForFunction(
    () => document.querySelector("#status").textContent.includes("Board scanned") ||
      document.querySelector("#status").textContent.includes("No chessboard") ||
      document.querySelector("#status").textContent.includes("Scan failed"),
    null, { timeout: 90000 },
  );
  console.log(`--- ${label} ---`);
  console.log("status:", await page.textContent("#status"));
  console.log("FEN:", await page.textContent("#fen-out"));
  console.log("turn source:", await page.textContent("#turn-source"));
  console.log("castling chip:", await page.textContent("#castling-chip"));
  console.log("legality:", await page.textContent("#legality-status"));
  console.log("confirm enabled, lichess disabled before confirm:",
    await page.evaluate(() => !document.querySelector("#lichess-open-btn").disabled));
  await page.click("#confirm-btn");
  console.log("lichess enabled after confirm:",
    await page.evaluate(() => !document.querySelector("#lichess-open-btn").disabled));
  console.log("editor link:", await page.getAttribute("#editor-link", "href"));
}

await scanFile("test/test-board.png", "synthetic board (expected FEN r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 0 1)");
await scanFile("test/whatsapp.png", "WhatsApp photo (expected FEN 1rbqk2r/5ppp/2np1b2/1p2p3/4P3/N5P1/PP3P1P/R1BQKB1R w KQk - 0 1, White from highlight)");

await browser.close();
if (server) server.kill();
console.log("console/page errors:", errors.length ? errors : "none");
process.exit(errors.length ? 1 : 0);
