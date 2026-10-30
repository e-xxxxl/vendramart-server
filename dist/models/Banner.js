import { Schema, model } from "mongoose";
/** HERO slides rotate in the carousel, SIDE tiles sit beside it, STRIP banners are the campaign row further down. */
export const BANNER_PLACEMENTS = ["HERO", "SIDE", "STRIP"];
const bannerSchema = new Schema({
    placement: { type: String, enum: BANNER_PLACEMENTS, required: true, default: "HERO", index: true },
    title: { type: String, required: true, trim: true, maxlength: 80 },
    subtitle: { type: String, trim: true, maxlength: 140 },
    ctaLabel: { type: String, trim: true, maxlength: 24 },
    // A page on this website ("/category/?slug=fashion") or a full https address.
    link: { type: String, required: true, trim: true, maxlength: 500 },
    image: { type: String, required: true, trim: true, maxlength: 1000 },
    sortOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    // Optional schedule. Outside it the banner is not shown, with no need to switch it off by hand.
    startsAt: { type: Date },
    endsAt: { type: Date },
}, { timestamps: true });
export const Banner = model("Banner", bannerSchema);
/** Whether a banner is showing to shoppers right now, worked out from its timestamps. */
export function bannerState(b, now = new Date()) {
    if (!b.isActive)
        return "HIDDEN";
    if (b.startsAt && b.startsAt > now)
        return "SCHEDULED";
    if (b.endsAt && b.endsAt <= now)
        return "ENDED";
    return "LIVE";
}
export const presentBanner = (b, now = new Date()) => ({
    id: String(b._id),
    placement: b.placement,
    title: b.title,
    subtitle: b.subtitle ?? null,
    ctaLabel: b.ctaLabel ?? null,
    link: b.link,
    image: b.image,
    sortOrder: b.sortOrder,
    isActive: b.isActive,
    startsAt: b.startsAt ?? null,
    endsAt: b.endsAt ?? null,
    state: bannerState(b, now),
});
/** What a shopper's browser needs: nothing about scheduling or status. */
export const publicBanner = (b) => ({
    id: String(b._id),
    placement: b.placement,
    title: b.title,
    subtitle: b.subtitle ?? null,
    ctaLabel: b.ctaLabel ?? null,
    link: b.link,
    image: b.image,
});
/** The query for banners showing right now. */
export const liveBannerFilter = (now = new Date()) => ({
    isActive: true,
    $and: [{ $or: [{ startsAt: null }, { startsAt: { $lte: now } }] }, { $or: [{ endsAt: null }, { endsAt: { $gt: now } }] }],
});
