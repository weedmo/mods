import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { props, exec, theme, closeOverlay } from "herdr";

function button(id, label, click, t) {
  return div().id(id).px(8).py(4).rounded(5).bg(t.surface).cursor_pointer()
    .hover(s => s.bg(t.hover)).on_click(click).child(label);
}

export class PullRequests {
  init(cx) {
    const { cwd, on, overlay } = props();
    this.where = { cwd, on };
    this.overlay = overlay;
    this.items = [];
    this.load(cx);
  }
  async gh(args) {
    const r = await exec("sh", ["-c", 'PATH="$HOME/.local/bin:$PATH" exec gh "$@"', "gh", ...args], this.where);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
    return r.stdout;
  }
  perform(cx, fn) {
    if (this.busy) return;
    this.busy = true;
    this.error = "";
    cx.spawn(async cx => {
      try { await fn(); }
      catch (e) { this.error = String(e.message ?? e); }
      finally { this.busy = false; cx.notify(); }
    });
  }
  load(cx) {
    this.perform(cx, async () => {
      this.repo = (await this.gh(["repo", "view", "--json", "url", "--jq", ".url"])).trim();
      this.items = JSON.parse(await this.gh(["pr", "list", "-R", this.repo, "--limit", "100", "--json", "number,title,isDraft"]));
      this.pr = null;
    });
  }
  open(number, cx) {
    this.perform(cx, async () => {
      this.pr = JSON.parse(await this.gh(["pr", "view", String(number), "-R", this.repo, "--json",
        "number,title,body,author,isDraft,state,reviewDecision,mergeStateStatus,baseRefName,headRefName,headRefOid,files"]));
      this.method = null;
      this.diff = null;
      this.notice = "";
    });
  }
  merge(cx) {
    const p = this.pr, method = this.method;
    this.method = null;
    this.perform(cx, async () => {
      await this.gh(["pr", "merge", String(p.number), "-R", this.repo, "--" + method, "--match-head-commit", p.headRefOid]);
      this.notice = "GitHub accepted the merge request.";
      this.pr = null;
      this.items = JSON.parse(await this.gh(["pr", "list", "-R", this.repo, "--limit", "100", "--json", "number,title,isDraft"]));
    });
  }
  render(cx) {
    const t = theme(), p = this.pr;
    const btn = (id, label, fn) => button(id, label, (_e, cx) => fn(cx), t);
    const panel = v_flex().size_full().p(14).gap(8).bg(t.popover).text_color(t.foreground).text_size(13);
    panel.child(h_flex().gap(8).items_center().child(div().flex_1().font_semibold().child(p ? `#${p.number} ${p.title}` : "Open pull requests"))
      .when(!this.busy, e => e.child(btn("pr-reload", p ? "Back to list" : "Refresh", cx => this.load(cx))))
      .child(btn("pr-close", "Close", () => closeOverlay(this.overlay))));
    if (this.error) panel.child(div().text_color(t.blocked).child(this.error));
    if (this.notice) panel.child(div().child(this.notice));
    if (this.busy) return panel.child(div().child("Loading…"));
    const body = v_flex().id("pr-scroll").flex_1().min_h(0).overflow_y_scrollbar().gap(7);
    if (p) {
      body.child(div().child(`${p.headRefName} → ${p.baseRefName} · @${p.author?.login ?? "unknown"} · ${p.isDraft ? "Draft" : p.state} · ${[p.reviewDecision, p.mergeStateStatus].filter(Boolean).join(" · ")}`))
        .child(div().child(p.body || "No description."))
        .child(div().font_semibold().child("Changed files"))
        .children(p.files.map(f => div().child(`${f.path}  +${f.additions} −${f.deletions}`)));
      if (this.diff == null) body.child(btn("pr-diff", "View diff", cx => this.perform(cx, async () => {
        this.diff = await this.gh(["pr", "diff", String(p.number), "-R", this.repo, "--color", "never"]);
      })));
      else body.child(div().font_family("monospace").child(this.diff || "No diff."));
      if (p.state === "OPEN" && !p.isDraft) {
        if (this.method) panel.child(h_flex().gap(6)
          .child(btn("pr-confirm", `Confirm ${this.method} #${p.number} → ${p.baseRefName}`, cx => this.merge(cx)))
          .child(btn("pr-cancel", "Cancel", cx => { this.method = null; cx.notify(); })));
        else panel.child(h_flex().gap(6).children(["merge", "squash", "rebase"].map(m =>
          btn("pr-method-" + m, m, cx => { this.method = m; cx.notify(); }))));
      }
    } else if (this.items.length) body.children(this.items.map(i =>
      btn("pr-" + i.number, `#${i.number}  ${i.title}${i.isDraft ? " · Draft" : ""}`, cx => this.open(i.number, cx))));
    else if (!this.error) body.child(div().child("No open pull requests."));
    return panel.child(body);
  }
}
