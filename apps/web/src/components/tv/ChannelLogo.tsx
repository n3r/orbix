import { useState } from "react";
import { cn } from "@orbix/ui";
import { channelHue, channelInitials } from "@/lib/tv";

/**
 * Channel logo art with a deterministic hue-hashed monogram fallback, shown
 * both when there's no cached logo AND when the logo `<img>` fails to load
 * (a dead/purged cache file) — so a broken-image icon never reaches the
 * screen. Purely presentational: sizing/shape/background are the caller's
 * className props so each call site (guide row, OSD, hero, tile) keeps its
 * own look; only the img-vs-monogram switch + onError logic is shared.
 */
export function ChannelLogo({
  logo,
  name,
  channelId,
  className,
  imgClassName,
  monogramClassName,
  gradient = false,
  loading,
}: {
  logo: string | null | undefined;
  name: string;
  channelId: string;
  /** Wrapper sizing/shape/background classes (merged after the base layout). */
  className?: string;
  /** Logo `<img>` max-size classes. */
  imgClassName?: string;
  /** Monogram text size/weight/color classes. */
  monogramClassName?: string;
  /** ChannelCard's tile uses a diagonal gradient; other sites use a flat fill. */
  gradient?: boolean;
  loading?: "lazy" | "eager";
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const hue = channelHue(channelId);

  return (
    <span className={cn("grid place-items-center overflow-hidden", className)}>
      {logo && !imgFailed ? (
        <img
          src={logo}
          alt=""
          loading={loading}
          className={cn("object-contain", imgClassName)}
          onError={() => setImgFailed(true)}
        />
      ) : (
        <span
          aria-hidden
          className={cn("grid h-full w-full place-items-center", monogramClassName)}
          style={
            gradient
              ? { backgroundImage: `linear-gradient(135deg, hsl(${hue} 45% 34%), hsl(${hue} 45% 18%))` }
              : { backgroundColor: `hsl(${hue} 45% 28%)` }
          }
        >
          {channelInitials(name)}
        </span>
      )}
    </span>
  );
}
