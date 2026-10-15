export const SOCIAL_PROVIDERS = ["APPLE", "GOOGLE"] as const;
export type SocialProvider = (typeof SOCIAL_PROVIDERS)[number];

export interface StartSocialSignInInput {
  provider: SocialProvider;
  idToken: string;
  /** The raw nonce the app hashed into the provider request, when it sent one. */
  nonce?: string;
}

export interface SocialSignInDto {
  /** Single use; hand it to POST /sessions with the phone verification. */
  socialToken: string;
  expiresAt: string;
  /** Whether this provider account is already linked to a login. */
  linked: boolean;
  /** The linked login's number, masked, so the app can say which one to verify. */
  phoneHint: string | null;
}

export interface SocialProvidersDto {
  apple: boolean;
  google: boolean;
}
