import { InAppChannel, pickEmailChannel } from "./channels.js";
import { NotificationService } from "./NotificationService.js";
let override;
let cached;
/** Tests swap in their own channels. */
export function setNotifier(service) {
    override = service;
}
export function getNotifier() {
    return override ?? (cached ??= new NotificationService([new InAppChannel(), pickEmailChannel()]));
}
export { NotificationService } from "./NotificationService.js";
