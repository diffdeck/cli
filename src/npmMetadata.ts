import {execFileSync} from "node:child_process";
import {isDeepStrictEqual} from "node:util";

// A workspace declaring an already installed library can change only its
// dependency map and npm's dev flags, leaving every installed file in place.
export function metadataOnly(base: string, changed: string[]): Set<string> {
    const safe = new Set<string>();
    const read = (rev: string, file: string) => JSON.parse(execFileSync("git", ["show", rev + ":" + file],
        {encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"]}));
    if (!changed.includes("package-lock.json")) return safe;
    try {
        const normalize = (lock: any) => {
            if (lock.lockfileVersion !== 3 || !lock.packages?.[""]) throw Error("unknown npm lockfile");
            for (const [key, entry] of Object.entries<any>(lock.packages)) {
                if (key.split("/").includes("node_modules")) delete entry.dev;
                else delete entry.dependencies;
            }
            return lock;
        };
        const before = normalize(read(base, "package-lock.json"));
        const after = normalize(read("HEAD", "package-lock.json"));
        if (!isDeepStrictEqual(before, after)) return safe;
        safe.add("package-lock.json");
        for (const file of changed.filter(f => /(^|\/)package\.json$/.test(f))) {
            const workspace = file.split("/").slice(0, -1).join("/");
            if (!Object.hasOwn(after.packages, workspace) || workspace.split("/").includes("node_modules")) continue;
            const a = read(base, file), b = read("HEAD", file);
            delete a.dependencies;
            delete b.dependencies;
            if (isDeepStrictEqual(a, b)) safe.add(file);
        }
    } catch { return new Set(); }
    return safe;
}
