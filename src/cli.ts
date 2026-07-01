#!/usr/bin/env node
/**
 * @diffdeck/cli entry point — the single DiffDeck upload engine.
 *
 * Commands:
 *   upload-storybook   Pack a Storybook static build and upload it for visual review.
 *   upload-recording   Upload a single Playwright test recording (video + metadata).
 *
 * The CLI only ever speaks HTTP to the DiffDeck ingest routes; the host is fully
 * configurable via --host / $DIFFDECK_HOST.
 */
import {parseArgs} from "./args";
import {DEFAULT_HOST} from "./http";
import {runUploadStorybook, STORYBOOK_HELP} from "./commands/uploadStorybook";
import {runUploadRecording, RECORDING_HELP} from "./commands/uploadRecording";

const VERSION = "0.1.0";

const ROOT_HELP = `diffdeck — upload Storybook builds and Playwright recordings to DiffDeck

Usage:
  diffdeck <command> [options]

Commands:
  upload-storybook   Pack a Storybook static build and upload it for visual review.
  upload-recording   Upload a single Playwright test recording (video + metadata).

Global options:
  --help, -h         Show help (per-command help: diffdeck <command> --help).
  --version, -V      Print the CLI version.

Authentication:
  Pass the project token with --token or the DIFFDECK_TOKEN env var. It is sent as
  the X-UI-Review-Token header. The host defaults to ${DEFAULT_HOST} and can be
  overridden with --host or DIFFDECK_HOST.

Examples:
  diffdeck upload-storybook --dir storybook-static --commit "$GITHUB_SHA" --branch main
  diffdeck upload-recording --video test.webm --test "Home renders" --status passed`;

async function main(): Promise<number> {
    const argv = process.argv.slice(2);
    const parsed = parseArgs(argv, ["help", "h", "version", "V"]);

    if (parsed.options.version === true || parsed.options.V === true) {
        console.log(VERSION);
        return 0;
    }

    switch (parsed.command) {
        case "upload-storybook":
            return runUploadStorybook(parsed);
        case "upload-recording":
            return runUploadRecording(parsed);
        case undefined:
            // No command: show root help (exit 0 if --help was asked, else 1).
            console.log(ROOT_HELP);
            return parsed.options.help === true || parsed.options.h === true ? 0 : 1;
        case "help":
            console.log(ROOT_HELP);
            return 0;
        default:
            console.error(`Unknown command: ${parsed.command}\n`);
            console.error(ROOT_HELP);
            return 2;
    }
}

// Keep STORYBOOK_HELP / RECORDING_HELP referenced for tooling; they are the
// per-command help bodies emitted by each command handler.
void STORYBOOK_HELP;
void RECORDING_HELP;

main()
    .then((code) => {
        process.exitCode = code;
    })
    .catch((e: any) => {
        console.error(`Fatal: ${e?.message ?? e}`);
        process.exitCode = 1;
    });
