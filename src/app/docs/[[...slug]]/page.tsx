import fs from "node:fs";
import path from "node:path";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

const DOCS: Record<string, { file: string; label: string }> = {
  methodology: { file: "METHODOLOGY.md", label: "Methodology" },
  governance: { file: "DATA_GOVERNANCE.md", label: "Data Governance" },
  architecture: { file: "ARCHITECTURE.md", label: "Architecture" },
  roadmap: { file: "ROADMAP.md", label: "Roadmap" },
  evals: { file: "EVALS.md", label: "Evals & QA" },
};

/** Minimal, dependency-free markdown rendering (headings, lists, tables, code, bold/italic/inline-code). */
function mdToHtml(md: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s: string) =>
    esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>");

  const lines = md.split("\n");
  const out: string[] = [];
  let inList = false;
  let inCode = false;
  let tableBuf: string[][] = [];

  const flushTable = () => {
    if (tableBuf.length === 0) return;
    const [head, ...body] = tableBuf;
    out.push("<table><thead><tr>" + head.map((c) => `<th>${inline(c)}</th>`).join("") + "</tr></thead><tbody>");
    for (const row of body) out.push("<tr>" + row.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>");
    out.push("</tbody></table>");
    tableBuf = [];
  };
  const closeList = () => { if (inList) { out.push("</ul>"); inList = false; } };

  for (const raw of lines) {
    const line = raw;
    if (line.trim().startsWith("```")) {
      flushTable(); closeList();
      out.push(inCode ? "</code></pre>" : "<pre><code>");
      inCode = !inCode;
      continue;
    }
    if (inCode) { out.push(esc(line)); continue; }

    if (/^\|/.test(line.trim())) {
      const cells = line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      if (cells.every((c) => /^:?-+:?$/.test(c))) continue; // separator row
      tableBuf.push(cells);
      continue;
    }
    flushTable();

    const h = line.match(/^(#{1,3})\s+(.*)/);
    if (h) { closeList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    if (/^\s*[-*]\s+/.test(line)) {
      if (!inList) { out.push("<ul>"); inList = true; }
      out.push(`<li>${inline(line.replace(/^\s*[-*]\s+/, ""))}</li>`);
      continue;
    }
    closeList();
    if (line.trim() === "") { out.push(""); continue; }
    out.push(`<p>${inline(line)}</p>`);
  }
  flushTable(); closeList();
  if (inCode) out.push("</code></pre>");
  return out.join("\n");
}

export default async function DocsPage({ params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug } = await params;
  const key = slug?.[0] ?? "methodology";
  const doc = DOCS[key];
  if (!doc) notFound();
  const filePath = path.join(process.cwd(), "docs", doc.file);
  if (!fs.existsSync(filePath)) notFound();
  const html = mdToHtml(fs.readFileSync(filePath, "utf-8"));

  return (
    <main className="page">
      <div className="page-head">
        <div className="eyebrow">Documentation</div>
        <h1>{doc.label}</h1>
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap" }}>
        {Object.entries(DOCS).map(([k, d]) => (
          <a key={k} href={`/docs/${k}`} className="chip" data-tone={k === key ? "accent" : undefined}>
            {d.label}
          </a>
        ))}
      </div>
      <div className="doc-body" dangerouslySetInnerHTML={{ __html: html }} />
    </main>
  );
}
