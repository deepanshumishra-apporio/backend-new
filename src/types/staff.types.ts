/**
 * Every permission the code checks. The `permissions` table is seeded from
 * this list by migration; a key added here needs that migration too, or no
 * role can ever hold it. That migration should grant it to SUPER_ADMIN and
 * SUB_ADMIN, who are meant to hold everything.
 */
export const PERMISSIONS = [
  "dashboard.read", "investors.read", "reports.read", "transactions.read", "support.manage", "compliance.manage", "announcements.manage",
  "portfolios.manage", "meetings.manage", "staff.manage", "roles.manage",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/**
 * Where a session stands on MFA.
 * - SETUP_REQUIRED   no confirmed authenticator yet: enrol one
 * - VERIFY_REQUIRED  enter a code from the enrolled authenticator
 * - VERIFIED         a full session
 */
export type MfaState = "SETUP_REQUIRED" | "VERIFY_REQUIRED" | "VERIFIED";

/** What `authenticateStaff` resolves a bearer token to. */
export interface StaffPrincipal {
  staffId: string;
  sessionId: string;
  email: string;
  permissions: Permission[];
  mfa: MfaState;
  mustChangePassword: boolean;
}

export interface StaffLoginInput {
  email: string;
  password: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface StaffSessionDto {
  accessToken: string;
  tokenType: "Bearer";
  expiresAt: string;
  mfa: MfaState;
}

export interface StaffSessionStateDto {
  expiresAt: string;
  mfa: MfaState;
  mustChangePassword: boolean;
}

export interface MfaSetupDto {
  /** Base32, for typing into an authenticator by hand. */
  secret: string;
  /** otpauth:// URI, for a QR code. */
  otpauthUri: string;
}

export interface StaffMeDto {
  id: string;
  email: string;
  fullName: string;
  roles: { key: string; name: string }[];
  permissions: Permission[];
  mustChangePassword: boolean;
  lastLoginAt: string | null;
}

export interface CreateStaffInput {
  email: string;
  fullName: string;
  phone?: string;
  password: string;
  roleKeys: string[];
  /** Off only for service accounts. */
  mfaRequired: boolean;
}

// --- staff management (the portal's Staff screens) -----------------------------

export type StaffStatusValue = "ACTIVE" | "SUSPENDED" | "DEACTIVATED";

export interface RoleDto {
  key: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: Permission[];
  staffCount: number;
}

export interface StaffListItemDto {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  status: StaffStatusValue;
  roles: { key: string; name: string }[];
  mfaEnrolled: boolean;
  locked: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface StaffDetailDto extends StaffListItemDto {
  createdBy: { id: string; fullName: string } | null;
  deactivatedAt: string | null;
  activeSessions: number;
  recentLogins: { outcome: string; ipAddress: string | null; userAgent: string | null; at: string }[];
}

/** Shown once to whoever created or reset the account; only its hash is stored. */
export interface TemporaryPasswordDto {
  staff: StaffListItemDto;
  temporaryPassword: string;
}

export interface CreateStaffByAdminInput {
  email: string;
  fullName: string;
  phone?: string;
  roleKeys: string[];
}

// --- Role Manager (the `roles.manage` permission) ---------------------------------

export interface PermissionDto {
  key: Permission;
  description: string;
}

export interface CreateRoleInput {
  name: string;
  description: string | null;
  permissions: Permission[];
}

export interface UpdateRoleInput {
  name?: string;
  description?: string | null;
  permissions?: Permission[];
}

export interface UpdateStaffInput {
  fullName?: string;
  phone?: string | null;
  roleKeys?: string[];
}
