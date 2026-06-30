import { useTranslation } from "react-i18next";
import ProfileMenuEditor from "@/components/account/ProfileMenuEditor";

export default function AccountMenuPage() {
  const { t } = useTranslation();
  return (
    <section>
      <h2 className="mb-4 text-lg font-medium text-[var(--text)]">{t("account:tabs.menu")}</h2>
      <ProfileMenuEditor />
    </section>
  );
}
