/**
 * `diffdeck upload-storybook` — gzip-tar a Storybook static build and POST it to the
 * DiffDeck builds ingest route as multipart/form-data.
 *
 * Target: POST <host>/api/products/ui-review/builds
 * Fields: build (tarball), branch, commitSha, commitMessage.
 */
import {boolOption, ParsedArgs, stringOption} from "../args";
import {DEFAULT_HOST, errorMessage, uploadMultipart} from "../http";
import {countFiles, createTarGz} from "../tar";

export const BUILDS_PATH = "/api/products/ui-review/builds";

export const STORYBOOK_HELP = `diffdeck upload-storybook — upload a Storybook static build for visual review

Usage:
  diffdeck upload-storybook --dir <storybook-static> [options]

Options:
  --dir <path>          Directory of the built Storybook (e.g. storybook-static). Required.
  --branch <name>       Git branch name. Defaults to the repo's default branch server-side.
  --commit <sha>        Git commit SHA. Required.
  --message <text>      Git commit message (optional).
  --default-branch <b>  Repository default branch (from CI). Persisted server-side so
                        PR baselines resolve against it.
  --pr-number <n>       Pull request number (from CI). Persisted server-side so the
                        build deep-links straight to the exact PR.
  --token <token>       Project token. Defaults to $DIFFDECK_TOKEN.
  --host <url>          DiffDeck host. Defaults to $DIFFDECK_HOST or ${DEFAULT_HOST}.
  --help                Show this help.

Environment:
  DIFFDECK_TOKEN        Project token (X-UI-Review-Token).
  DIFFDECK_HOST         DiffDeck host URL.`;

export async function runUploadStorybook(parsed: ParsedArgs): Promise<number> {
    if (boolOption(parsed.options, ["help", "h"])) {
        console.log(STORYBOOK_HELP);
        return 0;
    }

    const dir = stringOption(parsed.options, ["dir", "d"]);
    const token = stringOption(parsed.options, ["token", "t"], "DIFFDECK_TOKEN");
    const host = stringOption(parsed.options, ["host"], "DIFFDECK_HOST", DEFAULT_HOST)!;
    const branch = stringOption(parsed.options, ["branch", "b"]);
    const commitSha = stringOption(parsed.options, ["commit", "commit-sha", "commitSha", "c"]);
    const commitMessage = stringOption(parsed.options, ["message", "commit-message", "m"]);
    const defaultBranch = stringOption(parsed.options, ["default-branch", "defaultBranch"]);
    const prNumber = stringOption(parsed.options, ["pr-number", "prNumber"]);

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

    let tarball: Buffer;
    try {
        const fileCount = await countFiles(dir);
        console.error(`Packing ${fileCount} file(s) from ${dir} ...`);
        tarball = await createTarGz(dir);
    } catch (e: any) {
        console.error(`Error: failed to pack ${dir}: ${e?.message ?? e}`);
        return 1;
    }

    console.error(`Uploading build (${(tarball.length / 1024 / 1024).toFixed(2)} MB) to ${host} ...`);

    const result = await uploadMultipart({
        host,
        pathname: BUILDS_PATH,
        token,
        fields: {branch, commitSha, commitMessage, defaultBranch, prNumber},
        files: [
            {
                field: "build",
                data: tarball,
                filename: "storybook-build.tar.gz",
                contentType: "application/gzip",
            },
        ],
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
