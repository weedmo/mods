export const phases = {queued:"대기",prechecking:"조건 검사",dispatching:"시작 중",running:"실행 중",blocked:"확인 필요",unknown:"실행 확인 보류",succeeded:"완료",failed:"실패",interrupted:"중단",cancelled:"사용자 중지",skipped_precheck:"조건 불충족",skipped_missed:"예약 놓침",skipped_overlap:"중복 건너뜀",skipped_unavailable:"대상 사용 불가"};
export const active = p => ["queued","prechecking","dispatching","running","blocked","unknown"].includes(p);
export const time = value => value ? new Date(value * 1000).toLocaleString() : "—";
export const kinds = {hourly:"매시간",daily:"매일",weekdays:"평일",weekly:"매주"};
export const days = ["월","화","수","목","금","토","일"];
export function scheduleText(s) {
  const clock = `${String(s.hour).padStart(2,"0")}:${String(s.minute).padStart(2,"0")}`;
  return `${kinds[s.kind]} ${s.kind === "weekly" ? days[s.weekday] + " " : ""}${s.kind === "hourly" ? `${s.minute}분` : clock} · ${s.timezone}`;
}
