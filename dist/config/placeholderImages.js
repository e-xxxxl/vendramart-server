import { env } from "./env.js";
// PLACEHOLDER PHOTOS (temporary, for showing the client the full UI).
// These are free-to-use Unsplash photos, linked directly from images.unsplash.com. They stand in wherever a
// real photo does not exist yet (a product with no upload, a category tile, the demo stores). Real vendor
// uploads always win. To switch them off set PLACEHOLDER_IMAGES=false in server/.env.
// Before launch: replace with real photography (Unsplash asks for photographer credit on public sites).
export const unsplashUrl = (photoId, width = 700) => `https://images.unsplash.com/photo-${photoId}?auto=format&fit=crop&w=${width}&q=70`;
/** Photo ids, named by what is in the picture. */
export const PHOTO = {
    flourShelf: "1761222191837-4448599c09fc",
    flourSack: "1760727466909-a73872aeecda",
    flourBag: "1766387930184-5d9b2cf6d7a5",
    oilBottles: "1720468750623-39e9a09f5067",
    oilDispenser: "1552592074-ea7a91b851b3",
    oilOlive: "1611608927037-4e8da6aa170e",
    yams: "1757283961582-ab596b0ca595",
    sweetPotatoes: "1783553642630-792e38bf992a",
    cassavaA: "1757283961570-682154747d9c",
    cassavaB: "1764143914716-3524db64940e",
    beansMixed: "1564894809611-1742fc40ed80",
    beansSpoons: "1579705745811-a32bef7856a3",
    beansBeige: "1728931340168-3869028e99e7",
    tieDyeShirt: "1780565595413-16c7bc95af74",
    tieDyeNecklaces: "1780565596898-eaca27a6c862",
    printFabricA: "1768212565424-efa3a3852b81",
    printFabricB: "1768212566108-4ce4f329e4d2",
    printFabricC: "1768212565426-58b089b6386d",
    kenteDress: "1709809081557-78f803ce93a0",
    perfumeBottle: "1761659760494-32b921a2449f",
    beadsHand: "1601387603639-387c75bdcb0d",
    beadsBracelet: "1638768892257-8aec93a524e5",
    marketTomatoes: "1734255026082-82fdc81991f0",
    marketFruit: "1687422809617-a7d97879b3b0",
    marketWoman: "1773858440557-cdb7fa2275bb",
    jarsShelf: "1757801752791-8bcd63cec878",
    groceryAisle: "1604719312566-8912e9227c6a",
};
/** Tile photo for each category. */
const CATEGORY_TILE = {
    "grains-and-flour": PHOTO.flourShelf,
    "oils-and-condiments": PHOTO.oilBottles,
    "tubers-and-produce": PHOTO.yams,
    "beans-and-legumes": PHOTO.beansMixed,
    fashion: PHOTO.printFabricA,
    "beauty-and-fragrance": PHOTO.perfumeBottle,
    accessories: PHOTO.beadsHand,
};
/** Default product photo for a category, used when a product has no image of its own. */
const CATEGORY_PRODUCT = {
    "grains-and-flour": PHOTO.flourSack,
    "oils-and-condiments": PHOTO.oilDispenser,
    "tubers-and-produce": PHOTO.yams,
    "beans-and-legumes": PHOTO.beansBeige,
    fashion: PHOTO.printFabricB,
    "beauty-and-fragrance": PHOTO.perfumeBottle,
    accessories: PHOTO.beadsBracelet,
};
export const placeholdersEnabled = () => env.PLACEHOLDER_IMAGES !== "false";
/** A category's tile image: its own if it has one, otherwise the placeholder (when enabled). */
export function categoryImage(slug, own) {
    if (own)
        return own;
    return placeholdersEnabled() ? unsplashUrl(CATEGORY_TILE[slug] ?? PHOTO.groceryAisle, 600) : null;
}
/** A product's stand-in photo by category, used only when the product has no image of its own. */
export function productPlaceholder(categorySlug) {
    if (!placeholdersEnabled())
        return null;
    return unsplashUrl((categorySlug && CATEGORY_PRODUCT[categorySlug]) || PHOTO.groceryAisle, 700);
}
/** Marker for placeholder rows stored in the database, so they are recognisable and never sent to Cloudinary to delete. */
export const PLACEHOLDER_PREFIX = "placeholder/";
export const placeholderImage = (photoId) => ({ url: unsplashUrl(photoId, 900), publicId: `${PLACEHOLDER_PREFIX}${photoId}` });
