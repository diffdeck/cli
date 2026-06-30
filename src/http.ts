/**
 * HTTP upload helper built on the global `fetch` / `FormData` / `Blob` (Node 18+).
 * No third-party HTTP client — the CLI only ever speaks multipart/form-data POST to
 * the DiffDeck ingest routes.
 */

export const DEFAULT_HOST = "https://app.diffdeck.dev";
export const AUTH_HEADER = "X-UI-Review-Token";

export interface UploadFile {
    /** Form field name (e.g. "build" or "video"). */
    field: string;
    /** Raw file bytes. */
    data: Buffer;
    /** Filename advertised in the multipart part. */
    filename: string;
    /** MIME content type. */
    contentType: string;
}

export interface UploadOptions {
    host: string;
    pathname: string;
    token: string;
    /** Scalar form fields. `undefined`/`null` entries are skipped. */
    fields: Record<string, string | number | undefined | null>;
    files: UploadFile[];
}

export interface UploadResult {
    status: number;
    ok: boolean;
    /** Parsed JSON body when the response was JSON, else undefined. */
    json?: any;
    /** Raw text body (always populated). */
    text: string;
}

/** Join a host and pathname into a full URL, tolerating trailing/leading slashes. */
export function buildUrl(host: string, pathname: string): string {
    const trimmedHost = host.replace(/\/+$/, "");
    const trimmedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
    return `${trimmedHost}${trimmedPath}`;
}

/**
 * Build the multipart FormData body for an upload. Exposed separately so tests can
 * assert the exact field/file shape without performing a network request.
 */
export function buildFormData(
    fields: Record<string, string | number | undefined | null>,
    files: UploadFile[],
): FormData {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
        if (value === undefined || value === null) continue;
        form.append(key, String(value));
    }
    for (const file of files) {
        const blob = new Blob([file.data], {type: file.contentType});
        form.append(file.field, blob, file.filename);
    }
    return form;
}

/** Perform a multipart POST and return the parsed result. */
export async function uploadMultipart(opts: UploadOptions): Promise<UploadResult> {
    const url = buildUrl(opts.host, opts.pathname);
    const form = buildFormData(opts.fields, opts.files);

    let response: Response;
    try {
        response = await fetch(url, {
            method: "POST",
            headers: {[AUTH_HEADER]: opts.token},
            body: form,
        });
    } catch (e: any) {
        throw new Error(`Network request to ${url} failed: ${e?.message ?? e}`);
    }

    const text = await response.text();
    let json: any;
    try {
        json = text ? JSON.parse(text) : undefined;
    } catch {
        json = undefined;
    }

    return {status: response.status, ok: response.ok, json, text};
}

/** Extract a human-readable error message from a non-2xx response. */
export function errorMessage(result: UploadResult): string {
    if (result.json && typeof result.json.error === "string") return result.json.error;
    if (result.text) return result.text.slice(0, 500);
    return `HTTP ${result.status}`;
}
