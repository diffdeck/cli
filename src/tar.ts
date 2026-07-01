/**
 * Minimal, dependency-free gzip-tar writer.
 *
 * Produces a POSIX/USTAR tarball (with the GNU `L` long-name extension for paths
 * over 100 bytes) and gzips it with the built-in `zlib`. This avoids any runtime
 * dependency and avoids shelling out to a system `tar` binary (not guaranteed on
 * every CI image). The node-tar reader on the server side reads both USTAR and the
 * GNU long-name records.
 */
import {createReadStream, promises as fs} from "node:fs";
import path from "node:path";
import {gzip} from "node:zlib";
import {promisify} from "node:util";

const gzipAsync = promisify(gzip);

const BLOCK_SIZE = 512;
const ZERO_BLOCK = Buffer.alloc(BLOCK_SIZE);

interface FileEntry {
    /** POSIX path inside the archive (forward slashes, no leading slash). */
    archivePath: string;
    absolutePath: string;
    size: number;
    mode: number;
    mtime: number;
}

/** Write an octal value, NUL-terminated, right-aligned in a field of `length` bytes. */
function writeOctal(buffer: Buffer, value: number, offset: number, length: number): void {
    // length-1 octal digits + trailing NUL.
    const str = value.toString(8).padStart(length - 1, "0") + "\0";
    buffer.write(str, offset, length, "ascii");
}

/** Build a single 512-byte tar header block for the given entry. */
function buildHeader(opts: {
    name: string;
    mode: number;
    size: number;
    mtime: number;
    typeflag: string;
    prefix?: string;
}): Buffer {
    const header = Buffer.alloc(BLOCK_SIZE);

    header.write(opts.name, 0, 100, "utf8");
    writeOctal(header, opts.mode & 0o7777, 100, 8);
    writeOctal(header, 0, 108, 8); // uid
    writeOctal(header, 0, 116, 8); // gid
    writeOctal(header, opts.size, 124, 12);
    writeOctal(header, Math.floor(opts.mtime), 136, 12);
    header.write(opts.typeflag, 156, 1, "ascii");
    // linkname (165..264) left blank.
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    if (opts.prefix) header.write(opts.prefix, 345, 155, "utf8");

    // Checksum: fill field with spaces, sum every byte, then write the octal sum.
    header.write("        ", 148, 8, "ascii");
    let sum = 0;
    for (let i = 0; i < BLOCK_SIZE; i++) sum += header[i];
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");

    return header;
}

/** Pad a length up to the next 512-byte boundary; returns the padding buffer. */
function padding(size: number): Buffer {
    const remainder = size % BLOCK_SIZE;
    return remainder === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK_SIZE - remainder);
}

/**
 * Header(s) for one file. Emits a GNU long-name (`L`) record first when the path
 * exceeds 100 bytes, then the regular file header.
 */
function fileHeaders(archivePath: string, size: number, mode: number, mtime: number): Buffer[] {
    const nameBytes = Buffer.byteLength(archivePath, "utf8");
    const blocks: Buffer[] = [];

    if (nameBytes > 100) {
        const pathBuf = Buffer.from(archivePath + "\0", "utf8");
        blocks.push(
            buildHeader({
                name: "././@LongLink",
                mode: 0,
                size: pathBuf.length,
                mtime: 0,
                typeflag: "L",
            }),
        );
        blocks.push(pathBuf, padding(pathBuf.length));
    }

    blocks.push(
        buildHeader({
            // Truncated name is ignored by readers when a long-name record precedes it.
            name: archivePath.slice(0, 100),
            mode,
            size,
            mtime,
            typeflag: "0",
        }),
    );

    return blocks;
}

/** Recursively collect every regular file under `dir`. */
async function collectFiles(dir: string, base: string, out: FileEntry[]): Promise<void> {
    const entries = await fs.readdir(dir, {withFileTypes: true});
    for (const entry of entries) {
        const absolutePath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            await collectFiles(absolutePath, base, out);
        } else if (entry.isFile()) {
            const stat = await fs.stat(absolutePath);
            const archivePath = path.relative(base, absolutePath).split(path.sep).join("/");
            out.push({
                archivePath,
                absolutePath,
                size: stat.size,
                mode: stat.mode,
                mtime: stat.mtimeMs / 1000,
            });
        }
    }
}

async function readFileBuffer(absolutePath: string): Promise<Buffer> {
    const chunks: Buffer[] = [];
    const stream = createReadStream(absolutePath);
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
}

/**
 * Create a gzipped tarball of every file under `dir`, returning the compressed bytes.
 * Archive paths are relative to `dir` (so `dir/index.html` → `index.html`).
 */
export async function createTarGz(dir: string): Promise<Buffer> {
    const resolved = path.resolve(dir);
    const stat = await fs.stat(resolved).catch(() => null);
    if (!stat || !stat.isDirectory()) {
        throw new Error(`Not a directory: ${dir}`);
    }

    const files: FileEntry[] = [];
    await collectFiles(resolved, resolved, files);
    if (files.length === 0) {
        throw new Error(`Directory is empty: ${dir}`);
    }

    // Deterministic ordering keeps archives stable across runs.
    files.sort((a, b) => (a.archivePath < b.archivePath ? -1 : a.archivePath > b.archivePath ? 1 : 0));

    const parts: Buffer[] = [];
    for (const file of files) {
        for (const block of fileHeaders(file.archivePath, file.size, file.mode, file.mtime)) {
            parts.push(block);
        }
        const data = await readFileBuffer(file.absolutePath);
        parts.push(data, padding(data.length));
    }
    // Two trailing zero blocks mark end-of-archive.
    parts.push(ZERO_BLOCK, ZERO_BLOCK);

    const tar = Buffer.concat(parts);
    return gzipAsync(tar);
}

/** Count of files that would be archived — useful for logging. */
export async function countFiles(dir: string): Promise<number> {
    const resolved = path.resolve(dir);
    const files: FileEntry[] = [];
    await collectFiles(resolved, resolved, files);
    return files.length;
}
