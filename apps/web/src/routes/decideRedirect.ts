export function decideRedirect(s: {
  setupComplete?: boolean;
  authError401?: boolean;
  profileSelected?: boolean;
}): "/setup" | "/login" | "/profiles" | null {
  if (s.setupComplete === false) return "/setup";
  if (s.authError401) return "/login";
  if (s.profileSelected === false) return "/profiles";
  return null;
}
