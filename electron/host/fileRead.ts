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
