// Review meetings: a recorded conversation with an investor and the risk
// profile it leads to. The record is the evidence behind any change to the
// investor's curated portfolio.
import type { StaffRefDto, TicketInvestorDto } from "./support.types.ts";

export const MEETING_MODES = ["IN_PERSON", "VIDEO", "PHONE"] as const;
export type MeetingMode = (typeof MEETING_MODES)[number];

export const RISK_PROFILES = ["CONSERVATIVE", "MODERATE", "AGGRESSIVE"] as const;
export type RiskProfile = (typeof RISK_PROFILES)[number];

export const MEETING_STATUSES = ["SCHEDULED", "CAPTURED", "PROFILE_UPDATED"] as const;
export type MeetingStatus = (typeof MEETING_STATUSES)[number];

export interface ReviewMeetingDto {
  id: string;
  investor: TicketInvestorDto;
  conductedBy: StaffRefDto;
  recordedBy: StaffRefDto;
  mode: MeetingMode;
  /** yyyy-mm-dd */
  meetingDate: string;
  currentProfile: RiskProfile;
  recommendedProfile: RiskProfile;
  status: MeetingStatus;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewMeetingListDto {
  items: ReviewMeetingDto[];
  nextCursor: string | null;
  counts: Record<MeetingStatus, number>;
}

export interface ReviewMeetingListQuery {
  limit: number;
  status?: MeetingStatus;
  userId?: string;
  cursor?: string;
}

export interface CreateReviewMeetingInput {
  userId: string;
  /** Defaults to the staff member recording it. */
  conductedByStaffId?: string;
  mode: MeetingMode;
  meetingDate: string;
  currentProfile: RiskProfile;
  recommendedProfile: RiskProfile;
  notes: string;
}

/** After a meeting is written only its status and notes move (see the schema). */
export interface UpdateReviewMeetingInput {
  status?: MeetingStatus;
  notes?: string;
}

export interface MeetingInvestorOptionDto {
  id: string;
  name: string | null;
  phone: string | null;
}
