import type { Metadata } from "next";
import { Archivo, Barlow_Condensed, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import { listFacilities } from "@/lib/db/dal";
import NavLinks from "@/components/NavLinks";
import SignOutButton from "@/components/SignOutButton";
import { authMode } from "@/lib/auth/auth";
import { AuthzError, resolveContext } from "@/lib/authz";

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
  const mode = authMode();
  let context = null;
  try {
    context = await resolveContext();
  } catch (error) {
    if (!(error instanceof AuthzError)) throw error;
  }
  const visibleFacilities = context?.mode === "required"
    ? facilities.filter((f) => context.memberships.some((m) => m.facility_id === f.id))
    : facilities;

  return (
    <html lang="en" className={`${body.variable} ${display.variable} ${mono.variable}`}>
      <body>
        {mode === "demo" ? (
          <div className="demo-banner" role="note">
            <strong>Controlled demo — authentication disabled</strong>. Synthetic data only; never use this
            configuration for a production deployment.
          </div>
        ) : (
          <div className="demo-banner" role="note">
            <strong>Authenticated workspace</strong>
            {context?.user ? ` — signed in as ${context.user.display_name} (${context.role})` : " — sign in required"}
          </div>
        )}
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
          {context ? (
            <>
              <NavLinks role={context.role} />
              <div className="facility-switch">
                <span>Facility</span>
                {visibleFacilities.map((f) => (
                  <a key={f.id} href={`/api/facility?set=${f.id}`} data-active={f.id === context.facility.id}>
                    {f.short_name}
                  </a>
                ))}
                {context.mode === "required" && <SignOutButton />}
              </div>
            </>
          ) : <span style={{ marginLeft: "auto", color: "var(--ink-mute)", fontSize: 12 }}>Secure access</span>}
        </header>
        {children}
      </body>
    </html>
  );
}
