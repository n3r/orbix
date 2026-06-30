import { useState, useEffect } from "react";
import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { Button, Card, Input, Avatar } from "@orbix/ui";
import { apiFetch } from "@/lib/api";
import { errorMessage } from "@/lib/i18n/tError";
import { SUPPORTED_LANGUAGES, LANGUAGE_LABELS, isLanguageCode } from "@/lib/i18n/languages";
import LanguageSwitcher from "@/components/LanguageSwitcher";

interface Profile {
  id: string;
  name: string;
  avatar?: string | null;
  kind: string;
  maturityCap?: number | null;
}

export default function ProfilesPage() {
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [newLanguage, setNewLanguage] = useState(
    isLanguageCode(i18n.language) ? i18n.language : "en",
  );
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [selectError, setSelectError] = useState<string | null>(null);

  async function loadProfiles() {
    try {
      const res = await apiFetch("/profiles");
      if (res.ok) {
        const data = (await res.json()) as Profile[];
        setProfiles(data);
        return;
      }
      if (res.status === 401) {
        navigate("/login", { replace: true });
        return;
      }
      setSelectError(t("profiles:errors.loadFailed"));
    } catch {
      setSelectError(t("errors:network"));
    }
  }

  useEffect(() => {
    loadProfiles();
  }, []);

  async function handleAddProfile(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setSaving(true);
    try {
      const res = await apiFetch("/profiles", {
        method: "POST",
        body: JSON.stringify({ name: newName, kind: "standard", language: newLanguage }),
      });
      if (res.ok) {
        setNewName("");
        setShowForm(false);
        await loadProfiles();
      } else {
        const body = (await res.json()) as { error?: string };
        setFormError(errorMessage(body.error, t));
      }
    } catch {
      setFormError(t("errors:network"));
    } finally {
      setSaving(false);
    }
  }

  async function handleSelectProfile(profile: Profile) {
    setSelectError(null);
    const res = await apiFetch(`/profiles/${profile.id}/select`, {
      method: "POST",
    });
    if (res.ok) {
      // Full reload (like logout) so the TanStack Query cache is dropped and the
      // guard re-reads the new orbix_profile cookie. A client navigate would
      // re-enter RequireProfile with stale profile-scoped cache → bounce back to
      // /profiles and briefly show the previous profile's data.
      window.location.assign("/");
    } else {
      const body = (await res.json()) as { error?: string };
      if (body.error === "pin_required") {
        setSelectError(t("profiles:errors.pinNotSupported"));
      } else {
        setSelectError(t("profiles:errors.selectFailed"));
      }
    }
  }

  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center gap-8 p-8">
      <div className="absolute right-4 top-4">
        <LanguageSwitcher />
      </div>
      <h1 className="text-3xl font-bold text-[var(--text)]">{t("profiles:title")}</h1>

      {profiles.length > 0 && (
        <div className="flex flex-wrap justify-center gap-6">
          {profiles.map((profile) => (
            <button
              key={profile.id}
              onClick={() => handleSelectProfile(profile)}
              className="flex flex-col items-center gap-3 rounded-[var(--radius)] p-4 hover:bg-[var(--surface)] transition-colors cursor-pointer"
            >
              <Avatar name={profile.name} src={profile.avatar ?? undefined} size={80} />
              <span className="text-[var(--text)] font-medium">{profile.name}</span>
            </button>
          ))}
        </div>
      )}

      {selectError && <p className="text-sm text-red-400">{selectError}</p>}

      {!showForm ? (
        <Button
          variant="ghost"
          onClick={() => {
            setShowForm(true);
            setFormError(null);
            setNewName("");
          }}
        >
          {t("profiles:addProfile")}
        </Button>
      ) : (
        <Card className="w-full max-w-sm">
          <h2 className="mb-4 text-lg font-semibold text-[var(--text)]">{t("profiles:form.title")}</h2>
          <form onSubmit={handleAddProfile} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <label htmlFor="profile-name" className="text-sm font-medium text-[var(--text-dim)]">
                {t("profiles:form.nameLabel")}
              </label>
              <Input
                id="profile-name"
                type="text"
                required
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={t("profiles:form.namePlaceholder")}
                autoFocus
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="profile-language" className="text-sm font-medium text-[var(--text-dim)]">
                {t("profiles:language.label")}
              </label>
              <select
                id="profile-language"
                value={newLanguage}
                onChange={(e) => {
                  if (isLanguageCode(e.target.value)) setNewLanguage(e.target.value);
                }}
                className="rounded-[var(--radius)] bg-[var(--surface)] px-3 py-2 text-[var(--text)]"
              >
                {SUPPORTED_LANGUAGES.map((l) => (
                  <option key={l} value={l}>
                    {LANGUAGE_LABELS[l]}
                  </option>
                ))}
              </select>
              <p className="text-xs text-[var(--text-dim)]">{t("profiles:language.help")}</p>
            </div>
            {formError && <p className="text-sm text-red-400">{formError}</p>}
            <div className="flex gap-2">
              <Button type="submit" disabled={saving}>
                {saving ? t("common:status.saving") : t("common:actions.save")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setShowForm(false)}
              >
                {t("common:actions.cancel")}
              </Button>
            </div>
          </form>
        </Card>
      )}
    </main>
  );
}
