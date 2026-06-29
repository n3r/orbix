"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@orbix/ui";
import { Card } from "@orbix/ui";
import { Input } from "@orbix/ui";
import { Avatar } from "@orbix/ui";
import { apiFetch } from "@/lib/api";

interface Profile {
  id: string;
  name: string;
  avatar?: string | null;
  kind: string;
  maturityCap?: number | null;
}

export default function ProfilesPage() {
  const router = useRouter();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [selectError, setSelectError] = useState<string | null>(null);

  async function loadProfiles() {
    const res = await apiFetch("/profiles");
    if (res.ok) {
      const data = (await res.json()) as Profile[];
      setProfiles(data);
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
        body: JSON.stringify({ name: newName, kind: "standard" }),
      });
      if (res.ok) {
        setNewName("");
        setShowForm(false);
        await loadProfiles();
      } else {
        const body = (await res.json()) as { error?: string };
        setFormError(body.error ?? "Failed to create profile.");
      }
    } catch {
      setFormError("Network error. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleSelectProfile(profile: Profile) {
    setSelectError(null);
    const res = await apiFetch(`/profiles/${profile.id}/select`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    if (res.ok) {
      router.replace("/");
    } else {
      const body = (await res.json()) as { error?: string };
      if (body.error === "pin_required") {
        setSelectError("This profile requires a PIN. PIN entry is not yet supported.");
      } else {
        setSelectError("Failed to select profile.");
      }
    }
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 p-8">
      <h1 className="text-3xl font-bold text-[var(--text)]">Who&apos;s watching?</h1>

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
          Add Profile
        </Button>
      ) : (
        <Card className="w-full max-w-sm">
          <h2 className="mb-4 text-lg font-semibold text-[var(--text)]">New Profile</h2>
          <form onSubmit={handleAddProfile} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <label htmlFor="profile-name" className="text-sm font-medium text-[var(--text-dim)]">
                Name
              </label>
              <Input
                id="profile-name"
                type="text"
                required
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Profile name"
                autoFocus
              />
            </div>
            {formError && <p className="text-sm text-red-400">{formError}</p>}
            <div className="flex gap-2">
              <Button type="submit" disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setShowForm(false)}
              >
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      )}
    </main>
  );
}
