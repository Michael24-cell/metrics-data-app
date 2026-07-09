"use client";

import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Roster" },
  { href: "/import", label: "Imports" },
  { href: "/story", label: "Case Study" },
  { href: "/docs", label: "Methodology & Docs" },
];

export default function NavLinks() {
  const pathname = usePathname();
  return (
    <nav className="appnav">
      {LINKS.map((l) => (
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
