"use client";

/**
 * Persistent filter bar. State lives in the URL (shareable, survives
 * navigation); every control updates search params, and pages re-query
 * server-side from them — filters actually change the displayed data.
 */

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";

export interface FilterOptions {
  teams?: string[];
  athletes?: { id: string; name: string }[];
  metrics?: { key: string; label: string; status: string }[];
  testTypes?: { key: string; label: string }[];
  devices?: { id: string; label: string }[];
  /** which controls to render */
  show: ("team" | "athlete" | "metric" | "testType" | "device" | "range")[];
}

export default function FilterBar({ options }: { options: FilterOptions }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const set = useCallback(
    (key: string, value: string) => {
      const next = new URLSearchParams(params.toString());
      if (value) next.set(key, value);
      else next.delete(key);
      router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    },
    [params, pathname, router]
  );

  const s = (k: string) => params.get(k) ?? "";
  const show = new Set(options.show);

  return (
    <div className="filterbar" role="search" aria-label="data filters">
      {show.has("team") && options.teams && (
        <label>
          Team
          <select value={s("team")} onChange={(e) => set("team", e.target.value)}>
            <option value="">All</option>
            {options.teams.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </label>
      )}
      {show.has("athlete") && options.athletes && (
        <label>
          Athlete
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) router.push(`/athletes/${e.target.value}?${params.toString()}`);
            }}
          >
            <option value="">Jump to…</option>
            {options.athletes.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </label>
      )}
      {show.has("metric") && options.metrics && (
        <label>
          Metric
          <select value={s("metric")} onChange={(e) => set("metric", e.target.value)}>
            {options.metrics.map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}{m.status === "provisional" ? " (provisional)" : ""}
              </option>
            ))}
          </select>
        </label>
      )}
      {show.has("testType") && options.testTypes && (
        <label>
          Test
          <select value={s("test")} onChange={(e) => set("test", e.target.value)}>
            <option value="">All</option>
            {options.testTypes.map((t) => (
              <option key={t.key} value={t.key}>{t.label}</option>
            ))}
          </select>
        </label>
      )}
      {show.has("device") && options.devices && (
        <label>
          Device
          <select value={s("device")} onChange={(e) => set("device", e.target.value)}>
            <option value="">All</option>
            {options.devices.map((d) => (
              <option key={d.id} value={d.id}>{d.label}</option>
            ))}
          </select>
        </label>
      )}
      {show.has("range") && (
        <>
          <label>
            From
            <input type="date" value={s("from")} onChange={(e) => set("from", e.target.value)} />
          </label>
          <label>
            To
            <input type="date" value={s("to")} onChange={(e) => set("to", e.target.value)} />
          </label>
        </>
      )}
      <button className="reset" onClick={() => router.replace(pathname, { scroll: false })}>
        Clear filters
      </button>
    </div>
  );
}
