import { describe, expect, test } from 'bun:test';

import { open, seal } from '../src/utils/secret-box.ts';
import { bearerToken, newSessionToken } from '../src/utils/session-token.ts';
import { base32Decode, base32Encode, timeStep, totpAt, verifyTotp } from '../src/utils/totp.ts';

// RFC 6238 appendix B, SHA-1 seed. The RFC prints 8 digits; a 6-digit code is
// the same truncation mod 10^6, i.e. the last six.
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');
const at = (seconds: number) => new Date(seconds * 1000);

describe('TOTP', () => {
  test('matches the RFC 6238 test vectors', () => {
    expect(totpAt(RFC_SECRET, timeStep(at(59)))).toBe('287082');
    expect(totpAt(RFC_SECRET, timeStep(at(1111111109)))).toBe('081804');
    expect(totpAt(RFC_SECRET, timeStep(at(1234567890)))).toBe('005924');
    expect(totpAt(RFC_SECRET, timeStep(at(2000000000)))).toBe('279037');
  });

  test('accepts one step of drift either side, not two', () => {
    const now = at(1234567890);
    const step = timeStep(now);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step - 1), now, null)).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step + 1), now, null)).toBe(step + 1);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step - 2), now, null)).toBeNull();
  });

  test('a used code, or an older one, is never accepted again', () => {
    const now = at(1234567890);
    const step = timeStep(now);
    const code = totpAt(RFC_SECRET, step);
    expect(verifyTotp(RFC_SECRET, code, now, step)).toBeNull();
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step - 1), now, step)).toBeNull();
  });

  test('rejects anything that is not six digits', () => {
    for (const code of ['', '12345', '1234567', 'abcdef', '12 345']) {
      expect(verifyTotp(RFC_SECRET, code, at(59), null)).toBeNull();
    }
  });

  test('base32 round-trips (authenticator apps read this form)', () => {
    expect(base32Encode(Buffer.from('12345678901234567890'))).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ').toString()).toBe('12345678901234567890');
  });
});

describe('secret box', () => {
  const key = Buffer.alloc(32, 7);

  test('round-trips and never repeats a ciphertext', () => {
    const a = seal(RFC_SECRET, key);
    expect(open(a, key).equals(RFC_SECRET)).toBe(true);
    expect(seal(RFC_SECRET, key).equals(a)).toBe(false);
  });

  test('a wrong key or a tampered box fails loudly', () => {
    const box = seal(RFC_SECRET, key);
    expect(() => open(box, Buffer.alloc(32, 8))).toThrow();
    const tampered = Buffer.from(box);
    tampered[tampered.length - 1]! ^= 1;
    expect(() => open(tampered, key)).toThrow();
  });
});

describe('bearer tokens', () => {
  test('only a well-formed 43-character token is read', () => {
    const token = newSessionToken();
    expect(bearerToken(`Bearer ${token}`)).toBe(token);
    expect(bearerToken(token)).toBeNull();
    expect(bearerToken(`Bearer ${token}x`)).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });
});
