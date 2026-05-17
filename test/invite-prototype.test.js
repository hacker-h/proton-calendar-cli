import test from "node:test";
import assert from "node:assert/strict";
import { buildInvitePrototypeParts, INVITE_PROTOTYPE_DISABLED } from "../src/proton/internal/invite-prototype.js";

test("invite prototype is disabled unless explicitly enabled", () => {
  assert.throws(
    () => buildInvitePrototypeParts({}),
    (error) => error?.code === INVITE_PROTOTYPE_DISABLED
  );
});

test("invite prototype builds organizer and attendee payload fragments", () => {
  const parts = buildInvitePrototypeParts({
    uid: "evt-123",
    organizerEmail: "owner@example.test",
    attendees: [
      { email: "person@example.test", name: "Person One", uid: "evt-123" },
      { email: "optional@example.test", role: "OPT-PARTICIPANT", partstat: "TENTATIVE", uid: "evt-123" },
    ],
    startDate: "2026-05-20T10:00:00.000Z",
    endDate: "2026-05-20T10:30:00.000Z",
    title: "Invite research",
    description: "Prototype only",
    location: "Room A",
    sequence: 2,
    dtstamp: "2026-05-01T00:00:00.000Z",
  }, { enabled: true });

  assert.deepEqual(parts.methodByAction, { create: "REQUEST", update: "REQUEST", cancel: "CANCEL" });
  assert.equal(parts.action, "create");
  assert.equal(parts.method, "REQUEST");
  assert.deepEqual(parts.requiredApiFields, [
    "Permissions",
    "IsOrganizer",
    "SharedKeyPacket",
    "SharedEventContent",
    "AttendeesEventContent",
    "Attendees",
  ]);
  assert.match(parts.sharedSignedPart, /METHOD:REQUEST/);
  assert.match(parts.sharedSignedPart, /ORGANIZER;CN=owner@example\.test:mailto:owner@example\.test/);
  assert.match(parts.sharedSignedPart, /SEQUENCE:2/);
  assert.match(parts.sharedEncryptedPart, /SUMMARY:Invite research/);
  const unfoldedAttendees = parts.attendeesEncryptedPart.replace(/\r\n[ \t]/g, "");
  assert.match(unfoldedAttendees, /ATTENDEE;CN=Person One;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;X-PM-TOKEN=[a-f0-9]{40}:mailto:person@example\.test/);
  assert.match(unfoldedAttendees, /ATTENDEE;CN=optional@example\.test;ROLE=OPT-PARTICIPANT;PARTSTAT=TENTATIVE;RSVP=TRUE;X-PM-TOKEN=[a-f0-9]{40}:mailto:optional@example\.test/);
  assert.equal(parts.clearAttendees.length, 2);
  assert.equal(parts.clearAttendees[0].Status, 0);
  assert.equal(parts.clearAttendees[1].Status, 1);
});

test("invite prototype serializes cancel action as METHOD:CANCEL", () => {
  const parts = buildInvitePrototypeParts({
    uid: "evt-123",
    action: "cancel",
    organizerEmail: "owner@example.test",
    attendees: [{ email: "person@example.test" }],
    startDate: "2026-05-20T10:00:00.000Z",
    endDate: "2026-05-20T10:30:00.000Z",
  }, { enabled: true });

  assert.equal(parts.method, "CANCEL");
  assert.match(parts.attendeesEncryptedPart, /METHOD:CANCEL/);
});

test("invite prototype rejects ambiguous attendee lists", () => {
  const base = {
    uid: "evt-123",
    organizerEmail: "owner@example.test",
    startDate: "2026-05-20T10:00:00.000Z",
    endDate: "2026-05-20T10:30:00.000Z",
  };

  assert.throws(
    () => buildInvitePrototypeParts({
      ...base,
      attendees: [{ email: "owner@example.test" }],
    }, { enabled: true }),
    /organizer cannot also be an attendee/
  );

  assert.throws(
    () => buildInvitePrototypeParts({
      ...base,
      attendees: [{ email: "person@example.test" }, { email: "PERSON@example.test" }],
    }, { enabled: true }),
    /duplicate attendees/
  );
});

test("invite prototype attendee tokens are scoped to event uid", () => {
  const base = {
    organizerEmail: "owner@example.test",
    attendees: [{ email: "person@example.test" }],
    startDate: "2026-05-20T10:00:00.000Z",
    endDate: "2026-05-20T10:30:00.000Z",
  };

  const first = buildInvitePrototypeParts({ ...base, uid: "evt-1" }, { enabled: true });
  const second = buildInvitePrototypeParts({ ...base, uid: "evt-2" }, { enabled: true });

  assert.notEqual(first.clearAttendees[0].Token, second.clearAttendees[0].Token);
});
