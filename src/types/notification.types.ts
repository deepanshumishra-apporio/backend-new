export type NotificationCategory = "ORDER" | "PLAN" | "PAYMENT" | "ACTION" | "ACCOUNT" | "MARKET";

export interface NotificationDto {
  id: string;
  category: NotificationCategory;
  title: string;
  body: string;
  /** Where tapping it goes, when anywhere. */
  target: { type: "order" | "plan"; id: string } | null;
  read: boolean;
  /** When the event happened. */
  createdAt: string;
}

export interface NotificationPage {
  data: NotificationDto[];
  unreadCount: number;
  nextCursor: string | null;
}
