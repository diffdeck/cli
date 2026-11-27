import {strict as assert} from "node:assert";
import {test} from "node:test";
import {execFileSync} from "node:child_process";
import {mkdtempSync, writeFileSync, rmSync} from "node:fs";
import path from "node:path";
import {tmpdir} from "node:os";
import {metadataOnly} from "./npmMetadata";

test("npm declarations with identical installs are traceable, a changed resolution is global", t => {
    const cwd = process.cwd();
    const dir = mkdtempSync(path.join(tmpdir(), "dd-lock-"));
    process.chdir(dir);
    t.after(() => { process.chdir(cwd); rmSync(dir, {recursive: true, force: true}); });
    const git = (...args: string[]) => execFileSync("git", args, {encoding: "utf8"}).trim();
    const save = (version: string, added: boolean) => {
        const manifest = {dependencies: added ? {lib: "*"} : {}};
        writeFileSync("package.json", JSON.stringify(manifest));
        writeFileSync("package-lock.json", JSON.stringify({lockfileVersion: 3, packages: {
            "": manifest, "node_modules/lib": {version, dev: added ? undefined : true},
        }}));
        git("add", ".");
        git("-c", "user.name=test", "-c", "user.email=test@example.org", "commit", "-qm", "fixture");
    };
    git("init", "-q");
    save("1.0.0", false);
    const base = git("rev-parse", "HEAD");
    const changed = ["package-lock.json", "package.json"];
    save("1.0.0", true);
    assert.deepEqual([...metadataOnly(base, changed)], changed);
    save("2.0.0", true);
    assert.equal(metadataOnly(base, changed).size, 0);
});
