import { beforeEach, expect, mock, test } from 'bun:test';

let account: any = null;
let lookups = 0;
mock.module('../src/db/client.ts', () => ({ db: {
  user: { findUnique: async ({ where }: any) => {
    lookups++;
    expect(where.email).toBe('person@example.com');
    return account;
  } },
} }));
const { sessionRouter } = await import('../src/middleware/investor-auth.ts');
const handler = sessionRouter.stack.find((layer: any) => layer.route?.path === '/sandbox/email/verify')!.route!.stack[0]!.handle;
const call = async (body: any) => {
  let response: any;
  const res: any = { setHeader: () => {}, json: (value: any) => { response = value.data; } };
  await (handler as any)({ body }, res);
  return response;
};
beforeEach(() => {
  process.env.NODE_ENV = 'test';
  process.env.SANDBOX_AUTH_ENABLED = 'true';
  process.env.FP_BASE_URL = 'https://s.finprim.com';
  account = null;
  lookups = 0;
});
const input = { email: ' Person@Example.com ', otp: '1234' };
test('new verified email requires phone entry', async () => {
  expect(await call(input)).toEqual({ existing: false, phone: null });
});
test('existing verified email resolves its linked phone', async () => {
  account = { id: 'a', role: 'INVESTOR', status: 'ACTIVE', phone: '+919876543210', emailVerifiedAt: new Date() };
  expect(await call(input)).toEqual({ existing: true, phone: account.phone });
});
test('previous sandbox signup can sign back in without real verification timestamps', async () => {
  account = { role: 'INVESTOR', status: 'ACTIVE', phone: '+919876543210', emailVerifiedAt: null };
  expect((await call(input)).phone).toBe(account.phone);
});
test('wrong OTP never looks up or reveals the linked phone', async () => {
  await expect(call({ ...input, otp: '9999' })).rejects.toMatchObject({ code: 'INVALID_OTP' });
  expect(lookups).toBe(0);
});
test('blocked, deleted and non-investor accounts cannot continue', async () => {
  for (const override of [{ status: 'SUSPENDED' }, { deletedAt: new Date() }, { role: 'ADMIN' }]) {
    account = { role: 'INVESTOR', status: 'ACTIVE', phone: '+919876543210', ...override };
    await expect(call(input)).rejects.toMatchObject({ code: 'ACCOUNT_UNAVAILABLE' });
  }
});
test('production cannot use hardcoded email verification', async () => {
  process.env.NODE_ENV = 'production';
  await expect(call(input)).rejects.toMatchObject({ status: 404 });
  expect(lookups).toBe(0);
});
