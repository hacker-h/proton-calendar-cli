import * as openpgp from "openpgp";
import { ApiError } from "../../errors.js";
import { fromBase64 } from "./base64.js";

const LEGACY_PROTON_SESSION_BLOB_IV_BYTES = 16;

export async function decryptPersistedSessionKeyPassword({ clientKeyBase64, persistedBlobBase64 }) {
  if (!clientKeyBase64 || !persistedBlobBase64) {
    throw new ApiError(401, "SESSION_BLOB_MISSING", "Missing client key or persisted session blob");
  }

  const keyBytes = fromBase64(clientKeyBase64);
  const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);

  const blobBytes = fromBase64(persistedBlobBase64);
  // Proton persisted sessions still use the legacy WebClients sessionBlobCryptoHelper
  // format: encryptDataWith16ByteIV()/decryptData(..., true). V3 helpers use the
  // standard 12-byte AES-GCM IV, but persisted `blob` storage does not.
  const iv = blobBytes.slice(0, LEGACY_PROTON_SESSION_BLOB_IV_BYTES);
  const ciphertext = blobBytes.slice(LEGACY_PROTON_SESSION_BLOB_IV_BYTES);

  let decrypted;
  try {
    decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, ciphertext);
  } catch {
    throw new ApiError(401, "SESSION_BLOB_INVALID", "Unable to decrypt persisted session blob");
  }

  const parsed = JSON.parse(new TextDecoder().decode(new Uint8Array(decrypted)));
  const keyPassword = parsed?.keyPassword;
  if (typeof keyPassword !== "string" || keyPassword.length === 0) {
    throw new ApiError(401, "SESSION_BLOB_INVALID", "Persisted session does not contain keyPassword");
  }
  return keyPassword;
}

export async function decryptAddressPassphrase({ token, signature, userPrivateKey, userPublicKey, fallbackPassphrase }) {
  if (!token) {
    return fallbackPassphrase;
  }

  const message = await openpgp.readMessage({ armoredMessage: token });
  const signatureObject = signature
    ? await openpgp.readSignature({ armoredSignature: signature }).catch(() => undefined)
    : undefined;

  const decrypted = await openpgp.decrypt({
    message,
    decryptionKeys: userPrivateKey,
    verificationKeys: userPublicKey,
    ...(signatureObject ? { signature: signatureObject } : {}),
    format: "utf8",
  });

  if (decrypted.signatures?.length > 0) {
    await decrypted.signatures[0].verified;
  }

  return String(decrypted.data);
}

export async function decryptSymmetricMessageUtf8(encryptedBase64, sessionKey) {
  const message = await openpgp.readMessage({ binaryMessage: fromBase64(encryptedBase64) });
  const result = await openpgp.decrypt({
    message,
    sessionKeys: [sessionKey],
    format: "utf8",
  });
  return String(result.data);
}
