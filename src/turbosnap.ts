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
import {readFileSync, statSync} from "node:fs";

interface StatsReason {
    moduleName?: string;
    moduleIdentifier?: string;
}
interface StatsModule {
    type?: string;
    moduleType?: string;
    name?: string;
    identifier?: string;
    children?: StatsModule[];
    filteredModules?: number;
    filteredChildren?: number;
    filteredReasons?: number;
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

export interface SourceGraph {
    importers: Record<string, string[]>;
}

export function readSourceGraph(statsPath: string): SourceGraph | TraceResult {
    let stats: {modules?: StatsModule[]; filteredModules?: number};
    try {
        if (statSync(statsPath).size > 256 * 1024 * 1024) {
            return {full: true, affectedStoryIds: [], reason: "webpack stats exceed 256 MiB"};
        }
        stats = JSON.parse(readFileSync(statsPath, "utf8"));
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
    let incomplete = Boolean(stats.filteredModules);
    let edges = 0;
    const indexModule = (m: StatsModule, parent = "") => {
        // Webpack collapses its generated runtime helpers even in ordinary complete
        // source stats. They have no repository source paths to trace.
        if (incomplete || m.moduleType === "runtime") return;
        if (m.filteredModules || m.filteredChildren || m.filteredReasons) incomplete = true;
        const name = m.name ? normalizeModuleName(m.name) : "";
        if (name) known.add(name);
        if (m.type === "module" && !Array.isArray(m.reasons)) incomplete = true;
        if (parent && name && parent !== name) {
            addEdge(parent, name);
            addEdge(name, parent);
        }
        for (const r of m.reasons ?? []) {
            if (++edges > 2_000_000) { incomplete = true; return; }
            if (r.moduleName) addEdge(normalizeModuleName(r.moduleName), name);
        }
        for (const child of m.modules ?? []) indexModule(child, name);
        for (const child of m.children ?? []) indexModule(child, parent);
    };
    for (const m of modules) indexModule(m);
    if (incomplete) return {full: true, affectedStoryIds: [], reason: "incomplete or oversized webpack graph"};

    const importers: Record<string, string[]> = Object.create(null);
    for (const file of known) importers[file] = [];
    for (const [file, parents] of dependents) importers[file] = [...parents];
    return {importers};
}

/**
 * Trace which stories are affected by `changedFiles`.
 *
 * @param statsPath  path to preview-stats.json
 * @param changedFiles  repo-relative POSIX paths changed since the baseline
 * @param stories  every story with its source importPath (from index.json)
 * @param extraGlobalPatterns  additional "force full render" path regexes
 * @param globalExcludePatterns  paths to EXEMPT from the global rule (trace via the
 *        graph instead) — e.g. story fixtures under `.storybook/` that are actually
 *        imported by specific stories. A safety net still full-renders if such a
 *        file can't be found in the bundle graph (see below).
 */
export function traceAffectedStories(opts: {
    metadataPaths?: Set<string>;
    graph?: SourceGraph | TraceResult;
    statsPath: string;
    changedFiles: string[];
    stories: {id: string; importPath: string}[];
    extraGlobalPatterns?: RegExp[];
    globalExcludePatterns?: RegExp[];
}): TraceResult {
    const changed = opts.changedFiles.map(normalizeGitPath).filter(Boolean);
    if (changed.length === 0) {
        return {full: false, affectedStoryIds: [], reason: "no files changed since baseline"};
    }

    const globals = [...DEFAULT_GLOBAL_PATTERNS, ...(opts.extraGlobalPatterns ?? [])];
    const excludes = opts.globalExcludePatterns ?? [];
    // A file is "global" (forces a full render) if it matches a global pattern AND
    // is NOT excused by a global-exclude pattern. Excludes let a project opt a
    // conventionally-global path back into normal graph tracing — e.g. story
    // fixture/mocks that live under `.storybook/` but are imported by (or replace
    // modules imported by) specific stories, so their impact IS traceable and
    // shouldn't nuke the whole render.
    const matchesGlobal = (f: string) => globals.some((re) => re.test(f));
    const isExcluded = (f: string) => excludes.some((re) => re.test(f));
    const globalHit = changed.find((f) => matchesGlobal(f) && !isExcluded(f) && (!opts.metadataPaths?.has(f) || opts.extraGlobalPatterns?.some(re => re.test(f))));
    if (globalHit) {
        return {full: true, affectedStoryIds: [], reason: `global file changed: ${globalHit}`};
    }

    const graph = opts.graph ?? readSourceGraph(opts.statsPath);
    if ("full" in graph) return graph;
    const known = (name: string) => Object.hasOwn(graph.importers, name);

    // Safety net for global-excludes: a file that WOULD be global but was excused
    // (so it could be traced) yet ISN'T in the bundle graph can't be scoped — it
    // may still affect rendering, so fall back to a full render rather than
    // silently carry stale screenshots forward. This makes an over-broad or
    // mistyped exclude fail safe (over-render), never unsafe (under-render).
    const untraceableExcluded = changed.find((f) => matchesGlobal(f) && isExcluded(f) && !known(f));
    if (untraceableExcluded) {
        return {
            full: true,
            affectedStoryIds: [],
            reason: `global-excluded file not found in the bundle graph (can't scope it): ${untraceableExcluded}`,
        };
    }

    // Seed: changed files that ARE in the bundle. A changed file that's NOT in the
    // bundle and NOT a global (checked above) can't affect any story's render.
    const seeds = changed.filter((f) => known(f));

    // BFS over dependents to collect every affected module name.
    const storyCounts = new Map<string, number>();
    for (const story of opts.stories) {
        const file = normalizeGitPath(story.importPath);
        storyCounts.set(file, (storyCounts.get(file) ?? 0) + 1);
    }
    let hits = 0;
    const affected = new Set<string>(seeds);
    const queue = [...affected];
    for (let cursor = 0; cursor < queue.length; cursor++) {
        const cur = queue[cursor];
        hits += storyCounts.get(cur) ?? 0;
        if (opts.stories.length >= 20 && hits >= opts.stories.length * 0.9) {
            return {full: true, affectedStoryIds: [], reason: "at least 90% of stories affected"};
        }
        if (/(^|\/)\.storybook\/preview\.[cm]?[jt]sx?$/.test(cur)) {
            return {full: true, affectedStoryIds: [], reason: "shared preview dependency changed"};
        }
        for (const dep of known(cur) ? graph.importers[cur] : []) {
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
        if (!known(sp) || affected.has(sp)) affectedStoryIds.push(story.id);
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
