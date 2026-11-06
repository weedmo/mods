import { View, div } from 'gpui-kit';
import { v_flex, h_flex } from 'gpui-base';
import { exec, focused, spaces, theme, props } from 'herdr';
import { graph } from './model.mjs';

// Paths go through argv, never shell interpolation. Supports remote spaces.
const READ = `import pathlib,json,sys
root=pathlib.Path(sys.argv[1]); explicit=sys.argv[2]
files=[pathlib.Path(explicit)] if explicit else list((root/'docs/agents/matt-auto-log').glob('*.data.json'))
files=[p for p in files if p.is_file()]
if not files: print(json.dumps({'path':None,'data':None}))
else:
 p=max(files,key=lambda p:p.stat().st_mtime_ns)
 print(json.dumps({'path':str(p),'data':json.loads(p.read_text())}))`;
export default class MattGraph extends View {
  init(_props, cx) {
    this.data = null; this.error = ''; this.busy = false; this.selected = null;
    cx.timer.every(3000, cx => this.refresh(cx));
    this.refresh(cx);
  }
  refresh(cx) {
    if (this.busy) return;
    const p = props() || {}, f = focused() || {}, space = spaces().find(s => s.id === f.space);
    const folder = p.folder || f.cwd || space?.folder;
    if (!folder && !p.file) return;
    const key = JSON.stringify([folder,p.file,Object.prototype.hasOwnProperty.call(p, 'on') ? p.on : space?.machine]);
    if (this.key !== key) { this.data=null; this.selected=null; this.key=key; }
    this.busy = true;
    cx.spawn(async cx => {
      try {
        const r = await exec('python3', ['-c', READ, folder || '.', p.file || ''], {on:Object.prototype.hasOwnProperty.call(p, 'on') ? p.on : space?.machine});
        if (r.code && r.code !== 0) throw new Error(r.stderr || 'Unable to read report');
        const value = JSON.parse(r.stdout);
        if (value.data) graph(value.data);
        this.data=value.data; this.path=value.path; this.error='';
      } catch(e) { this.error=String(e); }
      finally { this.busy=false; cx.notify(); }
    });
  }
  render() {
    const t=theme(), d=this.data;
    const color = status => status==='done' ? t.done : status==='blocked' ? t.blocked : status==='in-progress' ? t.working : t.muted;
    const root=v_flex().size_full().bg(t.surface).text_color(t.foreground).text_size(13).p(14).gap(10);
    root.child(h_flex().justify_between().child(div().font_semibold().child(d?.title || 'Matt · Ticket graph'))
      .child(div().id('refresh').child('새로고침').on_click((_e,cx)=>this.refresh(cx))));
    if(this.error) root.child(div().text_color(t.blocked).child(`읽기 오류 · ${this.error}`));
    if(!d) return root.child(div().text_color(t.muted).child('실행 보고서를 기다리는 중 · docs/agents/matt-auto-log/*.data.json'));
    root.child(div().text_color(t.dim).child(this.path || ''));
    root.child(h_flex().gap(12).children((d.stages || []).map(s=>div().text_color(color(s.status)).child(`${s.status==='done'?'✓':'○'} ${s.name}`))));
    const g=graph(d), canvas=div().relative().w(g.width).h(g.height);
    const line=(id,x,y,w,h)=>div().id(id).absolute().left(x).top(y).w(Math.max(2,w)).h(Math.max(2,h)).bg(t.border);
    g.edges.forEach((e,i)=>{
      const x=e.from.x+120, y=e.from.y+100, ex=e.to.x+120, end=e.to.y, mid=end-40;
      canvas.child(line(`a${i}`,x,y,2,mid-y));
      canvas.child(line(`b${i}`,Math.min(x,ex),mid,Math.abs(ex-x),2));
      canvas.child(line(`c${i}`,ex,mid,2,end-mid));
      canvas.child(div().absolute().left(ex-5).top(end-16).text_color(t.muted).child('▾'));
    });
    g.nodes.forEach(n=>canvas.child(v_flex().id(`ticket-${n.id}`).absolute().left(n.x).top(n.y).w(240).h(100).p(10).gap(6)
      .bg(t.raised).border(1).border_color(this.selected===n.id?t.accent:color(n.status)).rounded(8)
      .child(div().font_semibold().child(String(n.id))).child(div().truncate().child(n.title || ''))
      .child(div().text_color(color(n.status)).child(`${n.status}  ${n.worker?.model || ''}`))
      .on_click((_e,cx)=>{this.selected=n.id;cx.notify();})));
    if(!g.nodes.length) canvas.child(div().p(20).child('아직 생성된 티켓이 없습니다.'));
    root.child(div().id('graph-scroll').flex_1().overflow_x_scroll().overflow_y_scroll().child(canvas));
    const selected=g.nodes.find(n=>n.id===this.selected);
    if(selected) root.child(v_flex().id('details').max_h(220).overflow_y_scroll().gap(6).p(10).bg(t.raised)
      .child(div().font_semibold().child(`${selected.id} · ${selected.title || ''}`))
      .child(div().child(`선행: ${(selected.blockedBy || []).join(', ') || '없음'}`))
      .child(div().child(selected.note || selected.blocker?.detail || ''))
      .children((selected.acceptance || []).map(a=>div().child(`• ${a}`)))
      .children((selected.steps || []).map(s=>div().text_color(color(s.status)).child(`${s.status} · ${s.name}`))));
    return root;
  }
}
