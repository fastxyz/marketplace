import React from "react";
import Link from "next/link";

import { cn } from "@/lib/utils";

export function AdminNav({
  current
}: {
  current: "suggestions" | "services";
}) {
  const items = [
    { href: "/admin/suggestions", label: "Suggestions", key: "suggestions" as const },
    { href: "/admin/services", label: "Provider Services", key: "services" as const }
  ];

  return (
    <nav className="mt-8 flex flex-wrap gap-2">
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className={cn(
            "inline-flex items-center rounded-full px-3 py-2 text-sm transition-colors",
            current === item.key ? "bg-foreground text-background" : "bg-background/55 text-muted-foreground hover:text-foreground"
          )}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
