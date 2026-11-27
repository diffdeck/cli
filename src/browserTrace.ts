import type {SourceGraph} from "./turbosnap";
// Each worker reuses a page. Associate every resource requested in a chunk with
// every story in that chunk: modules and fonts can stay in memory across switches.
import {createHash} from "node:crypto";
import {createReadStream, promises as fs} from "node:fs";
import path from "node:path";

export interface Group { ids: string[]; paths: string[]; external: boolean }
export interface SourceSnapshot { graph: SourceGraph; stories: {id: string; importPath: string}[] }
export interface Snapshot { source?: SourceSnapshot; version: 1; settings: string; groups: Group[]; hashes: Record<string, string> }
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
export function matchingSnapshot(value: any, settings: string): value is Snapshot {
    const strings = (items: unknown) => Array.isArray(items) && items.every(item => typeof item === "string");
    const source = value?.source;
    if (source !== undefined && (!source?.graph?.importers || typeof source.graph.importers !== "object" ||
        !Object.values(source.graph.importers).every(strings) || !Array.isArray(source.stories) ||
        !source.stories.every((s: any) => s && typeof s.id === "string" && typeof s.importPath === "string"))) return false;
    return value?.version === 1 && value.settings === settings && value.hashes && typeof value.hashes === "object" &&
        Array.isArray(value.groups) && value.groups.every((g: Group) => g && strings(g.ids) && strings(g.paths) &&
            typeof g.external === "boolean" && g.paths.every(p => Object.hasOwn(value.hashes, p) && typeof value.hashes[p] === "string"));
}

export const cacheFile = (dir: string, host: string, id: string) => path.join(dir, digest(host + "\n" + id) + ".json");

export function recordRequest(url: string, origin: string, paths: Set<string>): boolean {
    try {
        const u = new URL(url);
        if (u.protocol === "data:" || u.protocol === "blob:") return true;
        if (u.origin !== origin) return false;
        const resource = decodeURIComponent(u.pathname).replace(/^\/+/, "") || "index.html";
        if (resource.split(/[\\/]/).includes("..") || resource.includes("\\")) return false;
        paths.add(resource);
        return true;
    } catch { return false; }
}

export class AssetHashes {
    readonly values: Record<string, string> = Object.create(null);
    private bytes = 0;
    constructor(private root: string) {}
    async get(name: string): Promise<string> {
        if (Object.hasOwn(this.values, name)) return this.values[name];
        if (path.isAbsolute(name) || name.includes("\\") || name.split("/").includes("..")) throw Error("invalid asset path");
        const file = path.join(this.root, name);
        try {
            const stat = await fs.stat(file);
            this.bytes += stat.size;
            if (this.bytes > 512 * 1024 * 1024) throw Error("asset comparison exceeded 512 MiB");
            const hash = createHash("sha256");
            for await (const bytes of createReadStream(file)) hash.update(bytes);
            this.values[name] = hash.digest("hex");
        } catch (e: any) {
            if (!["ENOENT", "ENOTDIR", "EISDIR"].includes(e.code)) throw e;
            this.values[name] = "missing";
        }
        return this.values[name];
    }
}

// A story must have complete observations for all capture lanes. Writers only
// save snapshots after the whole render and upload succeeded.
export async function compare(snapshot: Snapshot, settings: string, ids: string[], assets: AssetHashes) {
    if (snapshot.version !== 1 || snapshot.settings !== settings) throw Error("capture settings changed");
    const covered = new Set<string>();
    const affected = new Set<string>();
    const wanted = new Set(ids);
    for (const group of snapshot.groups) {
        const present = group.ids.filter(id => wanted.has(id));
        if (!present.length) continue;
        let changed = group.external || !group.paths.includes("iframe.html");
        for (const p of group.paths) {
            if (changed) break;
            changed = snapshot.hashes[p] !== await assets.get(p);
        }
        for (const id of present) {
            covered.add(id);
            if (changed) affected.add(id);
        }
        if (ids.length >= 20 && affected.size >= ids.length * 0.9) throw Error("at least 90% of stories affected");
    }
    return ids.filter(id => !covered.has(id) || affected.has(id));
}

// Retain observations for stories that the source graph carried forward. If a
// freshly observed file conflicts with an old observation, discard every lane
// for that story so a later browser comparison must recapture it.
export function carryGroups(previous: Snapshot, skipped: Set<string>, hashes: Record<string, string>): Group[] {
    for (const group of previous.groups) {
        if (group.paths.some(p => Object.hasOwn(hashes, p) && hashes[p] !== previous.hashes[p])) {
            for (const id of group.ids) skipped.delete(id);
        }
    }
    const kept: Group[] = [];
    for (const group of previous.groups) {
        const ids = group.ids.filter(id => skipped.has(id));
        if (!ids.length) continue;
        for (const p of group.paths) hashes[p] = previous.hashes[p];
        kept.push({...group, ids});
    }
    return kept;
}
