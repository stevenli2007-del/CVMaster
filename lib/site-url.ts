export function getSiteUrl() {
  const value = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("NEXT_PUBLIC_SITE_URL must use HTTP or HTTPS");
  }
  return url.origin;
}
