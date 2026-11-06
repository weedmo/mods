# 자동화 사용 안내

`automations`는 이 PC의 기존 폴더에서 Claude Code/Codex 작업을 반복 실행하는 Herdr mod입니다. 예약은 별도 Python 서비스가 담당합니다. Orca를 실행하거나 Orca 코드를 가져올 필요가 없습니다.

## 열기와 첫 작업

개인 `main-weed` 왼쪽 사이드바 하단의 **◷ 자동화** 버튼으로 엽니다. 명령 팔레트의 `mod.open:automations` 또는 아래 명령도 가능합니다.

```sh
herdr-app do mod.open '{"name":"automations"}'
```

1. **새 자동화** → 이름·실행 폴더·Claude/Codex·작업 지시를 입력합니다.
2. 매시간/매일/평일/매주와 IANA 시간대를 선택합니다. 기본 시간대는 `Asia/Seoul`. 미리보기 시각은 화면 로컬 시간으로 표시됩니다.
3. 필요하면 조건 명령과 제한 시간을 입력합니다. 조건은 선택한 폴더에서 `/bin/sh -c`로 실행하며 exit 0일 때만 작업을 시작합니다.
4. 기본은 **일시정지**로 저장합니다. **지금 실행**으로 먼저 확인하고 **예약 켜기**를 누릅니다. 지금 실행은 조건 명령을 생략하며 확인 창에 이를 표시합니다.
5. **이력**에서 진행 상황을 확인하고 **터미널 열기**로 작업을 보거나 신뢰·권한·인증 화면을 해결합니다.

**보관**은 목록에서 숨기고 향후 예약을 중지합니다. 현재 실행은 계속됩니다. 보관한 자동화의 기록도 **전체 이력**에서 볼 수 있습니다. **실행 중지**는 그 실행의 프로세스를 종료합니다. 완료된 에이전트는 터미널을 유지하므로 검토 후 **터미널 종료**로 정리할 수 있습니다. 이미 그 터미널에서 다른 작업을 시작했다면 그 작업도 종료됩니다.

## 동작 규칙

- 로컬 Linux/systemd와 Python 3.9+, `hc`, Claude 또는 Codex가 필요합니다. 검증 환경: Python 3.12, hc 0.1.18, Herdr 0.1.13, Claude Code 2.1.318, Codex 0.166.0.
- 각 실행은 새로운 interactive agent terminal을 만듭니다. 실행 파일을 절대 경로로 해석하고 프롬프트를 `--` 뒤의 별도 argv로 전달합니다. Codex는 `--no-daemon`을 사용합니다. 모델·인증·권한은 사용자의 에이전트 기본 설정을 유지합니다.
- 초기 idle이나 exit 0만으로 성공이라고 하지 않습니다. core가 보고한 root `done`과 완료 turn이 필요합니다. **완료는 에이전트 turn이 끝났다는 뜻이며, 결과물의 품질 검증 통과를 의미하지 않습니다.** 신호가 없으면 90초 후 확인 필요로 표시합니다. 화면 문자열을 추측하여 완료 판정하지 않습니다.
- 단일 자동화에는 진행 중·확인 필요·실행 불명확 작업을 합쳐 1개만 허용합니다. 중첩 시 건너뛴 이유를 이력에 남깁니다.
- 예약을 놓쳤으면 기본 15분 유예 안의 최신 1회만 보충합니다. 오래된 누락은 요약 skip으로 기록합니다. 재활성화와 예약 변경은 앞으로의 시각부터 적용합니다. DST의 존재하지 않는 시각은 건너뛰고 반복되는 시각은 첫 번째만 사용합니다.
- UI를 닫아도 user service와 hc가 살아 있는 동안 실행됩니다. 전원 종료·절전 중에는 실행하지 않습니다. 일반적으로 user service는 로그인 시 시작합니다. 로그아웃 이후 수명은 OS user-manager 설정에 따르며 설치 과정은 linger를 변경하지 않습니다.
- 서비스 시작 요청의 응답이 유실되면 run label을 찾아 연결합니다. 실행 여부를 확정하지 못하면 **실행 확인 보류**로 남기고 다시 실행하지 않습니다. 해당 작업이 실제로 끝났는지 확인한 뒤 **보류 해제**를 사용합니다. Core identity가 바뀌면 다른 터미널에 열기·중지 명령을 보내지 않습니다.
- 서비스는 1초 주기로 예약을 점검하고 진행 중 작업을 약 3초 주기로 hc에서 확인합니다. 화면은 10초 주기로 갱신합니다. 이는 정밀 실시간 스케줄러가 아니며 hc 연결 지연에 따라 갱신이 늦어질 수 있습니다.
- 자동화별 종료된 최근 100회를 보관합니다. 진행 중·unknown 기록은 자동 정리하지 않습니다. 재요청 방지용 작은 ID 기록은 이력 정리 이후에도 유지됩니다. 저장된 출력은 완료 시 terminal 최근 80줄 중 최대 12,000자, 조건 출력은 최대 4,000 bytes입니다. 전체 agent transcript 대체물이 아닙니다.

## 설치·업데이트·제거

저장소 루트에서:

```sh
python3 scripts/herdr-automations/install.py
systemctl --user status herdr-automations
python3 ~/.local/share/herdr-automations/cli.py '{"op":"status"}'
```

설치기는 Python 실행 파일들을 `~/.local/share/herdr-automations/`에 복사하고, mod를 Herdr app home에 복사합니다. 기존 `main-weed`가 있으면 자동화 버튼만 병합합니다. mod·layout·unit의 이전 버전은 app home의 `backups/automations-<timestamp>/`에 보관합니다. 다른 mods는 수정하지 않습니다. `--no-start`는 복사/설정만 하고 서비스를 시작하지 않습니다. 업데이트 중 서비스는 잠시 재시작하며 기존 hc terminal은 계속 실행됩니다.

```sh
python3 scripts/herdr-automations/install.py --uninstall
```

제거는 user service와 mod·버튼을 제거하지만 DB와 agent terminal은 유지합니다. 설치 파일도 남겨 재설치/진단에 사용할 수 있습니다. DB까지 삭제하려면 먼저 보관할 이력이 없는지 확인하세요.

## 저장 위치와 복구

- 정의·실행 이력: `~/.local/state/herdr-automations/automations.db` (SQLite WAL).
- user unit: `~/.config/systemd/user/herdr-automations.service`.
- 제어 socket: `$XDG_RUNTIME_DIR/herdr-automations/control.sock`. runtime dir가 없을 때는 `/tmp/herdr-automations-<uid>/herdr-automations/`.
- 서비스 로그: `journalctl --user -u herdr-automations`.
- 별도 설정 파일은 v1에서 사용하지 않습니다. 정의/설정은 DB가 정본입니다.

일관된 백업은 서비스를 멈추고 `~/.local/state/herdr-automations/` 전체(DB와 존재하는 WAL/SHM 포함)를 복사한 뒤 재시작합니다. DB를 복원할 때도 서비스를 먼저 멈춥니다. schema version 1만 지원하며 알 수 없는 미래 schema를 덮어쓰지 않습니다. 실행 중이던 작업이 있으면 복원 후 이력과 실제 hc terminal을 먼저 대조하세요. 오래된 DB 복원은 그 이후 예약 cursor도 되돌리므로 작업이 중복될 수 있습니다.

## 검증과 현재 범위

```sh
python3 tests/automations/test_automations.py
node tests/automations/test_ui.mjs
python3 tests/automations/integration.py
python3 tests/automations/check_mod.py
python3 tests/automations/ui_smoke.py  # Xvfb 필요; 사용자 창과 격리하여 실제 GPUI 화면 렌더링
```

통합 테스트는 별도 `HC_SESSION`/XDG 경로와 가짜 provider를 실제 hc 안에서 실행합니다. 사용자의 core는 종료하지 않습니다. UI action 테스트는 실제 mod의 콜백과 요청을 검증하며, native layout 검증과 별개입니다. 화면 smoke 결과는 `~/analysis/herdr-automations-ui/`에 저장됩니다. 이 화면의 예시 이력은 렌더링 fixture입니다.

새 worktree 생성, 원격 PC 실행, cron/RRULE 입력, 기존 session 재사용은 후속 범위입니다. 현재는 선택한 기존 폴더에서 매번 새 에이전트를 실행합니다. 검증 없이 자동 commit/push/merge를 추가하지 않습니다.

OSC 상태 보고 형식은 [Herdr 공식 문서](https://herdr.dev/)의 공개 프로토콜 설명을 참고했습니다. 구체적인 실행 계약은 설치된 `hc schema`와 실제 에이전트 테스트로 검증했습니다.
