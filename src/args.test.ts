import {strict as assert} from "node:assert";
import {test} from "node:test";
import {boolOption, parseArgs, productOption, stringOption} from "./args";

test("parses --key value, --key=value and positionals", () => {
    const parsed = parseArgs(["upload-storybook", "--dir", "out", "--commit=abc123", "--help"], ["help"]);
    assert.equal(parsed.command, "upload-storybook");
    assert.equal(parsed.options.dir, "out");
    assert.equal(parsed.options.commit, "abc123");
    assert.equal(parsed.options.help, true);
});

test("a flag followed by another flag becomes boolean true", () => {
    const parsed = parseArgs(["--message", "--commit", "abc"]);
    assert.equal(parsed.options.message, true);
    assert.equal(parsed.options.commit, "abc");
});

test("stringOption falls through aliases, env var, then default", () => {
    assert.equal(stringOption({host: "h1"}, ["host"]), "h1");

    const prev = process.env.MY_HOST;
    process.env.MY_HOST = "envhost";
    assert.equal(stringOption({}, ["host"], "MY_HOST"), "envhost");
    if (prev === undefined) delete process.env.MY_HOST;
    else process.env.MY_HOST = prev;

    assert.equal(stringOption({}, ["host"], "UNSET_VAR_XYZ", "fallback"), "fallback");
});

test("boolOption detects presence across aliases", () => {
    assert.equal(boolOption({help: true}, ["help", "h"]), true);
    assert.equal(boolOption({h: true}, ["help", "h"]), true);
    assert.equal(boolOption({}, ["help", "h"]), false);
});

test("productOption reads --product / $DIFFDECK_PRODUCT, normalizes and validates", () => {
    const prev = process.env.DIFFDECK_PRODUCT;
    delete process.env.DIFFDECK_PRODUCT;
    try {
        assert.deepEqual(productOption({}), {});
        assert.deepEqual(productOption({product: " My-App "}), {key: "my-app"});
        assert.deepEqual(productOption({product: "web.admin_2"}), {key: "web.admin_2"});
        assert.ok(productOption({product: "-bad"}).error);
        assert.ok(productOption({product: "has space"}).error);
        assert.ok(productOption({product: "x".repeat(65)}).error);

        process.env.DIFFDECK_PRODUCT = "from-env";
        assert.deepEqual(productOption({}), {key: "from-env"});
        assert.deepEqual(productOption({product: "flag-wins"}), {key: "flag-wins"});
    } finally {
        if (prev === undefined) delete process.env.DIFFDECK_PRODUCT;
        else process.env.DIFFDECK_PRODUCT = prev;
    }
});
