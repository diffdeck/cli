import {strict as assert} from "node:assert";
import {test} from "node:test";
import {buildFormData, buildUrl, errorMessage} from "./http";

test("buildUrl joins host and path, tolerating slashes", () => {
    assert.equal(buildUrl("https://h.dev", "/api/x"), "https://h.dev/api/x");
    assert.equal(buildUrl("https://h.dev/", "api/x"), "https://h.dev/api/x");
    assert.equal(buildUrl("https://h.dev//", "/api/x"), "https://h.dev/api/x");
});

test("buildFormData skips null/undefined fields and attaches files", async () => {
    const form = buildFormData(
        {branch: "main", commitSha: "abc", commitMessage: undefined, retries: 2},
        [{field: "build", data: Buffer.from("hello"), filename: "b.tar.gz", contentType: "application/gzip"}],
    );

    assert.equal(form.get("branch"), "main");
    assert.equal(form.get("commitSha"), "abc");
    assert.equal(form.get("retries"), "2");
    assert.equal(form.has("commitMessage"), false);

    const file = form.get("build");
    assert.ok(file instanceof Blob, "build should be a Blob");
    assert.equal((file as File).name, "b.tar.gz");
    assert.equal(await (file as Blob).text(), "hello");
});

test("errorMessage prefers JSON error, then text", () => {
    assert.equal(errorMessage({status: 400, ok: false, json: {error: "boom"}, text: "{...}"}), "boom");
    assert.equal(errorMessage({status: 500, ok: false, text: "raw failure"}), "raw failure");
    assert.equal(errorMessage({status: 502, ok: false, text: ""}), "HTTP 502");
});
