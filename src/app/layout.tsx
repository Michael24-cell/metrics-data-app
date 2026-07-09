import type { Metadata } from "next";
import { Archivo, Barlow_Condensed, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import { listFacilities } from "@/lib/db/dal";
import { currentFacility } from "@/lib/facility";
import NavLinks from "@/components/NavLinks";

const body = Archivo({ subsets: ["latin"], variable: "--font-body", weight: ["400", "500", "600"] });
const display = Barlow_Condensed({ subsets: ["latin"], variable: "--font-display", weight: ["500", "600", "700"] });
const mono = IBM_Plex_Mono({ subsets: ["latin"], variable: "--font-mono", weight: ["400", "500", "600"] });

export const metadata: Metadata = {
  title: "TraceLab — Force & Training Intelligence",
  description:
    "Performance analytics for force-plate and training data. Measured data, trends, and practitioner-defined criteria — not diagnosis or clearance.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const facilities = listFacilities();
  const facility = await currentFacility();

  return (
    <html lang="en" className={`${body.variable} ${display.variable} ${mono.variable}`}>
      <body>
        <div className="demo-banner" role="note">
          <strong>Controlled demo</strong> — no user authentication is implemented. Intended for
          founder-led demos only; do not share this link or leave a session unattended.
        </div>
        <header className="appbar">
          <a href="/" className="brand" aria-label="TraceLab home">
            <svg width="26" height="18" viewBox="0 0 26 18" aria-hidden="true">
              {/* wordmark glyph: a countermovement-jump force trace */}
              <polyline
                points="0,13 5,13 7,16 10,4 12,1 13,6 14,17 17,8 26,8"
                fill="none"
                stroke="var(--accent)"
                strokeWidth="1.7"
                strokeLinejoin="round"
              />
            </svg>
            TRACE<em>LAB</em>
          </a>
          <NavLinks />
          <div className="facility-switch">
            <span>Facility</span>
            {facilities.map((f) => (
              <a key={f.id} href={`/api/facility?set=${f.id}`} data-active={f.id === facility.id}>
                {f.short_name}
              </a>
            ))}
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
