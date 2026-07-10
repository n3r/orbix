import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { Button, Card, Input, Avatar, Select, Skeleton, Checkbox, cn, focusRing } from "@orbix/ui";
import { apiFetch } from "@/lib/api";
import { errorMessage } from "@/lib/i18n/tError";
import { SUPPORTED_LANGUAGES, LANGUAGE_LABELS, isLanguageCode } from "@/lib/i18n/languages";
import LanguageSwitcher from "@/components/LanguageSwitcher";
import type { Profile } from "@/lib/types";

type NewProfileMode = "personal" | "group";

function pinIsValid(pin: string) {
  return /^\d{4,6}$/.test(pin);
}

export default function ProfilesPage() {
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [newMode, setNewMode] = useState<NewProfileMode>("personal");
  const [newName, setNewName] = useState("");
  const [newLanguage, setNewLanguage] = useState(
    isLanguageCode(i18n.language) ? i18n.language : "en",
  );
  const [newPin, setNewPin] = useState("");
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [selectError, setSelectError] = useState<string | null>(null);
  const [pinProfile, setPinProfile] = useState<Profile | null>(null);
  const [pinValue, setPinValue] = useState("");
  const [pinError, setPinError] = useState<string | null>(null);

  const loadProfiles = useCallback(async () => {
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
    } finally {
      setLoading(false);
    }
  }, [navigate, t]);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  function resetForm() {
    setNewMode("personal");
    setNewName("");
    setNewPin("");
    setSelectedMemberIds([]);
    setFormError(null);
    setNewLanguage(isLanguageCode(i18n.language) ? i18n.language : "en");
  }

  function toggleMember(profileId: string) {
    setSelectedMemberIds((ids) =>
      ids.includes(profileId) ? ids.filter((id) => id !== profileId) : [...ids, profileId],
    );
  }

  async function handleAddProfile(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);

    if (newPin && !pinIsValid(newPin)) {
      setFormError(t("profiles:errors.invalidPin"));
      return;
    }

    const groupMembers = profiles.filter((profile) => selectedMemberIds.includes(profile.id) && !profile.isGroup);
    if (newMode === "group" && groupMembers.length < 2) {
      setFormError(t("profiles:errors.groupMembersRequired"));
      return;
    }

    let kind: "standard" | "kids" = "standard";
    let maturityCap: number | undefined;
    const kidsCaps = groupMembers
      .filter((profile) => profile.kind === "kids")
      .map((profile) => profile.maturityCap ?? 0);
    if (kidsCaps.length > 0) {
      kind = "kids";
      maturityCap = Math.min(...kidsCaps);
    }

    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        name: newName.trim(),
        kind,
        language: newLanguage,
        isGroup: newMode === "group",
      };
      if (maturityCap !== undefined) payload.maturityCap = maturityCap;
      if (newPin) payload.pin = newPin;
      if (newMode === "group") payload.memberProfileIds = groupMembers.map((profile) => profile.id);
      const res = await apiFetch("/profiles", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        resetForm();
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

  async function selectProfile(profile: Profile, pin?: string) {
    if (pendingId) return;
    setSelectError(null);
    setPinError(null);
    setPendingId(profile.id);
    const init: RequestInit = { method: "POST" };
    if (pin !== undefined) init.body = JSON.stringify({ pin });
    const res = await apiFetch(`/profiles/${profile.id}/select`, init);
    if (res.ok) {
      // Full reload (like logout) so the TanStack Query cache is dropped and the
      // guard re-reads the new orbix_profile cookie. A client navigate would
      // re-enter RequireProfile with stale profile-scoped cache → bounce back to
      // /profiles and briefly show the previous profile's data. Leave the tile in
      // its pending state — the page is about to unload.
      window.location.assign("/");
    } else {
      setPendingId(null);
      const body = (await res.json()) as { error?: string };
      if (body.error === "pin_required") {
        if (pinProfile) {
          setPinError(t("profiles:errors.pinRequired"));
        } else {
          setSelectError(t("profiles:errors.pinRequired"));
        }
      } else {
        const message = t("profiles:errors.selectFailed");
        if (pinProfile) setPinError(message);
        else setSelectError(message);
      }
    }
  }

  async function handleSelectProfile(profile: Profile) {
    if (profile.hasPin) {
      setPinProfile(profile);
      setPinValue("");
      setPinError(null);
      setSelectError(null);
      return;
    }
    await selectProfile(profile);
  }

  async function handlePinSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!pinProfile) return;
    if (!pinIsValid(pinValue)) {
      setPinError(t("profiles:errors.invalidPin"));
      return;
    }
    await selectProfile(pinProfile, pinValue);
  }

  const memberOptions = profiles.filter((profile) => !profile.isGroup);

  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center gap-8 p-8">
      <div className="absolute right-4 top-4">
        <LanguageSwitcher />
      </div>
      <h1 className="text-3xl font-bold text-[var(--text)]">{t("profiles:title")}</h1>

      {loading ? (
        <div className="flex flex-wrap justify-center gap-6">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex flex-col items-center gap-3 p-4">
              <Skeleton rounded="full" className="h-20 w-20" />
              <Skeleton rounded="sm" className="h-4 w-16" />
            </div>
          ))}
        </div>
      ) : profiles.length > 0 ? (
        <div className="flex flex-wrap justify-center gap-6">
          {profiles.map((profile) => {
            const pending = pendingId === profile.id;
            return (
              <button
                key={profile.id}
                onClick={() => handleSelectProfile(profile)}
                disabled={pending}
                aria-busy={pending}
                className={cn(
                  "relative flex min-h-40 w-32 flex-col items-center justify-start gap-3 rounded-[var(--radius)] p-4 hover:bg-[var(--surface)] transition-colors cursor-pointer",
                  pending && "pointer-events-none opacity-50",
                  focusRing,
                )}
              >
                {profile.hasPin && (
                  <span className="absolute right-2 top-2 rounded-full border border-[var(--surface-2)] px-2 py-0.5 text-[10px] font-semibold tracking-wide text-[var(--text-dim)]">
                    {t("profiles:pin.badge")}
                  </span>
                )}
                <Avatar name={profile.name} src={profile.avatar ?? undefined} size={80} />
                <span className="line-clamp-2 text-center text-[var(--text)] font-medium">{profile.name}</span>
                {profile.isGroup && (
                  <span className="rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-xs text-[var(--text-dim)]">
                    {t("profiles:group.badge")}
                  </span>
                )}
                {profile.isGroup && profile.members && profile.members.length > 0 && (
                  <span className="flex -space-x-2" aria-label={t("profiles:group.membersLabel")}>
                    {profile.members.slice(0, 4).map((member) => (
                      <span key={member.id} className="rounded-full border border-[var(--bg)]">
                        <Avatar name={member.name} src={member.avatar ?? undefined} size={24} />
                      </span>
                    ))}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      ) : (
        <p className="max-w-sm text-center text-[var(--text-dim)]">{t("profiles:emptyHint")}</p>
      )}

      {selectError && <p className="text-sm text-red-400">{selectError}</p>}

      {!showForm ? (
        <Button
          variant="ghost"
          onClick={() => {
            setShowForm(true);
            resetForm();
          }}
        >
          {t("profiles:addProfile")}
        </Button>
      ) : (
        <Card className="w-full max-w-sm">
          <h2 className="mb-4 text-lg font-semibold text-[var(--text)]">{t("profiles:form.title")}</h2>
          <form onSubmit={handleAddProfile} className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-2 rounded-[var(--radius-sm)] bg-[var(--bg)] p-1">
              {(["personal", "group"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setNewMode(mode)}
                  aria-pressed={newMode === mode}
                  className={cn(
                    "min-h-10 rounded-[var(--radius-sm)] px-3 text-sm font-medium transition-colors",
                    newMode === mode
                      ? "bg-[var(--surface-2)] text-[var(--text)]"
                      : "text-[var(--text-dim)] hover:text-[var(--text)]",
                    focusRing,
                  )}
                >
                  {t(`profiles:form.mode.${mode}`)}
                </button>
              ))}
            </div>
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
            {newMode === "group" && (
              <fieldset className="flex flex-col gap-2">
                <legend className="text-sm font-medium text-[var(--text-dim)]">{t("profiles:group.membersLabel")}</legend>
                {memberOptions.length >= 2 ? (
                  <div className="grid gap-2">
                    {memberOptions.map((profile) => (
                      <label
                        key={profile.id}
                        className="flex min-h-11 items-center gap-3 rounded-[var(--radius-sm)] border border-[var(--surface-2)] px-3 py-2"
                      >
                        <Checkbox
                          checked={selectedMemberIds.includes(profile.id)}
                          onChange={() => toggleMember(profile.id)}
                        />
                        <Avatar name={profile.name} src={profile.avatar ?? undefined} size={28} />
                        <span className="min-w-0 flex-1 truncate text-sm text-[var(--text)]">{profile.name}</span>
                        {profile.kind === "kids" && (
                          <span className="rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-xs text-[var(--text-dim)]">
                            {t("account:profileKind.kids")}
                          </span>
                        )}
                      </label>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-[var(--text-dim)]">{t("profiles:group.notEnoughProfiles")}</p>
                )}
              </fieldset>
            )}
            <div className="flex flex-col gap-1">
              <label htmlFor="profile-language" className="text-sm font-medium text-[var(--text-dim)]">
                {t("profiles:language.label")}
              </label>
              <Select
                id="profile-language"
                value={newLanguage}
                onChange={(e) => {
                  if (isLanguageCode(e.target.value)) setNewLanguage(e.target.value);
                }}
              >
                {SUPPORTED_LANGUAGES.map((l) => (
                  <option key={l} value={l}>
                    {LANGUAGE_LABELS[l]}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-[var(--text-dim)]">{t("profiles:language.help")}</p>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="profile-pin" className="text-sm font-medium text-[var(--text-dim)]">
                {t("profiles:pin.label")}
              </label>
              <Input
                id="profile-pin"
                type="password"
                inputMode="numeric"
                autoComplete="new-password"
                pattern="[0-9]{4,6}"
                maxLength={6}
                value={newPin}
                onChange={(e) => setNewPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder={t("profiles:pin.placeholder")}
              />
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
      {pinProfile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6">
          <Card
            role="dialog"
            aria-modal="true"
            aria-labelledby="profile-pin-title"
            className="w-full max-w-xs border border-[var(--surface-2)]"
          >
            <h2 id="profile-pin-title" className="text-lg font-semibold text-[var(--text)]">
              {t("profiles:pin.dialogTitle", { name: pinProfile.name })}
            </h2>
            <form onSubmit={handlePinSubmit} className="mt-4 flex flex-col gap-4">
              <Input
                value={pinValue}
                onChange={(e) => setPinValue(e.target.value.replace(/\D/g, "").slice(0, 6))}
                type="password"
                inputMode="numeric"
                autoComplete="current-password"
                pattern="[0-9]{4,6}"
                maxLength={6}
                autoFocus
                aria-label={t("profiles:pin.label")}
                placeholder={t("profiles:pin.placeholder")}
              />
              {pinError && <p className="text-sm text-red-400">{pinError}</p>}
              <div className="flex gap-2">
                <Button type="submit" disabled={pendingId === pinProfile.id}>
                  {pendingId === pinProfile.id ? t("common:status.saving") : t("profiles:pin.unlock")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    if (!pendingId) setPinProfile(null);
                  }}
                >
                  {t("common:actions.cancel")}
                </Button>
              </div>
            </form>
          </Card>
        </div>
      )}
    </main>
  );
}
