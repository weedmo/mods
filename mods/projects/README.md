# Herdr Projects

Orca 방식의 프로젝트 → PC별 저장소 → worktree/branch/이슈 작업 계층을 제공하는 개인 Herdr mod.

## 사용

- 상단 ⋯의 프로젝트 관리에서 +: PC와 기존 Git 저장소 경로를 등록한다.
- 기존 Spaces가 기본 탐색이다. 선택한 space에 프로젝트·branch를 표시하고 연결된 이슈 번호를 붙인다.
- 상단 Issues: 선택한 space의 프로젝트와 PC를 기준으로 이슈를 연다. 등록되지 않은 공간에서는 기존 이슈 패널을 연다. 해당 PC의 gh 인증을 사용한다.
- Start workspace: 실행할 PC, base ref, 새 branch, Shell 또는 설치된 에이전트를 선택한다.
- 이슈로 만든 작업은 연결 정보를 보존한다. 다시 시작하면 선택한 PC/저장소의 기존 작업을 연다. 추가 작업을 선택하면 다른 branch로 별도 작업을 만든다.
- 프로젝트 안 branch를 클릭하면 체크아웃을 열고, 작업 행을 클릭하면 연결된 space를 다시 연다.

## 저장과 PC 간 공유

각 PC의 ~/.config/herdr-projects/catalog.json이 그 PC의 저장소/작업/space 연결 기록을 소유한다. 연결 별칭 대신 PC의 machine-id에서 유도한 식별자를 기록하고, 쓰기는 잠금 및 원자적 교체를 사용한다. 연결된 PC들의 카탈로그를 읽어 동일한 Git remote를 프로젝트로 묶는다. 다른 Herdr 화면에서도 이 mod와 필요한 PC 연결이 있으면 동일한 기록을 조회할 수 있다. 이 설치 작업은 현재 화면의 mods와 개인 레이아웃에 적용했으며 다른 PC의 Herdr UI를 교체하지 않았다.

shared("projects.catalogs.v1")는 화면의 캐시/오프라인 표시다. 원본은 각 PC의 catalog.json이다. 터미널 cwd와 branch는 현재 상태로 표시하고 저장된 작업 ID/space 연결은 유지한다. 프로젝트 표시는 20초마다 갱신되며 ↻로 즉시 갱신한다.

## 요구사항

선택한 PC에 POSIX 환경, Python 3, Git이 있어야 한다. 이슈 조회에는 gh와 해당 계정 인증이 필요하다. 현재 연결된 Linux PC 4대에서 등록/조회 검증을 했다. base ref는 이미 PC에 있는 ref를 사용하며 시작 시 자동 fetch/clone은 하지 않는다.

## 유지보수와 복구

backend.py를 변경하면 backend-source.js를 JSON 문자열로 재생성한다. main.js는 백엔드 소스를 python3 -c의 독립 인자로 전달해 선택한 PC에서 실행한다. shell 문자열에 사용자 입력을 합치지 않는다. 기본 배포 issues/worktree mod는 그대로 두었고 issues-projects 복제본의 상세 화면에 시작 버튼을 추가했다.

