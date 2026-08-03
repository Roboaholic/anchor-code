import {
  REMOTE_TRANSPORT_VERSION,
  type RelaySealedFrame,
} from "@anchor-code/remote-transport/v1";

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function keyFor(roomId: string, secret: string): Promise<CryptoKey> {
  const material = new TextEncoder().encode(`anchor-relay-v1\0${roomId}\0${secret}`);
  const digest = await crypto.subtle.digest("SHA-256", material);
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function additionalData(
  roomId: string,
  frame: Pick<RelaySealedFrame, "sessionId" | "sequence" | "from" | "to">,
): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode([
    "anchor-relay-v1",
    roomId,
    frame.sessionId,
    String(frame.sequence),
    frame.from,
    frame.to ?? "",
  ].join("\0"));
}

export async function sealRelayPayload(input: {
  roomId: string;
  secret: string;
  sessionId: string;
  sequence: number;
  from: string;
  to?: string;
  payload: unknown;
}): Promise<RelaySealedFrame> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const frame = {
    v: REMOTE_TRANSPORT_VERSION,
    type: "sealed" as const,
    from: input.from,
    ...(input.to ? { to: input.to } : {}),
    sessionId: input.sessionId,
    sequence: input.sequence,
    iv: bytesToBase64Url(iv),
  };
  const plaintext = new TextEncoder().encode(JSON.stringify(input.payload));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: additionalData(input.roomId, frame), tagLength: 128 },
    await keyFor(input.roomId, input.secret),
    plaintext,
  );
  return { ...frame, ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)) };
}

export async function openRelayPayload<T>(input: {
  roomId: string;
  secret: string;
  frame: RelaySealedFrame;
}): Promise<T> {
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64UrlToBytes(input.frame.iv),
      additionalData: additionalData(input.roomId, input.frame),
      tagLength: 128,
    },
    await keyFor(input.roomId, input.secret),
    base64UrlToBytes(input.frame.ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}
