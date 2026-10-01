// Contracts for announcements: messages the business sends to investors.

export const ANNOUNCEMENT_CATEGORIES = ["PROMOTIONAL", "INFORMATIONAL"] as const;
export type AnnouncementCategory = (typeof ANNOUNCEMENT_CATEGORIES)[number];

export const ANNOUNCEMENT_AUDIENCES = [
  "ALL_INVESTORS", "KYC_PENDING", "READY_NOT_INVESTED", "INVESTED", "ACTIVE_SIP", "NO_SIP",
] as const;
export type AnnouncementAudience = (typeof ANNOUNCEMENT_AUDIENCES)[number];

export const ANNOUNCEMENT_STATUSES = [
  "DRAFT", "PENDING_APPROVAL", "REJECTED", "SCHEDULED", "LIVE", "COMPLETED", "CANCELLED",
] as const;
export type AnnouncementStatus = (typeof ANNOUNCEMENT_STATUSES)[number];

/** Where a banner's call to action goes in the app. */
export const CTA_ACTIONS = ["start_sip", "invest", "sips", "none"] as const;
export type CtaAction = (typeof CTA_ACTIONS)[number];

/** What staff write; validated by the controller. */
export interface AnnouncementInput {
  name: string;
  category: AnnouncementCategory;
  audience: AnnouncementAudience;
  title: string;
  body: string;
  sendNotification: boolean;
  showBanner: boolean;
  tag: string | null;
  bannerTitle: string | null;
  bannerBody: string | null;
  highlight: string | null;
  ctaLabel: string | null;
  ctaAction: CtaAction | null;
  startsAt: Date;
  endsAt: Date | null;
}

export interface AnnouncementListItemDto {
  id: string;
  name: string;
  category: AnnouncementCategory;
  audience: AnnouncementAudience;
  status: AnnouncementStatus;
  title: string;
  sendNotification: boolean;
  showBanner: boolean;
  startsAt: string;
  endsAt: string | null;
  createdBy: { id: string; name: string } | null;
  approvedBy: { id: string; name: string } | null;
  sentAt: string | null;
  deliveredCount: number;
  createdAt: string;
}

export interface AnnouncementStatsDto {
  targeted: number;
  delivered: number;
  optedOut: number;
  capped: number;
  /** Notifications the investor opened. */
  read: number;
  /** Investors who saw the banner's modal, and who tapped its call to action. */
  bannerSeen: number;
  bannerClicked: number;
}

export interface AnnouncementDetailDto extends AnnouncementListItemDto {
  body: string;
  tag: string | null;
  bannerTitle: string | null;
  bannerBody: string | null;
  highlight: string | null;
  ctaLabel: string | null;
  ctaAction: CtaAction | null;
  submittedAt: string | null;
  approvedAt: string | null;
  rejectionReason: string | null;
  cancelledAt: string | null;
  stats: AnnouncementStatsDto;
  /** What the viewer may do now, so the screen shows only the buttons that will work. */
  can: { edit: boolean; submit: boolean; approve: boolean; reject: boolean; cancel: boolean; end: boolean };
}

export interface AnnouncementListDto {
  items: AnnouncementListItemDto[];
  summary: { drafts: number; awaitingApproval: number; scheduled: number; live: number };
}

/** How many investors a draft would reach, before it is sent. */
export interface AudienceReachDto {
  matched: number;
  optedOut: number;
  reachable: number;
}

/** The banner the investor's app should show now, if any. */
export interface ActiveBannerDto {
  id: string;
  tag: string;
  title: string;
  body: string;
  highlight: string | null;
  bannerTitle: string;
  bannerBody: string;
  ctaLabel: string | null;
  ctaAction: CtaAction;
  seen: boolean;
}
