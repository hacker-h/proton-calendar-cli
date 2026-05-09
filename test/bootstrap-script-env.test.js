import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { childProcessEnv } from "../scripts/bootstrap-proton-cookies.mjs";

const SAFE_STORAGE_ENV_KEY = "SWEET_COOKIE_CHROME_SAFE_STORAGE_PASSWORD";

test("bootstrap child process env does not inherit Chrome Safe Storage password", () => {
  const parentEnv = {
    PATH: "/usr/bin",
    [SAFE_STORAGE_ENV_KEY]: "secret-password",
  };

  const env = childProcessEnv(parentEnv);

  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env[SAFE_STORAGE_ENV_KEY], undefined);
  assert.equal(parentEnv[SAFE_STORAGE_ENV_KEY], "secret-password");
});

test("bootstrap script does not assign Chrome Safe Storage password to process.env", async () => {
  const source = await readFile(new URL("../scripts/bootstrap-proton-cookies.mjs", import.meta.url), "utf8");

  assert.equal(source.includes(`process.env.${SAFE_STORAGE_ENV_KEY} =`), false);
  assert.equal(source.includes(`process.env["${SAFE_STORAGE_ENV_KEY}"] =`), false);
  assert.equal(source.includes(`process.env['${SAFE_STORAGE_ENV_KEY}'] =`), false);
});

test("bootstrap child process launches use sanitized env", async () => {
  const source = await readFile(new URL("../scripts/bootstrap-proton-cookies.mjs", import.meta.url), "utf8");
  const spawnCalls = source.match(/\bspawn\(/g) || [];

  assert.equal(spawnCalls.length, 1);
  assert.match(source, /spawn\(chromePath, args, \{\s*env: childProcessEnv\(\),/m);
});
