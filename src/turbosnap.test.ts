import {strict as assert} from "node:assert";
import {test} from "node:test";
import {writeFileSync, mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {normalizeModuleName, traceAffectedStories} from "./turbosnap";

test("normalizeModuleName strips loaders, concat suffix, query/hash and ./", () => {
    assert.equal(normalizeModuleName("./src/Button.tsx"), "src/Button.tsx");
    assert.equal(normalizeModuleName("./src/Button.tsx?ngResource"), "src/Button.tsx");
    assert.equal(normalizeModuleName("./src/Button.tsx#foo"), "src/Button.tsx");
    assert.equal(normalizeModuleName("./src/Foo.tsx + 3 modules"), "src/Foo.tsx");
    assert.equal(
        normalizeModuleName("./node_modules/css-loader/dist/cjs.js!./src/a.css"),
        "src/a.css",
    );
    assert.equal(normalizeModuleName("src\\win\\path.tsx"), "src/win/path.tsx");
});

// A tiny synthetic webpack graph:
//   Button.tsx  ← imported by Button.stories.tsx AND Card.tsx
//   Card.tsx    ← imported by Card.stories.tsx
//   unrelated.ts is in the bundle but nothing imports it and it's not a story.
function writeStats(): string {
    const stats = {
        modules: [
            {name: "./src/Button.tsx", reasons: [{moduleName: "./stories/Button.stories.tsx"}, {moduleName: "./src/Card.tsx"}]},
            {name: "./src/Card.tsx", reasons: [{moduleName: "./stories/Card.stories.tsx"}]},
            {name: "./stories/Button.stories.tsx", reasons: [{moduleName: "./.storybook/generated-entry.js"}]},
            {name: "./stories/Card.stories.tsx", reasons: [{moduleName: "./.storybook/generated-entry.js"}]},
            {name: "./src/unrelated.ts", reasons: []},
        ],
    };
    const dir = mkdtempSync(path.join(tmpdir(), "dd-stats-"));
    const p = path.join(dir, "preview-stats.json");
    writeFileSync(p, JSON.stringify(stats));
    return p;
}

const STORIES = [
    {id: "button--primary", importPath: "./stories/Button.stories.tsx"},
    {id: "card--default", importPath: "./stories/Card.stories.tsx"},
];

test("changing a shared component affects every dependent story", () => {
    const r = traceAffectedStories({statsPath: writeStats(), changedFiles: ["src/Button.tsx"], stories: STORIES});
    assert.equal(r.full, false);
    assert.deepEqual([...r.affectedStoryIds].sort(), ["button--primary", "card--default"]);
});

test("changing a leaf component affects only its story", () => {
    const r = traceAffectedStories({statsPath: writeStats(), changedFiles: ["src/Card.tsx"], stories: STORIES});
    assert.equal(r.full, false);
    assert.deepEqual(r.affectedStoryIds, ["card--default"]);
});

test("a changed bundle file with no dependent stories affects nothing", () => {
    const r = traceAffectedStories({statsPath: writeStats(), changedFiles: ["src/unrelated.ts"], stories: STORIES});
    assert.equal(r.full, false);
    assert.deepEqual(r.affectedStoryIds, []);
});

test("a changed file not in the bundle affects nothing (no full render)", () => {
    const r = traceAffectedStories({statsPath: writeStats(), changedFiles: ["docs/README.md"], stories: STORIES});
    assert.equal(r.full, false);
    assert.deepEqual(r.affectedStoryIds, []);
});

test("no changed files → nothing affected", () => {
    const r = traceAffectedStories({statsPath: writeStats(), changedFiles: [], stories: STORIES});
    assert.equal(r.full, false);
    assert.deepEqual(r.affectedStoryIds, []);
});

test("a global file (lockfile) forces a full render", () => {
    const r = traceAffectedStories({statsPath: writeStats(), changedFiles: ["package-lock.json"], stories: STORIES});
    assert.equal(r.full, true);
});

test("a .storybook change forces a full render", () => {
    const r = traceAffectedStories({statsPath: writeStats(), changedFiles: [".storybook/preview.ts"], stories: STORIES});
    assert.equal(r.full, true);
});

test("unreadable stats forces a full render", () => {
    const r = traceAffectedStories({statsPath: "/no/such/stats.json", changedFiles: ["src/Button.tsx"], stories: STORIES});
    assert.equal(r.full, true);
});

// A graph where a fixture under .storybook/mocks is imported by exactly one story
// (like kavaro's alamData.ts → Alam.stories.tsx) — the case global-exclude targets.
function writeStatsWithMock(): string {
    const stats = {
        modules: [
            {name: "./.storybook/mocks/alamData.ts", reasons: [{moduleName: "./stories/Alam.stories.tsx"}]},
            {name: "./stories/Alam.stories.tsx", reasons: [{moduleName: "./.storybook/generated-entry.js"}]},
            {name: "./stories/Button.stories.tsx", reasons: [{moduleName: "./.storybook/generated-entry.js"}]},
        ],
    };
    const dir = mkdtempSync(path.join(tmpdir(), "dd-stats-"));
    const p = path.join(dir, "preview-stats.json");
    writeFileSync(p, JSON.stringify(stats));
    return p;
}
const MOCK_STORIES = [
    {id: "alam--default", importPath: "./stories/Alam.stories.tsx"},
    {id: "button--primary", importPath: "./stories/Button.stories.tsx"},
];
const STORYBOOK_MOCKS = [/(^|\/)\.storybook\/mocks\//];

test("without global-exclude, a .storybook/mocks change forces a full render", () => {
    const r = traceAffectedStories({
        statsPath: writeStatsWithMock(),
        changedFiles: [".storybook/mocks/alamData.ts"],
        stories: MOCK_STORIES,
    });
    assert.equal(r.full, true);
});

test("global-exclude scopes a .storybook/mocks change to only its dependent stories", () => {
    const r = traceAffectedStories({
        statsPath: writeStatsWithMock(),
        changedFiles: [".storybook/mocks/alamData.ts"],
        stories: MOCK_STORIES,
        globalExcludePatterns: STORYBOOK_MOCKS,
    });
    assert.equal(r.full, false);
    assert.deepEqual(r.affectedStoryIds, ["alam--default"]);
});

test("global-exclude still full-renders when the excused file isn't in the bundle graph (fail-safe)", () => {
    const r = traceAffectedStories({
        statsPath: writeStatsWithMock(),
        changedFiles: [".storybook/mocks/unbundled.ts"], // matches exclude but not in stats
        stories: MOCK_STORIES,
        globalExcludePatterns: STORYBOOK_MOCKS,
    });
    assert.equal(r.full, true);
});

test("extraGlobalPatterns forces a full render for an otherwise-traceable path", () => {
    const r = traceAffectedStories({
        statsPath: writeStatsWithMock(),
        changedFiles: ["stories/Button.stories.tsx"],
        stories: MOCK_STORIES,
        extraGlobalPatterns: [/(^|\/)stories\//],
    });
    assert.equal(r.full, true);
});
