import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [inputArg, outputArg] = process.argv.slice(2);
const inputPath = inputArg ? path.resolve(root, inputArg) : path.join(root, 'DOCUMENTATION_FA.md');
const outputPath = outputArg
  ? path.resolve(root, outputArg)
  : inputPath.replace(/\.md$/i, '.pdf');
const cacheDir = path.join(root, '.cache', 'docs-pdf');
const htmlPath = path.join(root, '.documentation-build.html');

const libraryAssets = [
  ['marked.min.js', 'https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js'],
  ['mermaid.min.js', 'https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js'],
  ['katex.min.js', 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js'],
  ['katex.min.css', 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css'],
  ['auto-render.min.js', 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js'],
  ['Vazirmatn-Regular.ttf', 'https://raw.githubusercontent.com/rastikerdar/vazirmatn/v33.003/fonts/ttf/Vazirmatn-Regular.ttf'],
  ['Vazirmatn-Bold.ttf', 'https://raw.githubusercontent.com/rastikerdar/vazirmatn/v33.003/fonts/ttf/Vazirmatn-Bold.ttf']
];

async function ensureFile(name, url) {
  const target = path.join(cacheDir, name);
  if (fs.existsSync(target) && fs.statSync(target).size > 0) return target;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  process.stdout.write(`  downloading ${name}\n`);
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length === 0) throw new Error('empty response');
      fs.writeFileSync(target, buffer);
      return target;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 750));
    }
  }
  throw new Error(`Failed to download ${url}: ${lastError?.message || lastError}`);
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'google-chrome-stable',
    'google-chrome',
    'chromium',
    'chromium-browser'
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate.includes(path.sep)) {
      if (fs.existsSync(candidate)) return candidate;
      continue;
    }
    const lookup = spawnSync('which', [candidate], { stdio: 'ignore' });
    if (lookup.status === 0) return candidate;
  }
  throw new Error('Chrome or Chromium was not found. Set CHROME_PATH to the browser executable.');
}

async function main() {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Markdown input was not found: ${path.relative(root, inputPath)}`);
  }
  const markdown = fs.readFileSync(inputPath, 'utf8');
  const titleMatch = markdown.match(/^#\s+(.+)$/m);
  const documentTitle = (titleMatch?.[1] || 'مستندات').replace(/[&<>]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;'
  })[char]);
  for (const [name, url] of libraryAssets) {
    await ensureFile(name, url);
  }

  let katexCss = fs.readFileSync(path.join(cacheDir, 'katex.min.css'), 'utf8');
  const katexFonts = [...new Set([...katexCss.matchAll(/url\(fonts\/([A-Za-z0-9_.-]+\.woff2)\)/g)].map((match) => match[1]))];
  for (const font of katexFonts) {
    await ensureFile(path.join('katex-fonts', font), `https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/fonts/${font}`);
  }
  katexCss = katexCss.replace(/url\(fonts\/([A-Za-z0-9_.-]+\.woff2)\)/g, (_match, font) => {
    const data = fs.readFileSync(path.join(cacheDir, 'katex-fonts', font)).toString('base64');
    return `url(data:font/woff2;base64,${data})`;
  });

  const marked = fs.readFileSync(path.join(cacheDir, 'marked.min.js'), 'utf8');
  const mermaid = fs.readFileSync(path.join(cacheDir, 'mermaid.min.js'), 'utf8');
  const katex = fs.readFileSync(path.join(cacheDir, 'katex.min.js'), 'utf8');
  const katexAutoRender = fs.readFileSync(path.join(cacheDir, 'auto-render.min.js'), 'utf8');
  const fontRegular = fs.readFileSync(path.join(cacheDir, 'Vazirmatn-Regular.ttf')).toString('base64');
  const fontBold = fs.readFileSync(path.join(cacheDir, 'Vazirmatn-Bold.ttf')).toString('base64');
  const safeMarkdown = markdown.replace(/<\/script/gi, '<\\/script');

  const css = `
@font-face {
  font-family: 'Vazirmatn';
  src: url(data:font/ttf;base64,${fontRegular}) format('truetype');
  font-weight: 400;
  font-style: normal;
}
@font-face {
  font-family: 'Vazirmatn';
  src: url(data:font/ttf;base64,${fontBold}) format('truetype');
  font-weight: 700;
  font-style: normal;
}
@page { size: A4; margin: 16mm 14mm 18mm; }
@page portrait { size: A4; margin: 16mm 14mm 18mm; }
@page landscape { size: A4 landscape; margin: 12mm 14mm; }
* { box-sizing: border-box; }
html { direction: rtl; }
body {
  page: portrait;
  margin: 0;
  font-family: 'Vazirmatn', 'DejaVu Sans', sans-serif;
  font-size: 10.3pt;
  line-height: 1.9;
  color: #111827;
  text-align: right;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
main { max-width: 100%; }
h1 { font-size: 21pt; line-height: 1.5; text-align: center; margin: 0 0 3mm; color: #0f172a; }
h1 + h2 { text-align: center; font-size: 12.5pt; font-weight: 400; color: #334155; margin: 0 0 7mm; padding-bottom: 5mm; border-bottom: 2.5px solid #0f766e; }
h2 { font-size: 15.5pt; color: #0f172a; border-bottom: 1.5px solid #0f766e; padding-bottom: 1.8mm; margin: 7mm 0 4mm; page-break-after: avoid; }
h3 { font-size: 12.4pt; color: #115e59; margin: 6mm 0 3mm; page-break-after: avoid; }
h4 { font-size: 11pt; color: #1f2937; margin: 5mm 0 2mm; page-break-after: avoid; }
p { margin: 0 0 2.6mm; }
a { color: #0f5bd7; text-decoration: none; }
strong { color: #0f172a; }
hr { border: 0; border-top: 1px solid #cbd5e1; margin: 6mm 0; }
ul, ol { margin: 0 0 3.5mm; padding-right: 7mm; padding-left: 0; }
li { margin-bottom: 1.4mm; }
table { width: 100%; border-collapse: collapse; margin: 3mm 0 5mm; font-size: 8.9pt; line-height: 1.7; }
thead { display: table-header-group; }
tr { page-break-inside: avoid; }
th, td { border: 1px solid #cbd5e1; padding: 1.8mm 2mm; vertical-align: top; text-align: right; }
th { background: #f0fdfa; color: #0f172a; font-weight: 700; }
tbody tr:nth-child(even) td { background: #f8fafc; }
img { max-width: 100%; height: auto; border: 1px solid #e2e8f0; border-radius: 2mm; }
pre { direction: ltr; text-align: left; unicode-bidi: isolate; background: #0f172a; color: #e2e8f0; padding: 3mm 3.5mm; border-radius: 2mm; font-size: 8.4pt; line-height: 1.55; overflow-wrap: anywhere; white-space: pre-wrap; page-break-inside: avoid; }
code { font-family: 'DejaVu Sans Mono', monospace; direction: ltr; unicode-bidi: isolate; }
:not(pre) > code { background: #f1f5f9; color: #b91c1c; padding: 0.2mm 1mm; border-radius: 1mm; font-size: 9pt; }
pre code { color: inherit; background: none; padding: 0; font-size: inherit; }
blockquote { margin: 3mm 0 4mm; padding: 2.4mm 4mm; border-right: 3px solid #0f766e; background: #f0fdfa; color: #134e4a; }
blockquote p { margin: 1.4mm 0; }
.mermaid { direction: ltr; text-align: center; margin: 3mm 0 5mm; page-break-inside: avoid; }
.mermaid svg { display: block; margin: 0 auto; max-width: 100%; }
.landscape { page: landscape; break-inside: avoid; }
.landscape-start { page: landscape; break-before: page; }
.landscape .mermaid { margin: 0; }
.landscape h2, .landscape h3, .landscape h4 { margin-top: 0; }
.portrait-start { page: portrait; break-before: page; }
.page-break { break-after: page; }
.note-block { border: 1px solid #cbd5e1; border-right: 3px solid #0f766e; background: #f8fafc; padding: 3mm; margin: 3mm 0 5mm; }
.note-title { font-weight: 700; color: #0f172a; margin-bottom: 2mm; }
.katex { direction: ltr; unicode-bidi: isolate; font-size: 1.02em; }
.katex-display { margin: 3.5mm 0; overflow: visible; }
.katex-display > .katex { direction: ltr; }
${katexCss}
`;

  const html = `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<title>${documentTitle}</title>
<style>${css}</style>
</head>
<body>
<main id="content"></main>
<script id="md-source" type="text/plain">${safeMarkdown}</script>
<script>${marked}</script>
<script>${mermaid}</script>
<script>${katex}</script>
<script>${katexAutoRender}</script>
<script>
(async () => {
  const source = document.getElementById('md-source').textContent;
  const content = document.getElementById('content');
  content.innerHTML = marked.parse(source);

  const seen = new Map();
  function slugify(text) {
    return text.toLowerCase().trim()
      .replace(/[^\\p{L}\\p{N}\\p{M}\\p{Pc}\\- ]/gu, '')
      .replace(/\\s/g, '-');
  }
  content.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((heading) => {
    let slug = slugify(heading.textContent);
    if (seen.has(slug)) {
      const index = seen.get(slug) + 1;
      seen.set(slug, index);
      slug = slug + '-' + index;
    } else {
      seen.set(slug, 0);
    }
    heading.id = slug;
  });

  content.querySelectorAll('details').forEach((details) => {
    const summary = details.querySelector('summary');
    const block = document.createElement('div');
    block.className = 'note-block';
    if (summary) {
      const title = document.createElement('div');
      title.className = 'note-title';
      title.innerHTML = summary.innerHTML.replace(' (کلیک کنید)', '');
      block.appendChild(title);
    }
    [...details.childNodes].filter((node) => node !== summary).forEach((node) => block.appendChild(node));
    details.replaceWith(block);
  });

  content.querySelectorAll('pre > code.language-mermaid').forEach((code) => {
    const diagram = document.createElement('div');
    diagram.className = 'mermaid';
    diagram.textContent = code.textContent;
    code.parentElement.replaceWith(diagram);
  });

  content.querySelectorAll('p').forEach((paragraph) => {
    const leading = paragraph.firstElementChild;
    if (!leading || leading.tagName !== 'STRONG' || !leading.querySelector('code')) return;
    const splitAt = paragraph.innerHTML.indexOf(' — ');
    if (splitAt === -1) {
      paragraph.setAttribute('dir', 'ltr');
      paragraph.style.textAlign = 'left';
      return;
    }
    const columns = document.createElement('p');
    columns.setAttribute('dir', 'ltr');
    columns.style.textAlign = 'left';
    columns.innerHTML = paragraph.innerHTML.slice(0, splitAt);
    const note = document.createElement('p');
    note.setAttribute('dir', 'rtl');
    note.style.textAlign = 'right';
    note.innerHTML = '— ' + paragraph.innerHTML.slice(splitAt + 3);
    paragraph.replaceWith(columns, note);
  });

  content.querySelectorAll('code').forEach((code) => {
    if (!code.closest('pre') && code.textContent.trim().length <= 40) {
      code.style.whiteSpace = 'nowrap';
    }
  });

  renderMathInElement(content, {
    delimiters: [
      { left: '$$', right: '$$', display: true },
      { left: '$', right: '$', display: false }
    ],
    throwOnError: false,
    ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code', 'option']
  });

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'loose',
    theme: 'base',
    fontFamily: 'Vazirmatn, DejaVu Sans, sans-serif',
    themeVariables: { fontFamily: 'Vazirmatn, DejaVu Sans, sans-serif', fontSize: '15px' },
    flowchart: { htmlLabels: true, useMaxWidth: true, curve: 'basis' }
  });
  try {
    await mermaid.run({ querySelector: '.mermaid' });
  } catch (error) {
    console.error('mermaid failed', error);
  }

  // Chrome paginates a diagram that exceeds the printable area instead of scaling it.
  // Fit every SVG to the page, and give wide diagrams a dedicated landscape page.
  const portraitArea = { width: 688, height: 794 };   // 182mm x 210mm at 96dpi
  const landscapeArea = { width: 1017, height: 600 }; // 269mm x 159mm at 96dpi, room for a heading
  const pageContentHeight = 995;                     // A4 minus the 16mm/18mm vertical margins
  const leadingSelector = 'P, H2, H3, H4';
  const layouts = [...content.querySelectorAll('.mermaid')].map((block) => {
    const svg = block.querySelector('svg');
    const box = svg?.viewBox?.baseVal;
    if (!box || !box.width || !box.height) return null;
    const portraitScale = Math.min(
      portraitArea.width / box.width,
      portraitArea.height / box.height
    );
    return {
      block,
      svg,
      box,
      useLandscape: box.width / box.height > 1.3 && portraitScale < 0.66
    };
  });
  let previousWasLandscape = false;
  layouts.forEach((layout, index) => {
    if (!layout) {
      previousWasLandscape = false;
      return;
    }
    const { block, svg, box, useLandscape } = layout;
    let portraitHeight = portraitArea.height;
    if (!useLandscape) {
      const lead = [];
      let prev = block.previousElementSibling;
      while (prev && prev.matches(leadingSelector)) {
        lead.unshift(prev);
        prev = prev.previousElementSibling;
      }
      if (lead.length) {
        const span = block.getBoundingClientRect().top - lead[0].getBoundingClientRect().top;
        const available = pageContentHeight - span - 36;
        if (available > 520) portraitHeight = Math.min(portraitHeight, available);
      }
    }
    const area = useLandscape ? landscapeArea : { ...portraitArea, height: portraitHeight };
    const scale = Math.min(area.width / box.width, area.height / box.height);
    svg.style.width = Math.round(box.width * scale) + 'px';
    svg.style.height = Math.round(box.height * scale) + 'px';
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    if (!useLandscape) {
      previousWasLandscape = false;
      return;
    }
    const wrapper = document.createElement('div');
    wrapper.className = previousWasLandscape ? 'landscape' : 'landscape landscape-start';
    const leading = [];
    let prev = block.previousElementSibling;
    while (prev && prev.tagName === 'P') {
      leading.unshift(prev);
      prev = prev.previousElementSibling;
    }
    if (prev && /^H[2-4]$/.test(prev.tagName)) leading.unshift(prev);
    block.replaceWith(wrapper);
    leading.forEach((node) => wrapper.appendChild(node));
    wrapper.appendChild(block);
    const textHeight = leading.reduce(
      (sum, node) => sum + node.getBoundingClientRect().height,
      0
    );
    const availableHeight = Math.max(320, landscapeArea.height - textHeight - 24);
    const fitted = Math.min(landscapeArea.width / box.width, availableHeight / box.height);
    svg.style.width = Math.round(box.width * fitted) + 'px';
    svg.style.height = Math.round(box.height * fitted) + 'px';
    previousWasLandscape = true;
    if (!layouts[index + 1]?.useLandscape) {
      wrapper.nextElementSibling?.classList.add('portrait-start');
    }
  });
  document.body.setAttribute('data-ready', 'true');
})();
</script>
</body>
</html>
`;

  fs.writeFileSync(htmlPath, html);
  const tempPdf = `${outputPath}.tmp`;
  fs.rmSync(tempPdf, { force: true });

  const chrome = findChrome();
  process.stdout.write(`Rendering ${path.relative(root, inputPath)} to ${path.relative(root, outputPath)} with ${chrome}\n`);
  const print = spawnSync(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-pdf-header-footer',
    '--run-all-compositor-stages-before-draw',
    '--virtual-time-budget=40000',
    `--print-to-pdf=${tempPdf}`,
    pathToFileURL(htmlPath).href
  ], { stdio: 'inherit' });
  if (print.status !== 0) {
    throw new Error(`Chrome exited with status ${print.status ?? 'unknown'}.`);
  }
  if (!fs.existsSync(tempPdf) || fs.statSync(tempPdf).size === 0) {
    throw new Error('Chrome did not produce a PDF.');
  }
  fs.renameSync(tempPdf, outputPath);
  process.stdout.write(`Wrote ${path.relative(root, outputPath)} (${(fs.statSync(outputPath).size / 1024 / 1024).toFixed(1)} MiB)\n`);
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(htmlPath, { force: true });
    fs.rmSync(`${outputPath}.tmp`, { force: true });
  });
