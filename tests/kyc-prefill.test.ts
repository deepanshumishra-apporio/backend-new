import { describe, expect, test } from 'bun:test';
import type { FpKycForm } from '../src/integrations/fp/resources/kyc-forms.ts';
import { kycFormToProfileFields } from '../src/services/kyc-prefill.service.ts';

function form(overrides: Partial<FpKycForm> = {}): FpKycForm {
  return {
    object: 'kyc_form',
    id: 'kycf_1',
    type: 'fresh',
    status: 'submitted',
    reason: null,
    pan: 'BCDPQ3753F',
    name: 'Rahul Sharma',
    date_of_birth: '1992-05-12',
    email_address: null,
    phone_number: null,
    proof_details: null,
    proof_details_callback_url: null,
    esign_callback_url: null,
    identity: null,
    address: null,
    requirements: null,
    signature_provided: true,
    gender: null,
    marital_status: null,
    father_name: null,
    spouse_name: null,
    occupation_type: null,
    aadhaar_number: null,
    citizenship_countries: null,
    nationality_country: null,
    country_of_birth: null,
    place_of_birth: null,
    income_slab: null,
    pep_details: null,
    residential_status: null,
    tax_residency_other_than_india: null,
    non_indian_tax_residency_1: null,
    non_indian_tax_residency_2: null,
    non_indian_tax_residency_3: null,
    geolocation: null,
    esign_details: null,
    created_at: '2026-09-15T17:13:00Z',
    updated_at: '2026-09-15T17:13:00Z',
    review_completed_at: null,
    awaiting_esign_at: null,
    awaiting_submission_at: null,
    submitted_at: null,
    failed_at: null,
    expires_at: null,
    ...overrides,
  } as FpKycForm;
}

describe('kycFormToProfileFields', () => {
  test('carries the identity across', () => {
    expect(kycFormToProfileFields(form())).toMatchObject({
      pan: 'BCDPQ3753F',
      name: 'Rahul Sharma',
      dateOfBirth: '1992-05-12',
      taxStatus: 'resident_individual',
    });
  });

  test('translates marital status — the profile has no "unmarried"', () => {
    // /v2/investor_profiles answers "should be one of married, single, others"
    // and rejects the whole create, so this one value decides whether an
    // unmarried investor can open a profile at all.
    expect(kycFormToProfileFields(form({ marital_status: 'unmarried' })).maritalStatus)
      .toBe('single');
    expect(kycFormToProfileFields(form({ marital_status: 'married' })).maritalStatus)
      .toBe('married');
    expect(kycFormToProfileFields(form({ marital_status: 'others' })).maritalStatus)
      .toBe('others');
  });

  test('translates PEP, which shares no value between the two objects', () => {
    expect(kycFormToProfileFields(form({ pep_details: 'no_exposure' })).pepDetails)
      .toBe('not_applicable');
    expect(kycFormToProfileFields(form({ pep_details: 'pep' })).pepDetails)
      .toBe('pep_exposed');
    expect(kycFormToProfileFields(form({ pep_details: 'related_pep' })).pepDetails)
      .toBe('pep_related');
  });

  test('translates the occupations that are spelled differently', () => {
    expect(kycFormToProfileFields(form({ occupation_type: 'housewife' })).occupation)
      .toBe('house_wife');
    expect(kycFormToProfileFields(form({ occupation_type: 'private_sector' })).occupation)
      .toBe('private_sector_service');
    // Already the profile's spelling — passed through, not mangled.
    expect(kycFormToProfileFields(form({ occupation_type: 'professional' })).occupation)
      .toBe('professional');
  });

  test('drops a value the profile endpoint would reject', () => {
    // Passing it through fails the whole create over one field; leaving it out
    // lets the investor pick it themselves.
    expect(kycFormToProfileFields(form({ occupation_type: 'astronaut' })).occupation)
      .toBeUndefined();
    expect(kycFormToProfileFields(form({ gender: 'unspecified' })).gender)
      .toBeUndefined();
    expect(kycFormToProfileFields(form({ income_slab: 'above_50cr' })).incomeSlab)
      .toBeUndefined();
  });

  test('lower-cases country codes and drops malformed ones', () => {
    const mapped = kycFormToProfileFields(
      form({ country_of_birth: 'IN', nationality_country: 'IN', citizenship_countries: ['IN', 'bad'] }),
    );
    expect(mapped.countryOfBirth).toBe('in');
    expect(mapped.nationalityCountry).toBe('in');
    expect(mapped.citizenshipCountries).toEqual(['in']);
  });

  test('omits every field the form left blank', () => {
    const mapped = kycFormToProfileFields(form());
    expect('gender' in mapped).toBe(false);
    expect('fatherName' in mapped).toBe(false);
    expect('citizenshipCountries' in mapped).toBe(false);
    expect('email' in mapped).toBe(false);
  });

  test('never carries an address — the form does not return one', () => {
    // DigiLocker gives FP the address but /poa/kyc_forms exposes only
    // address.proof_type, so the address card still has to ask.
    expect(kycFormToProfileFields(form())).not.toHaveProperty('line1');
    expect(kycFormToProfileFields(form())).not.toHaveProperty('postalCode');
  });

  test('takes the mobile number without its country code', () => {
    const mapped = kycFormToProfileFields(
      form({ email_address: 'a@b.com', phone_number: { isd: '+91', number: '9876543210' } }),
    );
    expect(mapped.email).toBe('a@b.com');
    expect(mapped.mobile).toBe('9876543210');
  });
});
