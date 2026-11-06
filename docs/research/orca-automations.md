# Orca 자동화 REA 조사

조사일: 2026-11-05. 대상: 설치된 Orca 1.4.249, Herdr 0.1.13의 로컬 mod 계약. 구현이나 서비스 설치는 하지 않았다.

## 결론

Herdr 개인 `automations` mod로 사용자 흐름을 구현할 수 있다. 예약을 책임질 독립 서비스와 hc 실행 어댑터가 필요하다. UI mod의 timer만으로는 창 종료 이후 예약 실행을 보장할 수 없다. Orca를 호출하는 wrapper보다 Herdr에서 독립적으로 실행·기록하는 구조를 권장한다.

## 증거와 조사 범위

- 원본: `/home/weed/.cache/orca/appimage/c73d7713a5af094a3fe6f2c7/cf8d757a82615c3d1b18aa4d/resources/app.asar`
- ASAR SHA-256: `7feff27ca1a9929bd7c4a781c7865ae7199242660730a0b37362b9af66f1af30`
- REA parent Evidence: `ev_5bcb3f0f14362e93e215e01fc01329160be6903e7636427118e94a65decf1010`
- REA summary Evidence: `ev_2cf39ccaa5cadda2ca3d01c486aa13fd8e1f61042050bf50bcb557fc44f18e62`
- 보관: `/home/weed/analysis/orca-automations-2026-11-05/rea-evidence.json`, `inventory.json`, `extracted/`.
- REA는 package manifest, 자동화 UI/CLI, schedule, precheck, session reuse, retention 등 9개 경로를 선택 분석했다. 8개 JS의 parse failure는 0. 미선택 4,788개 파일과 semantic node ceiling 때문에 전체 그래프는 partial이다. summary view가 exhausted라는 것은 전체 프로그램 분석 완료를 뜻하지 않는다.
- 아래 코드는 ASAR 및 동반 unpacked 파일에서 추출하여 정적으로 읽었다. 앱 실행이나 예약 발생을 관찰한 결과가 아니다. 추출 코드를 Herdr에 복사하는 계획이 아니다.
- 공개 1차 자료: [Orca CLI reference](https://github.com/stablyai/orca/blob/main/docs/site/content/docs/cli/reference.mdx). 최신 main과 설치 버전은 다를 수 있어 세부 동작은 설치 아티팩트를 우선했다.

## 확인한 기능

경로는 위 `extracted/` 기준이다. REA 선택 밖의 파일은 별도 정적 열람 근거이며 REA가 모든 관계를 입증했다는 뜻이 아니다.

| 기능 | 관찰 | 근거 |
|---|---|---|
| 예약 | 매시간, 매일, 평일, 주간, 5-field cron, RRULE 입력 | `out/cli/specs/automations.js`, `out/shared/automation-schedules.js` |
| 관리 | list/show/create/edit/remove/run/runs, 활성화·비활성화, 이력 pagination | `out/cli/specs/automations.js` |
| 대상 | repo, existing workspace, project와 host 선택. repo/project는 실행별 새 worktree 방식 지원 | 같은 CLI spec의 target flags와 notes |
| 실행 준비 | new-per-run에서 setup run/skip. 생략 시 현재 버전 설명은 skip | 같은 CLI spec |
| 조건 검사 | scheduled run 전에 command 실행, exit 0만 통과. 기본 60초, 1~600초, 출력 제한 상수 4,000자 | `out/shared/automation-precheck.js` |
| 수동 실행 | Run now는 precheck를 의도적으로 우회. queued/dispatching은 접수 상태이며 workspace가 아직 없을 수 있음 | CLI spec run/create notes |
| 세션 재사용 | existing workspace의 이전 completed run 중 동일 대상 host/repo/path 및 적절한 agent 상태와 live session 확인 | `out/shared/automation-session-reuse.js` |
| 재사용 제약 | extra agent args와 reuse-session 조합 금지 | CLI spec |
| 이력 | automation당 종료된 run 기본 100개 보관. 비종료 run은 삭제 대상에서 제외 | `out/shared/automation-run-retention.js` |
| 종료 상태 | completed, dispatch_failed, skipped_precheck, skipped_missed, skipped_unavailable, skipped_needs_interactive_auth | `out/shared/automations-types.js` |
| 소유 호스트 보호 | 읽을 때 본 host identity/generation과 수정·실행 시 대상 비교, 제거된 대상 실행 거절 | `out/shared/automation-owner-precondition.js` |
| 놓친 예약 | 저장 계약에 run_once_within_grace 정책과 missedRunGraceMinutes 존재 | `out/shared/orcad-migration/orcad-migration-dormant-automation-validation.js` |
| 시간 계산 | RRULE/cron 분리, 절대 분 순회와 calendar day 이동으로 DST 고려 | `out/shared/automation-schedule-occurrences.js` |

시간대 필드는 RPC 계약에 있지만 occurrence helper 자체는 JS local Date를 사용한다. 상위 실행기가 저장 timezone을 어떻게 적용하는지는 확인하지 못했다. grace 기본값, 실제 tick 주기, dispatch 장애 복구·동시실행 보장, GUI 없이 Orca가 예약을 유지하는 조건도 미확정이다. main bundle 검색에서 찾은 것은 migration schema였으므로 scheduler 본체로 오인하지 않았다.

## Herdr 제약과 활용점

- `~/.config/herdr-app/AGENTS.md`: mods는 GPUI JavaScript이며 DOM/Node/setTimeout이 없다. 기본 제공 mod는 재시작 시 교체되므로 새 개인 mod를 만든다.
- `herdr.d.ts:10`: `exec(program, argv, {cwd,on})`는 30초/8MiB 제한. 짧은 CLI 제어 요청에 적합하다.
- `AGENTS.md:874` 부근: timer는 View 컨텍스트, close는 250ms best effort. 창·패널 생명주기와 독립적인 scheduler를 만들 수 없다.
- `herdr.d.ts:28`: 파일 CAS/atomic replace는 있지만 shared는 latest-write-wins 상태이며 실행 큐 정본으로 쓰기 어렵다.
- `run('space.new')`는 null을 반환. `hc run --bg --json`은 실행 address를 반환하고 labels·cwd·on·no-parent를 지원한다.
- `hc schema`, `hc events --help`, `hc wait --help`: terminal state/exit_code/signal/reason, agent status/turn, JSONL 이벤트 사용 가능. idle/blocked/done와 process exit는 서로 다르다. wait timeout을 실패로 처리하면 안 된다.
- `--keep` 복구는 원래 작업 재실행이 아니라 shell 대체다. 자동화 resume 보장으로 사용할 수 없다.
- `herdr.space`, `herdr.tab` labels로 terminal의 UI adoption 가능. 원격은 local ID와 machine-qualified ID를 구분한다. 창 재열기까지의 동작은 구현 spike로 확인해야 한다.
- `mods/projects/backend.py:19,63`: PC별 catalog와 fcntl/fsync/atomic replace 패턴이 있다. `main.js:171`의 worktree → space 생성은 UI에 의존하므로 그대로 scheduler에서 호출하지 않는다.

## 조사 체크리스트

- 예약/입력/조건 검사/이력/재사용: 정적 근거로 답변 완료.
- Herdr UI/프로세스/API와 기존 projects 연결점: 소스·CLI 계약으로 답변 완료.
- Orca 실제 scheduling/dispatch service의 전체 상태 전이: 부분 확인. 위 미확정 항목 유지.
- Herdr agent 최초 task, 완료 판정, terminal adoption, crash recovery: 설계 가능하나 실행 검증 전.
- 구현 계획: `../plans/herdr-automations.md`에 범위·단계·검증 기준 명시.
