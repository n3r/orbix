import { useTranslation } from "react-i18next";
import { apiFetch } from "@/lib/api";
import {
  SUPPORTED_LANGUAGES,
  LANGUAGE_LABELS,
  isLanguageCode,
  type LanguageCode,
} from "@/lib/i18n/languages";
import { setActiveLanguage } from "@/lib/i18n/useActiveLanguage";

/**
 * A compact language selector. Always switches the UI language locally
 * (persisted to localStorage). When `persistToProfileId` is set, it also
 * PATCHes that profile's language so the choice sticks for the profile and
 * triggers catalog-metadata caching for the new language.
 */
export default function LanguageSwitcher({
  persistToProfileId,
  className,
}: {
  persistToProfileId?: string;
  className?: string;
}) {
  const { t, i18n } = useTranslation();
  const current: LanguageCode = isLanguageCode(i18n.language) ? i18n.language : "en";

  async function onChange(value: string) {
    if (!isLanguageCode(value)) return;
    await setActiveLanguage(value);
    if (persistToProfileId) {
      // Best-effort: failure to persist still leaves the local UI switched.
      await apiFetch(`/profiles/${persistToProfileId}`, {
        method: "PATCH",
        body: JSON.stringify({ language: value }),
      }).catch(() => {});
    }
  }

  return (
    <select
      aria-label={t("common:language")}
      value={current}
      onChange={(e) => void onChange(e.target.value)}
      className={
        className ??
        "rounded-[var(--radius)] bg-[var(--surface)] px-2 py-1 text-sm text-[var(--text)]"
      }
    >
      {SUPPORTED_LANGUAGES.map((l) => (
        <option key={l} value={l}>
          {LANGUAGE_LABELS[l]}
        </option>
      ))}
    </select>
  );
}
