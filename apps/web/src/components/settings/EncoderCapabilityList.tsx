import { useTranslation } from "react-i18next";
import type { CapabilityReport, EncoderCapability } from "@orbix/core";

function Badge({ available }: { available: boolean }) {
  const { t } = useTranslation();
  return (
    <span
      className={
        "rounded px-2 py-0.5 text-xs font-medium " +
        (available
          ? "bg-green-500/15 text-green-400"
          : "bg-red-500/10 text-red-400")
      }
    >
      {available
        ? t("settings:transcode.capabilities.available")
        : t("settings:transcode.capabilities.unavailable")}
    </span>
  );
}

function Row({ enc, current }: { enc: EncoderCapability; current: string }) {
  const { t } = useTranslation();
  const localizedReason = enc.reasonCode
    ? t(`settings:transcode.capabilities.reasons.${enc.reasonCode}`)
    : null;
  return (
    <div className="flex items-start justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <span className="text-sm text-[var(--text)]">
          {t(`settings:transcode.encoders.${enc.key}`)}
        </span>
        {enc.key === current && (
          <span className="ml-2 text-xs text-[var(--text-dim)]">
            ({t("settings:transcode.capabilities.current")})
          </span>
        )}
        {!enc.available && localizedReason && (
          <p className="mt-0.5 text-xs text-[var(--text-dim)]">
            {localizedReason}
            {enc.reason ? ` — ${enc.reason}` : ""}
          </p>
        )}
      </div>
      <Badge available={enc.available} />
    </div>
  );
}

export default function EncoderCapabilityList({
  report,
  current,
}: {
  report: CapabilityReport;
  current: string;
}) {
  const { t } = useTranslation();
  const toolsOk = report.ffmpeg.present && report.ffprobe.present;
  return (
    <div className="mt-3 rounded border border-[var(--border,#333)] p-3">
      <div className="divide-y divide-[var(--border,#333)]">
        {report.encoders.map((enc) => (
          <Row key={enc.key} enc={enc} current={current} />
        ))}
      </div>
      <p className="mt-3 text-xs text-[var(--text-dim)]">
        {toolsOk
          ? t("settings:transcode.capabilities.toolsFound", {
              ffmpeg: report.ffmpeg.version ?? "?",
              ffprobe: report.ffprobe.version ?? "?",
            })
          : t("settings:transcode.capabilities.toolsMissing")}
      </p>
    </div>
  );
}
