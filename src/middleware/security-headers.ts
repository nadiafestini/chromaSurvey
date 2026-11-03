const TURNSTILE = "https://challenges.cloudflare.com";

export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  `script-src 'self' ${TURNSTILE}`,
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  `frame-src ${TURNSTILE}`,
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'"
].join("; ");

export const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "camera=()",
  "display-capture=()",
  "geolocation=()",
  "gyroscope=()",
  "magnetometer=()",
  "microphone=()",
  "midi=()",
  "payment=()",
  "publickey-credentials-get=()",
  "screen-wake-lock=()",
  "usb=()"
].join(", ");

/** Applicato all'uscita del Worker, quindi vale per pagine, file statici ed errori. */
export function withSecurityHeaders(response: Response, requestUrl: string): Response {
  const res = new Response(response.body, response);
  res.headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  res.headers.set("Permissions-Policy", PERMISSIONS_POLICY);
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("X-Frame-Options", "DENY");
  if (new URL(requestUrl).protocol === "https:") {
    res.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  const type = res.headers.get("Content-Type") ?? "";
  if (type.startsWith("text/html") || type.startsWith("text/csv")) res.headers.set("Cache-Control", "no-store");
  return res;
}
