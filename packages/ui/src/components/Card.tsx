import { cn } from "../cn";
import type { HTMLAttributes } from "react";

type Props = HTMLAttributes<HTMLDivElement>;

export function Card({ className, ...rest }: Props) {
  return (
    <div
      className={cn(
        "bg-[var(--surface)] rounded-[var(--radius)] p-4",
        className
      )}
      {...rest}
    />
  );
}
