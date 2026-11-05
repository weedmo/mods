import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { home, readTextFile, theme, watchFolder, openOverlay, closeOverlay, props, shared, setShared } from "herdr";

// Agent rate-limit usage in the status bar, modeled on Orca's usage chips.
// Claude: live from the statusLine feed (~/.local/bin/herdr-statusline-tee.sh),
//         falling back to the OAuth usage API when the feed is stale.
// Codex:  ChatGPT wham/usage API.
// The bar copy fetches and publishes to shared state; the popup copy only reads it.

const KEY = "usage-weed.state";
const TICK_MS = 60_000;            // scheduler tick; network only when a provider is due
const POLL_MS = 15 * 60_000;       // Orca's default refresh interval
const FEED_STALE_MS = 10 * 60_000; // statusLine feed older than this -> use the API
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 15 * 60_000;
const KEEP_LAST_MS = 24 * 60 * 60_000;

const sched = { claude: { nextAt: 0, fails: 0 }, codex: { nextAt: 0, fails: 0 } };

function toMs(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string" && v.trim()) {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

// Always returns a slot so the 5h/7d pair stays visible; pct is null when not reported.
function claudeWindow(label, w) {
  const p = w && typeof w === "object"
    ? (typeof w.used_percentage === "number" ? w.used_percentage
      : typeof w.utilization === "number" ? w.utilization : null)
    : null;
  return { label, pct: p == null ? null : Math.min(100, Math.max(0, p)), resetsAt: p == null ? null : toMs(w.resets_at) };
}
const reported = (ws) => ws.some((w) => w.pct != null);

function codexLabel(seconds) {
  if (!seconds) return "limit";
  const h = seconds / 3600;
  return h >= 24 ? `${Math.round(h / 24)}d` : `${Math.round(h)}h`;
}

function codexWindow(w) {
  if (!w || typeof w.used_percent !== "number") return null;
  return { label: codexLabel(w.limit_window_seconds), pct: Math.min(100, Math.max(0, w.used_percent)), resetsAt: toMs(w.reset_at) };
}

async function readJson(path) {
  const raw = await readTextFile(path);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function state() {
  return shared(KEY) ?? {};
}

function publish(provider, entry) {
  setShared(KEY, { ...state(), [provider]: entry });
}

// A failure keeps the last good windows (Orca keeps them up to 24 h) and records the error.
function fail(provider, error, retryMs) {
  const s = sched[provider];
  s.fails += 1;
  s.nextAt = Date.now() + (retryMs ?? Math.min(BACKOFF_BASE_MS * 2 ** (s.fails - 1), BACKOFF_MAX_MS));
  const prev = state()[provider];
  const keep = prev?.windows?.length && Date.now() - prev.at < KEEP_LAST_MS;
  publish(provider, keep ? { ...prev, error } : { windows: [], at: Date.now(), src: "none", error });
}

function succeed(provider, entry) {
  sched[provider].fails = 0;
  sched[provider].nextAt = Date.now() + POLL_MS;
  publish(provider, { ...entry, error: null });
}

async function loadClaudeFeed(dir) {
  const f = await readJson(`${dir}/claude.json`);
  if (!f || typeof f.at !== "number") return;
  const windows = [claudeWindow("5h", f.fiveHour), claudeWindow("7d", f.sevenDay)];
  if (!reported(windows)) return;
  const at = f.at * 1000;
  const prev = state().claude;
  if (prev && prev.at >= at) return;
  succeed("claude", { windows, at, src: "statusline" });
}

async function fetchClaude() {
  const prev = state().claude;
  if (prev?.src === "statusline" && Date.now() - prev.at < FEED_STALE_MS) {
    sched.claude.nextAt = prev.at + FEED_STALE_MS;
    return;
  }
  const cred = await readJson(`${home()}/.claude/.credentials.json`);
  const token = cred?.claudeAiOauth?.accessToken;
  if (!token) return fail("claude", "Not signed in", POLL_MS);
  let r;
  try {
    r = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
    });
  } catch (e) {
    return fail("claude", "Network error");
  }
  if (r.status === 429) return fail("claude", "Rate limited", BACKOFF_MAX_MS);
  if (r.status === 401) return fail("claude", "Token expired; run Claude once", POLL_MS);
  if (!r.ok) return fail("claude", `HTTP ${r.status}`);
  const j = await r.json();
  const windows = [claudeWindow("5h", j.five_hour), claudeWindow("7d", j.seven_day)];
  succeed("claude", { windows, at: Date.now(), src: "api" });
}

async function fetchCodex() {
  const auth = await readJson(`${home()}/.codex/auth.json`);
  const t = auth?.tokens;
  if (!t?.access_token) return fail("codex", "Not signed in", POLL_MS);
  const headers = codexHeaders(t);
  let r;
  try {
    r = await fetch("https://chatgpt.com/backend-api/wham/usage", { headers });
  } catch (e) {
    return fail("codex", "Network error");
  }
  if (r.status === 429) return fail("codex", "Rate limited", BACKOFF_MAX_MS);
  if (r.status === 401) return fail("codex", "Token expired; run Codex once", POLL_MS);
  if (!r.ok) return fail("codex", `HTTP ${r.status}`);
  const j = await r.json();
  const rl = j.rate_limit ?? {};
  const windows = [codexWindow(rl.primary_window), codexWindow(rl.secondary_window)].filter(Boolean);
  const rc = j.rate_limit_reset_credits;
  const credits = rc && typeof rc.available_count === "number"
    ? { available: rc.available_count, applicable: typeof rc.applicable_available_count === "number" ? rc.applicable_available_count : null,
        nextExpiresAt: state().codex?.credits?.nextExpiresAt ?? null }
    : null;
  succeed("codex", { windows, at: Date.now(), src: "api", plan: j.plan_type ?? null, credits, limitReached: rl.limit_reached === true });
  if (credits?.available > 0) await fetchCodexCreditDetails(headers).catch(() => {});
}

function codexHeaders(t) {
  const h = { Authorization: `Bearer ${t.access_token}`, "OpenAI-Beta": "codex-1", "User-Agent": "codex-cli" };
  if (t.account_id) h["ChatGPT-Account-Id"] = t.account_id;
  return h;
}

// Reset-credit details: earliest expiry of an available credit (same endpoint Orca reads).
async function fetchCodexCreditDetails(headers) {
  const r = await fetch("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits", { headers });
  if (!r.ok) return;
  const j = await r.json();
  const exp = (j.credits ?? []).filter((c) => c.status === "available").map((c) => toMs(c.expires_at)).filter(Boolean).sort((a, b) => a - b)[0] ?? null;
  const cur = state().codex;
  if (!cur) return;
  publish("codex", { ...cur, credits: { ...(cur.credits ?? {}), available: j.available_count ?? cur.credits?.available ?? 0, nextExpiresAt: exp } });
}

const RESET_OUTCOMES = {
  reset: "Limits reset. 1 credit used.",
  nothing_to_reset: "Nothing to reset right now. No credit used.",
  no_credit: "No reset credit available.",
  already_redeemed: "This request was already redeemed.",
};

// Consumes one reset credit. The idempotency key makes a retried click safe.
async function redeemCodexReset(requestId) {
  const auth = await readJson(`${home()}/.codex/auth.json`);
  const t = auth?.tokens;
  if (!t?.access_token) return { ok: false, message: "Codex not signed in." };
  const r = await fetch("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume", {
    method: "POST",
    headers: { ...codexHeaders(t), "Content-Type": "application/json" },
    body: JSON.stringify({ redeem_request_id: requestId }),
  });
  if (!r.ok) return { ok: false, message: `Reset failed: HTTP ${r.status}` };
  const code = (await r.json())?.code;
  return { ok: code === "reset", message: RESET_OUTCOMES[code] ?? `Unknown outcome: ${code ?? "missing"}` };
}

function newRequestId() {
  const hex = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");
  return `${hex()}${hex()}-${hex()}-4${hex().slice(1)}-${hex()}-${hex()}${hex()}${hex()}`;
}

async function runDue(force) {
  const now = Date.now();
  const jobs = [];
  if (force || now >= sched.claude.nextAt) jobs.push(fetchClaude());
  if (force || now >= sched.codex.nextAt) jobs.push(fetchCodex());
  await Promise.all(jobs.map((p) => p.catch(() => {})));
}

const PROVIDERS = [["claude", "Claude"], ["codex", "Codex"]];
const tone = (p) => (p >= 80 ? "urgent" : p >= 60 ? "warning" : "normal");
const toneColor = (t, k) => (k === "urgent" ? t.blocked : k === "warning" ? t.working : t.done);
const shown = (e) => (e?.windows ?? []).filter((w) => w.pct != null);
const headline = (e) => { const ws = shown(e); return ws.length ? ws.reduce((a, b) => (b.pct > a.pct ? b : a)) : null; };

function fmtReset(ms) {
  if (!ms) return "";
  const d = ms - Date.now();
  if (d <= 0) return "resetting";
  const m = Math.round(d / 60_000);
  if (m < 60) return `resets in ${m}m`;
  if (m < 24 * 60) return `resets in ${Math.floor(m / 60)}h ${m % 60}m`;
  const dt = new Date(ms);
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dt.getDay()];
  return `resets ${day} ${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`;
}

function fmtShort(ms) {
  const m = Math.max(0, Math.round((ms - Date.now()) / 60_000));
  if (m < 60) return `${m}m`;
  if (m < 24 * 60) return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
  return `${Math.floor(m / 1440)}d`;
}

function fmtAge(at) {
  if (!at) return "";
  const m = Math.round((Date.now() - at) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`;
}

export default class UsageWeed extends View {
  init(_props, cx) {
    this.overlay = props()?.overlay ?? null;
    this.busy = false;
    if (this.overlay) return; // popup copy: reads shared state only
    this.dir = `${home()}/.local/state/herdr-usage`;
    cx.spawn(async (cx) => {
      await loadClaudeFeed(this.dir).catch(() => {});
      await runDue(false);
      cx.notify();
    });
    cx.spawn(async (cx) => {
      for (;;) {
        try { await watchFolder(this.dir); } catch { return; } // timer path still refreshes
        await loadClaudeFeed(this.dir).catch(() => {});
        cx.notify();
      }
    });
    cx.timer.every(TICK_MS, (cx) => {
      cx.spawn(async (cx) => {
        await loadClaudeFeed(this.dir).catch(() => {});
        await runDue(false);
        cx.notify();
      });
    });
  }

  refresh(cx) {
    if (this.busy) return;
    this.busy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      await runDue(true);
      this.busy = false;
      cx.notify();
    });
  }

  chip(t, key, label, e) {
    const h = headline(e);
    const open = () => openOverlay({ mod: "usage-weed", kind: "popup", at: "pointer", width: 320, height: 250 });
    const base = h_flex().id(`usage-${key}`).flex_none().gap(5).items_center().px(4).rounded(4)
      .hover((s) => s.bg(t.hover)).on_click(open);
    if (!e) return base.child(div().text_color(t.dim).child(`${label} ···`));
    if (!h) return base.child(div().text_color(t.dim).child(`${label} --`));
    const k = tone(h.pct);
    const c = toneColor(t, k);
    const slots = key === "claude" ? e.windows : [h];
    return base
      .child(div().size(6).rounded(3).bg(e.error ? t.dim : c))
      .child(div().text_color(t.foreground).child(label))
      .children(slots.map((w) => {
        if (w.pct == null) return div().text_color(t.dim).child(`${w.label} --`);
        const wk = tone(w.pct);
        return h_flex().gap(3)
          .child(div().text_color(t.dim).child(w.label))
          .child(div().text_color(wk === "normal" ? t.muted : toneColor(t, wk)).child(`${Math.round(w.pct)}%`));
      }))
      .when(Boolean(h.resetsAt), (el) => el.child(div().text_color(t.dim).child(`↻ ${fmtShort(h.resetsAt)}`)));
  }

  bar(t, pct) {
    const c = toneColor(t, tone(pct));
    return div().flex_none().w(64).h(5).rounded(3).bg(t.raised)
      .child(div().h(5).w(Math.max(2, Math.round((64 * pct) / 100))).rounded(3).bg(c));
  }

  renderDetail(t) {
    const s = state();
    return v_flex().size_full().p(12).gap(10).bg(t.popover).text_size(12).text_color(t.foreground)
      .child(h_flex().items_center().justify_between()
        .child(div().font_semibold().child("Agent usage limits"))
        .child(div().id("usage-refresh").px(6).rounded(4).text_color(t.muted).hover((st) => st.bg(t.hover))
          .on_click((_e, cx) => this.refresh(cx)).child(this.busy ? "Refreshing…" : "Refresh")))
      .children(PROVIDERS.map(([key, label]) => {
        const e = s[key];
        const head = h_flex().gap(6).items_center()
          .child(div().text_color(t.muted).child(label))
          .when(Boolean(e?.plan), (el) => el.child(div().text_color(t.dim).child(e.plan)))
          .child(div().flex_1())
          .child(div().text_color(t.dim).child(e ? `${e.src === "statusline" ? "live" : "api"} · ${fmtAge(e.at)}` : "loading"));
        const rows = (e?.windows ?? []).map((w) => w.pct == null
          ? h_flex().gap(8).items_center()
            .child(div().w(26).text_color(t.dim).child(w.label))
            .child(div().text_color(t.dim).child("not reported by provider (no active window)"))
          : h_flex().gap(8).items_center()
            .child(div().w(26).text_color(t.dim).child(w.label))
            .child(this.bar(t, w.pct))
            .child(div().w(34).child(`${Math.round(w.pct)}%`))
            .child(div().text_color(t.dim).truncate().child(fmtReset(w.resetsAt))));
        return v_flex().gap(4).child(head).children(rows)
          .when(Boolean(e?.error), (el) => el.child(div().text_color(t.blocked).child(e.error)))
          .when(Boolean(e) && !rows.length && !e.error, (el) => el.child(div().text_color(t.dim).child("No limits reported")))
          .when(key === "codex" && Boolean(e?.credits), (el) => el.child(this.resetRow(t, e)));
      }));
  }

  // Codex reset credits: count, earliest expiry, and a two-step "Reset now".
  // Disabled while the server reports no eligible window (applicable_available_count = 0),
  // so a click never spends a credit with nothing to reset.
  resetRow(t, e) {
    const c = e.credits;
    const eligible = c.available > 0 && (c.applicable == null || c.applicable > 0);
    const exp = c.nextExpiresAt ? new Date(c.nextExpiresAt) : null;
    const info = `${c.available} reset${c.available === 1 ? "" : "s"}` + (exp ? ` · exp ${exp.getMonth() + 1}/${exp.getDate()}` : "");
    const btn = (id, text, color, onClick) => div().id(id).flex_none().px(8).py(2).rounded(4).border(1).border_color(t.border)
      .text_color(color).hover((s) => s.bg(t.hover)).on_click(onClick).child(text);
    let action;
    if (this.redeeming) {
      action = div().text_color(t.muted).child("Using reset…");
    } else if (this.confirmReset) {
      action = h_flex().gap(6)
        .child(btn("reset-cancel", "Cancel", t.muted, (_ev, cx) => { this.confirmReset = false; cx.notify(); }))
        .child(btn("reset-confirm", "Use 1 credit", t.blocked, (_ev, cx) => this.redeem(cx)));
    } else if (eligible) {
      action = btn("reset-now", "Reset now", t.foreground, (_ev, cx) => { this.confirmReset = true; this.resetMsg = null; cx.notify(); });
    } else {
      action = div().text_color(t.dim).child(c.available > 0 ? "Not needed yet" : "No credits");
    }
    return v_flex().gap(4).pt(4).border_t(1).border_color(t.border)
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().text_color(t.dim).child(info))
        .child(action))
      .when(Boolean(this.confirmReset), (el) => el.child(div().text_color(t.muted)
        .child("Uses one Codex reset credit and resets eligible usage windows now.")))
      .when(Boolean(this.resetMsg), (el) => el.child(div().text_color(this.resetOk ? t.done : t.blocked).child(this.resetMsg)));
  }

  redeem(cx) {
    if (this.redeeming) return;
    this.redeeming = true;
    this.confirmReset = false;
    this.resetRequestId ??= newRequestId(); // reused on retry so a credit is spent at most once
    cx.notify();
    cx.spawn(async (cx) => {
      let res;
      try { res = await redeemCodexReset(this.resetRequestId); } catch { res = { ok: false, message: "Reset failed: network error" }; }
      this.resetOk = res.ok;
      this.resetMsg = res.message;
      if (!res.message.startsWith("Reset failed")) this.resetRequestId = null; // settled; next click is a new request
      this.redeeming = false;
      sched.codex.nextAt = 0;
      await fetchCodex().catch(() => {});
      cx.notify();
    });
  }

  render() {
    const t = theme();
    if (this.overlay) return this.renderDetail(t);
    const s = state();
    return h_flex().size_full().px(10).gap(10).items_center().justify_start()
      .bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8)
      .children(PROVIDERS.map(([key, label]) => this.chip(t, key, label, s[key])));
  }
}
