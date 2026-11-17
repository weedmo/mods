// Renders one HTML file to PNG tiles with headless Chrome over the DevTools protocol.
// Usage: node render.mjs <html file | http(s) URL> <cssWidth> <outDir> <prefix> [dark=0|1] [scale=2]
// Prints JSON: { title, width, height, tiles: [{ file, height }] } or { error }.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [html, widthArg, outDir, prefix, darkArg = "0", scaleArg = "2"] = process.argv.slice(2);
const width = Math.max(240, Math.min(2400, Math.round(Number(widthArg) || 480)));
const scale = Math.max(1, Math.min(3, Number(scaleArg) || 2));
const dark = darkArg === "1";
const isUrl = /^https?:\/\//i.test(html ?? "");
const TILE = 1000;          // CSS px per tile: small images load fast and stay under GPU texture limits
const MAX_H = 30000;        // never capture more than this many CSS px
const SETTLE_MS = isUrl ? 1800 : 900;  // let scripts, fonts and CDN libraries finish after load

const out = (o) => { process.stdout.write(JSON.stringify(o)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  const c = [process.env.CHROME, "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium"].filter(Boolean);
  return c.find((p) => existsSync(p));
}

function cleanOld(dir, keepPrefix) {
  const now = Date.now();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".png") || f.startsWith(keepPrefix)) continue;
    try { if (now - statSync(join(dir, f)).mtimeMs > 120000) rmSync(join(dir, f)); } catch {}
  }
}

async function main() {
  if (!html || (!isUrl && !existsSync(html))) return out({ error: `no such file: ${html}` });
  const chrome = findChrome();
  if (!chrome) return out({ error: "Chrome/Chromium not found (set CHROME=...)" });
  mkdirSync(outDir, { recursive: true });

  const profile = mkdtempSync(join(tmpdir(), "artifact-view-"));
  const proc = spawn(chrome, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
    "--no-default-browser-check", "--mute-audio", "--allow-file-access-from-files",
    "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  const cleanup = () => { try { proc.kill("SIGKILL"); } catch {} try { rmSync(profile, { recursive: true, force: true }); } catch {} };
  const killer = setTimeout(() => { out({ error: "render timed out" }); cleanup(); process.exit(1); }, 45000);

  try {
    let port = null;
    for (let i = 0; i < 100 && !port; i++) {
      await sleep(100);
      try { port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0].trim(); } catch {}
    }
    if (!port) throw new Error("Chrome did not open its DevTools port");
    let targets = [];
    for (let i = 0; i < 50 && !targets.length; i++) {
      try { targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter((t) => t.type === "page"); } catch {}
      if (!targets.length) await sleep(100);
    }
    if (!targets.length) throw new Error("no page target");

    const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("DevTools socket failed")); });
    let seq = 0; const pending = new Map(), waiters = [];
    ws.onmessage = (m) => {
      const msg = JSON.parse(typeof m.data === "string" ? m.data : m.data.toString());
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id); pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      } else if (msg.method) {
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (waiters[i].method === msg.method) waiters.splice(i, 1)[0].res(msg.params);
        }
      }
    };
    const send = (method, params = {}) => new Promise((res, rej) => {
      const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params }));
    });
    const waitEvent = (method, ms) => new Promise((res) => {
      const t = setTimeout(() => res(null), ms);
      waiters.push({ method, res: (p) => { clearTimeout(t); res(p); } });
    });

    await send("Page.enable");
    await send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: scale, mobile: false });
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
    const loaded = waitEvent("Page.loadEventFired", 15000);
    const nav = await send("Page.navigate", { url: isUrl ? html : pathToFileURL(html).href });
    if (nav?.errorText) throw new Error(`could not load: ${nav.errorText}`);
    await loaded;
    await sleep(SETTLE_MS);

    const ev = await send("Runtime.evaluate", { returnByValue: true, expression:
      "({ h: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0), t: document.title || '' })" });
    const { h, t } = ev.result.value;
    const height = Math.max(1, Math.min(MAX_H, Math.ceil(h)));

    const tiles = [];
    for (let y = 0, i = 0; y < height; y += TILE, i++) {
      const th = Math.min(TILE, height - y);
      const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true,
        clip: { x: 0, y, width, height: th, scale: 1 } });
      const file = `${prefix}-${i}.png`;
      writeFileSync(join(outDir, file), Buffer.from(shot.data, "base64"));
      tiles.push({ file, height: th });
    }
    ws.close();
    cleanOld(outDir, prefix);
    out({ title: t, width, height, truncated: h > MAX_H, tiles });
  } catch (e) {
    out({ error: String(e?.message ?? e) });
  } finally {
    clearTimeout(killer); cleanup();
  }
}
main();
