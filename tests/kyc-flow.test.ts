import { describe, expect, mock, test } from 'bun:test';
import type { Request, Response } from 'express';
import type { FpKycForm } from '../src/integrations/fp/resources/kyc-forms.ts';

let saved: any;
let mirrored: any;
mock.module('../src/services/kyc.service.ts', () => ({
  updateKycForm: async (_id: string, input: unknown) => { saved = input; return input; },
}));
mock.module('../src/db/client.ts', () => ({ db: {
  kycForm: { upsert: async (args: unknown) => { mirrored = args; return { id: 'local-1' }; } },
} }));
const { updateForm } = await import('../src/controllers/kyc.controller.ts');
const { syncKycForm } = await import('../src/services/fp-sync/kyc.sync.ts');
const response = { json: () => undefined } as unknown as Response;
const request = (body: unknown) => ({ body, params: { formId: 'local-1' } }) as Request<{ formId: string }>;

describe('POA KYC contract', () => {
  test('mobile nested phone, location and foreign residency reach the service', async () => {
    await updateForm(request({
      mobile: { isd: '+91', number: '9876543210' },
      geolocation: { latitude: 12.97, longitude: 77.59 },
      occupationType: 'private_sector_service',
      taxResidencyOtherThanIndia: false,
      nonIndianTaxResidency1: { country: 'us', taxIdNumber: '123456789' },
    }), response);
    expect(saved.mobile).toEqual({ isd: '+91', number: '9876543210' });
    expect(saved.geolocation).toEqual({ latitude: 12.97, longitude: 77.59 });
    expect(saved.taxResidencyOtherThanIndia).toBe(false);
    expect(saved.occupationType).toBe('private_sector_service');
    // Lower case, as the form's own documented payloads spell country codes.
    expect(saved.nonIndianTaxResidency1).toEqual({ country: 'us', taxIdNumber: '123456789' });
  });
  test('a device fix is trimmed to the six decimal places the form allows', async () => {
    // Anything longer is refused outright with "geolocation values must not
    // exceed 6 decimal places", which fails the whole details submission.
    await updateForm(request({
      geolocation: { latitude: 12.9715987654321, longitude: 77.5945627182818 },
    }), response);
    expect(saved.geolocation).toEqual({ latitude: 12.971599, longitude: 77.594563 });
    for (const value of Object.values(saved.geolocation as Record<string, number>)) {
      expect(String(value).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(6);
    }
  });
  test('legacy flat phone fields remain accepted', async () => {
    await updateForm(request({ mobileIsd: '91', mobileNumber: '9876543210' }), response);
    expect(saved.mobile).toEqual({ isd: '91', number: '9876543210' });
  });
  test('rejects incomplete or impossible location coordinates', async () => {
    for (const geolocation of [{ latitude: 12 }, { latitude: 100, longitude: 77 }, { latitude: 12, longitude: Infinity }]) {
      await expect(updateForm(request({ geolocation }), response)).rejects.toThrow('valid latitude');
    }
  });
  test('a fetched POA proof is stored as successful, preserving the next step', async () => {
    await syncKycForm({
      id: 'kycf_test', type: 'fresh', status: 'created', pan: 'AAAPA3753A',
      name: 'Test Investor', date_of_birth: '1990-01-01',
      proof_details: { fetch_url: null, status: 'fetched' },
      signature_provided: false, requirements: { fields_needed: ['signature'] },
    } as FpKycForm, { userId: 'investor-1' });
    expect(mirrored.update.proofStatus).toBe('SUCCESSFUL');
    expect(mirrored.update.userId).toBe('investor-1');
  });
});
