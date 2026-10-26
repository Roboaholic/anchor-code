import fs from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { HostError, type ReadFileOptions } from "./types.js";

export function fileReadLimit(options?: ReadFileOptions): number | undefined {
  const limit = options?.maxBytes;
  if (limit === undefined) return undefined;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit >= 0x7fffffff) {
    throw new HostError("failed", "File read limit must be a nonnegative byte count below 2 GiB");
  }
  return limit;
}

/** One lookahead byte distinguishes EOF from a preview cut inside UTF-8. */
export function decodeFilePrefix(bytes: Buffer, limit: number): string {
  if (bytes.length <= limit) return bytes.toString("utf8");
  // Do not flush the decoder: its pending suffix belongs to the next character.
  return new StringDecoder("utf8").write(bytes.subarray(0, limit));
}

export async function readFilePrefix(
  limit: number,
  read: (buffer: Buffer, position: number, length: number) => Promise<number>,
): Promise<string> {
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, limit + 1));
  const decoder = new StringDecoder("utf8");
  let position = 0;
  let text = "";
  while (position <= limit) {
    const count = await read(buffer, position, Math.min(buffer.length, limit + 1 - position));
    if (count === 0) return text + decoder.end();
    text += decoder.write(buffer.subarray(0, Math.min(count, limit - position)));
    position += count;
  }
  return text;
}

export async function readLocalFile(filePath: string, options?: ReadFileOptions): Promise<string> {
  const limit = fileReadLimit(options);
  if (limit === undefined) return fs.readFile(filePath, "utf8");
  const file = await fs.open(filePath, "r");
  try {
    return await readFilePrefix(limit, async (buffer, position, length) =>
      (await file.read(buffer, 0, length, position)).bytesRead);
  } finally {
    await file.close();
  }
}

/** Keep binary byte boundaries intact through the existing text-only protocol. */
export function boundedReadCommand(quotedPath: string, limit: number): string {
  return `set -o pipefail; head -c ${limit + 1} -- ${quotedPath} | base64`;
}

/** Hard cap for whole-file binary reads (image previews). */
export const MAX_BINARY_READ_BYTES = 20 * 1024 * 1024;

export function binaryReadLimit(maxBytes?: number): number {
  const limit = maxBytes ?? MAX_BINARY_READ_BYTES;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_BINARY_READ_BYTES) {
    throw new HostError("failed", "Binary read limit must be a nonnegative byte count up to 20 MiB");
  }
  return limit;
}

export function tooLargeError(filePath: string, limit: number): HostError {
  return new HostError("failed", `File is too large to preview (over ${Math.floor(limit / 1024 / 1024)} MiB): ${filePath}`);
}

/** Reject once the bounded read produced more than `limit` bytes. */
export function checkBinarySize(bytes: Buffer, limit: number, filePath: string): Buffer {
  if (bytes.length > limit) throw tooLargeError(filePath, limit);
  return bytes;
}

/** Decode the base64 output of `boundedReadCommand` (line-wrapped by coreutils). */
export function decodeBoundedBase64(output: string, limit: number, filePath: string): Buffer {
  return checkBinarySize(Buffer.from(output.replace(/\s+/g, ""), "base64"), limit, filePath);
}

export async function readLocalFileBytes(filePath: string, maxBytes?: number): Promise<Buffer> {
  const limit = binaryReadLimit(maxBytes);
  const file = await fs.open(filePath, "r");
  try {
    const st = await file.stat();
    if (st.size > limit) throw tooLargeError(filePath, limit);
    const buffer = Buffer.alloc(Math.min(st.size, limit) + 1);
    let position = 0;
    // Read up to limit + 1 so a file that grew after stat() is still bounded.
    while (position < buffer.length) {
      const { bytesRead } = await file.read(buffer, position, buffer.length - position, position);
      if (bytesRead === 0) break;
      position += bytesRead;
    }
    return checkBinarySize(buffer.subarray(0, position), limit, filePath);
  } finally {
    await file.close();
  }
}
