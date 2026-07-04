import { useState } from "react";
import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { Button, Input, Card } from "@orbix/ui";
import { apiFetch } from "@/lib/api";
import { errorMessage } from "@/lib/i18n/tError";
import LanguageSwitcher from "@/components/LanguageSwitcher";

export default function SetupPage() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await apiFetch("/setup", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      if (res.ok) {
        navigate("/profiles", { replace: true });
      } else {
        const body = (await res.json()) as { error?: string };
        setError(errorMessage(body.error, t));
      }
    } catch {
      setError(t("errors:network"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden p-8">
      {/* One brand moment: a subtle orbit glow behind the card (stays calm). */}
      <div aria-hidden className="pointer-events-none absolute -top-32 left-1/2 h-96 w-96 -translate-x-1/2 rounded-full bg-[var(--accent)]/15 blur-3xl" />
      <div className="absolute right-4 top-4">
        <LanguageSwitcher />
      </div>
      <div className="relative w-full max-w-sm">
        <p className="mb-6 text-center text-2xl font-extrabold uppercase tracking-[0.25em] text-[var(--accent)]">
          {t("common:app.name")}
        </p>
        <Card>
          <h1 className="text-2xl font-bold text-[var(--text)]">{t("auth:setup.title")}</h1>
          <p className="mb-6 mt-1 text-sm text-[var(--text-dim)]">{t("auth:setup.subtitle")}</p>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <label htmlFor="email" className="text-sm font-medium text-[var(--text-dim)]">
              {t("auth:fields.email")}
            </label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t("auth:fields.emailPlaceholder")}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="password" className="text-sm font-medium text-[var(--text-dim)]">
              {t("auth:fields.password")}
            </label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t("auth:setup.passwordPlaceholder")}
            />
          </div>
          {error && (
            <p role="alert" className="text-sm text-[var(--danger)]">
              {error}
            </p>
          )}
          <Button type="submit" disabled={loading}>
            {loading ? t("auth:setup.submitting") : t("auth:setup.submit")}
          </Button>
        </form>
        </Card>
      </div>
    </main>
  );
}
