// Authenticated encryption for small secrets at rest (AES-256-GCM). Pure: the
// key is a parameter, so where it comes from is the caller's concern.
//
// Layout: version(1) | iv(12) | tag(16) | ciphertext. The version byte leaves
// room to rotate the algorithm or key without guessing what old rows used.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = 1;

export function seal(plaintext: Uint8Array, key: Uint8Array): Buffer {
  if (key.length !== 32) throw new Error("secret-box key must be 32 bytes");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
}

export function open(box: Uint8Array, key: Uint8Array): Buffer {
  if (key.length !== 32) throw new Error("secret-box key must be 32 bytes");
  const data = Buffer.from(box);
  if (data[0] !== VERSION || data.length < 29) throw new Error("Unrecognised secret-box format");
  const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(1, 13));
  decipher.setAuthTag(data.subarray(13, 29));
  return Buffer.concat([decipher.update(data.subarray(29)), decipher.final()]);
}
