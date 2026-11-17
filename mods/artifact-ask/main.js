// Asked when an .html file or a link is opened through the system (Ctrl+click in a
// terminal, xdg-open, a file manager): show it beside the terminals in the Artifact panel, or
// in Chrome. herdr-artifact-open writes the request file and opens this dialog.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, theme, home, props, closeOverlay, run, setShared, readTextFile, checking } from "herdr";

const isUrl = (p) => /^https?:\/\//i.test(p ?? "");
const base = (p) => isUrl(p) ? p.replace(/^https?:\/\//i, "").replace(/[?#].*$/, "").replace(/\/$/, "") : p.split("/").pop();

export default class ArtifactAsk extends View {
  init(_props, cx) {
    this.file = `${home()}/.local/state/herdr-artifact/ask.json`;
    this.req = null; this.raw = null;
    this.handle = cx.focus_handle();
    this.handle.focus();
    if (checking()) return;
    this.load(cx);
    // A second Ctrl+click while this is open replaces the request.
    cx.timer.every(400, (cx) => this.load(cx));
  }

  load(cx) {
    cx.spawn(async (cx) => {
      const raw = await readTextFile(this.file);
      if (raw === this.raw) return;
      this.raw = raw;
      try { this.req = JSON.parse(raw ?? "null"); } catch { this.req = null; }
      cx.notify();
    });
  }

  close() { const id = props()?.overlay; id ? closeOverlay(id) : run("overlay.close", {}); }

  beside() {
    if (!this.req?.path) return this.close();
    setShared("artifact-view.open", { path: this.req.path, id: `${Date.now()}-${Math.random()}` });
    run("layout.select", { stack: "panel-body", child: "artifact" });
    run("layout.show", { id: "panel" });
    this.close();
  }

  chrome() {
    if (this.req?.path) exec("sh", ["-c", '"$0" "$1" >/dev/null 2>&1 &', this.req.browser || "google-chrome", this.req.path]).catch(() => null);
    this.close();
  }

  render(cx) {
    const t = theme(), p = this.req?.path;
    const choice = (id, key, label, sub, primary, act) => v_flex().id(id).flex_1().p(12).gap(4).rounded(8).cursor_pointer()
      .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
      .hover((s) => s.opacity(0.88)).on_click(() => act())
      .child(h_flex().gap(6).items_center()
        .child(div().px(5).rounded(4).text_size(11).bg(primary ? t.solid_foreground : t.border).text_color(primary ? t.solid : t.muted).child(key))
        .child(div().text_size(14).font_semibold().child(label)))
      .child(div().text_size(11).opacity(0.8).child(sub));
    return v_flex().id("artifact-ask").size_full().p(16).gap(12).bg(t.popover).text_color(t.foreground)
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        const k = e.key;
        if (k === "escape") { this.close(); cx.stop_propagation(); }
        else if (k === "1" || k === "enter") { this.beside(); cx.stop_propagation(); }
        else if (k === "2" || k === "c") { this.chrome(); cx.stop_propagation(); }
      })
      .child(v_flex().gap(2)
        .child(div().text_size(15).font_semibold().truncate().child(p ? base(p) : "Nothing to open"))
        .child(div().text_size(11).text_color(t.dim).truncate().child(p ?? "")))
      .child(h_flex().gap(10)
        .child(choice("ask-beside", "1", "옆에서 보기", "Artifact 패널에 렌더링", true, () => this.beside()))
        .child(choice("ask-chrome", "2", "Chrome에서 열기", "브라우저로 열어 상호작용", false, () => this.chrome())));
  }
}
