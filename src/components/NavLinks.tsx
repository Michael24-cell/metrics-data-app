"use client";

import { usePathname } from "next/navigation";
import type { Role } from "@/lib/auth/roles";

const LINKS = [
  { href: "/", label: "Roster", roles: ["admin", "coach", "analyst", "readonly"] },
  { href: "/monitoring", label: "Monitoring", roles: ["admin", "coach", "analyst", "readonly"] },
  { href: "/agent", label: "Intelligence Agent", roles: ["admin", "coach", "analyst"] },
  { href: "/import", label: "Imports", roles: ["admin"] },
  { href: "/story", label: "Case Study", roles: ["admin", "coach", "analyst", "readonly"] },
  { href: "/docs", label: "Methodology & Docs", roles: ["admin", "coach", "analyst", "readonly"] },
];

export default function NavLinks({ role }: { role: Role }) {
  const pathname = usePathname();
  return (
    <nav className="appnav">
      {LINKS.filter((l) => l.roles.includes(role)).map((l) => (
        <a
          key={l.href}
          href={l.href}
          data-active={l.href === "/" ? pathname === "/" : pathname.startsWith(l.href)}
        >
          {l.label}
        </a>
      ))}
    </nav>
  );
}
