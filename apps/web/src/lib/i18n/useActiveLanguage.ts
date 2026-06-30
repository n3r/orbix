import { useEffect } from "react";
import i18n from "./index";
import { DEFAULT_LANGUAGE, isLanguageCode, type LanguageCode } from "./languages";

const STORAGE_KEY = "orbix_lang";

/** Pre-login language: stored choice → browser language → default (en). */
export function detectInitialLanguage(): LanguageCode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && isLanguageCode(stored)) return stored;
  } catch {
    /* no localStorage */
  }
  const nav = (navigator.language ?? "").slice(0, 2).toLowerCase();
  if (isLanguageCode(nav)) return nav;
  return DEFAULT_LANGUAGE;
}

/** Switch the active UI language and persist the choice. */
export async function setActiveLanguage(code: LanguageCode): Promise<void> {
  await i18n.changeLanguage(code);
  try {
    localStorage.setItem(STORAGE_KEY, code);
  } catch {
    /* no localStorage */
  }
  document.documentElement.lang = code;
}

/**
 * Apply a profile's persisted language whenever it becomes known or changes.
 * No-op for null/unsupported values (keeps the detected pre-login language).
 */
export function useSyncProfileLanguage(language: string | null | undefined): void {
  useEffect(() => {
    if (language && isLanguageCode(language)) void setActiveLanguage(language);
  }, [language]);
}
