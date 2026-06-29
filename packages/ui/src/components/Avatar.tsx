import { cn } from "../cn";

type Props = {
  name: string;
  src?: string;
  size?: number;
  className?: string;
};

function initials(name: string): string {
  return name
    .split(" ")
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

export function Avatar({ name, src, size = 40, className }: Props) {
  const style = { width: size, height: size, minWidth: size };

  if (src) {
    return (
      <img
        src={src}
        alt={name}
        style={style}
        className={cn("rounded-full object-cover", className)}
      />
    );
  }

  return (
    <div
      aria-label={name}
      role="img"
      style={style}
      className={cn(
        "rounded-full bg-[var(--accent)] text-white flex items-center justify-center",
        "text-sm font-semibold select-none",
        className
      )}
    >
      {initials(name)}
    </div>
  );
}
