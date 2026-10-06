/* Printable Gantt export (dependency-free).

   Builds print-ready SVG pages from the CURRENT in-memory view state, using
   the same layout model as the on-screen chart (ganttModel in gantt.js), so
   the export always matches the screen: same rows, same bars, same colours,
   same axis — never a stale or re-fetched plan.

   Pagination guarantees:
   - every row appears on exactly one page band: no missing / duplicated tasks
   - title, legend, row-label gutter and time axis repeat identically on every
     page, and pages of the same time window share identical x coordinates
   - bars crossing a page's time window are clipped and get ◀/▶ continuation
     markers, so a bar split across pages lines up on both sides

   Output formats: SVG (one file per page), PNG (one file per page, 2x),
   PDF (single multi-page document, vector page size = paper size).

   Main entry point: exportGanttPages(spec, format) with
     spec = {
       problem,                              // current problem object
       name,                                 // base file name
       sections: [{ title, meta, assignments, mode }],   // ≥1 charts
       paper: 'a4'|'a3'|'a5'|'letter',
       orientation: 'landscape'|'portrait',
       fit: 'paginate'|'scale',              // paginate keeps 1:1 scale
       annotate: true,                       // start–end labels on bars
       generatedAt,                          // optional, for reproducibility
     }
*/

const EXPORT_PAPERS = {
  a4: { label: 'A4', w: 794, h: 1123 },
  a3: { label: 'A3', w: 1123, h: 1587 },
  a5: { label: 'A5', w: 559, h: 794 },
  letter: { label: 'Letter', w: 816, h: 1056 },
};

const EX_MARGIN = 36;
const EX_HEADER_H = 50;
const EX_AXIS_H = 30;
const EX_FOOTER_H = 26;
const EX_GUTTER = GANTT_LEFT;            // same row-label gutter as on screen
const EX_LEGEND_ROW_H = 18;
const EX_FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

const EX_R2 = v => Math.round(v * 100) / 100;

function exEl(tag, attrs, text) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
}

function exTruncate(s, max) {
  s = String(s == null ? '' : s);
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

/* Wrap legend chips into rows within contentW; the resulting layout is
   computed once and reused on every page (that is what keeps the legend
   aligned across pages). */
function layoutLegend(legend, contentW) {
  const chips = [];
  let x = 0, row = 0;
  for (const item of legend) {
    const w = 18 + item.label.length * 7 + 8;
    if (x > 0 && x + w > contentW) { row++; x = 0; }
    chips.push({ item, x, y: row * EX_LEGEND_ROW_H, w });
    x += w + 10;
  }
  return { chips, rows: legend.length ? row + 1 : 0 };
}

/* Compute the page plan: pure geometry, no DOM.  Each page descriptor says
   which row band and which time window of which section it shows. */
function planGanttExport(spec) {
  if (!spec || !spec.problem) throw new Error('缺少问题数据，无法导出');
  if (!spec.sections || !spec.sections.length) throw new Error('没有可导出的方案');
  const paper = EXPORT_PAPERS[spec.paper] || EXPORT_PAPERS.a4;
  const landscape = spec.orientation !== 'portrait';
  const pageW = landscape ? paper.h : paper.w;
  const pageH = landscape ? paper.w : paper.h;
  const contentW = pageW - 2 * EX_MARGIN;
  const generatedAt = spec.generatedAt ||
    new Date().toISOString().replace('T', ' ').slice(0, 16);

  const allAssignments = spec.sections.flatMap(s => s.assignments || []);
  const legend = ganttLegendItems(spec.problem, allAssignments);
  const legendLayout = layoutLegend(legend, contentW);
  const legendH = legend.length ? legendLayout.rows * EX_LEGEND_ROW_H + 6 : 0;

  const pages = [];
  spec.sections.forEach((section, sIdx) => {
    const assignments = section.assignments || [];
    const model = ganttModel(spec.problem, assignments, section.mode);
    // time range actually occupied (a makespan beyond the horizon still prints)
    const timeEnd = Math.max(model.horizon, ...assignments.map(a => a.end), 1);
    if (spec.fit === 'scale') {
      const chartW = EX_GUTTER + timeEnd * model.px + 6;
      const chartH = EX_AXIS_H + model.rowKeys.length * GANTT_ROW_H;
      const availH = pageH - 2 * EX_MARGIN - EX_HEADER_H - legendH - EX_FOOTER_H;
      const scale = Math.min(1, contentW / chartW, availH / Math.max(1, chartH));
      pages.push({
        kind: 'scale', section, sIdx, model, timeEnd, scale,
        rowStart: 0, rowEnd: model.rowKeys.length, winStart: 0, winEnd: timeEnd,
      });
    } else if (!model.rowKeys.length) {
      // nothing to paginate: a single empty-state page
      pages.push({
        kind: 'page', section, sIdx, model, timeEnd,
        rowStart: 0, rowEnd: 0, winStart: 0, winEnd: timeEnd,
      });
    } else {
      const axisW = Math.max(model.px, contentW - EX_GUTTER);
      const unitsPerPage = Math.max(1, Math.floor(axisW / model.px));
      const bodyH = pageH - 2 * EX_MARGIN - EX_HEADER_H - legendH - EX_AXIS_H - EX_FOOTER_H;
      const rowsPerPage = Math.max(1, Math.floor(bodyH / GANTT_ROW_H));
      const nBands = Math.max(1, Math.ceil(model.rowKeys.length / rowsPerPage));
      const nWins = Math.max(1, Math.ceil(timeEnd / unitsPerPage));
      for (let b = 0; b < nBands; b++) {
        for (let w = 0; w < nWins; w++) {
          pages.push({
            kind: 'page', section, sIdx, model, timeEnd,
            rowStart: b * rowsPerPage,
            rowEnd: Math.min(model.rowKeys.length, (b + 1) * rowsPerPage),
            winStart: w * unitsPerPage,
            winEnd: Math.min(timeEnd, (w + 1) * unitsPerPage),
          });
        }
      }
    }
  });
  pages.forEach((p, i) => { p.index = i; p.total = pages.length; });
  return { spec, pageW, pageH, contentW, legend, legendLayout, legendH, generatedAt, pages };
}

function pageDescriptor(plan, page) {
  const parts = [];
  if (plan.spec.sections.length > 1)
    parts.push(`方案 ${page.sIdx + 1}/${plan.spec.sections.length}`);
  if (page.kind === 'scale') {
    parts.push(`缩放 ${Math.round(page.scale * 100)}%`);
  } else {
    parts.push(`行 ${page.rowStart + 1}–${page.rowEnd}/${page.model.rowKeys.length}`);
    parts.push(`时间 ${page.winStart}–${page.winEnd}`);
  }
  return parts.join(' · ');
}

/* Render one page descriptor to an <svg> element sized exactly to the paper. */
function renderExportPage(plan, page) {
  const { spec, pageW, pageH } = plan;
  const M = EX_MARGIN;
  const model = page.model;
  const s = page.kind === 'scale' ? page.scale : 1;
  const px = model.px;

  const svg = exEl('svg', {
    xmlns: 'http://www.w3.org/2000/svg',
    width: pageW, height: pageH,
    viewBox: `0 0 ${pageW} ${pageH}`,
    'font-family': EX_FONT,
  });
  const add = (tag, attrs, text) => { const e = exEl(tag, attrs, text); svg.appendChild(e); return e; };

  add('rect', { x: 0, y: 0, width: pageW, height: pageH, fill: '#ffffff' });

  // ---- header -----------------------------------------------------------
  add('text', { x: M, y: M + 16, 'font-size': 15, 'font-weight': 700, fill: '#1f2430' },
    page.section.title || '甘特图');
  if (page.section.meta)
    add('text', { x: M, y: M + 34, 'font-size': 10, fill: '#6b7280' }, page.section.meta);
  add('text', {
    x: pageW - M, y: M + 34, 'font-size': 10, fill: '#6b7280', 'text-anchor': 'end',
  }, pageDescriptor(plan, page));
  add('line', { x1: M, y1: M + 44, x2: pageW - M, y2: M + 44, stroke: '#e5e7eb' });

  // ---- legend (identical layout on every page) ---------------------------
  if (plan.legendLayout.chips.length) {
    const lg = add('g', { class: 'legend' });
    const oy = M + EX_HEADER_H;
    for (const chip of plan.legendLayout.chips) {
      lg.appendChild(exEl('rect', {
        x: M + chip.x, y: oy + chip.y + 2, width: 10, height: 10, rx: 2, fill: chip.item.color,
      }));
      lg.appendChild(exEl('text', {
        x: M + chip.x + 14, y: oy + chip.y + 11, 'font-size': 10, fill: '#374151',
      }, chip.item.label));
    }
  }

  // ---- geometry ----------------------------------------------------------
  const axisY = M + EX_HEADER_H + plan.legendH;   // top of the axis-label zone
  const bodyTop = axisY + EX_AXIS_H;
  const nRows = page.rowEnd - page.rowStart;
  const bodyH = nRows * GANTT_ROW_H * s;
  const axisX0 = M + EX_GUTTER;

  if (!model.rowKeys.length) {
    add('text', {
      x: M + plan.contentW / 2, y: bodyTop + 40, 'font-size': 12,
      fill: '#6b7280', 'text-anchor': 'middle',
    }, '（无任务或资源可显示）');
  }

  // ---- row-label gutter (repeated on every page) --------------------------
  const rowsG = add('g', {
    class: 'rows', transform: `translate(${M} ${EX_R2(bodyTop)}) scale(${EX_R2(s)})`,
  });
  model.rowKeys.slice(page.rowStart, page.rowEnd).forEach((k, i) => {
    rowsG.appendChild(exEl('text', {
      class: 'row-label', x: EX_GUTTER - 8,
      y: i * GANTT_ROW_H + GANTT_ROW_H / 2 + 4,
      'font-size': 12, fill: '#374151', 'text-anchor': 'end',
    }, exTruncate(model.rowLabel(k), 20)));
  });

  // ---- chart group ---------------------------------------------------------
  // Child coordinates are unscaled chart units (x = t * px); the transform
  // maps the page's time window onto the paper.  Pages of the same window
  // therefore share identical x coordinates, and bars are clipped by the
  // window so nothing spills across the gutter or the page edge.
  const chartTx = axisX0 - page.winStart * px * s;
  const clipId = `exclip-${page.index}`;
  const clip = add('clipPath', { id: clipId });
  clip.appendChild(exEl('rect', {
    x: page.winStart * px, y: -EX_AXIS_H,
    width: (page.winEnd - page.winStart) * px, height: bodyH / s + EX_AXIS_H,
  }));
  const chartG = add('g', {
    class: 'chart',
    transform: `translate(${EX_R2(chartTx)} ${EX_R2(bodyTop)}) scale(${EX_R2(s)})`,
    'clip-path': `url(#${clipId})`,
  });

  // time axis: gridlines + labels at global multiples of the axis step
  const firstTick = Math.ceil(page.winStart / model.axisStep) * model.axisStep;
  for (let t = firstTick; t <= page.winEnd; t += model.axisStep) {
    chartG.appendChild(exEl('line', {
      class: 'axis-grid', x1: t * px, y1: -6, x2: t * px, y2: bodyH / s,
      stroke: '#eef0f3', 'stroke-width': 1,
    }));
    chartG.appendChild(exEl('text', {
      class: 'axis-label', x: t * px, y: -10, 'font-size': 10,
      fill: '#6b7280', 'text-anchor': 'middle',
    }, String(t)));
  }
  // window boundary lines (page edges of the time axis)
  for (const t of [page.winStart, page.winEnd]) {
    chartG.appendChild(exEl('line', {
      class: 'axis-edge', x1: t * px, y1: -6, x2: t * px, y2: bodyH / s,
      stroke: '#d1d5db', 'stroke-width': 1,
    }));
  }

  // row separators
  for (let i = 0; i < nRows; i++) {
    chartG.appendChild(exEl('line', {
      class: 'row-sep', x1: page.winStart * px, y1: (i + 1) * GANTT_ROW_H - 8,
      x2: page.winEnd * px, y2: (i + 1) * GANTT_ROW_H - 8, stroke: '#e5e7eb',
    }));
  }

  // bars visible in this page's rows × window
  const visible = model.bars.filter(bar => {
    const ri = model.rowIndex[bar.row];
    const a = bar.assignment;
    return ri >= page.rowStart && ri < page.rowEnd && a.end > page.winStart && a.start < page.winEnd;
  });
  for (const bar of visible) {
    const a = bar.assignment;
    const ri = model.rowIndex[bar.row];
    const y = (ri - page.rowStart) * GANTT_ROW_H + (GANTT_ROW_H - GANTT_BAR_H) / 2;
    const g = exEl('g', { class: 'gantt-bar', 'data-task': a.task, 'data-row': bar.row });
    g.appendChild(exEl('rect', {
      x: a.start * px, y, width: Math.max(3, (a.end - a.start) * px), height: GANTT_BAR_H,
      rx: 4, fill: bar.color, opacity: 0.85, stroke: 'rgba(0,0,0,.15)',
    }));
    if ((a.end - a.start) * px > 34) {
      g.appendChild(exEl('text', {
        x: a.start * px + 6, y: (ri - page.rowStart) * GANTT_ROW_H + GANTT_ROW_H / 2 + 4,
        'font-size': 11, fill: '#fff', 'font-weight': 600,
      }, a.task));
    }
    chartG.appendChild(g);
  }

  // makespan marker (same as on screen)
  if (model.makespan > page.winStart && model.makespan <= page.winEnd) {
    const x = model.makespan * px;
    chartG.appendChild(exEl('line', {
      class: 'makespan', x1: x, y1: -6, x2: x, y2: bodyH / s,
      stroke: '#dc2626', 'stroke-width': 2, 'stroke-dasharray': '4 3',
    }));
    const lx = Math.min(Math.max(x, page.winStart * px + 34), page.winEnd * px - 34);
    chartG.appendChild(exEl('text', {
      class: 'makespan-label', x: lx, y: -12, 'font-size': 11,
      fill: '#dc2626', 'font-weight': 700, 'text-anchor': 'middle',
    }, '完工时间 ' + model.makespan));
  }

  // ---- overlay (unclipped): time annotations + continuation markers -------
  const ovG = add('g', {
    class: 'overlay',
    transform: `translate(${EX_R2(chartTx)} ${EX_R2(bodyTop)}) scale(${EX_R2(s)})`,
  });
  for (const bar of visible) {
    const a = bar.assignment;
    const ri = model.rowIndex[bar.row];
    const centerY = (ri - page.rowStart) * GANTT_ROW_H + GANTT_ROW_H / 2;
    const x1 = Math.max(a.start, page.winStart) * px;
    const x2 = Math.min(a.end, page.winEnd) * px;
    if (spec.annotate !== false) {
      const label = `${a.start}–${a.end}`;
      const estW = label.length * 5.5 + 4;
      let tx, anchor, fill;
      if (x2 - x1 >= estW + 10) { tx = x2 - 4; anchor = 'end'; fill = '#ffffff'; }
      else if (x2 + 3 + estW <= page.winEnd * px) { tx = x2 + 3; anchor = 'start'; fill = '#6b7280'; }
      else if (x1 - 3 - estW >= page.winStart * px) { tx = x1 - 3; anchor = 'end'; fill = '#6b7280'; }
      else { tx = x1 + 4; anchor = 'start'; fill = '#ffffff'; }
      ovG.appendChild(exEl('text', {
        class: 'bar-anno', 'data-task': a.task, x: EX_R2(tx), y: centerY + 3,
        'font-size': 9, fill, 'text-anchor': anchor,
      }, label));
    }
    // continuation markers for bars split across time pages
    if (a.start < page.winStart) {
      const x = page.winStart * px + 1;
      ovG.appendChild(exEl('polygon', {
        class: 'cont-left', 'data-task': a.task,
        points: `${x},${centerY} ${x + 7},${centerY - 5} ${x + 7},${centerY + 5}`,
        fill: '#374151',
      }));
    }
    if (a.end > page.winEnd) {
      const x = page.winEnd * px - 1;
      ovG.appendChild(exEl('polygon', {
        class: 'cont-right', 'data-task': a.task,
        points: `${x},${centerY} ${x - 7},${centerY - 5} ${x - 7},${centerY + 5}`,
        fill: '#374151',
      }));
    }
  }

  // ---- footer --------------------------------------------------------------
  const prob = spec.problem;
  add('text', { x: M, y: pageH - 14, 'font-size': 9, fill: '#9ca3af' },
    `${prob.name || prob.id || ''} · 导出于 ${plan.generatedAt}`);
  add('text', {
    x: pageW - M, y: pageH - 14, 'font-size': 9, fill: '#9ca3af', 'text-anchor': 'end',
  }, `第 ${page.index + 1} / ${page.total} 页`);

  return svg;
}

function renderGanttExportPages(plan) {
  return plan.pages.map(p => renderExportPage(plan, p));
}

/* ---- serialisation ------------------------------------------------------ */

function exportSvgString(svg) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    new XMLSerializer().serializeToString(svg);
}

function exSanitize(name) {
  return String(name || 'gantt').replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '') || 'gantt';
}

function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function rasteriseSvg(svg, w, h, scale) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([exportSvgString(svg)], { type: 'image/svg+xml;charset=utf-8' }));
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('SVG 栅格化失败')); };
    img.src = url;
  });
}

function canvasToJpegBytes(canvas, quality = 0.92) {
  const dataUrl = canvas.toDataURL('image/jpeg', quality);
  const bin = atob(dataUrl.split(',')[1]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/* Minimal PDF writer: one full-page JPEG image per page.  Page size is given
   in points (1/72"); 96 CSS px = 72 pt, so pt = px * 0.75. */
function buildPdfDocument(images) {
  const enc = new TextEncoder();
  const chunks = [];
  let length = 0;
  const push = (data) => {
    const bytes = typeof data === 'string' ? enc.encode(data) : data;
    chunks.push(bytes);
    length += bytes.length;
  };
  const n = images.length;
  const offsets = [0];
  const beginObj = (num) => { offsets[num] = length; push(`${num} 0 obj\n`); };

  push('%PDF-1.4\n');
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));   // binary marker
  beginObj(1);
  push('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  beginObj(2);
  push(`<< /Type /Pages /Kids [${images.map((_, i) => `${3 + 3 * i} 0 R`).join(' ')}] /Count ${n} >>\nendobj\n`);
  images.forEach((img, i) => {
    const p = 3 + 3 * i, c = p + 1, x = p + 2;
    const wPt = EX_R2(img.wPt), hPt = EX_R2(img.hPt);
    beginObj(p);
    push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wPt} ${hPt}] ` +
      `/Resources << /XObject << /Im0 ${x} 0 R >> /ProcSet [/PDF /ImageC] >> ` +
      `/Contents ${c} 0 R >>\nendobj\n`);
    const content = `q\n${wPt} 0 0 ${hPt} 0 0 cm\n/Im0 Do\nQ\n`;
    beginObj(c);
    push(`<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`);
    beginObj(x);
    push(`<< /Type /XObject /Subtype /Image /Width ${img.wPx} /Height ${img.hPx} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode ` +
      `/Length ${img.jpeg.length} >>\nstream\n`);
    push(img.jpeg);
    push('\nendstream\nendobj\n');
  });
  const xrefPos = length;
  const total = 3 + 3 * n;
  push(`xref\n0 ${total}\n`);
  push('0000000000 65535 f \n');
  for (let i = 1; i < total; i++) push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`);
  return new Blob(chunks, { type: 'application/pdf' });
}

/* ---- top-level orchestration --------------------------------------------- */

async function exportGanttPages(spec, format) {
  const plan = planGanttExport(spec);
  const svgs = renderGanttExportPages(plan);
  const stamp = String(plan.generatedAt).slice(0, 10);
  const base = exSanitize(`${spec.name || 'gantt'}-${stamp}`);
  const n = svgs.length;

  if (format === 'svg') {
    svgs.forEach((svg, i) => downloadBlob(
      new Blob([exportSvgString(svg)], { type: 'image/svg+xml;charset=utf-8' }),
      n > 1 ? `${base}-p${i + 1}of${n}.svg` : `${base}.svg`));
    return n;
  }

  const scale = 2;   // rasterise at 192 dpi for print quality
  const canvases = [];
  for (const svg of svgs) canvases.push(await rasteriseSvg(svg, plan.pageW, plan.pageH, scale));

  if (format === 'png') {
    for (let i = 0; i < canvases.length; i++) {
      const blob = await new Promise(res => canvases[i].toBlob(res, 'image/png'));
      downloadBlob(blob, n > 1 ? `${base}-p${i + 1}of${n}.png` : `${base}.png`);
      if (n > 1) await new Promise(r => setTimeout(r, 350));   // let the browser keep up
    }
    return n;
  }

  if (format === 'pdf') {
    const images = canvases.map(c => ({
      jpeg: canvasToJpegBytes(c),
      wPx: c.width, hPx: c.height,
      wPt: plan.pageW * 0.75, hPt: plan.pageH * 0.75,
    }));
    downloadBlob(buildPdfDocument(images), `${base}.pdf`);
    return n;
  }

  throw new Error('未知导出格式: ' + format);
}
