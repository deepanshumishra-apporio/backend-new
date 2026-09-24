import { beforeEach, expect, mock, test } from 'bun:test';

process.env.NODE_ENV = 'test';
process.env.OTP_DEV_CODE = '123456';
process.env.OTP_LENGTH = '6';
let latest: any;
let created: any;
let retired = 0;
mock.module('../src/db/client.ts', () => ({ db: {
  phoneVerification: {
    findFirst: async () => latest,
    aggregate: async () => ({ _sum: { sendCount: 0 } }),
    updateMany: async () => { retired++; return { count: 1 }; },
    create: async ({ data }: any) => { created = { id: 'new-challenge', ...data }; return created; },
    update: async ({ data }: any) => ({ ...created, ...data }),
  },
  auditLog: { create: async () => ({}) },
} }));
const { requestOtp } = await import('../src/services/otp.service.ts');
const input = { phone: '+919832684913', purpose: 'TRANSACTION_APPROVAL' as const, context: 'plan:test-plan' };
beforeEach(() => {
  latest = { id: 'old', status: 'PENDING', purpose: 'TRANSACTION_APPROVAL', context: null,
    expiresAt: new Date(Date.now() + 600000), lastSentAt: new Date(), lockedUntil: null };
  created = undefined;
  retired = 0;
});
test('replaces an unbound legacy transaction OTP with a new context-bound challenge', async () => {
  await requestOtp(input);
  expect(retired).toBe(1);
  expect(created.context).toBe('plan:test-plan');
  expect(created.purpose).toBe('TRANSACTION_APPROVAL');
});
test('never rebinds a challenge belonging to another plan — it is retired and a new one issued', async () => {
  // The investor backed out of another plan and started this one: the old code
  // is expired (it can no longer authorise anything) rather than reused here,
  // and rather than leaving them locked out until it lapses.
  latest.context = 'plan:another-plan';
  await requestOtp(input);
  expect(retired).toBe(1);
  expect(created.id).toBe('new-challenge');
  expect(created.context).toBe('plan:test-plan');
});
test('a pending login challenge still blocks a transaction code', async () => {
  latest.purpose = 'LOGIN';
  latest.context = null;
  await expect(requestOtp(input)).rejects.toThrow('current OTP challenge');
  expect(retired).toBe(0);
  expect(created).toBeUndefined();
});
test('legacy challenge recovery preserves lockout protection', async () => {
  latest.lockedUntil = new Date(Date.now() + 600000);
  await expect(requestOtp(input)).rejects.toThrow('Too many incorrect attempts');
  expect(retired).toBe(0);
  expect(created).toBeUndefined();
});
test('a completed SIP challenge does not leak into the next SIP', async () => {
  latest.status = 'VERIFIED';
  latest.context = 'plan:previous-plan';
  await requestOtp(input);
  expect(retired).toBe(0);
  expect(created.context).toBe('plan:test-plan');
});
