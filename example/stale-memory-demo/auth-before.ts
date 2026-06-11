export function validateSession(cookie: string) {
  return cookie.startsWith("session=");
}
