import React from "react";
import Link from "next/link";

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
          className={current === item.key ? "filter-chip filter-chip-active" : "filter-chip"}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
