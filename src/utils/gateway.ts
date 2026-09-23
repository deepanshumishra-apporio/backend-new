// Which stored order gateways count as the ONDC route.
//
// FP has two gateway values that both sound like ONDC, and they are NOT
// aliases: FP stores and routes them separately.
//
//   ondc         the route every order is placed on. The ONDC payment provider
//                (UPI / netbanking `token_url`) is configured for it, and its
//                orders are allotted — `successful`, with a folio number.
//   cybrillapoa  what this platform used to send. The ONDC payment provider
//                refuses its orders (`422 Provider ONDC not configured`) and
//                none of them was ever allotted. Proven on 2026-09-23 with an
//                otherwise identical order and payment.
//
// New orders go out as `ondc`. Orders already stored as CYBRILLAPOA stay
// readable and progressable, so both are accepted wherever the route is checked.
import { OrderGateway } from "../../generated/prisma/enums.ts";

export function isOndcRoute(gateway: string | null | undefined): boolean {
  return gateway === OrderGateway.ONDC || gateway === OrderGateway.CYBRILLAPOA;
}

/**
 * Whether money may be moved for an order on this gateway.
 *
 * Narrower than `isOndcRoute`, on purpose: an old `cybrillapoa` order stays
 * readable, but it is never allotted — so paying for it, confirming it, or
 * debiting a mandate for it takes the investor's money for units that never
 * arrive. It happened: a server still on the old code placed one, the UPI
 * payment was refused (422 "Provider ONDC not configured"), and the AutoPay
 * fallback then debited the mandate for it.
 */
export function canMoveMoney(gateway: string | null | undefined): boolean {
  return gateway === OrderGateway.ONDC;
}

/** What to tell an investor whose order is on a gateway that never completes. */
export const LEGACY_GATEWAY_MESSAGE =
  "This order was placed on an older route that the fund house never completes, so it cannot be paid for or confirmed. Nothing further will happen to it — place a new order instead.";
