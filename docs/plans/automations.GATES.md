# Gates: Herdr automations v1

OWNS: mods/automations/**, scripts/herdr-automations/**, tests/automations/**, docs/plans/automations.GATES.md, docs/plans/herdr-automations.md, docs/automations.md, layouts/main-weed.json, README.md

Scope: Local recurring Claude/Codex automation service and native Herdr UI, including precheck, pause, run now, history, recovery and installation.

- [x] G1: Scheduler, validation, storage and recovery handle duplicate, missed and failed runs
  CHECK: python3 tests/automations/test_automations.py
  EXPECT: AUTOMATIONS_TESTS_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=76a049130d6df5632010a413219429f8b0a7c6fb2adc3dce89848363d8a97c98; exit=0; EXPECT=matched; output-sha256=5374575c36e4f05177b16343d012c38fe36fa9bcec5215e2dcccd167c959c16a; output-bytes=1906; shell=/bin/sh; cwd=/home/weed/mods; path=3151284c2932/29 entries

- [x] G2: Isolated service persists runs across restart and launches through real hc
  CHECK: python3 tests/automations/integration.py
  EXPECT: AUTOMATIONS_INTEGRATION_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=e2b9748b7d5d413707f1e23ea2220fac1647ad87249d82aaec4bf06d389185be; exit=0; EXPECT=matched; output-sha256=b8690f5754ba611cc175566823ae1689d7f7c8e1b0060533fd76b8c8a99757ae; output-bytes=31; shell=/bin/sh; cwd=/home/weed/mods; path=3151284c2932/29 entries

- [x] G3: Native automation mod passes Herdr loading validation
  CHECK: python3 tests/automations/check_mod.py
  EXPECT: AUTOMATIONS_MOD_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=fac7323099755689fab93386279b07c45d0f7d52c62dc97cce0273a433a3e4ec; exit=0; EXPECT=matched; output-sha256=0148bcc5afbfb8b74acdfc4c99b6ceccaea7a12e6d3ab007e4a294174e519689; output-bytes=72; shell=/bin/sh; cwd=/home/weed/mods; path=3151284c2932/29 entries

- [x] G4: Installed service and UI work together with readable forms, errors and history; agent adapters are verified or clearly unavailable
  EVIDENCE: 2026-11-05 installed systemd service active; production Claude/Codex runs t20/t21 reported done turn=1 with AUTOMATION_INSTALLED_OK, evidence at /home/weed/analysis/herdr-automations-installed-evidence.json. Test definitions archived and own terminals closed. Actual GPUI form/history/disconnect screenshots reviewed at /home/weed/analysis/herdr-automations-ui/. Live app check/status has no errors; source/deployment matched. UI clicks are covered by real callback tests; desktop pointer automation was unavailable, so native rendering used isolated Xvfb.

- [x] G5: Installation, removal, operating limits and recovery instructions match the delivered files
  EVIDENCE: 2026-11-05 reviewed docs/automations.md against installed paths and service behavior. Temporary-HOME installer smoke preserved an unrelated layout node, backed up the prior mod, installed the unit, then removed only owned UI/unit while retaining history; INSTALL_MERGE_BACKUP_UNINSTALL_PRESERVE_PASSED (systemctl mocked). Real systemctl enable/start and agent dispatch independently verified. No real user service uninstall performed.

- [x] G6: Real mod callbacks hydrate summaries and preserve request IDs across ambiguous failures
  CHECK: node tests/automations/test_ui.mjs
  EXPECT: AUTOMATIONS_UI_ACTIONS_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=d6a01c16ca04b7f5f5aa9bc89b83c20b953bb3840ebd2ed83dd817a10d695bbf; exit=0; EXPECT=matched; output-sha256=0d1ee5e2ed2801429cc64c55d82499caed5ba060c654aae60208ac607c5dc4fc; output-bytes=30; shell=/bin/sh; cwd=/home/weed/mods; path=3151284c2932/29 entries

- [x] G7: Real GPUI renders form, history and disconnect states in an isolated screen without runtime errors
  CHECK: python3 tests/automations/ui_smoke.py
  EXPECT: AUTOMATIONS_UI_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=28faecfabd9edeb7aa62b81c1b6f65a9cc51c98f2b10574b3f5406552bc3cc51; exit=0; EXPECT=matched; output-sha256=6fb7c010acc774f5d222c4e92cb2e41c83fbf7f1afc066d7b2c4b9d524755204; output-bytes=22; shell=/bin/sh; cwd=/home/weed/mods; path=3151284c2932/29 entries
