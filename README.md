# @diffdeckai/cli

The DiffDeck upload CLI — push Storybook builds and Playwright recordings to [DiffDeck](https://diffdeck.ai) from any CI.

It's a small, dependency-light Node/TypeScript CLI. It speaks only HTTP to the DiffDeck ingest API; there's no other runtime dependency (it uses Node's built-in `fetch`, `fs`, and `zlib`).

## Install

Requires **Node 18+**.

```bash
# one-off, no install
npx @diffdeckai/cli upload-storybook --help

# or add to your project
npm install --save-dev @diffdeckai/cli
```

The binary is `diffdeck`.

## Authentication & host

Every command needs a **project token**, sent as the `X-UI-Review-Token` header. Provide it with `--token` or the `DIFFDECK_TOKEN` environment variable.

The DiffDeck host defaults to `https://diffdeck.ai` and can be overridden with `--host` or the `DIFFDECK_HOST` environment variable (useful for self-hosted/enterprise instances).

```bash
export DIFFDECK_TOKEN=ddp_xxxxxxxxxxxxxxxx
export DIFFDECK_HOST=https://diffdeck.ai   # optional
```

## Commands

### `upload-storybook`

Packs a built Storybook directory into a gzip tarball and uploads it for visual review (`POST <host>/api/products/ui-review/builds`).

```bash
diffdeck upload-storybook --dir storybook-static \
  --commit "$GITHUB_SHA" \
  --branch main \
  --message "Fix button padding"
```

| Flag | Description |
| --- | --- |
| `--dir <path>` | Directory of the built Storybook (e.g. `storybook-static`). **Required.** |
| `--commit <sha>` | Git commit SHA. **Required.** |
| `--branch <name>` | Git branch name. Defaults to the repo's default branch server-side. |
| `--message <text>` | Git commit message. Optional. |
| `--token <token>` | Project token. Defaults to `$DIFFDECK_TOKEN`. |
| `--host <url>` | DiffDeck host. Defaults to `$DIFFDECK_HOST` or `https://diffdeck.ai`. |

Build your Storybook first (`npx storybook build` produces `storybook-static/`).

> `upload-storybook` uploads the build only; screenshots are then rendered server-side.
> Prefer **`screenshot-storybook`** below, which renders in CI (no server browser needed)
> and fails the build if a story can't render.

### `screenshot-storybook`

Renders every story in a built Storybook to PNGs **in CI** (six variants each: light/dark ×
phone/tablet/desktop), then uploads the screenshots together with the build
(`POST <host>/api/products/ui-review/builds`). The server does no rendering — it hosts the
build for browsing and diffs the screenshots against the baseline.

A **render-check** runs alongside: if any story fails to render (a thrown error, a non-benign
`console.error`, or Storybook's `#sb-errordisplay` overlay) the command prints a report, exits
non-zero, and uploads nothing — so a broken story fails the CI build.

```bash
npm i -D playwright && npx playwright install chromium   # once, in your project
diffdeck screenshot-storybook --dir storybook-static \
  --commit "$GITHUB_SHA" \
  --branch main \
  --message "Fix button padding"
```

| Flag | Description |
| --- | --- |
| `--dir <path>` | Directory of the built Storybook (e.g. `storybook-static`). **Required.** |
| `--commit <sha>` | Git commit SHA. **Required.** |
| `--branch <name>` | Git branch name. Defaults to the repo's default branch server-side. |
| `--message <text>` | Git commit message. Optional. |
| `--token <token>` | Project token. Defaults to `$DIFFDECK_TOKEN`. |
| `--host <url>` | DiffDeck host. Defaults to `$DIFFDECK_HOST` or `https://diffdeck.ai`. |

**Playwright** (with browsers) must be installed in the project — it's resolved from your
project, not bundled with the CLI, which keeps the CLI dependency-light.

### `upload-recording`

Uploads a single Playwright test recording (video + test metadata) (`POST <host>/api/products/ui-review/recordings`). Your CI runs Playwright itself; this command just uploads the resulting video.

```bash
diffdeck upload-recording --video test-results/home.webm \
  --test "Home page renders" \
  --file "tests/home.spec.ts" \
  --status passed \
  --duration 1840 \
  --retries 0 \
  --commit "$GITHUB_SHA" \
  --branch main
```

| Flag | Description |
| --- | --- |
| `--video <path>` | Recorded video file (`.webm`/`.mp4`/…). **Required.** |
| `--test <title>` | Test title. |
| `--file <path>` | Test file path. |
| `--test-id <id>` | Stable test identifier. |
| `--status <status>` | Test status (`passed`, `failed`, `skipped`, …). |
| `--duration <ms>` | Test duration in milliseconds. |
| `--retries <n>` | Number of retries. |
| `--metadata <json>` | Extra metadata as a JSON string. |
| `--branch <name>` | Git branch name. |
| `--commit <sha>` | Git commit SHA. |
| `--token <token>` | Project token. Defaults to `$DIFFDECK_TOKEN`. |
| `--host <url>` | DiffDeck host. Defaults to `$DIFFDECK_HOST` or `https://diffdeck.ai`. |

> Recordings are a separately-priced add-on. If they're not enabled for your repository, the upload is rejected with `HTTP 402` and the CLI prints a clear message.

Run `diffdeck <command> --help` for the full per-command help, and `diffdeck --version` for the version.

## CI examples

### GitHub Actions

```yaml
name: DiffDeck
on: [push]
jobs:
  storybook:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npx storybook build -o storybook-static
      - run: npx @diffdeckai/cli upload-storybook
              --dir storybook-static
              --commit "$GITHUB_SHA"
              --branch "${GITHUB_REF_NAME}"
              --message "$(git log -1 --pretty=%s)"
        env:
          DIFFDECK_TOKEN: ${{ secrets.DIFFDECK_TOKEN }}
```

### GitLab CI

```yaml
diffdeck-storybook:
  image: node:20
  script:
    - npm ci
    - npx storybook build -o storybook-static
    - npx @diffdeckai/cli upload-storybook
        --dir storybook-static
        --commit "$CI_COMMIT_SHA"
        --branch "$CI_COMMIT_REF_NAME"
        --message "$CI_COMMIT_TITLE"
  variables:
    DIFFDECK_TOKEN: $DIFFDECK_TOKEN
```

### CircleCI

```yaml
version: 2.1
jobs:
  diffdeck:
    docker:
      - image: cimg/node:20.11
    steps:
      - checkout
      - run: npm ci
      - run: npx storybook build -o storybook-static
      - run: >
          npx @diffdeckai/cli upload-storybook
          --dir storybook-static
          --commit "$CIRCLE_SHA1"
          --branch "$CIRCLE_BRANCH"
workflows:
  build:
    jobs:
      - diffdeck:
          context: diffdeck   # provides DIFFDECK_TOKEN
```

### Uploading a recording from CI

```bash
# after Playwright runs and produced a video at test-results/home.webm
npx @diffdeckai/cli upload-recording \
  --video test-results/home.webm \
  --test "Home page renders" \
  --file "tests/home.spec.ts" \
  --status passed \
  --commit "$GITHUB_SHA" \
  --branch "$GITHUB_REF_NAME"
```

## Development

```bash
npm install
npm run build       # tsc → dist/
npm test            # build + node --test
node dist/cli.js --help
```

## License

[MIT](./LICENSE)
