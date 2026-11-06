// A persisted move intent bridges asynchronous park/keep acknowledgements.
// Never consider a keep request successful until the terminal actually has a pane.
export const MOVE_KEY = "tabs-weed.move.v1";
export function advanceMove(move, world, now) {
  const source = world.panes.find(p => p.terminal === move.terminal);
  if (move.phase === "detaching") {
    if (source) {
      if (now - move.started > 15000) return {done:true, warning:"이동 요청이 적용되지 않아 원래 위치를 유지했습니다."};
      return {};
    }
    return {patch:{phase:"attaching", next:0}};
  }
  if (source) {
    const commands = [["tab.select",{id:source.tab}],["pane.focus",{pane:source.pane}]];
    if (move.swap && source.tab === move.targetTab && world.panes.some(p => p.pane === move.target))
      commands.push(["pane.swap",{direction:move.swap}]);
    return {done:true,commands};
  }
  if (now < move.next) return {};
  const target = world.panes.find(p => p.pane === move.target);
  const original = world.spaces.find(s => s.id === move.sourceSpace);
  const commands = [];
  let place = move.place;
  if (place !== "tab" && target) {
    commands.push(["tab.select",{id:target.tab}],["pane.focus",{pane:target.pane}]);
  } else {
    place = "tab";
    if (original) commands.push(["space.select",{id:original.id}]);
  }
  commands.push(["terminal.keep",{terminal:move.terminal,place}]);
  return {commands,patch:{next:now+1500, attempts:(move.attempts??0)+1},
    warning: !move.warned && now-move.started>10000 ? "이동 응답을 기다리며 터미널을 복구하고 있습니다. 연결 상태를 확인하세요." : null};
}
