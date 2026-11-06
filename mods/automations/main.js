import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { theme, props, home, focused, openOverlay, closeOverlay, run, pickFolder, shared, nextCommand, spaces } from "herdr";
import { request, requestId } from "./client.js";
import { phases, active, time, kinds, days, scheduleText } from "./model.js";

const errorText = e => String(e?.message ?? e);
function button(id, label, click, primary=false) {
  const t = theme();
  return div().id(id).px(10).py(6).rounded(6).cursor_pointer().text_size(12)
    .bg(primary ? t.accent : t.surface).text_color(primary ? t.accent_foreground : t.foreground)
    .hover(s => s.bg(t.hover)).child(label).on_click(click);
}
function field(state, multi=false) {
  const t = theme(), el = multi ? Textarea.new(state).h(100) : Input.new(state).h(32);
  return el.px(8).rounded(5).border_1().border_color(t.border).bg(t.background).text_color(t.foreground);
}
export default class Automations extends View {
  init(_p,cx) {
    this.mode = props()?.mode ?? "manager";
    this.rows = []; this.runs = []; this.error = ""; this.notice = "";
    this.loading = false; this.busy = false; this.page = "list"; this.selected = null;
    this.detail = null; this.status = null; this.preview = [];
    this.confirm = null; this.submitId = null; this.runKeys = {};
    if (!["toolbar", "sidebar"].includes(this.mode)) {
      this.refresh(cx);
      cx.spawn(async cx => {
        for (;;) {
          const command = await nextCommand();
          if (command === "new") this.edit(null,cx);
          if (command === "history") this.history({id:null,name:"전체 실행 이력"},cx);
          if (command === "list") {this.page="list";this.refresh(cx);cx.notify();}
        }
      });
      cx.timer.every(10000, cx => this.refresh(cx));
    }
  }
  refresh(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.spawn(async cx => {
      try {
        this.status = await request({op:"status"});
        this.rows = await request({op:"list"});
        if (this.page === "history" && this.selected) {
          this.runs = await request({op:"runs",id:this.selected.id});
          if (this.detail) this.detail = await request({op:"getRun",id:this.detail.id});
        }
        this.connectionError = "";
      } catch(e) { this.connectionError = errorText(e); }
      this.loading = false; cx.notify();
    });
  }
  perform(cx, fn) {
    if (this.busy) return;
    this.busy = true; this.error = ""; this.notice = "";
    cx.spawn(async cx => {
      try { await fn(); this.refresh(cx); }
      catch(e) { this.error = errorText(e); }
      this.busy = false; cx.notify();
    });
  }
  edit(d,cx) {
    if (d && d.prompt === undefined) {
      this.perform(cx,async () => { const full = await request({op:"get",id:d.id}); this.edit(full,cx); });
      return;
    }
    this.selected = d; this.page = "edit"; this.confirm = null; this.error = ""; this.preview = [];
    this.submitId = requestId();
    const inputs = {name:d?.name ?? "",cwd:d?.cwd ?? (spaces().find(s => s.id === focused()?.space)?.machine ? home() : focused()?.cwd ?? home()),
      hour:String(d?.schedule.hour ?? 9),minute:String(d?.schedule.minute ?? 0),
      zone:d?.schedule.timezone ?? "Asia/Seoul",grace:String(d?.graceMinutes ?? 15),
      timeout:String(d?.precheck.timeout ?? 60),precheck:d?.precheck.command ?? ""};
    this.inputs = {};
    for (const [key,value] of Object.entries(inputs)) {
      this.inputs[key] = InputState.new({value});
      this.inputs[key].on("change",(_e,cx) => { this.preview = []; cx.notify(); });
    }
    this.prompt = TextareaState.new({value:d?.prompt ?? "",rows:4,placeholder:"에이전트가 수행할 작업"});
    this.prompt.on("change",(_e,cx) => cx.notify());
    this.kind = d?.schedule.kind ?? "daily"; this.weekday = d?.schedule.weekday ?? 0;
    this.agent = d?.agent ?? (this.status?.providers.codex ? "codex" : "claude");
    this.enabled = d?.enabled ?? false;
    cx.notify();
  }
  schedule() {
    const integer = key => /^\d+$/.test(this.inputs[key].value().trim()) ? Number(this.inputs[key].value()) : -1;
    return {kind:this.kind,hour:integer("hour"),minute:integer("minute"),weekday:this.weekday,timezone:this.inputs.zone.value().trim()};
  }
  definition() {
    return {name:this.inputs.name.value(),cwd:this.inputs.cwd.value(),agent:this.agent,prompt:this.prompt.value(),
      enabled:this.enabled,schedule:this.schedule(),graceMinutes:Number(this.inputs.grace.value()),
      precheck:{command:this.inputs.precheck.value(),timeout:Number(this.inputs.timeout.value())}};
  }
  save(cx) {
    const q = {op:this.selected ? "update" : "create",id:this.selected?.id,revision:this.selected?.revision,
      requestId:this.submitId,definition:this.definition()};
    this.perform(cx,async () => { await request(q); this.page = "list"; this.notice = "자동화를 저장했습니다."; });
  }
  history(d,cx) {
    this.selected = d; this.page = "history"; this.detail = null; this.runs = []; this.confirm = null; this.error = "";
    this.refresh(cx); cx.notify();
  }
  runNow(d,cx) {
    // Keep the key after an ambiguous timeout so a retry cannot start a second task.
    const key = this.runKeys[d.id] ?? requestId(); this.runKeys[d.id] = key;
    this.perform(cx,async () => {
      const r = await request({op:"runNow",id:d.id,requestId:key});
      delete this.runKeys[d.id];
      this.notice = r.phase === "skipped_overlap" ? "이미 실행 중인 작업이 있어 건너뛰었습니다." : "실행 요청을 접수했습니다. 이력에서 진행 상태를 확인하세요.";
    });
  }
  render() {
    const t = theme();
    if (this.mode === "sidebar") return h_flex().size_full().items_center().px(12)
      .child(button("open-automations","◷  자동화",() => openOverlay({mod:"automations",kind:"dialog",width:900,height:760})));
    if (this.mode === "toolbar") return h_flex().size_full().items_center().justify_center()
      .child(button("open-automations","◷",() => openOverlay({mod:"automations",kind:"dialog",width:900,height:760})));
    const root = v_flex().size_full().p(18).gap(12).bg(t.canvas).text_color(t.foreground).text_size(13);
    root.child(h_flex().gap(8).items_center().child(div().flex_1().text_size(20).font_semibold().child("자동화"))
      .child(div().text_size(11).text_color(t.muted).child(this.connectionError ? "서비스 연결 끊김 · 마지막 조회 결과" : this.status ? "이 PC · 예약 서비스 연결됨" : "서비스 확인 중"))
      .child(button("refresh","새로고침",(_e,cx) => this.refresh(cx)))
      .child(button("close","닫기",() => closeOverlay(props().overlay))));
    if (this.connectionError) root.child(div().p(10).rounded(6).bg(t.surface).text_color(t.blocked).child(this.connectionError));
    if (this.status?.error) root.child(div().text_color(t.blocked).child("실행기 연결: " + this.status.error));
    if (this.error) root.child(div().text_color(t.blocked).child(this.error));
    if (this.notice) root.child(div().text_color(t.accent).child(this.notice));
    if (this.busy) root.child(div().text_color(t.muted).child("처리 중…"));
    root.child(this.page === "edit" ? this.editor() : this.page === "history" ? this.historyView() : this.listView());
    if (this.confirm) root.child(this.confirmation());
    return root;
  }
  listView() {
    const t = theme(), body = v_flex().flex_1().min_h(0).gap(10);
    body.child(h_flex().items_center().child(div().flex_1().text_color(t.muted).child("창을 닫아도 예약은 유지됩니다. PC가 꺼져 있거나 절전 중이면 실행되지 않습니다."))
      .child(button("all-history","전체 이력",(_e,cx) => this.history({id:null,name:"전체 실행 이력"},cx)))
      .child(button("new","+ 새 자동화",(_e,cx) => this.edit(null,cx),true)));
    const list = v_flex().id("automation-list").flex_1().min_h(0).overflow_y_scrollbar().gap(8);
    if (!this.rows.length) list.child(v_flex().p(24).gap(8).child(div().text_size(16).child("반복할 작업을 등록하세요"))
      .child(div().text_color(t.muted).child("예: 평일 오전 코드 검토, 매일 문서 점검. 처음에는 일시정지 상태로 저장됩니다.")));
    for (const d of this.rows) {
      const r = d.recent?.[0];
      list.child(v_flex().p(12).gap(7).rounded(8).bg(t.surface)
        .child(h_flex().gap(8).child(div().flex_1().font_semibold().child(d.name)).child(div().text_color(d.enabled?t.accent:t.muted).child(d.enabled?"예약 켜짐":"일시정지")))
        .child(div().text_color(t.muted).truncate().child(`${d.agent} · ${d.cwd}`))
        .child(div().child(scheduleText(d.schedule)))
        .child(div().text_size(12).text_color(t.muted).child(d.enabled ? `다음 실행 ${time(d.nextRunAt)}` : "예약은 멈춰 있습니다. 지금 실행은 가능합니다."))
        .child(div().text_size(12).child(r ? `최근: ${phases[r.phase] ?? r.phase} · ${time(r.createdAt)}` : "아직 실행 이력이 없습니다."))
        .child(h_flex().gap(6)
          .child(button(`edit-${d.id}`,"편집",(_e,cx) => this.edit(d,cx)))
          .child(button(`toggle-${d.id}`,d.enabled?"일시정지":"예약 켜기",(_e,cx) => this.perform(cx,async () => request({op:"setEnabled",id:d.id,revision:d.revision,enabled:!d.enabled,requestId:requestId()}))))
          .child(button(`run-${d.id}`,"지금 실행",(_e,cx) => { this.confirm = {kind:"run",d}; cx.notify(); }))
          .child(button(`history-${d.id}`,"이력",(_e,cx) => this.history(d,cx)))
          .child(button(`archive-${d.id}`,"보관",(_e,cx) => { this.confirm = {kind:"archive",d}; cx.notify(); }))));
    }
    return body.child(list);
  }
  editor() {
    const t = theme(), box = v_flex().flex_1().min_h(0).gap(10);
    box.child(h_flex().gap(8).child(button("back-edit","← 목록",(_e,cx) => {this.page="list";cx.notify();}))
      .child(div().font_semibold().child(this.selected?"자동화 편집":"새 자동화")));
    const form = v_flex().id("automation-form").flex_1().min_h(0).overflow_y_scrollbar().gap(9);
    form.child(div().child("이름")).child(field(this.inputs.name));
    form.child(h_flex().gap(6).child(div().flex_1().child("실행 폴더 · 이 PC"))
      .child(button("pick-folder","폴더 선택",(_e,cx) => this.perform(cx,async () => {
        const path = await pickFolder({prompt:"자동화 실행 폴더"}); if(path) this.inputs.cwd.set_value(path);
      }))));
    form.child(field(this.inputs.cwd));
    // Explicit local catalog choices; no writes to the projects registry.
    const local = (shared("projects.catalogs.v1") ?? {})["@local"];
    if (local?.locations?.length) {
      const choices = h_flex().gap(5);
      for (const l of local.locations.slice(0,4)) choices.child(button(`location-${l.id}`,l.name || l.path,(_e,cx) => {this.inputs.cwd.set_value(l.path);cx.notify();}));
      form.child(choices);
    }
    form.child(h_flex().gap(6).child(div().w(80).child("에이전트"))
      .children(["codex","claude"].map(agent => button(`agent-${agent}`,`${this.agent===agent?"● ":""}${agent}${this.status?.providers[agent]?"":" (미설치)"}`,(_e,cx) => {this.agent=agent;cx.notify();}))));
    form.child(div().child("작업 지시")).child(field(this.prompt,true));
    form.child(h_flex().gap(6).children(Object.entries(kinds).map(([kind,label]) => button(`kind-${kind}`,`${this.kind===kind?"● ":""}${label}`,(_e,cx) => {this.kind=kind;this.preview=[];cx.notify();}))));
    form.child(h_flex().gap(8).items_center()
      .child(div().child("시")).child(div().w(65).child(field(this.inputs.hour)))
      .child(div().child("분")).child(div().w(65).child(field(this.inputs.minute)))
      .child(div().child("시간대")).child(div().flex_1().child(field(this.inputs.zone))));
    if (this.kind === "hourly") form.child(div().text_color(t.muted).text_size(11).child("매시간 예약에서는 ‘분’만 사용합니다."));
    if (this.kind === "weekly") form.child(h_flex().gap(5).children(days.map((day,n) => button(`day-${n}`,`${this.weekday===n?"● ":""}${day}`,(_e,cx) => {this.weekday=n;this.preview=[];cx.notify();}))));
    form.child(h_flex().gap(6).child(button("preview","다음 3회 미리보기",(_e,cx) => this.perform(cx,async () => {this.preview=await request({op:"preview",schedule:this.schedule()});})))
      .child(div().text_size(11).text_color(t.muted).child("아래 시각 표시는 이 화면의 로컬 시간입니다.")));
    for (const at of this.preview) form.child(div().text_size(12).text_color(t.accent).child(time(at)));
    form.child(div().child("조건 명령 (선택) · 예약 실행 전 exit 0일 때만 진행"))
      .child(field(this.inputs.precheck));
    form.child(h_flex().gap(8).items_center().child(div().child("조건 제한(초)"))
      .child(div().w(70).child(field(this.inputs.timeout))).child(div().child("놓친 예약 유예(분)"))
      .child(div().w(70).child(field(this.inputs.grace))));
    form.child(div().text_size(11).text_color(t.muted).child("놓친 예약은 유예 시간 안의 최신 1회만 실행합니다. 같은 자동화는 동시에 1개만 실행합니다."));
    form.child(button("enabled",this.enabled?"● 저장 후 예약 켜짐":"○ 저장 후 일시정지",(_e,cx) => {this.enabled=!this.enabled;cx.notify();}));
    return box.child(form).child(h_flex().gap(8).child(button("save","저장",(_e,cx) => this.save(cx),true))
      .child(div().text_color(t.muted).text_size(11).child("기본 에이전트 설정을 사용합니다. 신뢰·인증 화면은 직접 확인해야 합니다.")));
  }
  historyView() {
    const t = theme(), box = v_flex().flex_1().min_h(0).gap(8);
    box.child(h_flex().gap(8).child(button("back-history","← 목록",(_e,cx) => {this.page="list";this.confirm=null;cx.notify();}))
      .child(div().flex_1().font_semibold().child(this.selected?.name ?? "실행 이력")));
    const list = v_flex().id("run-list").flex_1().min_h(0).overflow_y_scrollbar().gap(6);
    if (!this.runs.length) list.child(div().p(18).text_color(t.muted).child("실행 이력이 없습니다."));
    for (const r of this.runs) {
      list.child(v_flex().p(10).gap(6).rounded(6).bg(t.surface)
        .child(h_flex().gap(8).child(div().flex_1().child(`${phases[r.phase]??r.phase} · ${time(r.createdAt)}`))
          .child(button(`details-${r.id}`,"상세",(_e,cx) => {if(this.detail?.id===r.id){this.detail=null;cx.notify();}else this.perform(cx,async () => {this.detail=await request({op:"getRun",id:r.id});});})))
        .child(div().text_size(11).text_color(t.muted).child(`${r.trigger==="manual"?"수동 · 조건 검사 생략":"예약"} · ${r.address??"터미널 미배정"}`))
        .child(div().text_size(12).child(r.message || ""))
        .child(h_flex().gap(6)
          .when(!!r.address,el => el.child(button(`terminal-${r.id}`,"터미널 열기",(_e,cx) => this.perform(cx,async () => {const target=await request({op:"openTerminal",id:r.id});run("terminal.peek",{terminal:target.address});}))))
          .when(!!r.address && !active(r.phase),el => el.child(button(`close-terminal-${r.id}`,"터미널 종료",(_e,cx) => {this.confirm={kind:"closeTerminal",r};cx.notify();})))
          .when(active(r.phase),el => el.child(button(`cancel-${r.id}`,r.phase==="unknown"?"보류 해제":"실행 중지",(_e,cx) => {this.confirm={kind:r.phase==="unknown"?"resolve":"cancel",r};cx.notify();}))))
        .when(this.detail?.id===r.id,el => el.child(div().text_size(11).text_color(t.muted).child(`예약 시각: ${time(r.scheduledFor)}\n${this.detail?.snapshot?.cwd ?? ""}\n${this.detail?.snapshot?.prompt ?? ""}\n\n${this.detail?.precheck?.output??""}\n${this.detail?.output || "완료 후 터미널 출력 일부가 저장됩니다."}`))));
    }
    return box.child(list);
  }
  confirmation() {
    const c = this.confirm, t = theme();
    const messages = {run:"지금 실행은 조건 명령을 건너뜁니다. 이 폴더에서 작업을 시작할까요?",archive:"예약을 중지하고 목록에서 보관합니다. 현재 실행과 이력은 유지됩니다.",cancel:"이 실행의 터미널 프로세스를 중지할까요?",closeTerminal:"완료된 실행의 터미널을 종료할까요? 터미널에서 새로 시작한 작업도 종료됩니다.",resolve:"이 실행이 더 이상 작업하지 않는지 직접 확인했나요? 보류 해제 후 다음 예약이 다시 실행될 수 있습니다."};
    return v_flex().p(12).gap(8).rounded(8).bg(t.raised).child(div().child(messages[c.kind]))
      .child(h_flex().gap(8).child(button("confirm-action","확인",(_e,cx) => {
        this.confirm=null;
        if(c.kind==="run") this.runNow(c.d,cx);
        else this.perform(cx,async () => request(c.kind==="archive" ? {op:"archive",id:c.d.id,revision:c.d.revision}
          : ["cancel","closeTerminal"].includes(c.kind) ? {op:c.kind,id:c.r.id} : {op:"resolveUnknown",id:c.r.id,confirmed:true}));
      },true)).child(button("cancel-action","취소",(_e,cx) => {this.confirm=null;cx.notify();})));
  }
}
