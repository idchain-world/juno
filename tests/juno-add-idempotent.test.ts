import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chmod } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);

async function writeExecutable(path: string, content: string) {
  await writeFile(path, content, "utf8");
  await chmod(path, 0o755);
}

test("juno-add succeeds when the same instance already serves the MCP domain on the same upstream", async () => {
  const root = await mkdtemp(join(tmpdir(), "juno-add-idempotent-"));

  try {
    const binDir = join(root, "bin");
    const junoRoot = join(root, "opt-juno");
    const envDir = join(root, "etc-juno");
    const caddyDir = join(root, "caddy.d");
    const stateDir = join(root, "state");
    const templateDir = join(process.cwd(), "scripts");
    const script = join(process.cwd(), "scripts", "juno-add.sh");
    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      JUNO_ROOT: junoRoot,
      JUNO_ENV_DIR: envDir,
      JUNO_CADDY_DIR: caddyDir,
      JUNO_CADDY_LOG_DIR: join(root, "caddy-log"),
      JUNO_STATE_DIR: stateDir,
      JUNO_TEMPLATE_DIR: templateDir,
      JUNO_MCP_AGENT_DOMAIN: "abc123.203-0-113-10.mcp.dappa.ai",
      JUNO_PORT_BASE: "5200",
      JUNO_PORT_MAX: "5202",
      OPENROUTER_API_KEY: "",
    };

    await execFileAsync("mkdir", ["-p", binDir], { env });
    await writeExecutable(
      join(binDir, "systemctl"),
      "#!/usr/bin/env bash\nexit 0\n",
    );
    await writeExecutable(
      join(binDir, "caddy"),
      "#!/usr/bin/env bash\nexit 0\n",
    );
    await writeExecutable(
      join(binDir, "timeout"),
      "#!/usr/bin/env bash\nshift\nexec \"$@\"\n",
    );
    await writeExecutable(
      join(binDir, "flock"),
      "#!/usr/bin/env bash\nexit 0\n",
    );

    await execFileAsync("bash", [script, "abc123", "abc123.203-0-113-10.sslip.io"], { env });
    const second = await execFileAsync("bash", [script, "abc123", "abc123.203-0-113-10.sslip.io"], { env });

    expect(second.stdout).toContain("already provisioned");
    expect(second.stdout).toContain("127.0.0.1:5200");

    const site = await readFile(join(caddyDir, "abc123.caddy"), "utf8");
    expect(site).toContain("abc123.203-0-113-10.mcp.dappa.ai");
    expect(site).toContain("reverse_proxy 127.0.0.1:5200");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
