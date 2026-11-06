# Herdr 재설정 전체 점검

2026-11-06에 현재 설치본을 세션 구분 없이 전체 열거해 저장소와 비교했습니다.

- 사용자 모드 및 저장소에 보관한 모드: 21개, 소스·에셋 전체 포함. 기존 수집에서 빠졌던 `matt-graph`와 `workspace-chrome-edited` 추가.
- 사용자 레이아웃: `main-weed.json`.
- 설정 예시: 실제 `keys.json`, `settings.json`, `programs.json`.
- 사용자 테마: atom-one-dark, gruvbox-material, win98.
- 독립 서비스: 설치된 herdr-automations Python 소스 전체와 상태줄 스크립트 일치.
- 합계 205개 파일을 설치본과 바이트 단위로 대조.

Herdr가 배포·재생성하는 기본 모드, 기본 레이아웃, frame, 타입 선언, 아이콘, 앱 바이너리는 수집 대상에서 제외합니다. `clipboard-diagnostic` 폴더에는 생성된 타입 선언과 jsconfig만 있어 보관할 소스가 없습니다. 세션 DB, shared/view/window 상태, 프로젝트 카탈로그, 텔레메트리, 백업, 서비스의 사용자별 PATH도 공개 저장소에서 제외합니다. 자동화 서비스 등록은 기존 설치 스크립트가 재생성합니다.

재검증: `python3 scripts/audit-installed-setup.py`. 이 검사는 위 범위의 설치본에서 새 사용자 모드를 발견하며, 파일 누락이나 내용 차이가 있으면 실패합니다. 실제 UI 동작 전체를 보증하는 검사는 아닙니다.
