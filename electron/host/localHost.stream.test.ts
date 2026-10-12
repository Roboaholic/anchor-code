import { describe, expect, it } from "vitest";
import { LocalHostSession } from "./localHost.js";

describe("LocalHostSession.run streaming", () => {
  it("keeps multi-byte UTF-8 intact across stdout chunk boundaries", async () => {
    const host = new LocalHostSession("utf8-test");
    // Write "中" one byte at a time with pauses so chunks split the code point.
    const script =
      "const b=Buffer.from('中文');let i=0;const t=setInterval(()=>{process.stdout.write(b.subarray(i,i+1));if(++i>=b.length)clearInterval(t);},15);";
    const chunks: string[] = [];
    const r = await host.run(process.cwd(), process.execPath, ["-e", script], {
      onStdoutChunk: (c) => chunks.push(c),
    });
    expect(r.stdout).toBe("中文");
    expect(chunks.join("")).not.toContain("\uFFFD");
    await host.dispose();
  });

  it("abort kills the process and resolves with aborted + partial output", async () => {
    const host = new LocalHostSession("abort-test");
    const ctl = new AbortController();
    const started = Date.now();
    const r = await host.run(
      process.cwd(),
      process.execPath,
      ["-e", "process.stdout.write('first\\n');setTimeout(()=>{},30000);"],
      { signal: ctl.signal, onStdoutChunk: () => ctl.abort() },
    );
    expect(r.aborted).toBe(true);
    expect(r.stdout).toContain("first");
    expect(Date.now() - started).toBeLessThan(10_000);
    await host.dispose();
  });
});
