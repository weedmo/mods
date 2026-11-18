// Registry IO for project-spaces (this laptop only): ~/.config/herdr-projects/projects.json.
// The sidebar loads it on a timer; dialogs (Add PC, roles) change it with updateRegistry,
// which writes atomically and only if the file still matches what was read.

import { home, readTextFile, writeTextFile, exec, shared, setShared } from "herdr";
import { inspectRegistry, serializeRegistry, emptyRegistry } from "./project-model.js";

export const SHARED_REGISTRY = "project-spaces.registry";
export const SHARED_PROJECTS = "project-spaces.projects";
export const CATALOGS = "projects.catalogs.v1";

export const registryDir = () => `${home()}/.config/herdr-projects`;
export const registryPath = () => `${registryDir()}/projects.json`;
export const localCatalogPath = () => `${registryDir()}/catalog.json`;

// { text, registry, error, dropped }: text is the raw file (null when absent) for
// writeTextFile's expected-compare. An unreadable file gives error and an empty registry;
// `dropped` lists rows the model could not use. Callers must not write over a file they
// could not parse or that had dropped rows (updateRegistry enforces both).
export async function loadRegistry() {
  const text = await readTextFile(registryPath());
  try {
    if (text == null) return { text, registry: emptyRegistry(), error: null, dropped: [] };
    const { registry, dropped } = inspectRegistry(text);
    return { text, registry, error: null, dropped };
  } catch (e) {
    return { text, registry: emptyRegistry(), error: String(e?.message ?? e), dropped: [] };
  }
}

export const droppedMessage = (dropped) =>
  `projects.json has entries this mod cannot read (${dropped.slice(0, 3).join("; ")}${dropped.length > 3 ? `; +${dropped.length - 3} more` : ""}). Fix them by hand; saving is disabled so they are not lost.`;

// The registry other copies (sidebar, overlays) last saw; null before the first load.
export const sharedRegistry = () => {
  const r = shared(SHARED_REGISTRY);
  return r && typeof r === "object" && r.projects ? r : null;
};

export function publishRegistry(registry) {
  const before = shared(SHARED_REGISTRY);
  if (JSON.stringify(before ?? null) !== JSON.stringify(registry)) setShared(SHARED_REGISTRY, registry);
}

// Applies fn(registry) -> registry and writes it. fn returning the same object means
// "nothing changed" (the model's helpers do that) and skips the write. Retries a few
// times when another writer got there first. Resolves with the registry now on disk.
export async function updateRegistry(fn) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { text, registry, error, dropped } = await loadRegistry();
    if (error) throw new Error(`Refusing to overwrite unreadable projects.json: ${error}`);
    if (dropped.length) throw new Error(`Refusing to save: ${droppedMessage(dropped)}`);
    const next = fn(registry);
    if (!next || next === registry) return registry;
    if (text == null) await exec("mkdir", ["-p", "--", registryDir()]);
    try {
      await writeTextFile(registryPath(), serializeRegistry(next), text);
      publishRegistry(next);
      return next;
    } catch (e) {
      lastError = e; // stale snapshot: read again and re-apply
    }
  }
  throw new Error(`Could not save projects.json: ${lastError?.message ?? lastError}`);
}

// Catalogs as the projects mod publishes them; this laptop's own catalog.json when
// that mod has not run yet.
export async function loadLocalCatalog() {
  const text = await readTextFile(localCatalogPath()).catch(() => null);
  if (!text) return null;
  try { return { ...JSON.parse(text), machine: null }; } catch { return null; }
}
