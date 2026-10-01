import { describe, expect, test } from 'bun:test';

import { inQuietHours, personalise } from '../src/services/announcement.service.ts';
import { nextStepOf } from '../src/services/investor-facts.service.ts';
import { SLA_HOURS } from '../src/services/support-ticket.service.ts';
import { guardFormula, toCsv } from '../src/utils/csv.ts';
import { queryCursor, queryList, queryString } from '../src/utils/query.ts';
import { maskAccountNumber, maskPan } from '../src/utils/mask.ts';

// Raw SQL hands back FP's wire values (`awaiting_esign`, `successful`), while
// Prisma reads hand back enum names (`AWAITING_ESIGN`). Both must land on the
// same step, or the dashboard and the detail page disagree about one form.
describe('admin KYC next step', () => {
  const form = (status: string, extra: Partial<Parameters<typeof nextStepOf>[0]> = {}) =>
    nextStepOf({ status, proofStatus: null, signatureProvided: false, fieldsNeeded: [], ...extra });

  test('wire values and Prisma names agree', () => {
    for (const [wire, prisma] of [['awaiting_esign', 'AWAITING_ESIGN'], ['created', 'CREATED'], ['under_review', 'UNDER_REVIEW']]) {
      expect(form(wire!)).toBe(form(prisma!));
    }
  });

  test('follows the POA order: details, DigiLocker, signature, esign', () => {
    expect(form('created', { fieldsNeeded: ['occupation'] })).toBe('PROVIDE_DETAILS');
    expect(form('created', { fieldsNeeded: ['identity_proof'] })).toBe('FETCH_PROOF');
    expect(form('created', { proofStatus: 'successful' })).toBe('UPLOAD_SIGNATURE');
    expect(form('awaiting_esign')).toBe('ESIGN');
  });

  test("the provider's turn is WAITING_ON_PROVIDER, not null", () => {
    expect(form('under_review')).toBe('WAITING_ON_PROVIDER');
    expect(form('awaiting_submission')).toBe('WAITING_ON_PROVIDER');
    expect(form('created', { proofStatus: 'SUCCESSFUL', signatureProvided: true })).toBe('WAITING_ON_PROVIDER');
  });

  test('closed forms have no next step', () => {
    for (const status of ['submitted', 'failed', 'expired', null]) expect(form(status as string)).toBeNull();
  });
});

describe('masking', () => {
  test('PAN keeps only the last four', () => {
    expect(maskPan('ABCDE1234F')).toBe('XXXXXX234F');
    expect(maskPan(null)).toBeNull();
  });
  test('account number shows only the stored last four', () => {
    expect(maskAccountNumber('1193')).toBe('XXXXXX1193');
  });
});

describe('report CSV', () => {
  test('quotes commas, quotes and line breaks, and starts with a BOM for Excel', () => {
    const csv = toCsv(['Name', 'Note'], [['Rao, Asha', 'said "hi"\nthen left'], ['Ravi', '']]);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv.slice(1)).toBe('Name,Note\r\n"Rao, Asha","said ""hi""\nthen left"\r\nRavi,\r\n');
  });

  test('an investor-typed name cannot become a spreadsheet formula', () => {
    expect(guardFormula('=HYPERLINK("x")')).toBe('\'=HYPERLINK("x")');
    expect(guardFormula('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(guardFormula('Asha')).toBe('Asha');
  });
});

describe('admin query parsing', () => {
  test('a keyset cursor round-trips, and junk is refused', () => {
    const at = '2026-09-30T10:00:00.000Z';
    const id = '01a0f086-b551-760f-b7ff-b906cfd96e8b';
    const cursor = Buffer.from(`${at}|${id}`).toString('base64url');
    expect(queryCursor({ cursor })).toEqual({ at: new Date(at), id });
    expect(() => queryCursor({ cursor: 'bm90LWEtY3Vyc29y' })).toThrow('cursor is invalid');
  });

  test('lists are upper-cased and checked against what is allowed', () => {
    expect(queryList({ state: 'open, in_progress' }, 'state', ['OPEN', 'IN_PROGRESS'] as const)).toEqual(['OPEN', 'IN_PROGRESS']);
    expect(() => queryList({ state: 'OPEN,NOPE' }, 'state', ['OPEN'] as const)).toThrow();
  });

  test('a repeated parameter is refused rather than silently picking one', () => {
    expect(() => queryString({ q: ['a', 'b'] }, 'q')).toThrow('q must be given once');
  });
});

describe('support SLA', () => {
  test('urgent is tighter than normal, and every priority has a deadline', () => {
    expect(SLA_HOURS.URGENT).toBeLessThan(SLA_HOURS.HIGH);
    expect(SLA_HOURS.HIGH).toBeLessThan(SLA_HOURS.NORMAL);
    expect(SLA_HOURS.NORMAL).toBeLessThan(SLA_HOURS.LOW);
  });
});

describe('announcements', () => {
  test('quiet hours are 21:00 to 08:00 India time', () => {
    // 15:30 UTC = 21:00 IST; 02:29 UTC = 07:59 IST; 02:30 UTC = 08:00 IST.
    expect(inQuietHours(new Date('2026-09-30T15:30:00Z'))).toBe(true);
    expect(inQuietHours(new Date('2026-09-30T02:29:00Z'))).toBe(true);
    expect(inQuietHours(new Date('2026-09-30T02:30:00Z'))).toBe(false);
    expect(inQuietHours(new Date('2026-09-30T10:00:00Z'))).toBe(false);
  });

  test('{{firstName}} fills per investor, with a fallback for an unnamed one', () => {
    expect(personalise('Hi {{firstName}}, {{firstName}}!', 'Asha Rao')).toBe('Hi Asha, Asha!');
    expect(personalise('Hi {{firstName}}', null)).toBe('Hi there');
    expect(personalise('Hi {{firstName}}', '  ')).toBe('Hi there');
  });
});
