#!/usr/bin/env node
// Render a markdown file to a typeset A4 PDF via headless Chrome.
//
//   node render-pdf.mjs 01-invoice-extractor/RUNBOOK.md
//   node render-pdf.mjs 01-invoice-extractor/RUNBOOK.md out.pdf
//
// There is no pandoc, weasyprint or reportlab on this machine and no markdown
// library installed, so both the markdown subset and the typesetting live here.
// The subset is exactly what the runbooks and reports in this repo use:
// headings, paragraphs, rules, tables, lists, and inline bold/italic/code/links.
//
// PAGINATION GOTCHA (learned rendering AUDIT-REPORT.pdf): do NOT put
// `break-inside: avoid` on large blocks such as sections — it forces each onto
// a fresh page and leaves half-empty pages. Use `break-after: avoid` on
// headings so a heading cannot be orphaned at the foot of a page, and let
// everything else flow.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Inline formatting. Code spans are extracted first and reinserted last so that
// markdown inside them is not interpreted.
function inline(src) {
  const codes = [];
  let s = src.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return `@@C${codes.length - 1}@@`;
  });

  s = esc(s);
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, h) => `<a href="${h}">${t}</a>`);
  s = s.replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, '<a href="$1">$1</a>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(—])\*([^*]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/@@C(\d+)@@/g, (_, i) => `<code>${esc(codes[+i])}</code>`);
  return s;
}

const splitRow = r => r.replace(/^\||\|$/g, '').split('|').map(c => c.trim());

function mdToHtml(md) {
  const lines = md.split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    // Horizontal rule
    if (/^---+$/.test(line.trim())) { out.push('<hr>'); i++; continue; }

    // Heading
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const lvl = h[1].length;
      out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
      i++;
      continue;
    }

    // Table: a header row followed by a |---|---| separator
    if (line.trim().startsWith('|') && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
      const head = splitRow(line.trim());
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(splitRow(lines[i].trim()));
        i++;
      }
      out.push(
        '<table><thead><tr>' +
        head.map(c => `<th>${inline(c)}</th>`).join('') +
        '</tr></thead><tbody>' +
        rows.map(r => '<tr>' + r.map(c => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') +
        '</tbody></table>'
      );
      continue;
    }

    // Lists
    const isUl = l => /^\s*[-*]\s+/.test(l);
    const isOl = l => /^\s*\d+\.\s+/.test(l);
    if (isUl(line) || isOl(line)) {
      const ordered = isOl(line);
      const test = ordered ? isOl : isUl;
      const items = [];
      while (i < lines.length && (test(lines[i]) || (/^\s+\S/.test(lines[i]) && items.length))) {
        if (test(lines[i])) {
          items.push(lines[i].replace(/^\s*(?:[-*]|\d+\.)\s+/, ''));
        } else {
          items[items.length - 1] += ' ' + lines[i].trim(); // continuation line
        }
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>` + items.map(t => `<li>${inline(t)}</li>`).join('') + `</${tag}>`);
      continue;
    }

    // Paragraph — gather until a blank line or a block starter
    const para = [];
    while (
      i < lines.length && lines[i].trim() &&
      !/^(#{1,4}\s|---+$)/.test(lines[i].trim()) &&
      !lines[i].trim().startsWith('|') &&
      !isUl(lines[i]) && !isOl(lines[i])
    ) {
      para.push(lines[i].trim());
      i++;
    }
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
  }

  return out.join('\n');
}

const CSS = `
  @page { size: A4; margin: 18mm 16mm 16mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font: 10.5pt/1.55 "Charter", "Georgia", "Times New Roman", serif;
    color: #16181c;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  h1, h2, h3, h4 {
    font-family: -apple-system, "Helvetica Neue", Arial, sans-serif;
    line-height: 1.25;
    break-after: avoid;      /* never orphan a heading at the foot of a page */
    margin: 0 0 .35em;
  }
  h1 { font-size: 19pt; letter-spacing: -.01em; margin-bottom: .15em; }
  h2 { font-size: 12.5pt; margin-top: 1.5em; padding-bottom: .3em; border-bottom: 1px solid #d9dce1; }
  h3 { font-size: 10.5pt; margin-top: 1.2em; text-transform: uppercase; letter-spacing: .06em; color: #4a4f57; }
  h1 + p em, h1 + p { margin-top: .2em; }
  p { margin: 0 0 .7em; orphans: 2; widows: 2; }
  em { color: #4a4f57; }
  strong { font-weight: 700; }
  a { color: #16181c; text-decoration: none; border-bottom: .5pt solid #a9aeb6; }
  code {
    font-family: "SF Mono", Menlo, Consolas, monospace;
    font-size: .87em;
    background: #f2f3f5;
    border: .5pt solid #e2e4e8;
    border-radius: 2pt;
    padding: .05em .3em;
  }
  hr { border: 0; border-top: 1px solid #d9dce1; margin: 1.5em 0; }
  ul, ol { margin: 0 0 .7em; padding-left: 1.15em; }
  li { margin-bottom: .3em; }
  table {
    width: 100%;
    border-collapse: collapse;
    margin: .3em 0 1em;
    font-size: 9pt;
  }
  thead { display: table-header-group; }   /* repeat the header when a table splits */
  tr { break-inside: avoid; }              /* keep a row together, but let the TABLE split */
  th {
    text-align: left;
    font-family: -apple-system, "Helvetica Neue", Arial, sans-serif;
    font-size: 8pt;
    text-transform: uppercase;
    letter-spacing: .05em;
    color: #4a4f57;
    border-bottom: 1pt solid #16181c;
    padding: .35em .6em .35em 0;
  }
  td {
    vertical-align: top;
    padding: .45em .6em .45em 0;
    border-bottom: .5pt solid #e2e4e8;
  }
  td:first-child { padding-left: 0; }
  .footer {
    margin-top: 2em;
    padding-top: .7em;
    border-top: 1px solid #d9dce1;
    font-size: 8pt;
    color: #6b7079;
    font-family: -apple-system, "Helvetica Neue", Arial, sans-serif;
  }
`;

const src = process.argv[2];
if (!src) {
  console.error('usage: node render-pdf.mjs <file.md> [out.pdf]');
  process.exit(1);
}
const srcPath = path.resolve(src);
if (!fs.existsSync(srcPath)) {
  console.error('no such file: ' + srcPath);
  process.exit(1);
}
const outPath = path.resolve(process.argv[3] || srcPath.replace(/\.md$/, '.pdf'));

if (!fs.existsSync(CHROME)) {
  console.error('Chrome not found at: ' + CHROME);
  process.exit(1);
}

const md = fs.readFileSync(srcPath, 'utf8');
const title = (md.match(/^#\s+(.*)$/m) || [, path.basename(srcPath)])[1]
  .replace(/[*_`]/g, '');

const html = `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8">
<title>${esc(title)}</title><style>${CSS}</style></head>
<body>
${mdToHtml(md)}
<p class="footer">github.com/benfoster1997/n8n-portfolio &nbsp;·&nbsp; Self-initiated demonstration project, not client work.</p>
</body></html>`;

const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'render-pdf-')), 'doc.html');
fs.writeFileSync(tmp, html);
// KEEP_HTML=<path> writes the intermediate HTML out too. There is no poppler on
// this machine, so rasterising the PDF to check the typesetting is not possible
// — screenshotting this HTML at A4 width is how the layout gets eyeballed.
if (process.env.KEEP_HTML) fs.writeFileSync(process.env.KEEP_HTML, html);

execFileSync(CHROME, [
  '--headless',
  '--disable-gpu',
  '--no-pdf-header-footer',
  `--print-to-pdf=${outPath}`,
  'file://' + tmp,
], { stdio: 'pipe' });

// Report the real page count out of the PDF itself, not out of a viewer —
// the preview pane serves a stale cached snapshot for out-of-project files.
const buf = fs.readFileSync(outPath);
const count = (buf.toString('latin1').match(/\/Count\s+(\d+)/) || [])[1] ?? '?';
console.log(`${path.relative(process.cwd(), outPath)} — ${count} pages, ${(buf.length / 1024).toFixed(0)} KB`);
