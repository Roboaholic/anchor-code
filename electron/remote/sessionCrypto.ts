import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import type { RelaySealedFrame } from "../../contracts/remote-transport/v1/index.js";
import { REMOTE_TRANSPORT_VERSION } from "../../contracts/remote-transport/v1/index.js";

function keyFor(roomId: string, secret: string): Buffer {
  return createHash("sha256")
    .update(`anchor-relay-v1\0${roomId}\0${secret}`, "utf8")
    .digest();
}

function additionalData(
  roomId: string,
  frame: Pick<RelaySealedFrame, "sessionId" | "sequence" | "from" | "to">,
): Buffer {
  return Buffer.from([
    "anchor-relay-v1",
    roomId,
    frame.sessionId,
    String(frame.sequence),
    frame.from,
    frame.to ?? "",
  ].join("\0"), "utf8");
}

export function sealRelayPayload(input: {
  roomId: string;
  secret: string;
  sessionId: string;
  sequence: number;
  from: string;
  to?: string;
  payload: unknown;
}): RelaySealedFrame {
  const iv = randomBytes(12);
  const frame = {
    v: REMOTE_TRANSPORT_VERSION,
    type: "sealed" as const,
    from: input.from,
    ...(input.to ? { to: input.to } : {}),
    sessionId: input.sessionId,
    sequence: input.sequence,
    iv: iv.toString("base64url"),
  };
  const cipher = createCipheriv("aes-256-gcm", keyFor(input.roomId, input.secret), iv);
  cipher.setAAD(additionalData(input.roomId, frame));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(input.payload), "utf8"),
    cipher.final(),
  ]);
  return {
    ...frame,
    ciphertext: Buffer.concat([encrypted, cipher.getAuthTag()]).toString("base64url"),
  };
}

export function openRelayPayload<T>(input: {
  roomId: string;
  secret: string;
  frame: RelaySealedFrame;
}): T {
  const iv = Buffer.from(input.frame.iv, "base64url");
  const combined = Buffer.from(input.frame.ciphertext, "base64url");
  if (iv.length !== 12 || combined.length < 17) throw new Error("Invalid encrypted relay frame");
  const ciphertext = combined.subarray(0, -16);
  const tag = combined.subarray(-16);
  const decipher = createDecipheriv("aes-256-gcm", keyFor(input.roomId, input.secret), iv);
  decipher.setAAD(additionalData(input.roomId, input.frame));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}
