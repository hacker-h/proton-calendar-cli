import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ProtonAuthManager } from "../src/proton/proton-auth-manager.js";

test("failed relogin enters cooldown and suppresses repeated bootstrap attempts", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "proton-auth-manager-cooldown-"));
  try {
    const bundlePath = path.join(tmpDir, "proton-cookies.json");
    let now = 1_700_000_000_000;
    let attempts = 0;

    const manager = new ProtonAuthManager({
      sessionStore: {
        getBundlePath() {
          return bundlePath;
        },
      },
      enabled: true,
      mode: "headful",
      cooldownMs: 60_000,
      now: () => now,
      bootstrapRunner: async () => {
        attempts += 1;
        throw new Error("bootstrap failed");
      },
    });

    assert.equal(await manager.recover({ reason: "initial" }), false);
    assert.equal(attempts, 1);

    assert.equal(await manager.recover({ reason: "immediate-retry" }), false);
    assert.equal(attempts, 1);

    now += 60_001;
    assert.equal(await manager.recover({ reason: "after-cooldown" }), false);
    assert.equal(attempts, 2);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("second auth manager waits for shared relogin lock instead of spawning another browser", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "proton-auth-manager-lock-"));
  try {
    const bundlePath = path.join(tmpDir, "proton-cookies.json");
    let releaseFirst;
    let firstAttempts = 0;
    let secondAttempts = 0;
    let secondInvalidations = 0;

    const firstManager = new ProtonAuthManager({
      sessionStore: {
        getBundlePath() {
          return bundlePath;
        },
        async invalidate() {},
      },
      enabled: true,
      mode: "headless",
      timeoutMs: 250,
      cooldownMs: 0,
      lockPollMs: 10,
      bootstrapRunner: async () => {
        firstAttempts += 1;
        await new Promise((resolve) => {
          releaseFirst = resolve;
        });
      },
    });

    const secondManager = new ProtonAuthManager({
      sessionStore: {
        getBundlePath() {
          return bundlePath;
        },
        async invalidate() {
          secondInvalidations += 1;
        },
      },
      enabled: true,
      mode: "headful",
      timeoutMs: 250,
      cooldownMs: 0,
      lockPollMs: 10,
      bootstrapRunner: async () => {
        secondAttempts += 1;
      },
    });

    const firstRecovery = firstManager.recover({ reason: "first-process" });
    await delay(30);
    const secondRecovery = secondManager.recover({ reason: "second-process" });
    await delay(30);

    assert.equal(firstAttempts, 1);
    assert.equal(secondAttempts, 0);

    releaseFirst();

    assert.equal(await firstRecovery, true);
    assert.equal(await secondRecovery, true);
    assert.equal(secondAttempts, 0);
    assert.equal(secondInvalidations, 1);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
