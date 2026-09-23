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
