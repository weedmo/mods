# Herdr automations mod 구현 계획

상태: v1 구현·설치, 검증 기록은 `automations.GATES.md`. 2026-11-05. 근거: [Orca REA 조사](../research/orca-automations.md). 사용자 진행 요청으로 1~5단계의 로컬 v1을 구현했다. 6~7단계 확장은 후속 범위다. 실제 계약·사용법은 `../automations.md`를 우선한다. 원안의 events 구독 대신 hc root 상태/turn을 주기적으로 조회하며, 별도 config/log 파일 대신 SQLite에 정의와 제한된 출력을 저장한다. 실제 provider 실행은 template 없이 직접 argv를 전달한다.

## 사용자 경험과 첫 버전

자동화 목록에서 이름, 대상 프로젝트/폴더, 에이전트, 예약, 다음 실행, 최근 결과를 본다. 생성/편집 화면에서 프롬프트, 실행 대상, 시간대, 반복 주기, 선택적 precheck를 지정한다. 일시정지·다시 활성화·지금 실행·이력 보기·터미널 열기를 제공한다.

추천 v1은 로컬 PC 실행, 기존 checkout, Claude/Codex의 검증된 launch adapter, 매시간/매일/평일/주간, 실행 이력이다. precheck와 missed-run 정책을 포함한다. cron/RRULE 원문 호환, 새 worktree, 원격 PC, 세션 재사용은 아래 후속 단계로 확장한다. 이는 Orca 기능 전체와의 parity를 뜻하지 않는다.

기본 정책 제안: timezone은 저장된 IANA 이름(초기 Asia/Seoul), 동일 자동화 동시 실행 1개, 중첩 예약은 skipped_overlap 기록, 재시작 catch-up은 grace 15분 내 최신 1회만 수행하고 나머지는 skip. 15분은 Herdr의 새 설계값이며 Orca 기본값으로 확인된 값이 아니다. 수동 실행도 중복 실행 제한을 지키며 precheck 우회 여부를 버튼 설명에 명시한다. disabled는 향후 예약을 멈추고 현재 실행을 kill하지 않는다.

## 구조

```text
Herdr automations mod
  └─ 짧은 JSON CLI 요청
      └─ 로컬 Unix socket → automations service
           ├─ SQLite: 정의, 예약 cursor, 실행 intent/이력
           ├─ schedule / precheck / dispatch / reconcile
           └─ hc adapter → agent terminal → 상태 이벤트
```

서비스는 Python3 + SQLite를 우선한다. 기존 프로젝트 helper 생태계와 맞고 표준 라이브러리로 영속 상태를 만들 수 있다. systemd user service는 scheduler를 유지하고, 모드의 timer는 화면 상태 갱신만 한다. 창 종료 후에도 user service가 살아 있는 동안 실행한다. PC 전원 종료·절전 중 실행은 불가능하며 부팅/로그인 후 missed-run 정책을 적용한다. 로그아웃 후 계속 실행하려면 user manager linger 등 실제 호스트 정책을 별도 확인한다.

| 위치 | 책임 |
|---|---|
| `mods/automations/mod.json`, `main.js` | GPUI 목록·폼·이력·실행 열기 |
| `mods/automations/client.js`, `model.js` | JSON 계약과 화면 모델 |
| `scripts/herdr-automations/cli.py`, `service.py` | 짧은 제어 요청, singleton 서비스, Unix socket |
| `store.py`, `schedule.py`, `runner.py`, `hc_adapter.py` | migration/transaction, 시간 계산, 실행 정책, hc 계약 |
| `scripts/systemd/herdr-automations.service` | user service unit과 설치/제거 안내 |
| `tests/automations/` | fake clock/core, 장애 복구 및 schedule 테스트 |

정본 DB는 `~/.local/state/herdr-automations/automations.db`, 사용자 설정은 `~/.config/herdr-automations/`, socket은 XDG_RUNTIME_DIR 하위. 서비스만 DB를 쓰고 mod/shared는 조회 결과를 표시한다. 요청은 revision 또는 idempotency key를 포함한다. 소켓은 사용자 전용 권한, 요청/응답과 로그는 크기를 제한한다.

외부 API: list/get/create/update(expectedRevision)/setEnabled/runNow(requestId)/listRuns/getRun/serviceStatus. 화면에서 삭제는 우선 archive 처리하며 현재 실행과 과거 이력을 보존한다. 영구 삭제와 이력 정리는 별도 명령으로 둔다.

## 도메인과 실행 일관성

Automation: id, revision, name, enabled, target(machine identity, projectId/locationId 선택, cwd), agent/template/argv, prompt, schedule(kind, local fields, timezone, nextRunAt), precheck, missedPolicy, overlapPolicy, createdAt/updatedAt.

Run: id, automationId, definitionRevision 및 실행 설정 snapshot, trigger(manual/schedule), scheduledFor UTC, requestId, phase, core identity/address, workId, timestamps, precheck result, completion evidence, error, log path. 예약 run은 `(automationId, scheduledFor)` unique, 수동 run은 requestId unique. 설정 변경은 이미 claim한 실행 snapshot을 바꾸지 않는다.

제안 상태 전이: queued → prechecking → dispatching → running → succeeded/failed/blocked/interrupted/unknown. blocked는 최종 완료가 아니며 사용자 조치 뒤 running으로 복귀할 수 있다. 조건·지연·대상 부재·중첩은 skipped_* 종료 상태로 기록한다. completed라는 UI 표시를 만들 때에도 작업 성공과 단순 terminal 종료를 혼동하지 않는다.

트랜잭션으로 run intent와 예약 cursor를 저장한 뒤 외부 실행한다. `hc run --bg --json --no-parent --no-notify` 및 automation/run labels로 실행을 식별한다. 응답 유실·서비스 재시작 때 label과 core identity로 먼저 조회한다. hc 실행은 DB 트랜잭션에 참여하지 않으므로 exactly-once를 주장하지 않는다. dispatch 중 crash에서 실행 여부가 불명확하면 unknown으로 멈추고 자동 재발행하지 않는다.

agent 시작 직후 idle을 성공으로 판정하지 않는다. 시작한 turn/task와 연결된 완료 신호가 필요하다. process exit와 agent turn completion을 분리하고 blocked를 성공으로 저장하지 않는다. 이벤트 스트림 재연결 후 `hc ls --all --json`으로 reconcile한다. core 교체·terminal 유실은 interrupted/unknown이며 shell 복원을 작업 재개로 해석하지 않는다. 사용자 조회로 done→idle이 바뀌어도 저장된 완료 근거는 유지한다.

프롬프트/경로는 argv 또는 payload로 전달하고 shell 문자열로 합치지 않는다. precheck는 사용자가 명시한 shell command로 별도 취급하여 cwd, timeout, 출력 상한을 적용한다. 에이전트 기본 권한/승인 설정을 자동 우회하지 않는다. 무인 실행에서 인증·입력이 필요하면 blocked/needs_auth로 표시한다.

## 구현 단계와 완료 기준

1. **실행 계약 spike**: 테스트 폴더에서 hc template의 최초 task 전달, Claude/Codex 완료·blocked 이벤트, label adoption, 앱 닫기→재열기를 검증한다. 지원 버전과 계약을 fixture로 고정한다. 실패하면 해당 provider는 비활성화하고 지원 상태를 UI에 표시한다.
2. **저장과 scheduler**: SQLite migration, singleton, revision/idempotency, preset/timezone, catch-up/overlap 구현. fake clock으로 동일 due-time 중복, 재시작, 시간 역행, DST 중복/누락, schedule edit/pause를 검증한다. DST 정책은 누락 local time skip, 중복 local time 첫 occurrence만 실행으로 명시하고 UTC 키로 보관한다.
3. **실행기**: precheck, run intent, hc launch/events/reconcile, bounded logs와 종료 이력 retention 구현. dispatch 전후 crash, 응답 유실, core 재시작, 인증 block을 주입하여 중복 자동 실행이 없는지 확인한다. 종료된 최근 100회만 기본 보관하고 진행 중·unknown은 자동 제거하지 않는다.
4. **mod UI**: CRUD, 목록, 다음 3회 예약 미리보기, pause/run now, 이력·오류·터미널 열기, 서비스 연결 실패 표시. 개인 main-weed에 진입점 추가. `herdr-app check` 통과 및 실제 앱에서 비동기 상태·한글·좁은 창을 확인한다.
5. **설치와 통합 검증**: user service install/status/uninstall 안내, config/DB migration 및 백업 복구. 앱 종료 후 예약 1회, 재시작 후 동일 예약 미중복, pause 보존, 명령 timeout과 작업 failure 구분을 검증한다. mod 설치/해제가 기존 프로젝트·세션 기능을 손상시키지 않아야 한다.
6. **확장 A — worktree/projects**: headless worktree 준비 API를 projects backend에 추가하고 기존 catalog에 직접 쓰지 않는다. workId/runId 기반 경로로 재시도 가능하게 만들고 setup run/skip 지원. worktree 생성 후 launch 실패를 기록하며 자동으로 사용자 파일을 지우지 않는다. backend-source.js 동기화도 포함한다.
7. **확장 B — cron/원격/reuse**: cron과 필요한 RRULE subset을 명확히 검증하고 미지원 입력 거절. 원격은 machine/core identity와 재등록을 검증하고 local fallback 금지. 먼저 로컬 scheduler→원격 hc로 구현하면 관리 PC가 꺼질 때 예약이 중단됨을 UI에 표시한다. 호스트별 scheduler는 소유권·중복 방지 설계 후 별도 도입. 재사용은 기존 완료 session/대상/agent 일치와 busy 검증 이후에 추가한다.

## 주요 선택과 미확정 사항

- Orca CLI wrapper는 빠르지만 Orca runtime과 작업 공간에 의존하므로 독립 Herdr 구현 목표에 맞지 않는다.
- mod timer는 간단하지만 UI 수명에 종속된다. OS timer만 automation마다 만드는 방식은 실행 이력·중복 정책이 분산된다. 단일 서비스가 이를 소유하는 구조를 선택했다.
- agent template의 실제 최초 prompt/완료 관찰은 아직 실행 검증 전이다. 1단계 결과에 따라 runner adapter가 바뀔 수 있다.
- 원격 서비스를 각 PC에 설치할지와 전체 Orca parity가 필요한지는 후속 범위 결정이다. v1 설계는 이를 가정하지 않고 대상 모델에 확장 여지를 둔다.
- 구현 당시 `/home/weed/mods`의 기존 사용자 변경을 보존하고 현재 파일 기준으로 통합한다. 이번 조사 중 이미 README/layout/projects/space-folders/tabs-weed에 변경이 있었으며 손대지 않았다.
