/**
 * `diffdeck upload-recording` — upload a single Playwright recording (video + test
 * metadata) to the DiffDeck recordings ingest route as multipart/form-data.
 *
 * Target: POST <host>/api/products/ui-review/recordings
 * Fields: video, testTitle, testFile, testId, status, durationMs, retries, branch,
 *         commitSha, metadata.
 *
 * Recordings are a separately-priced add-on; the server returns 402 when not enabled
 * for the repository — we surface that with a clear message.
 */
import path from "node:path";
import {promises as fs} from "node:fs";
import {boolOption, ParsedArgs, stringOption} from "../args";
import {DEFAULT_HOST, errorMessage, uploadMultipart} from "../http";

export const RECORDINGS_PATH = "/api/products/ui-review/recordings";

export const RECORDING_HELP = `diffdeck upload-recording — upload a Playwright test recording

Usage:
  diffdeck upload-recording --video <file> [options]

Options:
  --video <path>        Recorded video file (e.g. .webm/.mp4). Required.
  --test <title>        Test title.
  --file <path>         Test file path.
  --test-id <id>        Stable test identifier.
  --status <status>     Test status (e.g. passed, failed, skipped).
  --duration <ms>       Test duration in milliseconds.
  --retries <n>         Number of retries.
  --metadata <json>     Extra metadata as a JSON string.
  --branch <name>       Git branch name.
  --commit <sha>        Git commit SHA.
  --token <token>       Project token. Defaults to $DIFFDECK_TOKEN.
  --host <url>          DiffDeck host. Defaults to $DIFFDECK_HOST or ${DEFAULT_HOST}.
  --help                Show this help.

Environment:
  DIFFDECK_TOKEN        Project token (X-UI-Review-Token).
  DIFFDECK_HOST         DiffDeck host URL.`;

const VIDEO_CONTENT_TYPES: Record<string, string> = {
    ".webm": "video/webm",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
};

function videoContentType(file: string): string {
    return VIDEO_CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

export async function runUploadRecording(parsed: ParsedArgs): Promise<number> {
    if (boolOption(parsed.options, ["help", "h"])) {
        console.log(RECORDING_HELP);
        return 0;
    }

    const video = stringOption(parsed.options, ["video", "v"]);
    const token = stringOption(parsed.options, ["token", "t"], "DIFFDECK_TOKEN");
    const host = stringOption(parsed.options, ["host"], "DIFFDECK_HOST", DEFAULT_HOST)!;

    const testTitle = stringOption(parsed.options, ["test", "test-title", "testTitle"]);
    const testFile = stringOption(parsed.options, ["file", "test-file", "testFile"]);
    const testId = stringOption(parsed.options, ["test-id", "testId"]);
    const status = stringOption(parsed.options, ["status"]);
    const durationMs = stringOption(parsed.options, ["duration", "duration-ms", "durationMs"]);
    const retries = stringOption(parsed.options, ["retries"]);
    const metadata = stringOption(parsed.options, ["metadata"]);
    const branch = stringOption(parsed.options, ["branch", "b"]);
    const commitSha = stringOption(parsed.options, ["commit", "commit-sha", "commitSha", "c"]);

    if (!video) {
        console.error("Error: --video <file> is required.");
        return 2;
    }
    if (!token) {
        console.error("Error: a project token is required (--token or $DIFFDECK_TOKEN).");
        return 2;
    }
    if (metadata) {
        try {
            JSON.parse(metadata);
        } catch {
            console.error("Error: --metadata must be a valid JSON string.");
            return 2;
        }
    }

    let data: Buffer;
    try {
        data = await fs.readFile(video);
    } catch (e: any) {
        console.error(`Error: cannot read video file ${video}: ${e?.message ?? e}`);
        return 1;
    }
    if (data.length === 0) {
        console.error(`Error: video file is empty: ${video}`);
        return 1;
    }

    console.error(`Uploading recording (${(data.length / 1024 / 1024).toFixed(2)} MB) to ${host} ...`);

    const result = await uploadMultipart({
        host,
        pathname: RECORDINGS_PATH,
        token,
        fields: {
            testTitle,
            testFile,
            testId,
            status,
            durationMs,
            retries,
            branch,
            commitSha,
            metadata,
        },
        files: [
            {
                field: "video",
                data,
                filename: path.basename(video),
                contentType: videoContentType(video),
            },
        ],
    });

    if (result.status === 402) {
        console.error(
            "Error: recordings are not enabled for this repository (HTTP 402). " +
                "Recordings are a separately-priced add-on — enable them in DiffDeck first.",
        );
        return 1;
    }
    if (!result.ok) {
        console.error(`Error: recording upload failed (HTTP ${result.status}): ${errorMessage(result)}`);
        return 1;
    }

    const {recordingId, url} = result.json ?? {};
    console.log("Recording uploaded.");
    if (recordingId) console.log(`  recordingId: ${recordingId}`);
    if (url) console.log(`  view:        ${url}`);
    return 0;
}
