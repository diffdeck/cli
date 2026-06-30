import {strict as assert} from "node:assert";
import {test} from "node:test";
import {gunzipSync} from "node:zlib";
import {promises as fs} from "node:fs";
import os from "node:os";
import path from "node:path";
import {countFiles, createTarGz} from "./tar";

async function makeFixture(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "diffdeck-tar-"));
    await fs.writeFile(path.join(dir, "index.html"), "<html></html>");
    await fs.mkdir(path.join(dir, "assets"));
    await fs.writeFile(path.join(dir, "assets", "app.js"), "console.log(1)");
    return dir;
}

test("createTarGz produces a valid gzip tar containing the files", async () => {
    const dir = await makeFixture();
    try {
        assert.equal(await countFiles(dir), 2);

        const gz = await createTarGz(dir);
        const tar = gunzipSync(gz);

        // gzip magic.
        assert.equal(gz[0], 0x1f);
        assert.equal(gz[1], 0x8b);

        // Tar size is a multiple of the 512-byte block.
        assert.equal(tar.length % 512, 0);

        // First entry header name (sorted: "assets/app.js" before "index.html").
        const firstName = tar.toString("utf8", 0, 13);
        assert.equal(firstName, "assets/app.js");

        // ustar magic at offset 257.
        assert.equal(tar.toString("ascii", 257, 262), "ustar");

        // The archive references both files somewhere in the header blocks.
        const whole = tar.toString("binary");
        assert.ok(whole.includes("index.html"));
        assert.ok(whole.includes("assets/app.js"));
    } finally {
        await fs.rm(dir, {recursive: true, force: true});
    }
});

test("createTarGz rejects an empty directory", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "diffdeck-empty-"));
    try {
        await assert.rejects(() => createTarGz(dir), /empty/i);
    } finally {
        await fs.rm(dir, {recursive: true, force: true});
    }
});
