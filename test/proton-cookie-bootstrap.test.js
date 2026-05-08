import test from "node:test";
import assert from "node:assert/strict";
import {
  countAuthCookies,
  flattenCookies,
  hasCalendarAppTarget,
  looksAuthenticated,
} from "../src/proton-cookie-bootstrap.js";

test("flattenCookies returns one row per domain cookie", () => {
  const result = flattenCookies({
    "calendar.proton.me": [{ name: "a", value: "1" }],
    "proton.me": [{ name: "b", value: "2" }],
  });

  assert.equal(result.length, 2);
  assert.equal(result[0].domain, "calendar.proton.me");
  assert.equal(result[1].domain, "proton.me");
});

test("countAuthCookies only counts auth-like named cookies", () => {
  const count = countAuthCookies({
    "calendar.proton.me": [
      { name: "pm-session", value: "abc" },
      { name: "timezone", value: "UTC" },
    ],
    "proton.me": [{ name: "auth-token", value: "def" }],
  });

  assert.equal(count, 2);
});

test("hasCalendarAppTarget is true only for non-login calendar targets", () => {
  const yes = hasCalendarAppTarget([
    { url: "https://calendar.proton.me/u/0/week" },
    { url: "https://account.proton.me/login" },
  ]);
  const no = hasCalendarAppTarget([{ url: "https://calendar.proton.me/login" }]);

  assert.equal(yes, true);
  assert.equal(no, false);
});

test("looksAuthenticated requires auth cookies and calendar target", () => {
  const cookies = {
    "calendar.proton.me": [{ name: "pm-session", value: "abc" }],
    "proton.me": [{ name: "auth-token", value: "def" }],
  };

  const targets = [{ url: "https://calendar.proton.me/u/0/day" }];
  const notReadyTargets = [{ url: "https://account.proton.me/login" }];

  assert.equal(looksAuthenticated(cookies, targets), true);
  assert.equal(looksAuthenticated(cookies, notReadyTargets), false);
});
