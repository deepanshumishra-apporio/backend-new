export interface MarketStatusDto {
  /** Today in India, YYYY-MM-DD. */
  today: string;
  /** A business day: a weekday that is not an exchange holiday. */
  open: boolean;
  reason: "holiday" | "weekend" | null;
  holiday: { date: string; name: string } | null;
  /** A business day, but past the usual 3 PM cut-off. */
  afterCutoff: boolean;
  /** The NAV date an order placed now would usually be processed at. */
  navDate: string;
  nextBusinessDay: string;
  /** The next weekday holiday within about two months. */
  upcomingHoliday: { date: string; name: string } | null;
}
