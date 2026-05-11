export function toBase64(input) {
  return Buffer.from(input).toString("base64");
}

export function fromBase64(value) {
  return Uint8Array.from(Buffer.from(String(value), "base64"));
}
