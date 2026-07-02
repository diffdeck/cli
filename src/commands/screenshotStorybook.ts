/**
 * `diffdeck screenshot-storybook` — render every story in a built Storybook to
 * PNGs in CI (where a browser is available) and upload them, together with the
 * build tarball, to the DiffDeck builds ingest route. The server does NO
 * rendering; it only hosts the build for browsing and diffs the screenshots.
 *
 * For each story we capture six variants — two colour schemes (light/dark, via
 * `prefers-color-scheme` emulation) × three device viewports (phone/tablet/
 * desktop). A render-check runs alongside: if any story fails to render (a thrown
 * error, a console error, or Storybook's `#sb-errordisplay` overlay) the command
 * exits non-zero with a clear report and uploads nothing — so a broken story fails
 * the CI build.
 *
 * Playwright is required at runtime and resolved from the consumer's project
 * (`process.cwd()`), so the CLI stays dependency-light. The consumer must have
 * `playwright` installed with its browsers (`npx playwright install chromium`).
 *
 * Target: POST <host>/api/products/ui-review/builds
 * Fields: build (tarball), branch, commitSha, commitMessage, screenshots (JSON
 *         manifest), plus one PNG form field per screenshot (shot0, shot1, …).
 */
import http from "node:http";
import os from "node:os";
import {promises as fsp, readFileSync} from "node:fs";
import path from "node:path";
import {createRequire} from "node:module";
import {boolOption, ParsedArgs, stringOption} from "../args";
import {DEFAULT_HOST, errorMessage, uploadMultipart, UploadFile} from "../http";
import {createTarGz, countFiles} from "../tar";

export const BUILDS_PATH = "/api/products/ui-review/builds";

// The six-variant matrix — must match the server/product constants
// (src/shared/products/ui-review/constants.ts).
const THEMES = ["light", "dark"] as const;
type Theme = (typeof THEMES)[number];
const DEVICE_VIEWPORTS: Record<string, {width: number; height: number}> = {
    phone: {width: 390, height: 844},
    tablet: {width: 820, height: 1180},
    desktop: {width: 1440, height: 900},
};
const DEVICES = Object.keys(DEVICE_VIEWPORTS);

const NAV_TIMEOUT_MS = 30_000;
// Freeze animations/transitions and hide carets so screenshots are deterministic.
const STABILIZE_CSS =
    "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}";

// A failed data fetch to /api/* (a static Storybook host has no backend) logs a
// console.error but the component still renders its empty/error state — that is
// NOT a render failure. Only thrown errors / the error overlay count.
const BENIGN_CONSOLE =
    /Failed to fetch|API error|WebSocket|initial fetch failed|net::ERR|Not Found|is not valid JSON|status of 404|Failed to load resource|favicon/i;

export const SCREENSHOT_HELP = `diffdeck screenshot-storybook — render + upload Storybook screenshots for visual review

Usage:
  diffdeck screenshot-storybook --dir <storybook-static> [options]

Options:
  --dir <path>          Directory of the built Storybook (e.g. storybook-static). Required.
  --branch <name>       Git branch name. Defaults to the repo's default branch server-side.
  --commit <sha>        Git commit SHA. Required.
  --message <text>      Git commit message (optional).
  --concurrency <n>     Parallel render workers (default: ~3× CPU count, capped 4–16). Alias: --jobs/-j.
  --locale <tag>        Browser locale (default: en-US). Fixes Intl throwing in locale-less CI.
  --timezone <tz>       Browser timezone (default: UTC). Alias: --tz.
  --settle <ms>         Wait after render before screenshot (default: 500).
  --token <token>       Project token. Defaults to $DIFFDECK_TOKEN.
  --host <url>          DiffDeck host. Defaults to $DIFFDECK_HOST or ${DEFAULT_HOST}.
  --help                Show this help.

Requires Playwright (with browsers) installed in the current project:
  npm i -D playwright && npx playwright install chromium

Environment:
  DIFFDECK_TOKEN        Project token (X-UI-Review-Token).
  DIFFDECK_HOST         DiffDeck host URL.`;

interface Story {
    id: string;
    title: string;
    name: string;
}

interface Shot {
    story: Story;
    theme: Theme;
    device: string;
    width: number;
    height: number;
    png: Buffer;
}

interface RenderFailure {
    id: string;
    variant: string;
    errors: string[];
}

function readJsonSafe(file: string): any {
    try {
        return JSON.parse(readFileSync(file, "utf8"));
    } catch {
        return null;
    }
}

function fromEntries(map: Record<string, any> | undefined): Story[] {
    if (!map) return [];
    return Object.values(map)
        .filter((e: any) => (e?.type ? e.type === "story" : true))
        .map((e: any) => ({
            id: String(e.id),
            title: String(e.title ?? e.kind ?? ""),
            name: String(e.name ?? e.story ?? ""),
        }))
        .filter((e) => e.id);
}

/** Storybook 7+ writes index.json ({entries}); Storybook 6 writes stories.json ({stories}). */
function enumerateStories(dir: string): Story[] {
    const index = readJsonSafe(path.join(dir, "index.json"));
    const fromIndex = fromEntries(index?.entries);
    if (fromIndex.length) return fromIndex;
    const legacy = readJsonSafe(path.join(dir, "stories.json"));
    return fromEntries(legacy?.stories);
}

const MIME: Record<string, string> = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".json": "application/json",
    ".css": "text/css",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".map": "application/json",
};

/** Minimal static file server rooted at `dir`, bound to a random loopback port. */
function serveDir(dir: string): Promise<{origin: string; close: () => Promise<void>}> {
    const root = path.resolve(dir);
    const server = http.createServer((req, res) => {
        const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
        const rel = urlPath === "/" ? "/index.html" : urlPath;
        const filePath = path.join(root, path.normalize(rel));
        if (!filePath.startsWith(root)) {
            res.writeHead(403).end();
            return;
        }
        fsp.readFile(filePath).then(
            (data) => {
                res.writeHead(200, {"content-type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream"});
                res.end(data);
            },
            () => res.writeHead(404).end("Not found"),
        );
    });
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const {port} = server.address() as {port: number};
            resolve({
                origin: `http://127.0.0.1:${port}`,
                close: () => new Promise<void>((r) => server.close(() => r())),
            });
        });
    });
}

/** Resolve Playwright's chromium from the consumer's project (not the CLI's). */
function resolveChromium(): any | null {
    try {
        const req = createRequire(path.join(process.cwd(), "diffdeck-cli-resolver.js"));
        return req("playwright").chromium;
    } catch {
        return null;
    }
}

/**
 * Wait for Storybook's preview channel and install listeners that record the
 * outcome of the most recent render on `window.__dd`. Lets a worker switch
 * stories in-page (no bundle reload per story). Returns false if the channel
 * isn't available (SB version mismatch) so the caller can fall back to navigation.
 */
async function installStoryChannel(page: any): Promise<boolean> {
    try {
        await page.waitForFunction(
            () => {
                const g = globalThis as any;
                return !!((g.__STORYBOOK_PREVIEW__ && g.__STORYBOOK_PREVIEW__.channel) || g.__STORYBOOK_ADDONS_CHANNEL__);
            },
            undefined,
            {timeout: 10_000},
        );
    } catch {
        return false;
    }
    return await page.evaluate(() => {
        const g = globalThis as any;
        const channel = (g.__STORYBOOK_PREVIEW__ && g.__STORYBOOK_PREVIEW__.channel) || g.__STORYBOOK_ADDONS_CHANNEL__;
        if (!channel || typeof channel.emit !== "function" || typeof channel.on !== "function") return false;
        if (g.__dd && g.__dd.installed) return true;
        g.__dd = {channel, result: null, installed: true};
        const ok = (id: any) => {
            g.__dd.result = {status: "ok", id: typeof id === "string" ? id : (id && id.storyId) || null};
        };
        channel.on("storyRendered", ok);
        channel.on("docsRendered", ok);
        channel.on("storyMissing", () => (g.__dd.result = {status: "error", reason: "storyMissing"}));
        channel.on("storyThrewException", (e: any) => (g.__dd.result = {status: "error", reason: "threw: " + String((e && e.message) || e).slice(0, 200)}));
        channel.on("storyErrored", (e: any) => (g.__dd.result = {status: "error", reason: "errored: " + String((e && (e.description || e.message)) || e).slice(0, 200)}));
        channel.on("playFunctionThrewException", (e: any) => (g.__dd.result = {status: "error", reason: "play: " + String((e && e.message) || e).slice(0, 200)}));
        return true;
    });
}

/**
 * Switch the already-loaded preview to `storyId` in-page and wait for it to
 * render. Returns an error string on failure/timeout, else null.
 */
async function switchStory(page: any, storyId: string): Promise<string | null> {
    await page.evaluate((id: string) => {
        const g = globalThis as any;
        g.__dd.result = null;
        g.__dd.channel.emit("setCurrentStory", {storyId: id, viewMode: "story"});
    }, storyId);
    try {
        const handle = await page.waitForFunction(() => (globalThis as any).__dd.result, undefined, {timeout: NAV_TIMEOUT_MS});
        const r = await handle.jsonValue();
        return r && r.status === "error" ? r.reason || "story error" : null;
    } catch {
        return "render timeout";
    }
}

export async function runScreenshotStorybook(parsed: ParsedArgs): Promise<number> {
    if (boolOption(parsed.options, ["help", "h"])) {
        console.log(SCREENSHOT_HELP);
        return 0;
    }

    const dir = stringOption(parsed.options, ["dir", "d"]);
    const token = stringOption(parsed.options, ["token", "t"], "DIFFDECK_TOKEN");
    const host = stringOption(parsed.options, ["host"], "DIFFDECK_HOST", DEFAULT_HOST)!;
    const branch = stringOption(parsed.options, ["branch", "b"]);
    const commitSha = stringOption(parsed.options, ["commit", "commit-sha", "commitSha", "c"]);
    const commitMessage = stringOption(parsed.options, ["message", "commit-message", "m"]);
    // Rendering is largely idle-wait (navigation + settle), so we oversubscribe
    // cores: concurrent pages far exceed the core count profitably.
    const cpuCount = os.cpus()?.length || 4;
    const defaultConcurrency = Math.max(4, Math.min(cpuCount * 3, 16));
    const concurrencyRaw = Number(stringOption(parsed.options, ["concurrency", "jobs", "j"]));
    const concurrency = Number.isFinite(concurrencyRaw) && concurrencyRaw > 0 ? Math.floor(concurrencyRaw) : defaultConcurrency;
    // Headless Chromium in a CI sandbox with no system locale (LC_CTYPE=POSIX)
    // otherwise resolves Intl's default to the invalid tag "en-US@posix", making
    // every Intl/toLocale* call throw — a pageerror on every story. Pin both.
    const locale = stringOption(parsed.options, ["locale"]) || "en-US";
    const timezone = stringOption(parsed.options, ["timezone", "tz"]) || "UTC";
    const settleRaw = Number(stringOption(parsed.options, ["settle", "settle-ms"]));
    const settleMs = Number.isFinite(settleRaw) && settleRaw >= 0 ? Math.floor(settleRaw) : 500;

    if (!dir) {
        console.error("Error: --dir <storybook-static> is required.");
        return 2;
    }
    if (!token) {
        console.error("Error: a project token is required (--token or $DIFFDECK_TOKEN).");
        return 2;
    }
    if (!commitSha) {
        console.error("Error: --commit <sha> is required.");
        return 2;
    }

    const stories = enumerateStories(dir);
    console.error(`Found ${stories.length} story(ies) in ${dir}.`);

    const chromium = resolveChromium();
    if (!chromium) {
        console.error(
            "Error: Playwright is required for screenshot-storybook but could not be resolved from this project.\n" +
                "Install it in your project first:  npm i -D playwright && npx playwright install chromium",
        );
        return 2;
    }

    const shots: Shot[] = [];
    const failures: RenderFailure[] = [];

    // Persistent workers with in-page story switching. A worker is pinned to one
    // (theme, device) lane, so it loads Storybook ONCE and then switches stories
    // via the preview channel — no per-story bundle reload, which is the dominant
    // cost. Each lane is split into chunks so ~`concurrency` pages run at once;
    // total Storybook boots ≈ number of chunks, not number of variants.
    const lanes: {theme: Theme; device: string}[] = [];
    for (const theme of THEMES) for (const device of DEVICES) lanes.push({theme, device});
    const chunksPerLane = Math.max(1, Math.round(concurrency / lanes.length));
    const chunkSize = Math.max(1, Math.ceil(stories.length / chunksPerLane));
    const chunks: {theme: Theme; device: string; stories: Story[]}[] = [];
    for (const lane of lanes)
        for (let i = 0; i < stories.length; i += chunkSize)
            chunks.push({theme: lane.theme, device: lane.device, stories: stories.slice(i, i + chunkSize)});

    const total = stories.length * lanes.length;
    const t0 = Date.now();
    const workerCount = Math.max(1, Math.min(concurrency, chunks.length || 1));
    console.error(
        `Rendering ${total} variant(s) — ${stories.length} story(ies) × ${THEMES.length} theme(s) × ${DEVICES.length} device(s) — ` +
            `with ${workerCount} parallel worker(s), in-page switching...`,
    );

    let done = 0;
    let lastBeat = Date.now();
    const logProgress = (ok: boolean, theme: string, device: string, id: string) => {
        done++;
        const elapsed = (Date.now() - t0) / 1000;
        const rate = done / Math.max(elapsed, 0.001);
        const eta = rate > 0 ? (total - done) / rate : 0;
        const beat = done === total || Date.now() - lastBeat > 2000;
        console.error(
            `  [${String(done).padStart(String(total).length)}/${total}] ${ok ? "✓" : "✗"} ${theme}/${device} ${id}` +
                (beat ? `  (${elapsed.toFixed(0)}s, ~${eta.toFixed(0)}s left)` : ""),
        );
        if (beat) lastBeat = Date.now();
    };

    // Only a VISIBLE #sb-errordisplay counts — Storybook keeps a hidden copy in the DOM.
    const readOverlay = (page: any): Promise<string | null> =>
        page.evaluate(() => {
            const g = globalThis as any;
            const d = g.document;
            const el = d.querySelector("#sb-errordisplay, .sb-errordisplay");
            if (!el) return null;
            const visible = el.offsetParent !== null || g.getComputedStyle(el).display !== "none";
            if (!visible) return null;
            const m = d.querySelector("#error-message, .sb-errordisplay_emphasize");
            return String(m?.textContent || el.textContent || "story error").trim().slice(0, 300);
        });

    const site = await serveDir(dir);
    let browser: any;
    try {
        browser = await chromium.launch({headless: true});
        let nextChunk = 0;
        const worker = async (): Promise<void> => {
            for (;;) {
                const ci = nextChunk++;
                if (ci >= chunks.length) break;
                const chunk = chunks[ci];
                const viewport = DEVICE_VIEWPORTS[chunk.device];
                // Lane-fixed colour scheme (via context) + viewport, set once.
                const context = await browser.newContext({
                    deviceScaleFactor: 1,
                    locale,
                    timezoneId: timezone,
                    colorScheme: chunk.theme,
                });
                let currentErrors: string[] = [];
                const page = await context.newPage();
                page.on("pageerror", (e: any) => currentErrors.push("pageerror: " + String(e?.message || e).split("\n")[0]));
                page.on("console", (m: any) => {
                    if (m.type() === "error") {
                        const t = m.text();
                        if (!BENIGN_CONSOLE.test(t)) currentErrors.push("console.error: " + t.split("\n")[0].slice(0, 300));
                    }
                });
                let channelReady = false;
                try {
                    await page.setViewportSize(viewport);
                    for (let idx = 0; idx < chunk.stories.length; idx++) {
                        const story = chunk.stories[idx];
                        currentErrors = [];
                        let chanErr: string | null = null;
                        try {
                            if (idx === 0) {
                                // First story: full navigation (loads the bundle once).
                                const url = `${site.origin}/iframe.html?id=${encodeURIComponent(story.id)}&viewMode=story`;
                                await page.goto(url, {waitUntil: "load", timeout: NAV_TIMEOUT_MS});
                                await page.waitForSelector("#storybook-root, #root", {timeout: NAV_TIMEOUT_MS}).catch(() => {});
                                await page.addStyleTag({content: STABILIZE_CSS}).catch(() => {});
                                channelReady = await installStoryChannel(page);
                            } else if (channelReady) {
                                // Subsequent stories: switch in-page via the channel.
                                chanErr = await switchStory(page, story.id);
                            } else {
                                // Fallback (no channel): navigate per story, reusing the page.
                                const url = `${site.origin}/iframe.html?id=${encodeURIComponent(story.id)}&viewMode=story`;
                                await page.goto(url, {waitUntil: "load", timeout: NAV_TIMEOUT_MS});
                                await page.waitForSelector("#storybook-root, #root", {timeout: NAV_TIMEOUT_MS}).catch(() => {});
                            }
                            await page.waitForTimeout(settleMs);
                            const overlay = await readOverlay(page);
                            const errs = [...currentErrors];
                            if (chanErr) errs.push(chanErr);
                            if (overlay) errs.push("sb-errordisplay: " + overlay);
                            if (errs.length === 0) {
                                const png = (await page.screenshot({type: "png", fullPage: false})) as Buffer;
                                shots.push({story, theme: chunk.theme, device: chunk.device, width: viewport.width, height: viewport.height, png});
                                logProgress(true, chunk.theme, chunk.device, story.id);
                            } else {
                                failures.push({id: story.id, variant: `${chunk.theme}/${chunk.device}`, errors: [...new Set(errs)]});
                                logProgress(false, chunk.theme, chunk.device, story.id);
                            }
                        } catch (err: any) {
                            failures.push({
                                id: story.id,
                                variant: `${chunk.theme}/${chunk.device}`,
                                errors: ["render: " + String(err?.message || err).split("\n")[0]],
                            });
                            logProgress(false, chunk.theme, chunk.device, story.id);
                        }
                    }
                } finally {
                    await context.close().catch(() => {});
                }
            }
        };
        await Promise.all(Array.from({length: workerCount}, () => worker()));
    } finally {
        if (browser) await browser.close().catch(() => {});
        await site.close();
    }

    // Render-check: any story that failed to render completely fails the build.
    if (failures.length) {
        console.error(`\n✗ ${failures.length} story variant(s) failed to render — not uploading:\n`);
        for (const f of failures) {
            console.error(`  ✗ ${f.id} [${f.variant}]`);
            for (const e of f.errors) console.error(`      ${e}`);
        }
        console.error("\nFix the failing stories above, then re-run.");
        return 1;
    }

    console.error(
        `Rendered ${shots.length} screenshot(s) across ${stories.length} story(ies) in ${((Date.now() - t0) / 1000).toFixed(1)}s.`,
    );

    // Pack the build (for hosted browsing) + attach one PNG per screenshot.
    let tarball: Buffer;
    try {
        const fileCount = await countFiles(dir);
        console.error(`Packing ${fileCount} file(s) from ${dir} ...`);
        tarball = await createTarGz(dir);
    } catch (e: any) {
        console.error(`Error: failed to pack ${dir}: ${e?.message ?? e}`);
        return 1;
    }

    const files: UploadFile[] = [
        {field: "build", data: tarball, filename: "storybook-build.tar.gz", contentType: "application/gzip"},
    ];
    const manifest = shots.map((s, i) => {
        const field = `shot${i}`;
        files.push({field, data: s.png, filename: `${field}.png`, contentType: "image/png"});
        return {
            field,
            storyId: s.story.id,
            storyTitle: s.story.title,
            storyName: s.story.name,
            theme: s.theme,
            device: s.device,
            width: s.width,
            height: s.height,
        };
    });

    const totalMb = files.reduce((n, f) => n + f.data.length, 0) / 1024 / 1024;
    console.error(`Uploading build + ${shots.length} screenshot(s) (${totalMb.toFixed(2)} MB) to ${host} ...`);

    const result = await uploadMultipart({
        host,
        pathname: BUILDS_PATH,
        token,
        fields: {branch, commitSha, commitMessage, screenshots: JSON.stringify(manifest)},
        files,
    });

    if (!result.ok) {
        console.error(`Error: build upload failed (HTTP ${result.status}): ${errorMessage(result)}`);
        return 1;
    }

    const {buildId, number, url} = result.json ?? {};
    console.log(`Build uploaded${number != null ? ` (#${number})` : ""}.`);
    if (buildId) console.log(`  buildId: ${buildId}`);
    if (url) console.log(`  view:    ${url}`);
    return 0;
}
