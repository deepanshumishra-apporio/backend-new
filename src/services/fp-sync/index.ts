// The mirror. One module per FP object family; every function upserts on the
// FP identifier so a payload can arrive twice and produce one row.
export * from "./identity.sync.ts";
export * from "./account.sync.ts";
export * from "./order.sync.ts";
export * from "./payment.sync.ts";
export * from "./kyc.sync.ts";
