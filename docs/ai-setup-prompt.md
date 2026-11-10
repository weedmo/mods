# AI 설치 프롬프트

새 PC에서 Claude Code·Codex 같은 코딩 에이전트에게 아래 블록을 그대로 붙여넣으면, Herdr 설치부터 현재와 같은 화면(배경색·테마·레이아웃·단축키·모드)까지 한 번에 맞춰 줍니다.

````text
Set up Herdr on this machine so it starts exactly like my saved setup
(colors/theme, main-weed layout, shortcuts, agent launchers, custom mods).
Source of truth: https://github.com/weedmo/mods (read its README.md first).

Steps:
1. Check prerequisites: git, python3, curl. Optional: gh (logged in) for the Issues
   panel, jq for the usage statusline. Install missing ones with the system package
   manager only after telling me.
2. If `herdr-app` is not on PATH (also check ~/.local/bin), install Herdr:
     curl -fsSL https://releases.herdr.dev/app/install.sh | sh
   Then make sure ~/.local/bin is on PATH.
3. Clone (or `git pull --ff-only` if it exists) https://github.com/weedmo/mods.git into ~/mods.
4. Prefer running this with Herdr closed, so the first launch skips the welcome
   screen and opens main-weed directly. Then run:
     python3 ~/mods/scripts/install.py
   Add `--with-statusline` if Claude Code is installed, and `--with-automations` only if
   I ask for scheduled agent runs. The script backs up ~/.config/herdr-app into
   backups/setup-<time>/ before writing anything.
5. Verify:
   - ~/.config/herdr-app/settings.json has "appearance": "dark" and
     "theme": {"light": "paper", "dark": "graphite"} (graphite dark background).
   - ~/.config/herdr-app/layouts/main-weed.json exists, and every folder in ~/mods/mods
     exists under ~/.config/herdr-app/mods/.
   - Launch `herdr-app`, then run `herdr-app status`: "layout" must be "main-weed" and
     "errors" must contain no mod errors (unreachable SSH machines are fine).
   - If something looks wrong, run `herdr-app shot ~/herdr-shot.png` and inspect it.
6. Agent launchers use `claude --dangerously-skip-permissions` and
   `codex --dangerously-bypass-approvals-and-sandbox` (programs.json, keys.json). Tell me
   this and ask whether to keep these flags before finishing.
7. Report what was installed, what was skipped, and the backup folder path.

Rules: do not delete files in ~/.config/herdr-app; do not edit Herdr's built-in mods
or layouts; do not copy runtime state (sessions, view.json, window.json, telemetry).
````

## 이 프롬프트가 맞춰 주는 것

| 항목 | 저장 위치 | 값 |
| --- | --- | --- |
| 배경색·테마 | `examples/settings.json` | 다크 고정, `graphite`(라이트는 `paper`) |
| 레이아웃 | `layouts/main-weed.json` | 왼쪽 Spaces·Agents 사이드바, 상단 탭, 오른쪽 패널 |
| 단축키 | `examples/keys.json` | 전체 단축키 |
| 에이전트 실행 | `examples/programs.json` | Claude Code, Codex |
| 사용자 테마 | `examples/themes/` | atom-one-dark, gruvbox-material, win98 |
| 모드 | `mods/` | 사용자 모드 21개 |

직접 하려면 프롬프트 없이 아래 한 줄로 같은 결과를 얻습니다.

```sh
curl -fsSL https://raw.githubusercontent.com/weedmo/mods/main/scripts/bootstrap.sh | sh
```
