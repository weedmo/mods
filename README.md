# Herdr mods

개인적으로 사용하고 확장하는 Herdr 모드 모음. 현재 설치된 기본 제공 모드는 제외하고, 별도로 설치하거나 복제·작성한 모드와 `main-weed` 레이아웃을 보관합니다.

## 모드

| 모드 | 역할 |
| --- | --- |
| `automations` | 로컬 Claude/Codex 반복 예약, 조건 검사, 실행 이력 ([설치/사용 안내](docs/automations.md)) |
| `projects` | PC별 저장소 등록, 프로젝트와 worktree 작업 관리 |
| `space-folders` | Spaces 탐색과 프로젝트 연결 표시 (설치는 유지, `main-weed` 사이드바는 이제 `project-spaces` 사용) |
| `project-spaces` | 사이드바 (`space-folders` 기반). git origin 원격(host/owner/repo, ssh·https 동일 취급)으로 묶은 프로젝트 → 사용하는 PC → 그 PC의 space 트리. 원격 없는 space는 PC별 `기타`. 프로젝트 `+`는 PC 추가(기존 폴더 연결 / 백그라운드 hc 터미널에서 클론), PC `+`는 space 만들기(체크아웃·새 worktree·하위 폴더), PC 우클릭은 역할(impl/QA/plan) 지정. 레지스트리는 이 노트북의 `~/.config/herdr-projects/projects.json` |
| `project-lead` | 오른쪽 패널 (Ctrl+Alt+P). 프로젝트별 PC·역할·현재 작업·상태·마지막 보고 표시. `herdr-lead` 스킬이 쓰는 `lead-state.json`을 읽기만 함 |
| `issues` | GitHub 이슈 탐색과 상세 보기 |
| `issues-projects` | 프로젝트 작업 시작 기능을 연결한 이슈 패널 |
| `sessions-weed` | Claude/Codex 세션 탐색 및 재개 |
| `agent-resume` | 에이전트가 종료되고 셸만 남은 터미널에서 세션 복원 |
| `agents-weed` | 사용자화한 에이전트 목록. `project-spaces`가 있으면 프로젝트별로 묶어 보기 가능 (`project-spaces.projects`) |
| `tabs-weed` | 사용자화한 탭 표시와 조작 |
| `tab-drop` | 탭·에이전트 드래그의 분할 위치 표시 |
| `pane-weed` | 사용자화한 터미널 패널 헤더 |
| `files-weed` | 우측 Files 패널 (기본 `files` 복제). 터미널 우클릭 메뉴의 `Open <경로>`로 파일을 바로 엽니다 |
| `menu-weed` | 사용자화한 터미널 컨텍스트 메뉴 |
| `reviewer` | Git 변경사항과 diff 리뷰 |
| `git-graph` | Git 커밋 그래프와 저장소 작업 |
| `workflow-graph` | Claude workflow · matt-auto · autocode 실행을 레인 그래프로 표시 (오른쪽 패널, Ctrl+Shift+G) |
| `artifact-view` | Claude/Codex가 만든 HTML·링크를 headless Chrome으로 렌더링해 오른쪽 패널에 표시. 현재 space의 파일만 표시 (Ctrl+Shift+A) |
| `artifact-ask` | HTML 파일·링크 Ctrl+클릭 시 "옆에서 보기 / Chrome에서 열기" 선택 창 |
| `keymap` | 단축키 조회와 편집 |
| `usage-weed` | Claude/Codex 사용량 표시 |

`cloned_from` 메타데이터와 기존 파일의 출처·라이선스 표기는 그대로 유지합니다. 이 저장소 전체에 적용할 별도 라이선스는 지정하지 않았습니다.

## 새 PC 빠른 시작

Herdr 설치부터 현재 화면(다크 `graphite` 배경, `main-weed` 레이아웃, 단축키, 모드)까지 한 줄로 맞춥니다. Herdr를 닫은 상태에서 실행하면 첫 실행 환영 화면 없이 바로 `main-weed`로 열립니다.

```sh
curl -fsSL https://raw.githubusercontent.com/weedmo/mods/main/scripts/bootstrap.sh | sh
```

AI 에이전트에게 맡기려면 [docs/ai-setup-prompt.md](docs/ai-setup-prompt.md)의 프롬프트를 그대로 붙여넣습니다.

## 설치

Herdr 0.1.13 환경에서 수집했습니다. Herdr와 기본 제공 모드가 먼저 설치되어 있어야 합니다. Python 보조 프로그램에는 `python3`, Git 작업에는 `git`, GitHub 이슈에는 인증된 `gh`가 필요합니다. Projects는 POSIX 환경을 사용합니다.

저장소 루트에서 아래 명령 하나로 모드, `main-weed` 레이아웃, 단축키(`keys.json`), 화면 설정(`settings.json`, 다크 테마 `graphite` 고정), 에이전트 실행 명령(`programs.json`), 사용자 테마를 모두 적용합니다. 기존 파일은 `$app_home/backups/setup-<시각>/`에 먼저 백업합니다.

```sh
python3 scripts/install.py                      # 전체 적용 (단축키·설정은 병합, 저장소 값 우선)
python3 scripts/install.py --with-automations --with-statusline   # 자동화 서비스와 상태줄 스크립트까지
python3 scripts/install.py --replace            # keys/settings/programs를 병합 대신 저장소 값으로 덮어쓰기
```

`keys.json`·`settings.json`·`programs.json`은 기본적으로 병합하므로 저장소에 있는 단축키는 모두 적용되고, 그 PC에만 있던 단축키는 유지됩니다. 설치 후 열린 창을 `main-weed` 레이아웃으로 전환합니다(`--no-switch`로 생략).

모드 이름은 이미지 경로와 모드 간 호출에 사용하므로 폴더 이름을 유지합니다. `main-weed`는 이 저장소의 `workspace-chrome`과 기본 제공 `workspace-status`도 사용합니다. 설치된 모드는 Herdr에서 자동으로 다시 읽습니다.

`examples/keys.json`은 현재 사용하는 단축키 전체이며 `scripts/install.py`가 자동 병합합니다. 세션 창은 `mod.open:sessions-weed`, 에이전트 복원은 `mod.open:agent-resume`, 단축키 편집은 `mod.open:keymap`으로 열 수 있습니다.

### 사용량 상태줄 보조 스크립트

`scripts/herdr-statusline-tee.sh`는 Claude Code 상태줄 입력의 사용량 정보만 `~/.local/state/herdr-usage/claude.json`에 저장합니다. `jq`가 필요하며, 기존 Orca 상태줄 훅이 있으면 전달합니다. 사용하려면 `~/.local/bin/`에 복사하고 Claude Code의 `statusLine.command`에서 호출합니다. 다른 상태줄을 사용한다면 마지막 전달 부분을 환경에 맞게 조정합니다. 스크립트 복사만으로 Claude 설정이 바뀌지는 않습니다.

Spaces의 원격 폴더 선택은 Linux GTK 기본 파일 선택창과 GVfs SFTP를 사용합니다. 로컬 PC에 `/usr/bin/python3`, PyGObject GTK 3, GVfs SFTP 백엔드가 필요하며 SSH 연결 설정을 사용합니다. 로컬 폴더는 Herdr의 시스템 선택기를 사용합니다.

## 버전과 업데이트

저장소 전체 버전은 `VERSION`, mod별 버전은 각 `mods/<name>/mod.json`의 `version`에 있습니다(semver). 릴리스마다 `vX.Y.Z` 태그와 GitHub Release를 만들고, 변경 내역은 `CHANGELOG.md`에 쌓입니다.

```sh
python3 scripts/versions.py list              # 저장소·mod 버전 보기
python3 scripts/versions.py check             # 모든 mod에 버전이 있는지 검사
python3 scripts/release.py patch --dry-run    # 릴리스 계획만 보기
python3 scripts/release.py patch|minor|major|X.Y.Z
```

- `release.py`는 `origin/main`의 임시 worktree에서 동작하므로 로컬의 커밋 안 한 작업은 릴리스에 섞이지 않습니다. main에 merge한 뒤 실행합니다.
- 직전 태그 이후 파일이 바뀐 mod는 patch를 자동으로 올립니다. 기능 추가처럼 더 크게 올리려면 PR에서 그 mod의 `version`을 직접 올립니다(그 경우 자동으로 올리지 않음). 버전이 없는 새 mod는 1.0.0이 됩니다.

다른 PC 설치본 업데이트는 수동입니다.

```sh
python3 scripts/update.py --check             # 설치 버전 vs 최신, 바뀌는 mod 보기
python3 scripts/update.py                     # 이 PC를 최신 릴리스로 (install.py 인자 전달 가능)
python3 scripts/update.py --version 1.0.0     # 특정 릴리스로 (되돌리기 포함)
python3 scripts/update.py --on vn_server      # hc로 다른 PC에서 실행 (반복 가능)
python3 scripts/update.py --all-machines      # 연결된 모든 hc PC
```

릴리스는 `~/.cache/herdr-mods`로 받아 그 안의 `install.py`를 실행하므로 `~/mods` 작업 트리와 무관합니다. 설치된 버전은 `~/.local/state/herdr-mods/installed.json`에 기록됩니다. 원격 PC에는 `python3`, `git`과 GitHub 접근이 필요합니다. 검증: `python3 tests/versions/test_versions.py`.

## 개발 및 검증

이 모드는 HTML/Node 앱이 아니라 Herdr의 GPUI JavaScript 런타임에서 실행됩니다. `.d.ts`와 `jsconfig.json`은 Herdr가 생성하므로 저장소에서 제외합니다.

```sh
for mod in mods/*; do
  herdr-app check "$mod" || break
done
```

`check`는 초기 렌더링 검사입니다. 비동기 동작, 원격 PC, 드래그, GitHub 작업은 실제 앱에서도 확인해야 합니다. Projects 백엔드를 바꾸면 `backend.py`와 JSON 문자열로 내장한 `backend-source.js`를 함께 갱신합니다.

실행 중인 원본은 `~/.config/herdr-app/mods/`입니다. 여기서 계속 수정한 내용은 저장소 사본에 동기화한 뒤 커밋해야 합니다. `data/`, `shared.json`, 세션 DB, 인증 정보, 프로젝트 카탈로그, 텔레메트리, 백업은 버전 관리하지 않습니다.

### herdr-lead 스킬

`skills/herdr-lead/`는 Claude Code 스킬입니다 (`SKILL.md`, `lead_state.py`). `~/.claude/skills/herdr-lead/`에 복사하면 이 노트북의 Claude가 `projects.json`의 역할 PC에 작업을 보내고(`hc run --bg --on <pc>`), 보고를 기다리고, 다음 역할로 넘기기 전에 사용자에게 묻습니다. 진행 상황은 `project-lead` 패널에 표시됩니다. 역할은 사용자가 `project-spaces`의 PC 우클릭으로만 지정합니다.

### 자동화 서비스

`automations`는 mod 복사 외에 독립 예약 서비스 설치가 필요합니다. `python3 scripts/herdr-automations/install.py`를 실행하세요. 자세한 정책·복구·제거 방법은 [자동화 안내](docs/automations.md)를 참고하세요.

### Artifact 패널

`artifact-view`는 현재 space에 속한 HTML만 보여줍니다: space 폴더, 그 space 터미널들의 폴더, 그 space에서 실행 중인 Claude 세션의 scratchpad. 홈 폴더 자체는 모든 space가 공유하므로 탐색하지 않습니다. 렌더링에는 Node와 Chrome/Chromium이 필요합니다.

Ctrl+클릭 선택 창을 쓰려면 `scripts/artifact-open/install.sh`를 실행하세요. `.html`과 `http(s)` 링크의 기본 프로그램을 `herdr-artifact-open`으로 바꿉니다. 링크는 Herdr에서 열었을 때만 선택 창을 띄우고, 다른 프로그램에서 연 링크는 바로 브라우저로 엽니다. 되돌리기: `xdg-mime default google-chrome.desktop text/html application/xhtml+xml x-scheme-handler/http x-scheme-handler/https`

### 최근 Herdr 재설정 반영

- `Ctrl+,` 또는 Settings에서 사용자 설정 화면을 열고 **단축키 안내**에서 기능 설명·검색·편집을 사용합니다.
- 글자가 있는 버튼은 단축키만, 아이콘 버튼은 기능명과 단축키를 툴팁으로 표시합니다.
- Spaces의 머신별 `+`는 현재 화면과 무관하게 해당 머신에 공간을 만듭니다.
- Agents 항목은 해당 공간, 탭, 분할 터미널을 함께 선택합니다.
- Workflow 패널은 `Ctrl+Shift+G`로 열거나 닫습니다.

`examples/keys.json`에는 현재 사용하는 재설정 단축키를 반영했고, `scripts/install.py`가 설치 시 자동 병합합니다.

### 재설정 파일과 설치본 대조

`examples/settings.json`, `examples/programs.json`, `examples/themes/`에 현재 화면 설정, 에이전트 실행 명령, 사용자 테마도 보관합니다. `scripts/install.py`가 백업 후 설정을 병합하고 테마를 `$app_home/themes/`에 복사합니다. `programs.json`의 현재 예시는 에이전트 승인 생략 옵션을 포함합니다.

`matt-graph`와 `workspace-chrome-edited`도 설치본에 있는 별도 모드로 함께 보관합니다. 설치본 전체와 저장소를 다시 비교하려면 `python3 scripts/audit-installed-setup.py`를 실행하세요. 이 명령은 사용자 모드 전체를 발견하고 소스와 설정을 바이트 단위로 대조합니다. 앱 제공 모드 중 저장소에 없는 항목과 실행 데이터는 제외합니다. 대조 범위는 [설정 점검 기록](docs/setup-audit.md)을 참고하세요.
