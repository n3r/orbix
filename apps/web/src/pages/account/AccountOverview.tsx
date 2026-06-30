import { Link } from "react-router";
import { Avatar, Button } from "@orbix/ui";
import { apiFetch } from "@/lib/api";
import { useMyProfile } from "@/lib/queries";

async function handleLogout() {
  try {
    await apiFetch("/auth/logout", { method: "POST" });
  } catch {
    // Navigate regardless so the user isn't stuck.
  }
  window.location.href = "/login";
}

export default function AccountOverview() {
  const { data } = useMyProfile();

  return (
    <section className="flex flex-col gap-8">
      <div className="flex items-center gap-4">
        <Avatar name={data?.name ?? "?"} src={data?.avatar ?? undefined} size={64} />
        <div>
          <p className="text-lg font-medium text-[var(--text)]">{data?.name ?? ""}</p>
          <p className="text-sm text-[var(--text-dim)]">
            {data?.kind === "kids" ? "Kids profile" : "Standard profile"}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-3">
        <Link to="/profiles">
          <Button variant="ghost">Switch profile</Button>
        </Link>
        <Button variant="ghost" onClick={handleLogout}>Log out</Button>
      </div>
    </section>
  );
}
