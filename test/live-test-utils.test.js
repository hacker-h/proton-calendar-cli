import test from "node:test";
import assert from "node:assert/strict";
import { readLiveCapabilities, readLiveConfig, skipUnlessCapability } from "./live/helpers/live-test-utils.js";

test("readLiveCapabilities defaults to free-account safe gates", () => {
  const capabilities = readLiveCapabilities({});

  assert.equal(capabilities.plan, "free");
  assert.equal(capabilities.calendarCrud, false);
  assert.equal(capabilities.sharing, false);
  assert.equal(capabilities.invites, false);
  assert.equal(capabilities.conferencingMetadata, false);
  assert.equal(capabilities.protonMeet, false);
  assert.equal(capabilities.zoom, false);
  assert.equal(capabilities.availability, false);
  assert.equal(capabilities.appointmentScheduling, false);
  assert.equal(capabilities.subscribedCalendars, false);
  assert.equal(capabilities.holidayCalendars, false);
  assert.equal(capabilities.birthdayCalendars, false);
  assert.equal(capabilities.secondAccount, false);
  assert.equal(capabilities.hasSecondAccount, false);
});

test("readLiveCapabilities keeps conferencing and special calendars opt-in", () => {
  const capabilities = readLiveCapabilities({
    PROTON_LIVE_ENABLE_CONFERENCING_METADATA: "1",
    PROTON_LIVE_ENABLE_PROTON_MEET: "true",
    PROTON_LIVE_ENABLE_ZOOM: "yes",
    PROTON_LIVE_ENABLE_AVAILABILITY: "1",
    PROTON_LIVE_ENABLE_APPOINTMENT_SCHEDULING: "1",
    PROTON_LIVE_ENABLE_SUBSCRIBED_CALENDARS: "1",
    PROTON_LIVE_ENABLE_HOLIDAY_CALENDARS: "1",
    PROTON_LIVE_ENABLE_BIRTHDAY_CALENDARS: "1",
  });

  assert.equal(capabilities.conferencingMetadata, true);
  assert.equal(capabilities.protonMeet, true);
  assert.equal(capabilities.zoom, true);
  assert.equal(capabilities.availability, true);
  assert.equal(capabilities.appointmentScheduling, true);
  assert.equal(capabilities.subscribedCalendars, true);
  assert.equal(capabilities.holidayCalendars, true);
  assert.equal(capabilities.birthdayCalendars, true);
});

test("readLiveCapabilities enables second account only when gate and credentials are present", () => {
  const withoutGate = readLiveCapabilities({
    PROTON_USERNAME2: "second@example.com",
    PROTON_PASSWORD2: "secret",
  });
  assert.equal(withoutGate.hasSecondAccount, true);
  assert.equal(withoutGate.secondAccount, false);

  const inviteWithoutSecondAccount = readLiveCapabilities({
    PROTON_LIVE_ENABLE_INVITES: "1",
    PROTON_USERNAME2: "second@example.com",
    PROTON_PASSWORD2: "secret",
  });
  assert.equal(inviteWithoutSecondAccount.invitesRequested, true);
  assert.equal(inviteWithoutSecondAccount.invites, false);

  const withGate = readLiveCapabilities({
    PROTON_LIVE_PLAN: "paid",
    PROTON_LIVE_ENABLE_SECOND_ACCOUNT: "true",
    PROTON_LIVE_ENABLE_INVITES: "1",
    PROTON_USERNAME2: "second@example.com",
    PROTON_PASSWORD2: "secret",
  });
  assert.equal(withGate.plan, "paid");
  assert.equal(withGate.secondAccount, true);
  assert.equal(withGate.invites, true);
  assert.equal(withGate.attendeeEmail, "second@example.com");
});

test("skipUnlessCapability explains disabled or misconfigured gates", () => {
  const config = readLiveConfig({
    PC_API_TOKEN: "token",
    PROTON_LIVE_ENABLE_SECOND_ACCOUNT: "1",
  });

  assert.equal(config.enabled, true);
  assert.equal(skipUnlessCapability(config, "sharing"), "sharing live tests are disabled by capability gate");
  assert.equal(skipUnlessCapability(config, "zoom"), "zoom live tests are disabled by capability gate");
  assert.equal(skipUnlessCapability(config, "secondAccount"), "second-account live tests require PROTON_USERNAME2 and PROTON_PASSWORD2");
  assert.equal(skipUnlessCapability(readLiveConfig({
    PC_API_TOKEN: "token",
    PROTON_LIVE_ENABLE_INVITES: "1",
  }), "invites"), "invite live tests require PROTON_LIVE_ENABLE_SECOND_ACCOUNT=1 with PROTON_USERNAME2 and PROTON_PASSWORD2");
});
