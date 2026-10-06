/* SVG Gantt chart renderer (dependency-free).

   Usage: renderGantt(container, {
     problem: {resources, tasks, horizon, time_unit},
     assignments: [{task, start, end, resources}],
     mode: 'task' | 'resource',
     title
   })

   ganttModel() computes the shared layout (rows, bars, colours, axis step)
   used by BOTH the interactive renderer below and the print exporter in
   gantt-export.js.  Keeping a single layout model is what guarantees the
   exported file matches what is on screen.
*/

const GANTT_ROW_H = 34;
const GANTT_BAR_H = 20;
const GANTT_LEFT = 150;
const GANTT_TOP = 30;
const GANTT_PX_PER_UNIT = 24;

/* Pure layout model for a gantt view.  Null-prototype maps are used so task /
   resource ids can never collide with Object.prototype members. */
function ganttModel(problem, assignments, mode = 'resource') {
  assignments = assignments || [];
  const horizon = problem.horizon || 0;
  const tasks = Object.create(null);
  for (const t of problem.tasks || []) tasks[t.id] = t;
  const resources = Object.create(null);
  for (const r of problem.resources || []) resources[r.id] = r;

  // rows: task ids or resource ids
  const rowKeys = mode === 'task'
    ? (problem.tasks || []).map(t => t.id)
    : (problem.resources || []).map(r => r.id);
  const rowIndex = Object.create(null);
  rowKeys.forEach((k, i) => { rowIndex[k] = i; });
  const rowLabel = (k) => mode === 'task'
    ? `${k} · ${(tasks[k] && tasks[k].name) || ''}`.trim()
    : `${k} · ${(resources[k] && resources[k].name) || ''}`.trim();

  // One visible bar per (assignment, row): in resource mode an assignment
  // appears on every resource row it occupies.
  const bars = [];
  for (const a of assignments) {
    let rows;
    if (mode === 'task') {
      rows = a.task in rowIndex ? [a.task] : [];
    } else {
      rows = (a.resources || []).filter(r => r in rowIndex);
      if (!rows.length && rowKeys.length) rows = [rowKeys[0]];
    }
    for (const row of rows) bars.push({ assignment: a, row, color: colorFor(a.task) });
  }

  const makespan = assignments.length ? Math.max(...assignments.map(a => a.end)) : 0;
  const axisStep = Math.max(1, Math.round(horizon / 20));
  return {
    horizon, px: GANTT_PX_PER_UNIT, tasks, resources,
    rowKeys, rowIndex, rowLabel, bars, makespan, axisStep,
    width: GANTT_LEFT + horizon * GANTT_PX_PER_UNIT + 40,
    height: GANTT_TOP + rowKeys.length * GANTT_ROW_H + 40,
  };
}

/* Legend chips matching the bars.  Bars are coloured by task id (colorFor),
   so the legend lists tasks — not resources — in first-appearance order. */
function ganttLegendItems(problem, assignments) {
  const ids = [];
  for (const a of assignments || []) if (!ids.includes(a.task)) ids.push(a.task);
  if (!ids.length) for (const t of problem.tasks || []) ids.push(t.id);
  return ids.map(id => ({ id, label: id, color: colorFor(id) }));
}

function renderGantt(container, opts) {
  const { problem, assignments = [], mode = 'resource', title } = opts;
  const model = ganttModel(problem, assignments, mode);
  const { horizon, px, rowKeys, rowLabel } = model;
  const tasks = model.tasks;
  const width = model.width;
  const height = model.height;

  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'gantt-wrap';
  wrap.style.position = 'relative';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.style.fontFamily = 'system-ui, sans-serif';
  wrap.appendChild(svg);
  container.appendChild(wrap);

  // tooltip element
  const tip = document.createElement('div');
  tip.className = 'gantt-tooltip';
  tip.style.display = 'none';
  wrap.appendChild(tip);

  function add(tag, attrs) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.appendChild(el);
    return el;
  }

  // header
  if (title) {
    const t = add('text', { x: GANTT_LEFT, y: 18, 'font-size': 13, 'font-weight': 600, fill: '#1f2430' });
    t.textContent = title;
  }

  // time axis grid + labels
  for (let t = 0; t <= horizon; t += model.axisStep) {
    const x = GANTT_LEFT + t * px;
    add('line', { x1: x, y1: GANTT_TOP - 6, x2: x, y2: GANTT_TOP + rowKeys.length * GANTT_ROW_H, stroke: '#eef0f3', 'stroke-width': 1 });
    const lbl = add('text', { x, y: GANTT_TOP - 10, 'font-size': 10, fill: '#6b7280', 'text-anchor': 'middle' });
    lbl.textContent = t;
  }

  // rows
  rowKeys.forEach((k, i) => {
    const y = GANTT_TOP + i * GANTT_ROW_H;
    add('line', { x1: GANTT_LEFT, y1: y + GANTT_ROW_H - 8, x2: GANTT_LEFT + horizon * px, y2: y + GANTT_ROW_H - 8, stroke: '#e5e7eb' });
    const lbl = add('text', { x: GANTT_LEFT - 8, y: y + GANTT_ROW_H / 2 + 4, 'font-size': 12, fill: '#374151', 'text-anchor': 'end' });
    lbl.textContent = rowLabel(k);
  });

  // bars
  for (const bar of model.bars) {
    const a = bar.assignment;
    const x = GANTT_LEFT + a.start * px;
    const w = Math.max(3, (a.end - a.start) * px);
    const y = GANTT_TOP + model.rowIndex[bar.row] * GANTT_ROW_H;
    const g = add('g', { class: 'gantt-bar', 'data-task': a.task });
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    for (const [k, v] of Object.entries({
      x, y: y + (GANTT_ROW_H - GANTT_BAR_H) / 2, width: w, height: GANTT_BAR_H,
      rx: 4, fill: bar.color, opacity: 0.85, stroke: 'rgba(0,0,0,.15)',
    })) rect.setAttribute(k, v);
    g.appendChild(rect);
    if (w > 34) {
      const label = add('text', { x: x + 6, y: y + GANTT_ROW_H / 2 + 4, 'font-size': 11, fill: '#fff', 'font-weight': 600 });
      label.textContent = a.task;
      g.appendChild(label);
    }
    // interactions
    const show = (ev) => {
      tip.innerHTML = `<b>${escapeHtml(a.task)}</b> · ${escapeHtml(tasks[a.task]?.name || '')}<br>` +
        `开始 ${a.start} → 结束 ${a.end}（工期 ${a.end - a.start} ${problem.time_unit}）<br>` +
        `资源：${escapeHtml((a.resources || []).join(', ') || '—')}`;
      tip.style.display = 'block';
      const rectBox = wrap.getBoundingClientRect();
      tip.style.left = (ev.clientX - rectBox.left + 12) + 'px';
      tip.style.top = (ev.clientY - rectBox.top + 12) + 'px';
    };
    rect.addEventListener('mousemove', show);
    rect.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
  }

  // makespan marker
  if (model.makespan > 0) {
    const x = GANTT_LEFT + model.makespan * px;
    add('line', { x1: x, y1: GANTT_TOP - 6, x2: x, y2: GANTT_TOP + rowKeys.length * GANTT_ROW_H, stroke: '#dc2626', 'stroke-width': 2, 'stroke-dasharray': '4 3' });
    const mkLbl = add('text', { x, y: GANTT_TOP - 12, 'font-size': 11, fill: '#dc2626', 'font-weight': 700, 'text-anchor': 'middle' });
    mkLbl.textContent = '完工时间 ' + model.makespan;
  }
}
