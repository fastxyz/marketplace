import React from "react";

import { cn } from "@/lib/utils";

export interface VolumePoint {
  date: string;
  amount: string;
}

export function VolumeChart({
  points,
  tokenSymbol = "USDC",
  className
}: {
  points: VolumePoint[];
  tokenSymbol?: string;
  className?: string;
}) {
  const values = points.map((point) => Number(point.amount));
  const maximum = Math.max(...values, 0);

  if (points.length === 0) {
    return <div className={cn("text-sm text-muted-foreground", className)}>No activity yet.</div>;
  }

  return (
    <div className={cn("space-y-3", className)}>
      <div className="glass-panel flex h-56 items-end overflow-hidden p-5" style={{ gap: "3px" }}>
        {points.map((point) => {
          const value = Number(point.amount);
          const height = maximum > 0 ? Math.max(12, (value / maximum) * 100) : 12;
          const isPeak = maximum > 0 && value / maximum > 0.6;

          return (
            <div key={point.date} className="relative flex flex-1 flex-col items-center justify-end">
              <div
                className={cn(
                  "w-full bg-brand/60 transition-opacity duration-200 hover:opacity-85",
                  isPeak ? "rounded-pill" : "rounded-sm",
                  value === 0 && "opacity-25"
                )}
                style={{ height: `${height}%` }}
                title={`${point.date}: ${point.amount} ${tokenSymbol}`}
              />
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-3 text-sm tracking-headline text-muted-foreground">
        {points
          .filter((_, index) => index % 4 === 0 || index === points.length - 1)
          .map((point) => (
            <span key={point.date}>{point.date.slice(5)}</span>
          ))}
      </div>
    </div>
  );
}
