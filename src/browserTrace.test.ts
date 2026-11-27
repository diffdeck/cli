import {strict as assert} from "node:assert";
import {test} from "node:test";
import {mkdtemp, writeFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {recordRequest, AssetHashes, compare, Snapshot} from "./browserTrace";

test("baseline browser assets scope generated output, missing assets and new stories", async t => {
    const dir = await mkdtemp(path.join(tmpdir(), "dd-assets"));
    t.after(() => rm(dir, {recursive: true, force: true}));
    await writeFile(path.join(dir, "iframe.html"), "base");
    const assets = new AssetHashes(dir);
    await assets.get("iframe.html");
    await assets.get("photo.png");
    const snapshot: Snapshot = {version: 1, settings: "chromium", hashes: assets.values, groups: [
        {ids: ["photo"], paths: ["iframe.html", "photo.png"], external: false},
        {ids: ["button"], paths: ["iframe.html"], external: false},
    ]};
    const ids = ["photo", "button", "new"];
    assert.deepEqual(await compare(snapshot, "chromium", ids, new AssetHashes(dir)), ["new"]);
    await writeFile(path.join(dir, "photo.png"), "now present");
    assert.deepEqual(await compare(snapshot, "chromium", ids, new AssetHashes(dir)), ["photo", "new"]);
    await writeFile(path.join(dir, "iframe.html"), "new preview");
    assert.deepEqual(await compare(snapshot, "chromium", ids, new AssetHashes(dir)), ids);
    await assert.rejects(compare(snapshot, "other", ids, assets), /settings changed/);
    const many = Array.from({length: 100}, (_, i) => String(i));
    await assert.rejects(compare({...snapshot, groups: [{ids: many, paths: [], external: true}]}, "chromium", many, assets), /90%/);
});

test("record only local request paths and mark external or untraceable input", () => {
    const paths = new Set<string>();
    assert.ok(recordRequest("http://localhost:345/a%20b.svg?v=1", "http://localhost:345", paths));
    assert.ok(!recordRequest("https://fonts.example/x", "http://localhost:345", paths));
    assert.deepEqual([...paths], ["a b.svg"]);
});

test("a conflict in one capture lane invalidates all inherited lanes for that story", async () => {
    const {carryGroups, matchingSnapshot} = await import("./browserTrace");
    const prior: Snapshot = {version: 1, settings: "same", hashes: {font: "a", css: "b"}, groups: [
        {ids: ["a", "b"], paths: ["css"], external: false},
        {ids: ["a"], paths: ["font"], external: false},
    ]};
    assert.ok(matchingSnapshot(prior, "same"));
    assert.ok(!matchingSnapshot({...prior, hashes: {}}, "same"));
    const hashes = {font: "c"};
    assert.deepEqual(carryGroups(prior, new Set(["a", "b"]), hashes), [{ids: ["b"], paths: ["css"], external: false}]);
    assert.deepEqual(hashes, {font: "c", css: "b"});
});
