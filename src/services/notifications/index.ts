import { EmailChannel, InAppChannel } from "./channels.js";
import { NotificationService } from "./NotificationService.js";

let override: NotificationService | undefined;
let cached: NotificationService | undefined;

/** Tests swap in their own channels. */
export function setNotifier(service: NotificationService | undefined) {
  override = service;
}

export function getNotifier(): NotificationService {
  return override ?? (cached ??= new NotificationService([new InAppChannel(), new EmailChannel()]));
}

export { NotificationService } from "./NotificationService.js";
export type { NotificationChannel, NotificationMessage, Recipient } from "./NotificationService.js";
