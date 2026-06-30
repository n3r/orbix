import type { TFunction } from "i18next";

/**
 * Map an API error code (the machine-readable `{ error: "<code>" }` the API
 * returns) to a localized message via the `errors` namespace. Unknown or
 * missing codes fall back to a generic message — never a raw code.
 */
export function errorMessage(code: string | undefined, t: TFunction): string {
  if (!code) return t("errors:unknown");
  const key = `errors:${code}`;
  const msg = t(key);
  // i18next returns the full key OR the bare key (namespace stripped) when a
  // translation is missing — treat either as "unmapped".
  return msg === key || msg === code ? t("errors:unknown") : msg;
}
