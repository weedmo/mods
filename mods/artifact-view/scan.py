"""List recent HTML artifacts under the given roots, newest first, as JSON.

Usage: python3 scan.py <days> <limit> <label>=<depth>=<path> ...
Each root is walked to <depth> levels; heavy folders are pruned.
"""
import glob
import json
import os
import re
import sys
import time

PRUNE = {".git", "node_modules", ".venv", "venv", "__pycache__", ".cache", ".next", "target",
         ".mypy_cache", ".pytest_cache", "site-packages", ".tox", "build", "coverage"}
TITLE = re.compile(rb"<title[^>]*>(.*?)</title>", re.I | re.S)


def title_of(path):
    try:
        with open(path, "rb") as f:
            m = TITLE.search(f.read(8192))
        return re.sub(r"\s+", " ", m.group(1).decode("utf-8", "replace")).strip()[:120] if m else ""
    except OSError:
        return ""


def walk(root, depth):
    root = root.rstrip("/") or "/"
    base = root.count(os.sep)
    for cur, dirs, files in os.walk(root):
        if cur.count(os.sep) - base >= depth:
            dirs[:] = []
        dirs[:] = [d for d in dirs if d not in PRUNE]
        for f in files:
            if f.lower().endswith((".html", ".htm")):
                yield os.path.join(cur, f)


def main():
    days, limit = float(sys.argv[1]), int(sys.argv[2])
    cutoff = time.time() - days * 86400
    seen, out, pins = set(), [], []
    for spec in sys.argv[3:]:
        label, depth, pattern = spec.split("=", 2)
        if label == "pin":  # one file, kept whatever its age or rank
            try:
                st = os.stat(pattern)
                pins.append({"path": pattern, "mtime": int(st.st_mtime * 1000), "size": st.st_size, "source": "open"})
            except OSError:
                pass
            continue
        for root in sorted(glob.glob(os.path.expanduser(pattern))):
            if not os.path.isdir(root):
                continue
            for p in walk(root, int(depth)):
                rp = os.path.realpath(p)
                if rp in seen:
                    continue
                seen.add(rp)
                try:
                    st = os.stat(p)
                except OSError:
                    continue
                if st.st_mtime < cutoff:
                    continue
                out.append({"path": p, "mtime": int(st.st_mtime * 1000), "size": st.st_size, "source": label})
    out.sort(key=lambda r: r["mtime"], reverse=True)
    out = out[:limit]
    have = {os.path.realpath(r["path"]) for r in out}
    out += [p for p in pins if os.path.realpath(p["path"]) not in have]
    for r in out:
        r["title"] = title_of(r["path"])
    print(json.dumps(out))


if __name__ == "__main__":
    main()
