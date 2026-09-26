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

/**
 * Monorepo product key: splits one repository into several independently-reviewed
 * DiffDeck products (own baselines, build numbers and GitHub check). Lowercase
 * letters, digits, `.`, `_` and `-`, starting with a letter or digit, max 64 chars.
 * Must match the server's rule (src/shared/products/ui-review/productKeys.ts).
 */
export const PRODUCT_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Read `--product` / `$DIFFDECK_PRODUCT`. Returns `{key: undefined}` when unset (the
 * server then uses the repo's default product), or `{error}` for an invalid key.
 */
export function productOption(options: Record<string, string | boolean>): {key?: string; error?: string} {
    const raw = stringOption(options, ["product"], "DIFFDECK_PRODUCT");
    const key = raw?.trim().toLowerCase();
    if (!key) return {};
    if (!PRODUCT_KEY_PATTERN.test(key)) {
        return {
            error:
                `invalid product key "${raw}" — use lowercase letters, digits, ".", "_" or "-" ` +
                `(starting with a letter or digit, max 64 chars).`,
        };
    }
    return {key};
}
