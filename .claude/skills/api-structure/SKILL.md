---
name: api-structure
description: Layered structure for this backend — routes, controllers, services, types, utils. Use whenever adding or changing an API endpoint, a resource, a service method, or a database query in backend/. Triggers on "add endpoint", "new route", "new API", "create service", "add controller", "CRUD", "add a feature to the backend".
---

# API structure

Every feature is built as the same five layers. No shortcuts, no "just this once
in the route file".

## Dependency direction — one way only

```
routes  ->  controllers  ->  services  ->  db (Prisma)
                 |                |
                 +--> types <-----+
                 +--> utils <-----+
```

| Layer | Owns | Must never |
|---|---|---|
| `routes/` | paths, HTTP verbs, middleware order | contain logic, touch Prisma |
| `controllers/` | parse + validate input, set status, shape response | import `db`, contain business rules |
| `services/` | business rules, Prisma queries, return DTOs | see `req`, `res`, or throw HTTP status codes it built itself |
| `types/` | shared interfaces, DTOs, input contracts | import from services or controllers |
| `utils/` | pure, reusable helpers | import from services, controllers, or `db` |

A service that imports `express` is wrong. A controller that imports
`src/db/client.ts` is wrong. Fix the layering, do not add an exception.

## File naming

```
src/routes/fund.routes.ts
src/controllers/fund.controller.ts
src/services/fund.service.ts
src/types/fund.types.ts
src/utils/money.ts
```

Singular resource name + layer suffix. One resource per file. Register every
router in `src/routes/index.ts`.

## Templates

### types

Define the contract first — the input shape and the DTO you return. Never leak a
Prisma model straight out of a service; a schema change would silently reshape
your API.

```ts
export interface CreateOrderInput {
  schemeCode: string;
  amount: string;
  idempotencyKey: string;
}

export interface OrderDto {
  id: string;
  status: OrderStatus;
  amount: string;   // money is always a string — see money.ts
}
```

### service

```ts
import { db } from "../db/client.ts";
import { HttpError } from "../utils/http-error.ts";
import { asAmount } from "../utils/money.ts";
import type { CreateOrderInput, OrderDto } from "../types/order.types.ts";

const select = { id: true, status: true, amount: true } as const;

const toDto = (row: Row): OrderDto => ({ ... });   // always map to a DTO

export async function createOrder(input: CreateOrderInput): Promise<OrderDto> {
  const fund = await db.fund.findUnique({ where: { schemeCode: input.schemeCode } });
  if (!fund) throw HttpError.notFound(`No fund ${input.schemeCode}`);
  // business rules here, not in the controller
}
```

- Always `select` explicitly. Never return whole rows — `select` is your
  API contract and stops PII (`passwordHash`) leaking by accident.
- Multi-write operations go in `db.$transaction`.
- Paginate with a cursor, not `skip`.

### controller

```ts
import type { Request, Response } from "express";
import * as orderService from "../services/order.service.ts";
import { HttpError } from "../utils/http-error.ts";

export async function create(req: Request, res: Response) {
  const body = req.body as Record<string, unknown> | undefined;
  if (typeof body?.["schemeCode"] !== "string") {
    throw HttpError.badRequest("schemeCode is required");
  }
  res.status(201).json({ data: await orderService.createOrder({ ... }) });
}
```

- Validate **everything** off the wire here. Services trust their input.
- Standalone controllers need `Request<{ id: string }>` — params are only
  inferred for inline handlers.
- Response envelope: `{ data }` for success, `{ error: { code, message } }` for
  failure. Be consistent.

### routes

```ts
import { Router } from "express";
import * as order from "../controllers/order.controller.ts";

export const orderRouter = Router();

orderRouter.post("/", order.create);      // Express 5 forwards async rejections
orderRouter.get("/:id", order.getOne);
```

### utils

Pure functions only — same input, same output, no `db`, no `req`. If it needs
either, it belongs in a service.

## Non-negotiables

- **No `any`.** Type it, or use `unknown` and narrow.
- **No secrets in logs.** Connection strings and PII get redacted.
- **Errors:** throw `HttpError` for expected failures. Let unexpected ones reach
  the error handler — never `catch` and return a fake 200.
- **Money is `Decimal` and leaves as a string.** Never `Float`, never a JSON
  number, always `.toFixed(dp)` on the way out.
- **Comment the *why*, not the *what*.** Explain a non-obvious constraint, not
  the line below it.

## Before you say it works

1. `bunx tsc --noEmit` is clean.
2. `bun run db:generate` if the schema changed.
3. Actually run the query/endpoint against the database — do not infer from code.
