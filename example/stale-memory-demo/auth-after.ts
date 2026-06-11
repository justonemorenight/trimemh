export function validateBearerToken(authHeader: string) {
  return authHeader.startsWith("Bearer ");
}
