import { describe, expect, test } from 'bun:test';

import {
  kycNextAction,
  outstandingInvestorFields,
  ProviderSuppliedFields,
  type KycStepState,
} from '../src/utils/kyc-steps.ts';

const state = (overrides: Partial<KycStepState> = {}): KycStepState => ({
  status: 'CREATED',
  fieldsNeeded: [],
  proofStatus: 'PENDING',
  signatureProvided: false,
  ...overrides,
});

describe('POA fields_needed', () => {
  test('only DigiLocker and the signature upload are provider-managed', () => {
    expect([...ProviderSuppliedFields].sort()).toEqual([
      'address',
      'identity_proof',
      'signature',
    ]);
  });

  test('geolocation is the investor to supply, not the provider', () => {
    // The details screen asks for location permission and sends the fix, so
    // treating it as provider-managed left a form that could never complete.
    expect(outstandingInvestorFields(['geolocation'])).toEqual(['geolocation']);
  });

  test('provider-managed requirements are not counted as form fields', () => {
    expect(outstandingInvestorFields(['identity_proof', 'address', 'signature'])).toEqual([]);
    expect(outstandingInvestorFields(['address', 'gender'])).toEqual(['gender']);
  });
});

describe('kycNextAction', () => {
  test('asks for outstanding details before DigiLocker', () => {
    // The documented order. proofStatus is PENDING from the moment a form is
    // created, so leading with the proof made this step unreachable.
    expect(kycNextAction(state({ fieldsNeeded: ['gender', 'identity_proof'] }))).toBe(
      'PROVIDE_DETAILS',
    );
  });

  test('sends the investor to DigiLocker once the details are in', () => {
    expect(kycNextAction(state({ fieldsNeeded: ['identity_proof', 'address'] }))).toBe(
      'FETCH_PROOF',
    );
  });

  test('keeps asking for the proof while the fetch has not succeeded', () => {
    for (const proofStatus of ['PENDING', 'FAILED', 'EXPIRED', null]) {
      expect(kycNextAction(state({ proofStatus }))).toBe('FETCH_PROOF');
    }
  });

  test('asks for the signature only after the proof is fetched', () => {
    expect(kycNextAction(state({ proofStatus: 'SUCCESSFUL' }))).toBe('UPLOAD_SIGNATURE');
  });

  test('owes nothing once everything the investor supplies is in', () => {
    // The form is complete; POA has yet to move it to awaiting_esign.
    expect(
      kycNextAction(state({ proofStatus: 'SUCCESSFUL', signatureProvided: true })),
    ).toBeNull();
  });

  test('signs once the provider says the form is ready for it', () => {
    expect(kycNextAction(state({ status: 'AWAITING_ESIGN' }))).toBe('ESIGN');
  });

  test('owes nothing in a state the investor cannot act on', () => {
    for (const status of [
      'UNDER_REVIEW',
      'AWAITING_SUBMISSION',
      'SUBMITTED',
      'FAILED',
      'EXPIRED',
    ]) {
      expect(kycNextAction(state({ status, fieldsNeeded: ['gender'] }))).toBeNull();
    }
  });
});
