export const SUPPORTED_LANGUAGES = ["en", "es", "de", "pt", "ru", "fr"] as const;
export type LanguageCode = (typeof SUPPORTED_LANGUAGES)[number];
export const DEFAULT_LANGUAGE: LanguageCode = "en";

export const LANGUAGE_LABELS: Record<LanguageCode, string> = {
  en: "English",
  es: "Español",
  de: "Deutsch",
  pt: "Português",
  ru: "Русский",
  fr: "Français",
};

export function isLanguageCode(x: string): x is LanguageCode {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(x);
}
