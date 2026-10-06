/* Node test suite for the Gantt export engine (no browser required).

   Run: node tests/test_gantt_export.js

   Verifies the guarantees the export makes:
   - paginated export covers every row exactly once (no missing/duplicated tasks)
   - every assignment is drawn, and bars split across time pages get
     continuation markers on both sides
   - time axis / row labels / legend are identical across pages (alignment)
   - scale-to-fit produces exactly one page per section
   - multi-section (compare) exports keep section order and page numbering
   - the minimal PDF writer emits a structurally valid document
   - rendering is deterministic for a fixed generatedAt
*/

const fs = require('fs');
const path = require('path');

/* ---- minimal DOM shim ---------------------------------------------------- */
function makeEl(tag) {
  const el = {
    tagName: tag, attrs: {}, children: [], _text: '',
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k]; },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener() {},
  };
  Object.defineProperty(el, 'textContent', {
    get() { return this._text; },
    set(v) { this._text = String(v); },
  });
  Object.defineProperty(el, 'style', { get() { return {}; } });
  return el;
}
global.document = {
  createElementNS: (ns, tag) => makeEl(tag),
  createElement: (tag) => makeEl(tag),
  body: makeEl('body'),
};

/* ---- load the frontend modules ------------------------------------------- */
const read = f => fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', f), 'utf8');
const src = ['common.js', 'gantt.js', 'gantt-export.js'].map(read).join('\n;\n');
const api = new Function('document', 'window', 'localStorage', 'location', 'history', `${src}
  return { ganttModel, ganttLegendItems, planGanttExport, renderGanttExportPages,
           buildPdfDocument, layoutLegend, colorFor, GANTT_ROW_H, GANTT_PX_PER_UNIT,
           EX_MARGIN, EX_HEADER_H, EX_AXIS_H, EX_FOOTER_H, EX_GUTTER };`);
const X = api(global.document, {}, { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  { search: '' }, { replaceState: () => {} });

/* ---- helpers --------------------------------------------------------------- */
let failures = 0;
function ok(cond, msg) {
  if (cond) { console.log('  ✓ ' + msg); }
  else { failures++; console.error('  ✗ ' + msg); }
}
function section(name) { console.log('\n' + name); }

function walk(el, fn) { fn(el); (el.children || []).forEach(c => walk(c, fn)); }
function findAll(el, pred) { const out = []; walk(el, e => { if (pred(e)) out.push(e); }); return out; }
function hasClass(el, cls) { return (el.attrs.class || '').split(/\s+/).includes(cls); }
function serialise(el) {
  const attrs = Object.keys(el.attrs).sort().map(k => `${k}=${el.attrs[k]}`).join(' ');
  return `<${el.tagName} ${attrs}>${el._text}${(el.children || []).map(serialise).join('')}</${el.tagName}>`;
}

/* ---- fixtures -------------------------------------------------------------- */
function syntheticProblem(nTasks, nResources, horizon) {
  return {
    id: 'p_test', name: '测试项目', horizon, time_unit: '天',
    resources: Array.from({ length: nResources }, (_, i) => ({ id: 'R' + (i + 1), name: '资源' + (i + 1) })),
    tasks: Array.from({ length: nTasks }, (_, i) => ({
      id: 'T' + (i + 1), name: '任务' + (i + 1), duration: 5,
      resource_requirements: {}, dependencies: [], release_time: 0,
    })),
  };
}
function syntheticAssignments(problem, horizon) {
  // spread tasks across resources and the whole horizon, with several bars
  // deliberately crossing page boundaries
  return problem.tasks.map((t, i) => {
    const start = (i * 7) % Math.max(1, horizon - 12);
    return { task: t.id, start, end: start + 5 + (i % 9), resources: [problem.resources[i % problem.resources.length].id] };
  });
}

const SPEC_BASE = {
  paper: 'a4', orientation: 'landscape', fit: 'paginate',
  annotate: true, generatedAt: '2026-10-06 10:00',
};

/* ---- 1. pagination coverage (synthetic, task mode) ------------------------- */
section('分页覆盖：每一行恰好出现一次，任务条不丢不重');
{
  const problem = syntheticProblem(40, 3, 120);
  const assignments = syntheticAssignments(problem, 120);
  const spec = { ...SPEC_BASE, problem, name: 't', sections: [{ title: 'S', meta: '', assignments, mode: 'task' }] };
  const plan = X.planGanttExport(spec);
  ok(plan.pages.length > 1, `40 任务 A4 横向应分页（实际 ${plan.pages.length} 页）`);

  // row bands tile [0, 40) exactly (dedupe: each band repeats per time window)
  const bands = [...new Set(plan.pages.map(p => `${p.rowStart}-${p.rowEnd}`))];
  const covered = new Set();
  let overlap = false;
  for (const b of bands) {
    const [s, e] = b.split('-').map(Number);
    for (let r = s; r < e; r++) {
      if (covered.has(r)) overlap = true;
      covered.add(r);
    }
  }
  ok(!overlap && covered.size === 40, `行带恰好铺满 40 行（${bands.length} 个行带，无重叠无遗漏）`);

  // every assignment drawn exactly once per intersecting window
  const svgs = X.renderGanttExportPages(plan);
  const barCount = {};
  svgs.forEach(svg => findAll(svg, e => hasClass(e, 'gantt-bar')).forEach(g => {
    const t = g.attrs['data-task'];
    barCount[t] = (barCount[t] || 0) + 1;
  }));
  const unitsPerPage = plan.pages[0].winEnd - plan.pages[0].winStart;
  let allOk = true;
  for (const a of assignments) {
    const expected = Math.max(1,
      Math.ceil(Math.min(a.end, 120) / unitsPerPage) - Math.floor(a.start / unitsPerPage));
    if (barCount[a.task] !== expected) {
      allOk = false;
      console.error(`    ${a.task}: 画了 ${barCount[a.task]} 次，应为 ${expected} 次`);
    }
  }
  ok(allOk, '每个任务条在其跨越的每个时间页各出现一次');
  ok(Object.keys(barCount).length === 40, `40 个任务全部入图（实际 ${Object.keys(barCount).length}）`);
}

/* ---- 2. continuation markers ----------------------------------------------- */
section('跨页任务条：两端各有 ◀ ▶ 衔接标记');
{
  const problem = syntheticProblem(6, 2, 120);
  // one long bar guaranteed to cross several windows
  const assignments = [{ task: 'T1', start: 3, end: 110, resources: ['R1'] }];
  const spec = { ...SPEC_BASE, problem, name: 't', sections: [{ title: 'S', meta: '', assignments, mode: 'resource' }] };
  const plan = X.planGanttExport(spec);
  const svgs = X.renderGanttExportPages(plan);
  let lefts = 0, rights = 0, middles = 0;
  plan.pages.forEach((p, i) => {
    const hasL = findAll(svgs[i], e => hasClass(e, 'cont-left')).length > 0;
    const hasR = findAll(svgs[i], e => hasClass(e, 'cont-right')).length > 0;
    if (hasL) lefts++;
    if (hasR) rights++;
    if (hasL && hasR) middles++;
  });
  // expected counts derived from which windows the bar [3,110) intersects
  const wins = plan.pages.map(p => [p.winStart, p.winEnd]);
  const hit = wins.filter(([s, e]) => 110 > s && 3 < e);
  const expL = hit.filter(([s]) => 3 < s).length;
  const expR = hit.filter(([, e]) => 110 > e).length;
  const expBoth = hit.filter(([s, e]) => 3 < s && 110 > e).length;
  ok(hit.length >= 3, `长条应跨至少 3 个时间页（实际 ${hit.length}）`);
  ok(lefts === expL && rights === expR && middles === expBoth,
    `跨页处双向标记、首末页单向（左 ${lefts}/${expL} 右 ${rights}/${expR} 双向 ${middles}/${expBoth}）`);
}

/* ---- 3. cross-page alignment ------------------------------------------------ */
section('跨页对齐：时间轴、行标签、图例在各页位置一致');
{
  const problem = syntheticProblem(40, 3, 120);
  const assignments = syntheticAssignments(problem, 120);
  const spec = { ...SPEC_BASE, problem, name: 't', sections: [{ title: 'S', meta: '', assignments, mode: 'task' }] };
  const plan = X.planGanttExport(spec);
  const svgs = X.renderGanttExportPages(plan);

  // pages sharing a time window must share gridline x coordinates
  const gridByWindow = new Map();
  plan.pages.forEach((p, i) => {
    const xs = findAll(svgs[i], e => hasClass(e, 'axis-grid')).map(l => l.attrs.x1).join(',');
    const key = `${p.winStart}-${p.winEnd}`;
    if (!gridByWindow.has(key)) gridByWindow.set(key, xs);
    else ok(gridByWindow.get(key) === xs, `时间窗 ${key} 的网格线在各页一致`);
  });

  // pages sharing a row band must show the same row labels at the same y
  const rowsByBand = new Map();
  plan.pages.forEach((p, i) => {
    const sig = findAll(svgs[i], e => hasClass(e, 'row-label')).map(t => `${t.attrs.y}:${t._text}`).join('|');
    const key = `${p.rowStart}-${p.rowEnd}`;
    if (!rowsByBand.has(key)) rowsByBand.set(key, sig);
    else ok(rowsByBand.get(key) === sig, `行带 ${key} 的行标签在各页一致`);
  });

  // legend identical on every page
  const legends = svgs.map(svg => serialise(findAll(svg, e => hasClass(e, 'legend'))[0]));
  ok(legends.every(l => l === legends[0]), `图例在全部 ${svgs.length} 页完全一致`);

  // legend colours match bar colours
  const items = X.ganttLegendItems(problem, assignments);
  ok(items.every(it => it.color === X.colorFor(it.id)), '图例颜色与任务条颜色（colorFor）一致');
}

/* ---- 4. annotations ---------------------------------------------------------- */
section('时间标注');
{
  const problem = syntheticProblem(4, 2, 60);
  const assignments = [{ task: 'T1', start: 5, end: 30, resources: ['R1'] }];
  const mk = annotate => X.renderGanttExportPages(X.planGanttExport({
    ...SPEC_BASE, problem, name: 't', annotate,
    sections: [{ title: 'S', meta: '', assignments, mode: 'resource' }],
  }));
  const withAnno = mk(true);
  const found = withAnno.some(svg => findAll(svg, e => hasClass(e, 'bar-anno')).some(t => t._text === '5–30'));
  ok(found, '开启标注时任务条带 “5–30” 起止标注');
  const without = mk(false);
  ok(without.every(svg => findAll(svg, e => hasClass(e, 'bar-anno')).length === 0), '关闭标注时无起止标注');
}

/* ---- 5. scale mode ------------------------------------------------------------- */
section('缩放至一页');
{
  const problem = syntheticProblem(40, 3, 120);
  const assignments = syntheticAssignments(problem, 120);
  const spec = { ...SPEC_BASE, fit: 'scale', problem, name: 't',
    sections: [{ title: 'S', meta: '', assignments, mode: 'task' }] };
  const plan = X.planGanttExport(spec);
  ok(plan.pages.length === 1, '缩放模式恰好 1 页');
  ok(plan.pages[0].scale > 0 && plan.pages[0].scale <= 1, `缩放比例 ${plan.pages[0].scale.toFixed(3)} ∈ (0,1]`);
  const svg = X.renderGanttExportPages(plan)[0];
  ok(findAll(svg, e => hasClass(e, 'gantt-bar')).length === 40, '缩放页包含全部 40 个任务条');
}

/* ---- 6. multi-section (compare) ----------------------------------------------- */
section('多方案对比导出');
{
  const problem = syntheticProblem(10, 2, 60);
  const a1 = syntheticAssignments(problem, 60);
  const a2 = syntheticAssignments(problem, 60).map(a => ({ ...a, start: Math.max(0, a.start - 2), end: Math.max(1, a.end - 2) }));
  const spec = { ...SPEC_BASE, problem, name: 'cmp', sections: [
    { title: '甘特图 — 方案A（按资源）', meta: '目标 10', assignments: a1, mode: 'resource' },
    { title: '甘特图 — 方案B（按资源）', meta: '目标 12', assignments: a2, mode: 'resource' },
  ] };
  const plan = X.planGanttExport(spec);
  const firstOfB = plan.pages.findIndex(p => p.sIdx === 1);
  ok(firstOfB > 0 && plan.pages.slice(0, firstOfB).every(p => p.sIdx === 0) &&
     plan.pages.slice(firstOfB).every(p => p.sIdx === 1),
    '方案 B 另起新页且方案顺序不变');
  ok(plan.pages.every((p, i) => p.index === i && p.total === plan.pages.length), '页码连续且总页数一致');
  const svgs = X.renderGanttExportPages(plan);
  const titleB = findAll(svgs[firstOfB], e => e.tagName === 'text' && e._text.includes('方案B'));
  ok(titleB.length === 1, '方案 B 页面标题正确');
  const descB = findAll(svgs[firstOfB], e => e.tagName === 'text' && e._text.includes('方案 2/2'));
  ok(descB.length >= 1, '页眉标注 “方案 2/2”');
}

/* ---- 7. real-size instance (demo_large: 75 tasks, horizon 200) ------------------ */
section('大实例：75 任务 × 200 周期（demo_large）');
{
  const problem = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'data', 'instances', 'demo_large', 'problem.json'), 'utf8'));
  const assignments = problem.tasks.map(t => ({
    task: t.id, start: t.release_time, end: t.release_time + t.duration,
    resources: Object.keys(t.resource_requirements || {}),
  }));
  for (const mode of ['task', 'resource']) {
    const spec = { ...SPEC_BASE, problem, name: 'big',
      sections: [{ title: 'S', meta: '', assignments, mode }] };
    const plan = X.planGanttExport(spec);
    const svgs = X.renderGanttExportPages(plan);
    const seen = new Set();
    svgs.forEach(svg => findAll(svg, e => hasClass(e, 'gantt-bar'))
      .forEach(g => seen.add(g.attrs['data-task'])));
    ok(seen.size === problem.tasks.length,
      `按${mode === 'task' ? '任务' : '资源'}视图：${problem.tasks.length} 个任务全部入图（${plan.pages.length} 页）`);
    const rowCount = mode === 'task' ? problem.tasks.length : problem.resources.length;
    const labels = new Set();
    svgs.forEach(svg => findAll(svg, e => hasClass(e, 'row-label')).forEach(t => labels.add(t._text)));
    ok(labels.size === rowCount, `全部 ${rowCount} 个行标签都出现`);
  }
}

/* ---- 8. PDF structure ----------------------------------------------------------- */
section('PDF 结构');
{
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);   // minimal JPEG SOI/EOI
  const images = [1, 2, 3].map(() => ({ jpeg, wPx: 100, hPx: 80, wPt: 842.25, hPt: 595.5 }));
  (async () => {
    const blob = X.buildPdfDocument(images);
    const buf = Buffer.from(await blob.arrayBuffer());
    const head = buf.slice(0, 8).toString('latin1');
    ok(head === '%PDF-1.4', 'PDF 头正确');
    ok(buf.includes('/Type /Catalog') && buf.includes('/Count 3'), '包含目录与 3 页计数');
    ok(buf.includes('/Filter /DCTDecode'), '图像以 DCTDecode(JPEG) 嵌入');
    ok(buf.slice(-6).toString('latin1').includes('%%EOF'), '以 %%EOF 结尾');
    // validate xref offsets point at "N 0 obj" (skip the free entry for object 0)
    const xrefAt = buf.indexOf('xref\n');
    const lines = buf.slice(xrefAt).toString('latin1').split('\n');
    const total = 3 + 3 * 3;
    ok(lines[1] === `0 ${total}`, `xref 声明 ${total} 个对象`);
    const offsets = lines.slice(3, 3 + total - 1).map(l => parseInt(l.split(' ')[0], 10));
    let xrefOk = true;
    offsets.forEach((off, i) => {
      const expect = `${i + 1} 0 obj`;
      if (buf.slice(off, off + expect.length).toString('latin1') !== expect) xrefOk = false;
    });
    ok(xrefOk, 'xref 偏移全部指向正确的对象');
    const sx = buf.lastIndexOf('startxref');
    const declared = parseInt(buf.slice(sx + 9).toString('latin1').trim().split('\n')[0], 10);
    ok(declared === xrefAt, 'startxref 指向 xref 表');
  })().then(runMore).catch(e => { failures++; console.error('PDF 测试异常: ' + e.message); runMore(); });
}

function runMore() {
  /* ---- 9. determinism -------------------------------------------------------- */
  section('确定性');
  {
    const problem = syntheticProblem(20, 3, 90);
    const assignments = syntheticAssignments(problem, 90);
    const spec = { ...SPEC_BASE, problem, name: 't',
      sections: [{ title: 'S', meta: '', assignments, mode: 'task' }] };
    const a = X.renderGanttExportPages(X.planGanttExport(spec)).map(serialise).join('\n');
    const b = X.renderGanttExportPages(X.planGanttExport(spec)).map(serialise).join('\n');
    ok(a === b, '相同输入两次渲染结果完全一致');
  }

  /* ---- 10. edge cases ---------------------------------------------------------- */
  section('边界情况');
  {
    const problem = syntheticProblem(0, 0, 50);
    const spec = { ...SPEC_BASE, problem, name: 't',
      sections: [{ title: 'S', meta: '', assignments: [], mode: 'task' }] };
    let threw = false;
    try {
      const plan = X.planGanttExport(spec);
      X.renderGanttExportPages(plan);
      ok(plan.pages.length === 1, '空方案仍导出 1 页（空态提示）');
    } catch (e) { threw = true; }
    ok(!threw, '空方案不抛异常');

    let guard = false;
    try { X.planGanttExport({ ...SPEC_BASE, problem, name: 't', sections: [] }); }
    catch (e) { guard = true; }
    ok(guard, '无方案时明确报错');

    // A5 portrait: tiny page must still paginate without zero-size windows
    const p2 = syntheticProblem(8, 2, 200);
    const a2 = syntheticAssignments(p2, 200);
    const plan2 = X.planGanttExport({ ...SPEC_BASE, paper: 'a5', orientation: 'portrait',
      problem: p2, name: 't', sections: [{ title: 'S', meta: '', assignments: a2, mode: 'task' }] });
    ok(plan2.pages.every(p => p.winEnd > p.winStart && p.rowEnd > p.rowStart),
      `A5 纵向小纸张正常分页（${plan2.pages.length} 页，无零宽窗口）`);
    X.renderGanttExportPages(plan2);   // must not throw
    ok(true, 'A5 纵向渲染不抛异常');
  }

  console.log(`\n${failures ? '✗ 失败 ' + failures + ' 项' : '✓ 全部通过'}`);
  process.exit(failures ? 1 : 0);
}
