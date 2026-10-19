import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isSshConfigAlias, listSshConfigHosts, tokenizeConfigLine } from "./sshConfig.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((p) => fs.rm(p, { recursive: true, force: true }))); });
async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "anchor-ssh-config-"));
  dirs.push(home);
  await fs.mkdir(path.join(home, ".ssh", "config.d"), { recursive: true });
  return { home, systemConfig: path.join(home, "missing-system") };
}

describe("SSH config discovery", () => {
  it("follows sorted Includes, aliases, wildcard defaults and cycles without resolving or running config commands", async () => {
    const options = await fixture();
    await fs.writeFile(path.join(options.home, ".ssh", "config"), 'Host work prod !excluded *.internal\n  HostName example.test\nInclude config.d/*.conf\nHost WORK\nMatch exec "touch NEVER_EXECUTE"\n  User test\n');
    await fs.writeFile(path.join(options.home, ".ssh", "config.d", "b.conf"), 'Host=second\nInclude config\n');
    await fs.writeFile(path.join(options.home, ".ssh", "config.d", "a.conf"), 'Host "first"\nInclude "~/extra config"\n');
    await fs.writeFile(path.join(options.home, "extra config"), 'Host extra # a comment\n');
    const result = await listSshConfigHosts(options);
    expect(result.hosts.map((h) => h.alias)).toEqual(["work", "prod", "first", "extra", "second"]);
    expect(result.warnings).toEqual([]);
  });

  it("returns no hosts for missing configs and supports system Includes", async () => {
    const options = await fixture();
    expect((await listSshConfigHosts(options)).hosts).toEqual([]);
    await fs.writeFile(options.systemConfig, 'Include system-extra\nHost system\n');
    await fs.writeFile(path.join(options.home, "system-extra"), 'Host from-include\n');
    expect((await listSshConfigHosts(options)).hosts.map((h) => h.alias)).toEqual(["from-include", "system"]);
  });

  it("does not enumerate malformed or option-like destinations", async () => {
    const options = await fixture();
    await fs.writeFile(path.join(options.home, ".ssh", "config"), 'Host "unterminated\nHost -oProxyCommand=bad !negated x?y [ab] *.test valid-alias\n');
    expect((await listSshConfigHosts(options)).hosts.map((h) => h.alias)).toEqual(["valid-alias"]);
    expect(isSshConfigAlias("-oProxyCommand=bad")).toBe(false);
    expect(isSshConfigAlias("::1")).toBe(true);
    expect(isSshConfigAlias("host\nProxyCommand bad")).toBe(false);
  });

  it("tokenizes quoted paths and equal separators", () => {
    expect(tokenizeConfigLine('Include="config dir/hosts" # comment')).toEqual(["Include", "config dir/hosts"]);
    expect(tokenizeConfigLine('Host one two')).toEqual(["Host", "one", "two"]);
  });
});
