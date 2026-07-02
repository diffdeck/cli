/**
 * TurboSnap-style impact analysis: given the webpack module graph Storybook emits
 * (`preview-stats.json`, from `storybook build --webpack-stats-json`) and the list
 * of files changed since the baseline commit, work out which stories could have
 * changed — so the screenshotter renders only those and the server carries the
 * rest forward from the baseline.
 *
 * Safety first: this only ever tells you a story is affected, never that it's
 * safe to skip when we're unsure. Callers must full-render whenever this returns
 * `{full: true}` (no stats, a global/untraced file changed, or the graph can't be
 * trusted).
 */
import {readFileSync} from "node:fs";

interface StatsReason {
    moduleName?: string;
    moduleIdentifier?: string;
}
interface StatsModule {
    name?: string;
    identifier?: string;
    reasons?: StatsReason[];
    modules?: StatsModule[]; // concatenated (ModuleConcatenationPlugin) children
}

/**
 * Files that affect rendering but usually AREN'T in the preview bundle graph.
 * If any changed file matches these, we can't scope the impact → full render.
 */
const DEFAULT_GLOBAL_PATTERNS: RegExp[] = [
    /(^|\/)package\.json$/,
    /(^|\/)package-lock\.json$/,
    /(^|\/)yarn\.lock$/,
    /(^|\/)pnpm-lock\.yaml$/,
    /(^|\/)\.storybook\//,
    /(^|\/)(tailwind|postcss)\.config\.[cm]?[jt]s$/,
];

/** Normalise a webpack module name to a repo-relative POSIX path we can compare to git paths. */
export function normalizeModuleName(raw: string): string {
    let n = raw;
    // Loaders: keep only the part after the last "!".
    const bang = n.lastIndexOf("!");
    if (bang !== -1) n = n.slice(bang + 1);
    // Concatenated modules: "./src/Foo.tsx + 3 modules".
    n = n.replace(/\s*\+\s*\d+\s*modules?$/, "");
    // Query/hash suffixes.
    n = n.split("?")[0].split("#")[0];
    // Normalise separators + strip a leading "./".
    n = n.replace(/\\/g, "/").replace(/^\.\//, "");
    return n.trim();
}

/** Normalise a git path (already repo-relative POSIX) for comparison. */
function normalizeGitPath(p: string): string {
    return p.replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

export interface TraceResult {
    /** True → the caller must render every story (couldn't safely scope). */
    full: boolean;
    /** When not full: the set of story IDs that may have changed. */
    affectedStoryIds: string[];
    /** Human-readable reason (for logging). */
    reason: string;
}

/**
 * Trace which stories are affected by `changedFiles`.
 *
 * @param statsPath  path to preview-stats.json
 * @param changedFiles  repo-relative POSIX paths changed since the baseline
 * @param stories  every story with its source importPath (from index.json)
 * @param extraGlobalPatterns  additional "force full render" path regexes
 */
export function traceAffectedStories(opts: {
    statsPath: string;
    changedFiles: string[];
    stories: {id: string; importPath: string}[];
    extraGlobalPatterns?: RegExp[];
}): TraceResult {
    const changed = opts.changedFiles.map(normalizeGitPath).filter(Boolean);
    if (changed.length === 0) {
        return {full: false, affectedStoryIds: [], reason: "no files changed since baseline"};
    }

    const globals = [...DEFAULT_GLOBAL_PATTERNS, ...(opts.extraGlobalPatterns ?? [])];
    const globalHit = changed.find((f) => globals.some((re) => re.test(f)));
    if (globalHit) {
        return {full: true, affectedStoryIds: [], reason: `global file changed: ${globalHit}`};
    }

    let stats: {modules?: StatsModule[]};
    try {
        stats = JSON.parse(readFileSync(opts.statsPath, "utf8"));
    } catch (e: any) {
        return {full: true, affectedStoryIds: [], reason: `could not read stats: ${e?.message ?? e}`};
    }
    const modules = stats.modules ?? [];
    if (modules.length === 0) {
        return {full: true, affectedStoryIds: [], reason: "empty/invalid stats"};
    }

    // Reverse dependency graph over normalised module names: dependents[X] = the
    // set of modules that import X. Include concatenated children so an edge into a
    // merged module resolves. Because content-hashed builds cascade, walking
    // importers from a changed module reaches every module whose output depends on it.
    const dependents = new Map<string, Set<string>>();
    const known = new Set<string>();
    const addEdge = (importer: string, imported: string) => {
        if (!importer || !imported) return;
        let set = dependents.get(imported);
        if (!set) dependents.set(imported, (set = new Set()));
        set.add(importer);
    };
    const indexModule = (m: StatsModule) => {
        const name = m.name ? normalizeModuleName(m.name) : "";
        if (name) known.add(name);
        for (const r of m.reasons ?? []) {
            if (r.moduleName) addEdge(normalizeModuleName(r.moduleName), name);
        }
        for (const child of m.modules ?? []) {
            const cn = child.name ? normalizeModuleName(child.name) : "";
            if (cn) {
                known.add(cn);
                // A child of a concatenated module shares that module's fate.
                if (name && cn !== name) {
                    addEdge(cn, name);
                    addEdge(name, cn);
                }
            }
            for (const r of child.reasons ?? []) {
                if (r.moduleName) addEdge(normalizeModuleName(r.moduleName), cn || name);
            }
        }
    };
    for (const m of modules) indexModule(m);

    // Seed: changed files that ARE in the bundle. A changed file that's NOT in the
    // bundle and NOT a global (checked above) can't affect any story's render.
    const seeds = changed.filter((f) => known.has(f));

    // BFS over dependents to collect every affected module name.
    const affected = new Set<string>(seeds);
    const queue = [...seeds];
    while (queue.length) {
        const cur = queue.shift()!;
        for (const dep of dependents.get(cur) ?? []) {
            if (!affected.has(dep)) {
                affected.add(dep);
                queue.push(dep);
            }
        }
    }

    // A story is affected if its source module is in the affected set.
    const affectedStoryIds: string[] = [];
    for (const story of opts.stories) {
        const sp = normalizeGitPath(story.importPath);
        if (affected.has(sp)) affectedStoryIds.push(story.id);
    }

    return {
        full: false,
        affectedStoryIds,
        reason:
            seeds.length === 0
                ? "no changed files are in the Storybook bundle"
                : `${affectedStoryIds.length} affected via ${seeds.length} changed bundle file(s)`,
    };
}
