// The fulfilment lifecycle of ONE sub-order (one vendor, one delivery). Who may move it where lives
// here and nowhere else; every route that changes a status goes through `assertTransition`.
export const ORDER_STATUSES = [
    "PENDING_PAYMENT",
    "PAID",
    "READY_FOR_PICKUP",
    "PICKED_UP",
    "DELIVERED",
    "COMPLETED",
    "CANCELLED",
    "FAILED_DELIVERY",
];
const RULES = [
    { from: "PENDING_PAYMENT", to: "PAID", actors: ["SYSTEM"] },
    { from: "PENDING_PAYMENT", to: "CANCELLED", actors: ["SYSTEM", "CUSTOMER"] },
    { from: "PAID", to: "READY_FOR_PICKUP", actors: ["VENDOR"] },
    { from: "PAID", to: "CANCELLED", actors: ["ADMIN"] },
    { from: "READY_FOR_PICKUP", to: "PICKED_UP", actors: ["HANDLER"] },
    { from: "READY_FOR_PICKUP", to: "CANCELLED", actors: ["ADMIN"] },
    { from: "PICKED_UP", to: "DELIVERED", actors: ["HANDLER"] },
    { from: "PICKED_UP", to: "FAILED_DELIVERY", actors: ["HANDLER"] },
    { from: "FAILED_DELIVERY", to: "PICKED_UP", actors: ["ADMIN"] }, // retry the delivery
    { from: "FAILED_DELIVERY", to: "CANCELLED", actors: ["ADMIN"] },
    { from: "DELIVERED", to: "COMPLETED", actors: ["SYSTEM"] }, // when the hold after deliveredAt ends
];
export const TERMINAL = ["COMPLETED", "CANCELLED"];
export function canTransition(from, to, actor) {
    return RULES.some((r) => r.from === from && r.to === to && r.actors.includes(actor));
}
/** Every status a given actor could move a sub-order to from `from`. */
export function allowedNext(from, actor) {
    return RULES.filter((r) => r.from === from && r.actors.includes(actor)).map((r) => r.to);
}
export class TransitionError extends Error {
    from;
    to;
    actor;
    constructor(from, to, actor) {
        super(`${actor} cannot move an order from ${from} to ${to}`);
        this.from = from;
        this.to = to;
        this.actor = actor;
        this.name = "TransitionError";
    }
}
export function assertTransition(from, to, actor) {
    if (!canTransition(from, to, actor))
        throw new TransitionError(from, to, actor);
}
