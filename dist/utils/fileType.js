/** Sniffs the real image type from the first bytes. The client-sent mimetype and filename are not trusted. */
export function detectImageKind(buf) {
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)
        return "jpeg";
    if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
        return "png";
    if (buf.length >= 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP")
        return "webp";
    return null;
}
/** For documents that may be an image or a PDF (payout receipts, NIN slips). */
export function isPdf(buf) {
    return buf.length >= 5 && buf.subarray(0, 5).toString("ascii") === "%PDF-";
}
/** Sniffs the real file type of an uploaded document: a JPG, PNG or WebP image, or a PDF. The name and browser-sent type are not trusted. */
export function classifyDocument(buffer) {
    const image = detectImageKind(buffer);
    if (image)
        return { mime: `image/${image}`, ext: image === "jpeg" ? "jpg" : image };
    if (isPdf(buffer))
        return { mime: "application/pdf", ext: "pdf" };
    return null;
}
