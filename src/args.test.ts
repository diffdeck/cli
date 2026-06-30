import {strict as assert} from "node:assert";
import {test} from "node:test";
import {boolOption, parseArgs, stringOption} from "./args";

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
