/**
 * Tiny dependency-free argument parser.
 *
 * Supports `--flag value`, `--flag=value`, and boolean `--flag` forms. The first
 * non-option token is treated as the command. Everything is hand-rolled so the CLI
 * has zero runtime dependencies.
 */

export interface ParsedArgs {
    /** First positional token (the sub-command), or undefined. */
    command?: string;
    /** Remaining positional tokens. */
    positionals: string[];
    /** Parsed `--key value` / `--key=value` options (string) and boolean flags (true). */
    options: Record<string, string | boolean>;
}

/**
 * Parse a raw argv list (without the leading `node` + script entries).
 *
 * A bare `--flag` consumes the following token as its value UNLESS that token also
 * starts with `--`, or the flag name is listed in `booleanFlags` (in which case the
 * flag is `true` and the next token stays positional).
 */
export function parseArgs(argv: string[], booleanFlags: string[] = []): ParsedArgs {
    const booleans = new Set(booleanFlags);
    const positionals: string[] = [];
    const options: Record<string, string | boolean> = {};

    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];

        if (token.startsWith("--")) {
            const body = token.slice(2);
            const eq = body.indexOf("=");
            if (eq !== -1) {
                // --key=value
                options[body.slice(0, eq)] = body.slice(eq + 1);
                continue;
            }

            const key = body;
            const next = argv[i + 1];
            if (booleans.has(key) || next === undefined || next.startsWith("--")) {
                options[key] = true;
            } else {
                options[key] = next;
                i++;
            }
            continue;
        }

        positionals.push(token);
    }

    return {command: positionals[0], positionals: positionals.slice(1), options};
}

/** Read a string option, falling back through aliases then an env var then a default. */
export function stringOption(
    options: Record<string, string | boolean>,
    keys: string[],
    envVar?: string,
    fallback?: string,
): string | undefined {
    for (const key of keys) {
        const value = options[key];
        if (typeof value === "string" && value.length > 0) return value;
    }
    if (envVar && process.env[envVar]) return process.env[envVar];
    return fallback;
}

/** Read a boolean flag, true if present in any aliased form. */
export function boolOption(options: Record<string, string | boolean>, keys: string[]): boolean {
    return keys.some((key) => options[key] === true || options[key] === "true");
}
