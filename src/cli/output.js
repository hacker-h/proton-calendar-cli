export function writeOutput(stdout, output, payload) {
  if (output === "json") {
    write(stdout, `${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  if (Array.isArray(payload?.data?.calendars)) {
    write(stdout, formatCalendarTable(payload.data.calendars));
    return;
  }

  const events = Array.isArray(payload?.data?.events) ? payload.data.events : [];
  if (events.length === 0) {
    write(stdout, "No events\n");
    return;
  }

  const lines = ["id\tstart\tend\ttitle\tlocation\tprotected"];
  for (const event of events) {
    lines.push(
      `${event.id || ""}\t${event.start || ""}\t${event.end || ""}\t${event.title || ""}\t${event.location || ""}\t${event.protected === true ? "yes" : "no"}`
    );
  }
  write(stdout, `${lines.join("\n")}\n`);
}

function formatCalendarTable(calendars) {
  if (calendars.length === 0) {
    return "No calendars\n";
  }

  const lines = ["id\tname\tdefault\ttarget\tcolor\tpermissions"];
  for (const calendar of calendars) {
    lines.push(
      `${calendar.id || ""}\t${calendar.name || ""}\t${calendar.default ? "yes" : "no"}\t${calendar.target ? "yes" : "no"}\t${calendar.color || ""}\t${calendar.permissions ?? ""}`
    );
  }
  return `${lines.join("\n")}\n`;
}

export function write(stream, text) {
  stream.write(text);
}
