import { randomInt } from "node:crypto";

// No 0/O, 1/l/I: an issued password is read off a screen and typed by hand.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

/** Four groups of four, e.g. `Kp7r-Qm2x-Ht9c-Ws4n` — about 95 bits. */
export function temporaryPassword(): string {
  const groups = Array.from({ length: 4 }, () =>
    Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join(""),
  );
  return groups.join("-");
}
