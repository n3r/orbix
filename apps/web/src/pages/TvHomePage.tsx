import { useState } from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { Button } from "@orbix/ui";
import { useAuthMe, useTvHome } from "@/lib/queries";
import type { TvChannelCard } from "@/lib/types";
import ChannelRail from "@/components/tv/ChannelRail";
import LiveTvOverlay from "@/components/tv/LiveTvOverlay";
import { regionName } from "@/lib/tv";
import { TvIcon } from "@/components/shell/icons";

/** Category ids are lowercase data values ("news") — display-capitalize only. */
function categoryLabel(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

function EmptyState({ isAdmin }: { isAdmin: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 px-6 py-24 text-center">
      <TvIcon className="h-12 w-12 text-[var(--text-dim)]" />
      <h2 className="text-xl font-semibold text-[var(--text)]">{t("tv:empty.title")}</h2>
      {isAdmin ? (
        <>
          <p className="text-sm text-[var(--text-dim)]">{t("tv:empty.adminBody")}</p>
          <Link to="/account/tv?wizard=1">
            <Button>{t("tv:empty.adminCta")}</Button>
          </Link>
        </>
      ) : (
        <p className="text-sm text-[var(--text-dim)]">{t("tv:empty.memberBody")}</p>
      )}
    </div>
  );
}

export default function TvHomePage() {
  const { t, i18n } = useTranslation();
  const { data, isLoading } = useTvHome();
  const me = useAuthMe();
  const [playing, setPlaying] = useState<{ channels: TvChannelCard[]; id: string } | null>(null);

  const openPlayer = (channel: TvChannelCard, context: TvChannelCard[]) =>
    setPlaying({ channels: context, id: channel.id });

  if (isLoading)
    return <div className="p-8 text-[var(--text-dim)]">{t("common:status.loading")}</div>;

  const home = data ?? { recents: [], favorites: [], countries: [], categories: [] };
  const empty =
    home.recents.length === 0 &&
    home.favorites.length === 0 &&
    home.countries.every((c) => c.channels.length === 0) &&
    home.categories.every((c) => c.channels.length === 0);

  return (
    <div className="flex flex-col gap-6 pb-12 md:gap-9">
      <div className="flex items-center justify-between px-[4vw] pt-4">
        <h1 className="text-2xl font-bold text-[var(--text)]">{t("tv:title")}</h1>
        {/* Visible Guide affordance — the Hulu lesson (spec §Web UI). */}
        <Link to="/tv/guide">
          <Button variant="ghost">{t("tv:guide")}</Button>
        </Link>
      </div>

      {empty ? (
        <EmptyState isAdmin={me.data?.isAdmin ?? false} />
      ) : (
        <>
          {home.recents.length > 0 && (
            <ChannelRail title={t("tv:rails.recents")} channels={home.recents} onPlay={openPlayer} />
          )}
          {home.favorites.length > 0 && (
            <ChannelRail title={t("tv:rails.favorites")} channels={home.favorites} onPlay={openPlayer} />
          )}
          {home.countries.map((c) =>
            c.channels.length > 0 ? (
              <ChannelRail
                key={c.code}
                title={regionName(c.code, i18n.language) ?? c.code}
                channels={c.channels}
                onPlay={openPlayer}
              />
            ) : null,
          )}
          {home.categories.map((c) =>
            c.channels.length > 0 ? (
              <ChannelRail
                key={c.id}
                title={categoryLabel(c.id)}
                channels={c.channels}
                onPlay={openPlayer}
              />
            ) : null,
          )}
        </>
      )}

      {playing && (
        <LiveTvOverlay
          channels={playing.channels}
          initialId={playing.id}
          onClose={() => setPlaying(null)}
        />
      )}
    </div>
  );
}
