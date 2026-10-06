/* Gantt export: PNG / SVG download and paginated printing (dependency-free).

   Every export path renders from the caller's *current* in-memory state — the
   same problem / solution / view mode that produced the on-screen chart — so
   the output always matches the screen: never a stale solution, never the
   other view, never missing tasks.

   - renderExportChart() re-renders the chart off-screen with per-task time
     annotations (the screen chart stays clean).
   - downloadSVG / downloadPNG serialize a standalone document with title,
     meta line, legend and the chart.
   - printGantt() slices that same SVG into paper-sized pages.  Each page is
     built from translated + clipped clones of the one source SVG, so the time
     axis, row labels, grid and cross-page task bars all share a single
     coordinate system and stay aligned; the header (title / meta / legend)
     is repeated on every page.  Printing goes through window.print(), which
     is also how the user saves a PDF.
*/

const GEX_SVG_NS = 'http://www.w3.org/2000/svg';
const GEX_MM_TO_PX = 96 / 25.4;
const GEX_MARGIN_MM = 10;
const GEX_PAPER = {
  A4: { w: 210, h: 297 },
  A3: { w: 297, h: 420 },
  Letter: { w: 215.9, h: 279.4 },
};

/* ---- small SVG helpers ------------------------------------------------- */
function _gexEl(tag, attrs, parent) {
  const el = document.createElementNS(GEX_SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (parent) parent.appendChild(el);
  return el;
}

function _gexSvg(w, h) {
  const svg = _gexEl('svg', { viewBox: `0 0 ${w} ${h}`, width: w, height: h });
  svg.style.fontFamily = 'system-ui, sans-serif';
  return svg;
}

function _gexText(parent, x, y, str, { size = 11, fill = '#6b7280', weight = null, anchor = null } = {}) {
  const attrs = { x, y, 'font-size': size, fill };
  if (weight) attrs['font-weight'] = weight;
  if (anchor) attrs['text-anchor'] = anchor;
  const t = _gexEl('text', attrs, parent);
  t.textContent = str;
  return t;
}

/* Rough text width estimate (px) for legend layout; CJK glyphs are wider. */
function _gexTextWidth(s, size = 11) {
  let w = 0;
  for (const ch of String(s)) w += (ch.codePointAt(0) > 255 ? 1.05 : 0.56) * size;
  return w;
}

/* ---- legend ------------------------------------------------------------ */
function _gexLegendRows(items, maxWidth, maxRows = Infinity) {
  const rowH = 16, sw = 10, gap = 16;
  const rows = [[]];
  let x = 0, truncated = 0;
  for (let i = 0; i < items.length; i++) {
    const w = sw + 4 + _gexTextWidth(items[i].label) + gap;
    if (x > 0 && x + w > maxWidth) {
      if (rows.length >= maxRows) { truncated = items.length - i; break; }
      rows.push([]);
      x = 0;
    }
    rows[rows.length - 1].push({ ...items[i], x });
    x += w;
  }
  return { rows, rowH, truncated };
}

function _gexDrawLegend(svg, layout, x0, y0, total) {
  layout.rows.forEach((row, ri) => {
    const y = y0 + ri * layout.rowH;
    for (const it of row) {
      _gexEl('rect', { x: x0 + it.x, y: y - 9, width: 10, height: 10, rx: 2, fill: it.color }, svg);
      _gexText(svg, x0 + it.x + 14, y, it.label, { size: 11, fill: '#374151' });
    }
  });
  if (layout.truncated) {
    const last = layout.rows[layout.rows.length - 1];
    const tailX = last.length
      ? x0 + last[last.length - 1].x + 14 + _gexTextWidth(last[last.length - 1].label) + 10
      : x0;
    _gexText(svg, tailX, y0 + (layout.rows.length - 1) * layout.rowH,
      `… 等 ${total} 项`, { size: 11 });
  }
}

/* ---- source chart ------------------------------------------------------ */
/* Off-screen render of the current chart with time annotations. */
function renderExportChart(problem, assignments, mode, title) {
  const tmp = document.createElement('div');
  renderGantt(tmp, { problem, assignments, mode, title, annotate: true });
  return tmp.querySelector('svg');
}

/* Concatenate charts horizontally (compare page: what you see side by side
   on screen is what gets exported). */
function composeSideBySide(svgs, gap = 40) {
  const w = svgs.reduce((s, e) => s + Number(e.getAttribute('width')), 0) + gap * (svgs.length - 1);
  const h = Math.max(...svgs.map(e => Number(e.getAttribute('height'))));
  const svg = _gexSvg(w, h);
  let x = 0;
  for (const src of svgs) {
    const g = _gexEl('g', { transform: `translate(${x}, 0)` }, svg);
    for (const child of [...src.childNodes]) g.appendChild(child.cloneNode(true));
    x += Number(src.getAttribute('width')) + gap;
  }
  return svg;
}

/* ---- standalone document (for SVG / PNG download) ---------------------- */
function buildStandaloneSVG({ title, meta, legend = [], source }) {
  const pad = 24;
  const srcW = Number(source.getAttribute('width'));
  const srcH = Number(source.getAttribute('height'));
  const W = Math.max(srcW + pad * 2, 360);
  const leg = _gexLegendRows(legend, W - pad * 2);
  let headerH = 14;
  if (title) headerH += 24;
  if (meta) headerH += 17;
  if (leg.rows.length) headerH += leg.rows.length * leg.rowH + 6;
  headerH += 6;
  const H = headerH + srcH + pad;

  const svg = _gexSvg(W, H);
  _gexEl('rect', { x: 0, y: 0, width: W, height: H, fill: '#fff' }, svg);
  let y = 14;
  if (title) { _gexText(svg, pad, y + 15, title, { size: 16, weight: 650, fill: '#1f2430' }); y += 24; }
  if (meta) { _gexText(svg, pad, y + 12, meta, { size: 11 }); y += 17; }
  if (leg.rows.length) {
    _gexDrawLegend(svg, leg, pad, y + 11, legend.length);
    y += leg.rows.length * leg.rowH + 6;
  }
  const g = _gexEl('g', { transform: `translate(${pad}, ${headerH})` }, svg);
  for (const child of [...source.childNodes]) g.appendChild(child.cloneNode(true));
  return svg;
}

/* ---- download ---------------------------------------------------------- */
function serializeSVG(svg) {
  const clone = svg.cloneNode(true);
  clone.setAttribute('xmlns', GEX_SVG_NS);
  return new XMLSerializer().serializeToString(clone);
}

function _gexDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function downloadSVG(svg, filename) {
  const url = URL.createObjectURL(new Blob([serializeSVG(svg)], { type: 'image/svg+xml;charset=utf-8' }));
  _gexDownload(url, filename);
}

function downloadPNG(svg, filename, scale = 2) {
  return new Promise((resolve, reject) => {
    const w = Number(svg.getAttribute('width'));
    const h = Number(svg.getAttribute('height'));
    const MAX = 8192;  // keep the canvas within browser limits
    const s = Math.min(scale, MAX / w, MAX / h);
    const url = URL.createObjectURL(new Blob([serializeSVG(svg)], { type: 'image/svg+xml;charset=utf-8' }));
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(w * s);
      canvas.height = Math.round(h * s);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(blob => {
        if (!blob) return reject(new Error('PNG 生成失败'));
        _gexDownload(URL.createObjectURL(blob), filename);
        resolve();
      }, 'image/png');
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('SVG 栅格化失败')); };
    img.src = url;
  });
}

/* ---- paginated printing ------------------------------------------------ */
let _gexClipSeq = 0;

function _gexHeader(svg, { title, meta, leg, legendTotal, availW, pageLabel }) {
  let y = 12;
  if (title) { _gexText(svg, 0, y + 14, title, { size: 15, weight: 650, fill: '#1f2430' }); y += 22; }
  if (meta) { _gexText(svg, 0, y + 11, meta, { size: 10.5 }); y += 15; }
  if (leg.rows.length) _gexDrawLegend(svg, leg, 0, y + 10, legendTotal);
  if (pageLabel) _gexText(svg, availW, 14, pageLabel, { size: 10, anchor: 'end' });
}

/* One page showing the whole chart scaled to fit. */
function _gexScalePage({ source, header, availW, availH, headerH, scale }) {
  const svg = _gexSvg(availW, availH);
  _gexEl('rect', { x: 0, y: 0, width: availW, height: availH, fill: '#fff' }, svg);
  _gexHeader(svg, header);
  const g = _gexEl('g', { transform: `translate(0, ${headerH}) scale(${scale})` }, svg);
  for (const child of [...source.childNodes]) g.appendChild(child.cloneNode(true));
  return svg;
}

/* One page showing rows [r0, …) × time [t0, …) of the source chart.
   Axis, body and row labels are three clipped slices of the same source, so
   everything lines up exactly as on screen. */
function _gexBandPage({ source, header, availW, availH, headerH, r0, t0 }) {
  const svg = _gexSvg(availW, availH);
  const id = `gex-clip-${++_gexClipSeq}`;
  _gexEl('rect', { x: 0, y: 0, width: availW, height: availH, fill: '#fff' }, svg);
  _gexHeader(svg, header);

  const LABEL_W = GANTT_LEFT, AXIS_H = GANTT_TOP;
  const bodyTop = headerH + AXIS_H;
  const dx = LABEL_W - (GANTT_LEFT + t0 * GANTT_PX_PER_UNIT);
  const dy = bodyTop - (GANTT_TOP + r0 * GANTT_ROW_H);

  const defs = _gexEl('defs', {}, svg);
  const mkClip = (name, x, y, w, h) => {
    const cp = _gexEl('clipPath', { id: `${id}-${name}` }, defs);
    _gexEl('rect', { x, y, width: w, height: h }, cp);
    return `url(#${id}-${name})`;
  };
  const clipAxis = mkClip('axis', 0, headerH, availW, AXIS_H);
  const clipBody = mkClip('body', LABEL_W, bodyTop, availW - LABEL_W, availH - bodyTop);
  const clipLab = mkClip('lab', 0, bodyTop, LABEL_W, availH - bodyTop);

  const slice = (tx, ty, clip) => {
    const g = _gexEl('g', { transform: `translate(${tx}, ${ty})`, 'clip-path': clip }, svg);
    for (const child of [...source.childNodes]) g.appendChild(child.cloneNode(true));
  };
  slice(dx, headerH, clipAxis);  // time axis (+ per-chart captions in compare)
  slice(dx, dy, clipBody);       // grid + bars for this band
  slice(0, dy, clipLab);         // row labels
  return svg;
}

/* Build paper-sized pages and open the print dialog (Save-as-PDF included).
   fit: 'pages' keeps 1:1 scale and paginates; 'scale' shrinks onto one page.
   Returns the number of pages. */
function printGantt({ title, meta, legend = [], source,
                      paper = 'A4', orientation = 'landscape', fit = 'pages' }) {
  const size = GEX_PAPER[paper] || GEX_PAPER.A4;
  const [pwMM, phMM] = orientation === 'landscape'
    ? [Math.max(size.w, size.h), Math.min(size.w, size.h)]
    : [Math.min(size.w, size.h), Math.max(size.w, size.h)];
  const availW = Math.round((pwMM - 2 * GEX_MARGIN_MM) * GEX_MM_TO_PX);
  const availH = Math.round((phMM - 2 * GEX_MARGIN_MM) * GEX_MM_TO_PX);

  const srcW = Number(source.getAttribute('width'));
  const srcH = Number(source.getAttribute('height'));

  // Legend is capped at 3 rows per printed page (full legend in SVG/PNG export).
  const leg = _gexLegendRows(legend, availW - 90, 3);
  let headerH = 12;
  if (title) headerH += 22;
  if (meta) headerH += 15;
  if (leg.rows.length) headerH += leg.rows.length * leg.rowH + 4;
  headerH += 4;

  const pages = [];
  if (fit === 'scale') {
    const scale = Math.min(1, availW / srcW, (availH - headerH) / srcH);
    pages.push(_gexScalePage({
      source, availW, availH, headerH, scale,
      header: { title, meta, leg, legendTotal: legend.length, availW, pageLabel: '' },
    }));
  } else {
    const horizon = Math.max(1, Math.round((srcW - GANTT_LEFT - 40) / GANTT_PX_PER_UNIT));
    const nRows = Math.max(1, Math.round((srcH - GANTT_TOP - 40) / GANTT_ROW_H));
    const bodyW = availW - GANTT_LEFT - 4;
    const bodyH = availH - headerH - GANTT_TOP - 4;
    const unitsPerPage = Math.max(1, Math.floor(bodyW / GANTT_PX_PER_UNIT));
    const rowsPerPage = Math.max(1, Math.floor(bodyH / GANTT_ROW_H));
    const tBands = [];
    const rBands = [];
    for (let t = 0; t < horizon; t += unitsPerPage) tBands.push([t, Math.min(t + unitsPerPage, horizon)]);
    for (let r = 0; r < nRows; r += rowsPerPage) rBands.push([r, Math.min(r + rowsPerPage, nRows)]);
    const total = tBands.length * rBands.length;
    let k = 0;
    for (const [r0, r1] of rBands) {
      for (const [t0, t1] of tBands) {
        k += 1;
        const pageLabel = total > 1 ? `第 ${k}/${total} 页 · 行 ${r0 + 1}–${r1} · 时间 ${t0}–${t1}` : '';
        pages.push(_gexBandPage({
          source, availW, availH, headerH, r0, t0,
          header: { title, meta, leg, legendTotal: legend.length, availW, pageLabel },
        }));
      }
    }
  }
  _gexPrint(pages, paper, orientation);
  return pages.length;
}

function _gexPrint(pageSvgs, paper, orientation) {
  const sizeName = { A4: 'a4', A3: 'a3', Letter: 'letter' }[paper] || 'a4';
  let style = document.getElementById('gex-print-style');
  if (!style) {
    style = document.createElement('style');
    style.id = 'gex-print-style';
    document.head.appendChild(style);
  }
  style.textContent =
    '#gex-print-root { display: none; }\n' +
    `@page { size: ${sizeName} ${orientation}; margin: ${GEX_MARGIN_MM}mm; }\n` +
    '@media print {\n' +
    '  body > *:not(#gex-print-root) { display: none !important; }\n' +
    '  #gex-print-root { display: block !important; }\n' +
    '  .gex-page { break-after: page; page-break-after: always;' +
    '    print-color-adjust: exact; -webkit-print-color-adjust: exact; }\n' +
    '  .gex-page:last-child { break-after: auto; page-break-after: auto; }\n' +
    '  .gex-page svg { display: block; }\n' +
    '}';
  document.getElementById('gex-print-root')?.remove();
  const root = document.createElement('div');
  root.id = 'gex-print-root';
  for (const svg of pageSvgs) {
    const d = document.createElement('div');
    d.className = 'gex-page';
    d.appendChild(svg);
    root.appendChild(d);
  }
  document.body.appendChild(root);
  const cleanup = () => { root.remove(); window.removeEventListener('afterprint', cleanup); };
  window.addEventListener('afterprint', cleanup);
  window.print();
}
