import { describe, expect, it } from "vitest";
import { openRelayPayload, sealRelayPayload } from "./sessionCrypto.js";

describe("relay session crypto", () => {
  it("round-trips JSON while binding routing metadata as authenticated data", () => {
    const frame = sealRelayPayload({
      roomId: "room-one",
      secret: "secret-one",
      sessionId: "session-one",
      sequence: 1,
      from: "phone",
      to: "pc",
      payload: { prompt: "private source and terminal text" },
    });
    expect(JSON.stringify(frame)).not.toContain("private source");
    expect(openRelayPayload({ roomId: "room-one", secret: "secret-one", frame }))
      .toEqual({ prompt: "private source and terminal text" });
  });

  it("rejects tampered routing metadata", () => {
    const frame = sealRelayPayload({
      roomId: "room-one",
      secret: "secret-one",
      sessionId: "session-one",
      sequence: 1,
      from: "phone",
      to: "pc",
      payload: { ok: true },
    });
    expect(() => openRelayPayload({
      roomId: "room-one",
      secret: "secret-one",
      frame: { ...frame, sequence: 2 },
    })).toThrow();
  });
});
