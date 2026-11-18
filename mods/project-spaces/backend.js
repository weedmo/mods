// Backend operations for the Add PC and New space dialogs, on any machine.
// Every path, URL and branch goes to programs as its own argv item: nothing a
// person typed is ever put into a shell string. The only `sh -c` scripts here are
// fixed text that read their values from "$1", "$2", ...
//
//   listDir(machine, path)        a folder's subfolders, tagged with git facts
//   inspectGit(machine, path)     is it a checkout: top, main, linked, origin
//   preflightClone(machine, ...)  git present, parent ok, target free, remote reachable
//   startClone(machine, ...)      git clone in a background hc terminal on that machine
//   cloneProgress(address)        its state, exit code and last lines
//   addWorktree(machine, ...)     git worktree add
//   removeCreated(machine, ...)   delete the folder a failed clone made (after confirming)

import { exec, hc } from "herdr";
import { normPath, cloneTarget } from "./project-model.js";

const opts = (machine, timeout = 20000) => ({ on: machine ?? null, timeout });

// Drop "user:token@" from scheme URLs so credentials never reach the registry or
// the screen; scp-like "git@host:owner/repo" carries no secret and stays.
export function redactUrl(url) {
  if (url == null) return null;
  return String(url).trim().replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/@]*@/, "$1");
}
export const hasCredentials = (url) => /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/@]*:[^/@]*@/.test(String(url ?? "").trim());

export const isAbs = (p) => typeof p === "string" && p.startsWith("/");
export const parentOf = (p) => {
  const n = normPath(p);
  const i = n.lastIndexOf("/");
  return i <= 0 ? "/" : n.slice(0, i);
};
export const joinPath = (dir, name) => (normPath(dir) === "/" ? `/${name}` : `${normPath(dir)}/${name}`);

// Same listing as /home/weed/analysis/herdr-project-spaces/lsdir.py: standard
// library only, no subprocesses (git facts are read from files), origin URLs redacted.
// argv: [path, max]. Prints one JSON object.
export const LSDIR = String.raw`
import json, os, sys, re
def git_info(p):
    g = os.path.join(p, ".git")
    try:
        if os.path.isdir(g):
            return {"kind": "repo", "origin": origin(os.path.join(g, "config"))}
        if os.path.isfile(g):
            with open(g) as f:
                line = f.read(4096).strip()
            if line.startswith("gitdir:"):
                gd = line[7:].strip()
                if not os.path.isabs(gd):
                    gd = os.path.normpath(os.path.join(p, gd))
                cd = gd
                try:
                    with open(os.path.join(gd, "commondir")) as f:
                        c = f.read().strip()
                    cd = os.path.normpath(os.path.join(gd, c))
                    kind = "worktree"
                except OSError:
                    kind = "submodule" if "/modules/" in gd else "gitfile"
                main = os.path.dirname(cd) if kind == "worktree" else None
                return {"kind": kind, "origin": origin(os.path.join(cd, "config")), "main": main}
    except OSError:
        pass
    return None
def origin(cfg):
    try:
        with open(cfg) as f:
            txt = f.read(65536)
    except OSError:
        return None
    sec = None
    for raw in txt.splitlines():
        s = raw.strip()
        m = re.match(r'^\[\s*remote\s+"([^"]+)"\s*\]', s)
        if m:
            sec = m.group(1); continue
        if s.startswith("["):
            sec = None; continue
        if sec == "origin":
            m = re.match(r'^url\s*=\s*(.+)$', s)
            if m:
                return redact(m.group(1).strip())
    return None
def redact(url):
    return re.sub(r'^([a-zA-Z][a-zA-Z0-9+.-]*://)[^/@]*@', r'\1', url)
def main():
    path = os.path.expanduser(sys.argv[1] if len(sys.argv) > 1 else "~")
    limit = int(sys.argv[2]) if len(sys.argv) > 2 else 500
    path = os.path.realpath(path)
    out = {"path": path, "home": os.path.expanduser("~"), "self": git_info(path), "entries": [], "truncated": False}
    try:
        it = sorted(os.scandir(path), key=lambda e: e.name.lower())
    except OSError as e:
        out["error"] = e.strerror or str(e); print(json.dumps(out)); return
    for e in it:
        try:
            if not e.is_dir():
                continue
        except OSError:
            continue
        if len(out["entries"]) >= limit:
            out["truncated"] = True; break
        ent = {"name": e.name, "hidden": e.name.startswith("."), "link": e.is_symlink()}
        gi = git_info(e.path)
        if gi:
            ent["git"] = gi
        out["entries"].append(ent)
    print(json.dumps(out))
main()
`;

// { path, home, self, entries: [{ name, path, hidden, link, git? }], truncated, error? }
export async function listDir(machine, path, max = 500) {
  const r = await exec("python3", ["-c", LSDIR, String(path || "~"), String(max)], opts(machine));
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n").pop() || `python3 exited ${r.code}`);
  const out = JSON.parse(r.stdout);
  out.entries = (out.entries ?? []).map((e) => ({ ...e, path: joinPath(out.path, e.name) }));
  return out;
}

const git = (machine, args, timeout = 20000) => exec("git", args, opts(machine, timeout));

// Mode A facts for a folder. { exists, dir, git: null | { top, main, common, linked, branch, remote } }
export async function inspectGit(machine, path) {
  if (!isAbs(path)) throw new Error("Pick an absolute folder.");
  const d = await exec("test", ["-d", path], opts(machine));
  if (d.code !== 0) {
    const e = await exec("test", ["-e", path], opts(machine));
    return { exists: e.code === 0, dir: false, git: null };
  }
  const r = await git(machine, ["-C", path, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir", "--abbrev-ref", "HEAD"]);
  if (r.code !== 0) {
    // "not a git repository" (128); a bare repo or an unborn HEAD also lands here.
    const top = await git(machine, ["-C", path, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"]);
    if (top.code !== 0) return { exists: true, dir: true, git: null };
    r.stdout = top.stdout + "\n";
  }
  const [top, common, branch] = r.stdout.split("\n").map((s) => s.trim());
  if (!top) return { exists: true, dir: true, git: null };
  const main = common.endsWith("/.git") ? common.slice(0, -5) : common;
  const o = await git(machine, ["-C", top, "config", "--get", "remote.origin.url"]);
  const remote = o.code === 0 ? redactUrl(o.stdout.trim()) || null : null;
  return { exists: true, dir: true, git: { top, main, common, linked: normPath(main) !== normPath(top), branch: branch && branch !== "HEAD" ? branch : null, remote } };
}

const PY_HOME = "import os; print(os.path.expanduser('~'))";
export async function remoteHome(machine) {
  const r = await exec("python3", ["-c", PY_HOME], opts(machine));
  if (r.code !== 0 || !r.stdout.trim()) throw new Error("Could not find that PC's home folder.");
  return r.stdout.trim();
}

// No prompts: a missing credential fails fast instead of waiting for a password.
const NO_PROMPT = ["env", "GIT_TERMINAL_PROMPT=0", "GIT_ASKPASS=", "SSH_ASKPASS=", "GIT_SSH_COMMAND=ssh -o BatchMode=yes -o ConnectTimeout=10"];

export async function lsRemote(machine, url, branch) {
  const args = [...NO_PROMPT, "git", "ls-remote", "--quiet", "--heads", "--", url];
  if (branch) args.push(`refs/heads/${branch}`);
  const r = await exec(args[0], args.slice(1), opts(machine, 45000));
  return { ok: r.code === 0, out: r.stdout.trim(), err: redactUrl(r.stderr.trim()) };
}

export function validBranch(b) {
  const s = String(b ?? "").trim();
  if (!s) return true;
  return !/(^[-/.])|([/.]$)|\.\.|[\s~^:?*[\\]|@\{|\/\/|\.lock$/.test(s) && s !== "@";
}

// Checks before a clone. Each check: { id, ok, level: "error" | "warn" | "info", text }.
// existing: the target's git facts when it already exists (the dialog offers Connect).
export async function preflightClone(machine, { parent, name, url, branch }) {
  const checks = [];
  const add = (id, ok, level, text) => checks.push({ id, ok, level: ok ? "info" : level, text });
  const target = isAbs(parent) ? cloneTarget(parent, name) : null;
  let existing = null;
  if (!target) add("target", false, "error", "Choose a parent folder and a plain folder name.");
  if (!String(url ?? "").trim()) add("url", false, "error", "Enter the remote URL.");
  if (!validBranch(branch)) add("branch", false, "error", "That branch name is not valid.");
  const v = await git(machine, ["--version"]).catch((e) => ({ code: 1, stderr: String(e) }));
  add("git", v.code === 0, "error", v.code === 0 ? v.stdout.trim() : "git is not installed on that PC.");
  if (target) {
    const p = await exec("test", ["-d", parent, "-a", "-w", parent], opts(machine));
    add("parent", p.code === 0, "error", p.code === 0 ? `Parent ${parent} is writable.` : `Parent ${parent} is missing or not writable.`);
    const info = await inspectGit(machine, target).catch(() => null);
    if (info?.exists) {
      existing = info;
      add("free", false, "error", info.git ? `${target} already exists and is a git checkout. Connect it instead.` : `${target} already exists. Pick another name.`);
    } else add("free", true, "info", `${target} is free.`);
  }
  if (v.code === 0 && String(url ?? "").trim()) {
    const r = await lsRemote(machine, url.trim(), null);
    add("auth", r.ok, "error", r.ok ? "Remote reachable, access ok." : `Can't read the remote: ${(r.err.split("\n").filter(Boolean).pop() ?? "").slice(0, 200) || "no access"}`);
    if (r.ok && branch?.trim()) {
      const b = await lsRemote(machine, url.trim(), branch.trim());
      add("branch-exists", Boolean(b.ok && b.out), "warn", b.ok && b.out ? `Branch ${branch.trim()} exists.` : `Branch ${branch.trim()} is not on the remote.`);
    }
  }
  return { ok: checks.every((c) => c.ok || c.level !== "error"), checks, target, existing };
}

// Fixed script: makes the target (fails if it exists, so a later delete only ever
// removes what this run made), says so, then clones into it. argv: target, git args...
export const CLONE_SCRIPT = 't=$1; shift; mkdir -- "$t" || exit 90; printf "PS_CREATED %s\\n" "$t"; exec git clone --progress "$@" "$t"';

export function cloneArgv({ target, url, branch }) {
  const b = String(branch ?? "").trim();
  return ["sh", "-c", CLONE_SCRIPT, "ps-clone", target, ...(b ? ["--branch", b] : []), "--", url];
}

const randomName = () => `ps-clone-${Math.random().toString(36).slice(2, 8)}`;

// Starts the clone in a background terminal on that machine (no parent: it is the
// dialog's, nobody else's). Resolves with { address, name, target }.
export async function startClone(machine, { parent, name, url, branch }) {
  const target = cloneTarget(parent, name);
  if (!target) throw new Error("Bad clone target.");
  const tname = randomName();
  const args = ["run", "--bg", "--json", "--no-parent", "--name", tname, "--cwd", parent,
    ...(machine ? ["--on", machine] : []), "--", ...cloneArgv({ target, url, branch })];
  const r = await hc(args);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || "hc run failed");
  const out = JSON.parse(r.stdout);
  return { address: out.address, name: tname, target };
}

// { state: "live" | "finished" | "gone", exit, lines, created }
export async function cloneProgress(address, target) {
  const g = await hc(["get", address, "--json"]);
  if (g.code !== 0) return { state: "gone", exit: null, lines: [], created: false };
  const info = JSON.parse(g.stdout);
  const rd = await hc(["read", address, "--lines", "40"]);
  const text = rd.code === 0 ? rd.stdout : "";
  const lines = text.split(/\r?\n|\r/).map((l) => redactUrl(l.trimEnd())).filter(Boolean);
  return { state: info.state === "finished" ? "finished" : "live", exit: info.exit_code ?? null, lines: lines.slice(-8), created: text.includes(`PS_CREATED ${target}`) };
}

export async function removeTerminal(address) {
  if (!address) return;
  try { await hc(["kill", address]); } catch {}
  try { await hc(["rm", address]); } catch {}
}

// Deletes a folder a failed clone made. Refuses anything that isn't exactly
// <parent>/<name> under an absolute parent, or the home or root folder.
export async function removeCreated(machine, { parent, name, target, home }) {
  const t = cloneTarget(parent, name);
  if (!t || t !== target || !isAbs(t) || t === "/" || (home && normPath(t) === normPath(home)) || t.split("/").length < 3)
    throw new Error("Refusing to delete that folder.");
  const r = await exec("rm", ["-rf", "--", t], opts(machine, 120000));
  if (r.code !== 0) throw new Error(r.stderr.trim() || "rm failed");
}

export async function branches(machine, top) {
  const r = await git(machine, ["-C", top, "for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads", "refs/remotes"]);
  if (r.code !== 0) return [];
  return r.stdout.split("\n").map((s) => s.trim()).filter((s) => s && !s.endsWith("/HEAD") && s !== "origin");
}

export async function branchExists(machine, top, branch) {
  return (await git(machine, ["-C", top, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
}

export const slug = (branch) => String(branch).trim().replace(/\//g, "-");

// Where Herdr's own New worktree puts checkouts: <dir>/<repo>/<branch-slug>.
export function worktreePath(dir, home, repo, branch) {
  const d = String(dir || "~/.herdr/worktrees").replace(/^~(?=\/|$)/, home);
  return `${normPath(d)}/${repo}/${slug(branch)}`;
}

export async function remoteBranchExists(machine, top, branch, remote = "origin") {
  return (await git(machine, ["-C", top, "show-ref", "--verify", "--quiet", `refs/remotes/${remote}/${branch}`])).code === 0;
}

// git worktree add: an existing local branch is checked out; a branch that exists only
// as origin/<branch> becomes a local branch tracking it (base is not used then); any
// other name is a new branch starting at base.
export async function addWorktree(machine, { top, path, branch, base }) {
  if (!validBranch(branch) || !String(branch).trim()) throw new Error("That branch name is not valid.");
  if (!isAbs(path)) throw new Error("Bad worktree path.");
  const name = branch.trim();
  const exists = await branchExists(machine, top, name);
  const tracking = !exists && (await remoteBranchExists(machine, top, name)) ? `origin/${name}` : null;
  const args = exists
    ? ["-C", top, "worktree", "add", "--", path, name]
    : tracking
      ? ["-C", top, "worktree", "add", "--track", "-b", name, "--", path, tracking]
      : ["-C", top, "worktree", "add", "-b", name, "--", path, ...(base?.trim() ? [base.trim()] : [])];
  const r = await git(machine, args, 600000);
  if (r.code !== 0) throw new Error(r.stderr.trim() || "git worktree add failed");
  return { path, created: !exists, tracking };
}
