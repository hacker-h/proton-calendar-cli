import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pc-package-smoke-"));

try {
  const packDir = path.join(tmpDir, "pack");
  const installDir = path.join(tmpDir, "install");
  await mkdir(packDir, { recursive: true });
  await mkdir(installDir, { recursive: true });

  const { stdout } = await execFileAsync("pnpm", ["pack", "--pack-destination", packDir], { cwd: repoRoot });
  const tarballName = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);

  if (!tarballName || !tarballName.endsWith(".tgz")) {
    throw new Error(`Unable to determine packed tarball from pnpm output: ${stdout}`);
  }

  await writeFile(path.join(installDir, "package.json"), '{"private":true,"type":"module"}\n');
  const tarballPath = path.join(packDir, path.basename(tarballName));
  await execFileAsync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarballPath], {
    cwd: installDir,
  });

  const binPath = path.join(installDir, "node_modules", ".bin", "pc");
  const help = await execFileAsync(binPath, ["--help"], { cwd: installDir });
  if (!help.stdout.includes("pc - Proton Calendar CLI")) {
    throw new Error("Packaged pc binary did not print expected help text");
  }
} finally {
  await rm(tmpDir, { recursive: true, force: true });
}
