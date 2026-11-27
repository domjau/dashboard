/* Seafood Demand Planner – report + writeback client for Supabase (PostgREST). */
(() => {
"use strict";
const CFG = window.APP_CONFIG;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

// ------------------------------------------------------------------ API
const api = {
  headers(extra = {}) { return { apikey: CFG.supabaseKey, "Content-Type": "application/json", ...extra }; },
  async get(path) {
    const res = await fetch(`${CFG.supabaseUrl}/rest/v1/${path}`, { headers: this.headers() });
    if (!res.ok) throw new Error(await errText(res));
    return res.json();
  },
  async getAll(path, page = 1000) {
    let out = [], off = 0;
    for (;;) {
      const sep = path.includes("?") ? "&" : "?";
      const chunk = await this.get(`${path}${sep}limit=${page}&offset=${off}`);
      out = out.concat(chunk);
      if (chunk.length < page) return out;
      off += page;
    }
  },
  async rpc(fn, body) {
    const res = await fetch(`${CFG.supabaseUrl}/rest/v1/rpc/${fn}`, {
      method: "POST", headers: this.headers(), body: JSON.stringify(body) });
    if (!res.ok) throw new Error(await errText(res));
    return res.json();
  },
};
async function errText(res) {
  try { const j = await res.json(); return j.message || j.error || JSON.stringify(j); }
  catch { return `${res.status} ${res.statusText}`; }
}

// ------------------------------------------------------------------ State
const S = {
  rows: [], byId: new Map(), series: new Map(),
  comments: [], cByPlan: new Map(), audit: [], lastAuditId: 0,
  months: [], actMonths: [], fcMonths: [],
  filters: {}, unit: "kg", page: "overview",
  user: CFG.users[0], selId: null, editing: null,
  feedStatus: "Open", feedCategory: null, gridMatrix: [], cardLimit: 20,
};
const DIMS = [
  ["region", "Region"], ["country", "Country"], ["channel", "Channel"],
  ["species", "Species"], ["product_format", "Format"], ["product_name", "Product"],
  ["customer", "Customer"], ["demand_planner", "Demand planner"],
];
DIMS.forEach(([k]) => (S.filters[k] = new Set()));
const CATEGORIES = ["Tender pending", "Customer confirmed", "New business", "Lost business", "Price change",
  "Promotion / campaign", "Supply constraint", "Catch / quota", "Regulatory", "Phasing / timing", "Other"];
const CAT_CLASS = { "Tender pending": "t-tender", "Customer confirmed": "t-confirmed", "Lost business": "t-lost",
  "Regulatory": "t-reg", "Catch / quota": "t-reg", "New business": "t-new" };
const COLORS = { actual: "#257de0", final: "#f47230", stat: "#8a8886", py: "#c2c2c2", bar: "#257de0", bar2: "#84b9f3" };

// ------------------------------------------------------------------ Responsive
const mq = window.matchMedia("(max-width: 860px)");
const isMobile = () => mq.matches;

// ------------------------------------------------------------------ Helpers
const finalKg = r => (r.override_kg ?? r.consensus_kg);
const toUnit = (kg, r) => (S.unit === "eur" ? kg * r.price_eur_per_kg : kg);
const seriesKey = r => `${r.product_code}|${r.customer}|${r.country}`;
const nf0 = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 });
const fmtN = v => (v == null || isNaN(v) ? "–" : nf0.format(v));
function fmtC(v, unit = S.unit) {
  if (v == null || isNaN(v)) return "–";
  const a = Math.abs(v);
  const s = a >= 1e6 ? String(+(v / 1e6).toFixed(a >= 1e8 ? 0 : a >= 1e7 ? 1 : 2)) + "M" : a >= 1e4 ? (v / 1e3).toFixed(0) + "k" : a >= 1e3 ? (v / 1e3).toFixed(1) + "k" : v.toFixed(0);
  return unit === "eur" ? `€${s}` : `${s} kg`;
}
const fmtU = v => (S.unit === "eur" ? "€" + fmtN(v) : fmtN(v) + " kg");
const pct = (v, d = 1) => (v == null || !isFinite(v) ? "–" : (v >= 0 ? "+" : "−") + Math.abs(v * 100).toFixed(d) + "%");
const mLabel = iso => { const d = new Date(iso + "T00:00:00Z"); return d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" }) + " " + String(d.getUTCFullYear()).slice(2); };
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const when = ts => { const d = new Date(ts); const diff = (Date.now() - d) / 1000;
  if (diff < 60) return "just now"; if (diff < 3600) return Math.floor(diff / 60) + " min ago";
  if (diff < 86400) return Math.floor(diff / 3600) + " h ago"; if (diff < 86400 * 7) return Math.floor(diff / 86400) + " d ago";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }); };
const sum = (arr, f) => arr.reduce((a, x) => a + (f(x) || 0), 0);
function store(k, v) { try { v === undefined ? localStorage.getItem(k) : localStorage.setItem(k, v); } catch {} }
function recall(k) { try { return localStorage.getItem(k); } catch { return null; } }

function toast(msg, kind = "ok") {
  const t = document.createElement("div");
  t.className = "toast " + (kind === "ok" ? "" : kind);
  t.innerHTML = msg;
  $("#toasts").appendChild(t);
  setTimeout(() => t.remove(), kind === "err" ? 7000 : 3800);
}
function setSync(ok, text) {
  const el = $("#syncStatus");
  el.className = "sync " + (ok ? "ok" : "err");
  el.querySelector("span").textContent = text;
}

// ------------------------------------------------------------------ Data load
function indexRows(rows) {
  S.rows = rows;
  S.byId = new Map(rows.map(r => [r.id, r]));
  S.series = new Map();
  for (const r of rows) {
    const k = seriesKey(r);
    if (!S.series.has(k)) S.series.set(k, { key: k, meta: r, cells: {} });
    S.series.get(k).cells[r.period] = r;
  }
  const months = [...new Set(rows.map(r => r.period))].sort();
  S.months = months;
  S.actMonths = months.filter(m => rows.some(r => r.period === m && r.period_type === "Actual"));
  S.fcMonths = months.filter(m => !S.actMonths.includes(m));
}
function indexComments(c) {
  S.comments = c;
  S.cByPlan = new Map();
  for (const x of c) { if (!S.cByPlan.has(x.plan_id)) S.cByPlan.set(x.plan_id, []); S.cByPlan.get(x.plan_id).push(x); }
}
const openCount = id => (S.cByPlan.get(id) || []).filter(c => c.status === "Open").length;

async function loadAll() {
  const [rows, comments, audit] = await Promise.all([
    api.getAll(`demand_plan?select=*&plan_cycle=eq.${CFG.planCycle}&order=id`),
    api.getAll("plan_comment?select=*&order=created_at.desc"),
    api.get("plan_audit?select=*&order=id.desc&limit=500"),
  ]);
  indexRows(rows);
  indexComments(comments);
  S.audit = audit;
  S.lastAuditId = audit.length ? audit[0].id : 0;
  setSync(true, `Live · ${rows.length.toLocaleString()} rows · synced ${new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`);
}
async function refetchRows(ids) {
  ids = [...new Set(ids)];
  for (let i = 0; i < ids.length; i += 150) {
    const chunk = await api.get(`demand_plan?select=*&id=in.(${ids.slice(i, i + 150).join(",")})`);
    for (const r of chunk) {
      const old = S.byId.get(r.id);
      if (old) Object.assign(old, r);
    }
  }
}
async function refetchComments() { indexComments(await api.getAll("plan_comment?select=*&order=created_at.desc")); }

// Poll the audit log for changes (from anyone) and pull in what changed
let polling = false;
async function poll() {
  if (polling || document.hidden) return;
  polling = true;
  try {
    const fresh = await api.get(`plan_audit?select=*&id=gt.${S.lastAuditId}&order=id.asc`);
    if (fresh.length) {
      S.lastAuditId = fresh[fresh.length - 1].id;
      S.audit = [...fresh.reverse(), ...S.audit].slice(0, 800);
      const rowIds = fresh.filter(a => /OVERRIDE|BULK/.test(a.action)).map(a => a.plan_id);
      if (rowIds.length) await refetchRows(rowIds);
      if (fresh.some(a => a.action === "COMMENT" || a.action === "RESOLVE")) await refetchComments();
      const others = fresh.filter(a => a.actor !== S.user);
      if (others.length) {
        const who = [...new Set(others.map(a => a.actor))].join(", ");
        toast(`<b>${esc(who)}</b> made ${others.length} change${others.length > 1 ? "s" : ""}. View updated.`, "info");
      }
      renderPage(true);
    }
    setSync(true, `Live · ${S.rows.length.toLocaleString()} rows · synced ${new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`);
  } catch (e) { setSync(false, "Offline – retrying"); }
  polling = false;
}

// ------------------------------------------------------------------ Filtering
function passes(r, skipDim) {
  for (const [k] of DIMS) {
    if (k === skipDim) continue;
    const f = S.filters[k];
    if (f.size && !f.has(r[k])) return false;
  }
  return true;
}
const filtered = () => S.rows.filter(r => passes(r));

// ------------------------------------------------------------------ Slicers
let openSlicer = null;
function renderSlicers() {
  const box = $("#slicers");
  const active = DIMS.reduce((a, [k]) => a + (S.filters[k].size ? 1 : 0), 0);
  $("#filterCount").textContent = active || "";
  box.innerHTML = `<div class="sheet-h"><span class="grab"></span><b>Filters</b><button class="btn primary" id="filtersDone">Done</button></div>` + DIMS.map(([k, lbl]) => {
    const f = S.filters[k];
    const txt = f.size === 0 ? "All" : f.size === 1 ? [...f][0] : `${f.size} selected`;
    return `<div class="slicer" data-dim="${k}"><label>${lbl}</label><button class="slicer-btn ${f.size ? "active" : ""}" title="${esc(txt)}">${esc(txt)}</button></div>`;
  }).join("") + `<button class="linkbtn clear-all" id="clearAll">Clear all filters</button>`;
  $$(".slicer-btn", box).forEach(b => b.addEventListener("click", e => { e.stopPropagation(); toggleSlicer(b.parentElement.dataset.dim); }));
  $("#clearAll").addEventListener("click", () => { DIMS.forEach(([k]) => S.filters[k].clear()); onFilter(); });
  $("#filtersDone").addEventListener("click", e => { e.stopPropagation(); closeFilterSheet(); });
}
function toggleSlicer(dim) {
  closeSlicer();
  if (openSlicer === dim) { openSlicer = null; return; }
  openSlicer = dim;
  const host = $(`.slicer[data-dim="${dim}"]`);
  const all = [...new Set(S.rows.map(r => r[dim]))].sort();
  const avail = new Set(S.rows.filter(r => passes(r, dim)).map(r => r[dim]));
  const pop = document.createElement("div");
  pop.className = "slicer-pop";
  pop.innerHTML = `<input type="search" placeholder="Search">
    <div class="slicer-list">${all.map(v => `<label class="slicer-item ${avail.has(v) ? "" : "dim"}"><input type="checkbox" value="${esc(v)}" ${S.filters[dim].has(v) ? "checked" : ""}>${esc(v)}</label>`).join("")}</div>
    <div class="slicer-actions"><button class="linkbtn" data-a="all">Select all</button><button class="linkbtn" data-a="clear">Clear</button></div>`;
  host.appendChild(pop);
  pop.addEventListener("click", e => e.stopPropagation());
  const q = $("input[type=search]", pop);
  q.focus();
  q.addEventListener("input", () => $$(".slicer-item", pop).forEach(it => (it.style.display = it.textContent.toLowerCase().includes(q.value.toLowerCase()) ? "" : "none")));
  $$(".slicer-item input", pop).forEach(cb => cb.addEventListener("change", () => {
    cb.checked ? S.filters[dim].add(cb.value) : S.filters[dim].delete(cb.value);
    onFilter(true);
  }));
  $$(".slicer-actions button", pop).forEach(b => b.addEventListener("click", () => {
    if (b.dataset.a === "clear") S.filters[dim].clear();
    else $$(".slicer-item", pop).filter(i => i.style.display !== "none" && !i.classList.contains("dim")).forEach(i => S.filters[dim].add(i.querySelector("input").value));
    onFilter();
  }));
}
function closeSlicer() { $$(".slicer-pop").forEach(p => p.remove()); }
function openFilterSheet() { $("#slicers").classList.add("open"); $("#sheetBackdrop").classList.add("open"); }
function closeFilterSheet() { closeSlicer(); openSlicer = null; $("#slicers").classList.remove("open"); $("#sheetBackdrop").classList.remove("open"); renderSlicers(); }
document.addEventListener("click", () => { if (openSlicer) { closeSlicer(); openSlicer = null; renderSlicers(); } });

function onFilter(keepPop) {
  S.cardLimit = 20;
  if (!keepPop) { closeSlicer(); openSlicer = null; renderSlicers(); }
  else { // update button labels without closing
    $("#filterCount").textContent = DIMS.reduce((a, [k]) => a + (S.filters[k].size ? 1 : 0), 0) || "";
    DIMS.forEach(([k]) => { const b = $(`.slicer[data-dim="${k}"] .slicer-btn`); const f = S.filters[k];
      b.textContent = f.size === 0 ? "All" : f.size === 1 ? [...f][0] : `${f.size} selected`; b.classList.toggle("active", f.size > 0); });
  }
  renderPage();
}
function crossFilter(dim, value) {
  const f = S.filters[dim];
  if (f.size === 1 && f.has(value)) f.clear(); else { f.clear(); f.add(value); }
  onFilter();
}

// ------------------------------------------------------------------ Charts
const charts = {};
function chart(id) {
  if (!charts[id]) charts[id] = echarts.init(document.getElementById(id), null, { renderer: "svg" });
  return charts[id];
}
window.addEventListener("resize", () => Object.values(charts).forEach(c => c.resize()));
const axisCommon = {
  axisLine: { lineStyle: { color: "#c2c2c2" } }, axisTick: { show: false },
  axisLabel: { color: "#605e5c", fontSize: 11 }, splitLine: { lineStyle: { color: "#ececec" } },
};
const tipBase = { backgroundColor: "#fff", borderColor: "#e1dfdd", textStyle: { color: "#191919", fontSize: 12 }, extraCssText: "box-shadow:0 4px 14px rgba(0,0,0,.12);border-radius:4px;" };

// ------------------------------------------------------------------ Overview
function renderOverview() {
  const rows = filtered();
  const fc = rows.filter(r => r.period_type === "Forecast");
  const act = rows.filter(r => r.period_type === "Actual");
  const final = sum(fc, r => toUnit(finalKg(r), r));
  const stat = sum(fc, r => toUnit(r.stat_forecast_kg, r));
  const cons = sum(fc, r => toUnit(r.consensus_kg, r));
  const pyFc = sum(fc.filter(r => r.prior_year_kg > 0), r => toUnit(r.prior_year_kg, r));
  const finWithPy = sum(fc.filter(r => r.prior_year_kg > 0), r => toUnit(finalKg(r), r));
  const actSum = sum(act, r => r.actual_kg);
  const absErr = sum(act, r => Math.abs(r.actual_kg - r.consensus_kg));
  const biasV = sum(act, r => r.consensus_kg - r.actual_kg);
  const acc = actSum ? 1 - absErr / actSum : null;
  const ovr = fc.filter(r => r.override_kg != null);
  const ovrImpact = sum(ovr, r => toUnit(r.override_kg - r.consensus_kg, r));
  const ids = new Set(rows.map(r => r.id));
  const openC = S.comments.filter(c => c.status === "Open" && ids.has(c.plan_id));
  const tender = openC.filter(c => c.category === "Tender pending").length;
  const confirmed = openC.filter(c => c.category === "Customer confirmed").length;
  const vsPy = pyFc ? finWithPy / pyFc - 1 : null;
  const vsStat = stat ? final / stat - 1 : null;
  const cls = v => (v == null ? "" : v >= 0 ? "up" : "down");
  const [n, suf] = splitC(final);
  $("#kpis").innerHTML = `
    <div class="kpi"><div class="lbl">Final forecast · next 12M</div><div class="val">${n}<small>${suf}</small></div><div class="foot"><span class="${cls(vsStat)}">${pct(vsStat)}</span> vs statistical</div></div>
    <div class="kpi"><div class="lbl">Growth vs prior year</div><div class="val">${pct(vsPy)}</div><div class="foot">PY same months: ${fmtC(pyFc)}</div></div>
    <div class="kpi"><div class="lbl">Forecast accuracy · L6M</div><div class="val">${acc == null ? "–" : (acc * 100).toFixed(1) + "%"}</div><div class="foot">WMAPE ${actSum ? (absErr / actSum * 100).toFixed(1) + "%" : "–"} · bias ${pct(actSum ? biasV / actSum : null)}</div></div>
    <div class="kpi"><div class="lbl">Planner overrides</div><div class="val">${ovr.length}<small>cells</small></div><div class="foot">Net impact <span class="${cls(ovrImpact)}">${ovrImpact >= 0 ? "+" : ""}${fmtC(ovrImpact)}</span></div></div>
    <div class="kpi"><div class="lbl">Open comments</div><div class="val">${openC.length}</div><div class="foot">${tender} tender pending · ${confirmed} customer confirmed</div></div>`;

  // ---- Trend
  const m = S.months;
  const by = (f, onlyType) => m.map(p => { const rs = rows.filter(r => r.period === p && (!onlyType || r.period_type === onlyType)); return rs.length ? sum(rs, f) : null; });
  const actualS = by(r => toUnit(r.actual_kg, r), "Actual");
  const finalS = m.map((p, i) => S.fcMonths.includes(p) ? sum(rows.filter(r => r.period === p), r => toUnit(finalKg(r), r)) : null);
  const lastAct = S.actMonths.length - 1;
  if (lastAct >= 0) finalS[lastAct] = actualS[lastAct]; // connect actual → forecast
  const statS = by(r => toUnit(r.stat_forecast_kg, r));
  const pyS = by(r => toUnit(r.prior_year_kg, r));
  const labels = m.map(mLabel);
  const fcStart = labels[S.actMonths.length];
  chart("chTrend").setOption({
    animationDuration: 300,
    grid: { left: 8, right: isMobile() ? 56 : 64, top: isMobile() ? 56 : 34, bottom: 4, containLabel: true },
    legend: { top: 0, left: 0, itemGap: isMobile() ? 8 : 10, itemWidth: 16, itemHeight: 3, icon: "rect", textStyle: { color: "#605e5c", fontSize: 12 } },
    tooltip: { ...tipBase, trigger: "axis", axisPointer: { type: "line", lineStyle: { color: "#8a8886" } },
      valueFormatter: v => (v == null ? "–" : fmtU(v)) },
    xAxis: { type: "category", data: labels, boundaryGap: false, ...axisCommon, splitLine: { show: false } },
    yAxis: { type: "value", scale: true, ...axisCommon, axisLine: { show: false }, axisLabel: { ...axisCommon.axisLabel, formatter: v => fmtC(v) } },
    series: [
      { name: "Actual", type: "line", data: actualS, lineStyle: { width: 2, color: COLORS.actual }, itemStyle: { color: COLORS.actual }, symbol: "circle", symbolSize: 7, showSymbol: true,
        markArea: { silent: true, itemStyle: { color: "rgba(242,166,0,.07)" }, label: { color: "#8a8886", fontSize: 11, position: "insideTopLeft" },
          data: [[{ name: "Forecast horizon →", xAxis: fcStart }, { xAxis: labels[labels.length - 1] }]] } },
      { name: "Final forecast", type: "line", lineStyle: { width: 2, color: COLORS.final }, itemStyle: { color: COLORS.final }, symbol: "circle", symbolSize: 7,
        data: finalS.map((v, i) => i === finalS.length - 1 ? { value: v, label: { show: true, position: "right", formatter: p => fmtC(p.value), color: "#191919", fontSize: 11 } } : v) },
      { name: "Statistical forecast", type: "line", data: statS, lineStyle: { width: 1.5, type: [4, 3], color: COLORS.stat }, itemStyle: { color: COLORS.stat }, symbol: "none" },
      { name: "Prior year", type: "line", data: pyS, lineStyle: { width: 1.5, color: COLORS.py }, itemStyle: { color: COLORS.py }, symbol: "none" },
    ],
  }, true);

  // ---- Bridge (waterfall)
  const steps = [["Statistical", stat, "total"], ["Market\nintel", cons - stat, "delta"], ["Planner\nwriteback", final - cons, "delta"], ["Final", final, "total"]];
  let run = 0; const base = [], val = [];
  const lo = Math.min(stat, cons, final), hi = Math.max(stat, cons, final);
  const span = Math.max(hi - lo, hi * 0.01);
  const step = Math.pow(10, Math.floor(Math.log10(span * 4)));
  const yMin = Math.max(0, Math.floor((lo - span * 2.5) / step) * step);
  const yMax = Math.ceil((hi + span * 0.6) / step) * step;
  steps.forEach(([, v, t]) => { if (t === "total") { base.push(0); val.push(v); run = v; } else { base.push(v >= 0 ? run : run + v); val.push(Math.abs(v)); run += v; } });
  chart("chBridge").setOption({
    animationDuration: 300,
    grid: { left: 8, right: 12, top: 22, bottom: 4, containLabel: true },
    tooltip: { ...tipBase, trigger: "axis", axisPointer: { type: "shadow", shadowStyle: { color: "rgba(0,0,0,.03)" } },
      formatter: ps => { const i = ps[0].dataIndex; const [nm, v, t] = steps[i]; return `<b>${nm.replace("\n", " ")}</b><br>${t === "delta" ? (v >= 0 ? "+" : "−") + fmtU(Math.abs(v)) : fmtU(v)}`; } },
    xAxis: { type: "category", data: steps.map(s => s[0]), ...axisCommon, axisLabel: { ...axisCommon.axisLabel, interval: 0 }, splitLine: { show: false } },
    yAxis: { type: "value", ...axisCommon, axisLine: { show: false }, min: yMin, max: yMax, axisLabel: { ...axisCommon.axisLabel, formatter: v => fmtC(v) } },
    series: [
      { type: "bar", stack: "w", data: base, itemStyle: { color: "transparent" }, silent: true },
      { type: "bar", stack: "w", data: val.map((v, i) => ({ value: v, itemStyle: { color: steps[i][2] === "total" ? COLORS.bar : steps[i][1] >= 0 ? "#00b894" : "#ec4647", borderRadius: [3, 3, 0, 0] } })),
        barWidth: "46%", label: { show: true, position: "top", color: "#191919", fontSize: 11, formatter: p => { const [, v, t] = steps[p.dataIndex]; return t === "delta" ? (v >= 0 ? "+" : "−") + fmtC(Math.abs(v)) : fmtC(v); } } },
    ],
  }, true);

  // ---- Region / Channel bars (cross-filter)
  barBy("chRegion", "region", fc);
  barBy("chChannel", "channel", fc);

  // ---- Matrix (growth vs PY)
  const regs = [...new Set(rows.map(r => r.region))].sort();
  const inds = [...new Set(rows.map(r => r.channel))].sort();
  const cell = (rg, ind) => { const rs = fc.filter(r => r.region === rg && r.channel === ind && r.prior_year_kg > 0);
    if (!rs.length) return null; const py = sum(rs, r => toUnit(r.prior_year_kg, r)); return py ? sum(rs, r => toUnit(finalKg(r), r)) / py - 1 : null; };
  const colorFor = v => { const t = Math.max(-1, Math.min(1, v / 0.15));
    const mix = (a, b, k) => a.map((x, i) => Math.round(x + (b[i] - x) * k));
    const mid = [239, 239, 239], pos = [27, 100, 190], neg = [196, 53, 53];
    const c = t >= 0 ? mix(mid, pos, t) : mix(mid, neg, -t);
    return { bg: `rgb(${c})`, fg: Math.abs(t) > 0.55 ? "#fff" : "#191919" }; };
  $("#matrix").innerHTML = `<table class="matrix"><thead><tr><th></th>${inds.map(i => `<th>${esc(i)}</th>`).join("")}</tr></thead><tbody>
    ${regs.map(rg => `<tr><th>${esc(rg)}</th>${inds.map(ind => { const v = cell(rg, ind); if (v == null) return `<td class="na">·</td>`;
      const c = colorFor(v); return `<td style="background:${c.bg};color:${c.fg}" title="${esc(rg)} · ${esc(ind)}: ${pct(v)} vs PY">${(v * 100).toFixed(0)}%</td>`; }).join("")}</tr>`).join("")}
    </tbody></table><div class="scale">−15%<span class="bar"></span>+15% <span style="margin-left:8px">· = no business</span></div>`;

  // ---- Top customers
  const cust = new Map();
  for (const r of fc) {
    const c = cust.get(r.customer) || { name: r.customer, ind: r.channel, fin: 0, py: 0, pyF: 0, regions: new Set(), ids: [] };
    c.fin += toUnit(finalKg(r), r); if (r.prior_year_kg > 0) { c.py += toUnit(r.prior_year_kg, r); c.pyF += toUnit(finalKg(r), r); }
    c.regions.add(r.region); c.ids.push(r.id); cust.set(r.customer, c);
  }
  const top = [...cust.values()].sort((a, b) => b.fin - a.fin).slice(0, 12);
  const max = top[0]?.fin || 1;
  $("#topCustomers").innerHTML = `<table class="t"><thead><tr><th>Customer</th><th>Channel</th><th>Regions</th><th class="num">Final forecast</th><th class="num">vs PY</th><th class="num">Open comments</th></tr></thead><tbody>
    ${top.map(c => { const g = c.py ? c.pyF / c.py - 1 : null; const oc = c.ids.reduce((a, id) => a + openCount(id), 0);
      return `<tr><td>${esc(c.name)}</td><td>${esc(c.ind)}</td><td>${c.regions.size}</td>
      <td class="num databar"><i style="width:${(c.fin / max * 100).toFixed(1)}%"></i><span>${fmtC(c.fin)}</span></td>
      <td class="num ${g == null ? "" : g >= 0 ? "up" : "down"}">${pct(g)}</td><td class="num">${oc || ""}</td></tr>`; }).join("")}
    </tbody></table>`;

  // ---- Comment preview
  renderFeed($("#commentPreview"), openC.slice(0, 10));
}
function splitC(v) { const s = fmtC(v); if (S.unit === "eur") return [s, ""]; return [s.replace(" kg", ""), "kg"]; }
function barBy(id, dim, fc) {
  const g = new Map();
  for (const r of fc) g.set(r[dim], (g.get(r[dim]) || 0) + toUnit(finalKg(r), r));
  const data = [...g.entries()].sort((a, b) => a[1] - b[1]);
  const sel = S.filters[dim];
  const c = chart(id);
  c.setOption({
    animationDuration: 300,
    grid: { left: 8, right: 54, top: 4, bottom: 4, containLabel: true },
    tooltip: { ...tipBase, trigger: "item", confine: true, formatter: p => `<b>${esc(p.name)}</b><br>${fmtU(p.value)}<br><span style="color:#8a8886">Click to ${sel.has(p.name) && sel.size === 1 ? "clear filter" : "filter"}</span>` },
    xAxis: { type: "value", show: false },
    yAxis: { type: "category", data: data.map(d => d[0]), ...axisCommon, axisLine: { show: false }, splitLine: { show: false } },
    series: [{ type: "bar", barWidth: "62%", cursor: "pointer",
      data: data.map(([k, v]) => ({ value: v, itemStyle: { color: !sel.size || sel.has(k) ? COLORS.bar : "#cce3fd", borderRadius: [0, 3, 3, 0] } })),
      label: { show: true, position: "right", color: "#191919", fontSize: 11, formatter: p => fmtC(p.value) } }],
  }, true);
  c.off("click");
  c.on("click", p => crossFilter(dim, p.name));
}

// ------------------------------------------------------------------ Writeback grid
function gridSeries() {
  const q = $("#gridSearch").value.trim().toLowerCase();
  const only = $("#onlyChanged").checked;
  const list = [];
  for (const s of S.series.values()) {
    if (!passes(s.meta)) continue;
    const m = s.meta;
    if (q && ![m.product_name, m.product_code, m.customer, m.country, m.channel, m.species, m.product_format].some(v => v.toLowerCase().includes(q))) continue;
    const cells = Object.values(s.cells);
    if (only && !cells.some(r => r.override_kg != null || openCount(r.id) || (S.cByPlan.get(r.id) || []).length)) continue;
    list.push(s);
  }
  const tot = s => sum(Object.values(s.cells).filter(r => r.period_type === "Forecast"), r => toUnit(finalKg(r), r));
  list.forEach(s => (s._tot = tot(s)));
  return list.sort((a, b) => b._tot - a._tot);
}
function cellHtml(r, ri, ci) {
  if (!r) return `<td class="v act">–</td>`;
  const isAct = r.period_type === "Actual";
  const v = isAct ? toUnit(r.actual_kg, r) : toUnit(finalKg(r), r);
  const cls = ["v", isAct ? "act" : "", r.override_kg != null && !isAct ? "ovr" : "", (S.cByPlan.get(r.id) || []).some(c => c.status === "Open") ? "cm" : "", S.selId === r.id ? "sel" : ""].join(" ");
  const tip = isAct ? `Actual · forecast was ${fmtN(toUnit(r.consensus_kg, r))}` : r.override_kg != null ? `Override by ${r.updated_by} · consensus ${fmtN(toUnit(r.consensus_kg, r))}` : `Stat ${fmtN(toUnit(r.stat_forecast_kg, r))} · consensus`;
  return `<td class="${cls}" data-id="${r.id}" data-r="${ri}" data-c="${ci}" title="${esc(tip)}">${fmtN(v)}</td>`;
}
function mcellHtml(r) {
  const isAct = r.period_type === "Actual";
  const v = isAct ? toUnit(r.actual_kg, r) : toUnit(finalKg(r), r);
  const cls = ["mcell", isAct ? "act" : "", r.override_kg != null && !isAct ? "ovr" : "", (S.cByPlan.get(r.id) || []).some(c => c.status === "Open") ? "cm" : "", S.selId === r.id ? "sel" : ""].join(" ");
  return `<button class="${cls}" data-id="${r.id}"><span class="m">${mLabel(r.period)}${isAct ? " · A" : ""}</span><span class="v">${fmtC(v).replace(" kg", "")}</span></button>`;
}
function renderCards() {
  const showAct = $("#showActuals").checked;
  const cols = [...(showAct ? S.actMonths : []), ...S.fcMonths];
  const list = gridSeries();
  const shown = list.slice(0, S.cardLimit);
  const box = $("#wbCards");
  const grand = sum(list, s => s._tot);
  box.innerHTML = `<div class="mc-summary">${list.length} series · total next 12M <b>${fmtC(grand)}</b> · tap a month to edit or comment</div>` +
    shown.map(s => {
      const m = s.meta;
      const st = sum(Object.values(s.cells).filter(r => r.period_type === "Forecast"), r => toUnit(r.stat_forecast_kg, r));
      const d = st ? s._tot / st - 1 : null;
      return `<div class="mcard"><div class="mc-h"><div class="mc-name"><span class="mc-code">${esc(m.product_code)} · ${esc(m.species)} · ${esc(m.product_format)}</span>${esc(m.product_name)}</div>
        <div class="mc-tot">Next 12M<b>${fmtC(s._tot)}</b><span class="${d == null ? "" : d >= 0 ? "up" : "down"}">${pct(d)}</span> vs stat</div></div>
        <div class="mc-sub">${esc(m.customer)} · ${esc(m.country)} · ${esc(m.channel)}</div>
        <div class="mc-strip">${cols.map(p => s.cells[p] ? mcellHtml(s.cells[p]) : "").join("")}</div></div>`;
    }).join("") +
    (list.length > shown.length ? `<button class="btn mc-more" id="mcMore">Show ${Math.min(20, list.length - shown.length)} more (${list.length - shown.length} remaining)</button>` : "") +
    (!list.length ? `<div class="empty">No series match the current filters.</div>` : "");
  if (showAct) $$(".mc-strip", box).forEach(st => { const f = st.querySelector(".mcell:not(.act)"); if (f) st.scrollLeft = f.offsetLeft - st.offsetLeft - 90; });
  $("#mcMore")?.addEventListener("click", () => { S.cardLimit += 20; const y = window.scrollY; renderCards(); window.scrollTo(0, y); });
}
function renderGrid() {
  if (S.editing) return; // don't clobber an active edit
  if (isMobile()) { renderCards(); return; }
  const showAct = $("#showActuals").checked;
  const cols = [...(showAct ? S.actMonths : []), ...S.fcMonths];
  const list = gridSeries();
  S.gridMatrix = list.map(s => cols.map(p => s.cells[p]?.id ?? null));
  const nAct = showAct ? S.actMonths.length : 0;
  const head = `<thead>
    <tr class="grp"><th class="stick c0 dim"></th><th class="stick c1 dim"></th><th class="stick c2 dim"></th>
      ${nAct ? `<th colspan="${nAct}">Actuals (locked)</th>` : ""}<th colspan="${S.fcMonths.length}">Final forecast (${S.unit === "eur" ? "EUR" : "kg"}) · editable</th><th colspan="2">Next 12M</th></tr>
    <tr class="mon"><th class="stick c0 dim">Product</th><th class="stick c1 dim">Customer</th><th class="stick c2 dim">Country</th>
      ${cols.map(p => `<th>${mLabel(p)}</th>`).join("")}<th>Total</th><th>vs stat</th></tr></thead>`;
  const body = list.map((s, ri) => {
    const m = s.meta;
    const fcs = Object.values(s.cells).filter(r => r.period_type === "Forecast");
    const st = sum(fcs, r => toUnit(r.stat_forecast_kg, r));
    const d = st ? s._tot / st - 1 : null;
    return `<tr><td class="stick c0 dimc" title="${esc(m.product_code + " " + m.product_name + " · " + m.species + " · " + m.product_format)}"><span class="code">${esc(m.product_code)}</span>${esc(m.product_name)}</td>
      <td class="stick c1 dimc" title="${esc(m.customer + " · " + m.channel)}">${esc(m.customer)}</td>
      <td class="stick c2 dimc" title="${esc(m.region)}">${esc(m.country)}</td>
      ${cols.map((p, ci) => cellHtml(s.cells[p], ri, ci)).join("")}
      <td class="tot">${fmtN(s._tot)}</td><td class="dlt ${d == null ? "" : d >= 0 ? "up" : "down"}">${pct(d)}</td></tr>`;
  }).join("");
  const colTot = cols.map(p => { const rs = list.map(s => s.cells[p]).filter(Boolean); return rs.length ? sum(rs, r => r.period_type === "Actual" ? toUnit(r.actual_kg, r) : toUnit(finalKg(r), r)) : null; });
  const grand = sum(list, s => s._tot);
  const grandStat = sum(list.flatMap(s => Object.values(s.cells)).filter(r => r.period_type === "Forecast"), r => toUnit(r.stat_forecast_kg, r));
  const foot = `<tfoot><tr><td class="stick c0">Total (${list.length} series)</td><td class="stick c1"></td><td class="stick c2"></td>${colTot.map(v => `<td>${fmtN(v)}</td>`).join("")}<td>${fmtN(grand)}</td><td>${pct(grandStat ? grand / grandStat - 1 : null)}</td></tr></tfoot>`;
  $("#wbGrid").innerHTML = head + `<tbody>${body}</tbody>` + foot;
  const allCells = list.flatMap(s => Object.values(s.cells)).filter(r => r.period_type === "Forecast");
  $("#gridFoot").innerHTML = `<span>${list.length} series · ${allCells.length.toLocaleString()} editable cells</span><span>${allCells.filter(r => r.override_kg != null).length} overridden</span><span>${allCells.filter(r => openCount(r.id)).length} with open comments</span><span style="margin-left:auto">Writing to <code>${esc(new URL(CFG.supabaseUrl).host)}</code> as <b>${esc(S.user)}</b></span>`;
}
function refreshCell(id) {
  const mc = $(`#wbCards .mcell[data-id="${id}"]`);
  if (mc) { const t = document.createElement("div"); t.innerHTML = mcellHtml(S.byId.get(id)); mc.replaceWith(t.firstChild); }
  const td = $(`#wbGrid td[data-id="${id}"]`);
  if (!td) return;
  const tmp = document.createElement("tr");
  tmp.innerHTML = cellHtml(S.byId.get(id), td.dataset.r, td.dataset.c);
  td.replaceWith(tmp.firstChild);
}
function selectCell(id, { open = true, scroll = false } = {}) {
  $$("#wbGrid td.sel, #wbCards .mcell.sel").forEach(t => t.classList.remove("sel"));
  S.selId = id;
  $(`#wbCards .mcell[data-id="${id}"]`)?.classList.add("sel");
  const td = $(`#wbGrid td[data-id="${id}"]`);
  if (td) { td.classList.add("sel"); if (scroll) td.scrollIntoView({ block: "center", inline: "center" }); }
  const mc = $(`#wbCards .mcell[data-id="${id}"]`);
  if (mc && scroll) mc.scrollIntoView({ block: "center", inline: "center" });
  if (open) openDrawer(id);
}
function startEdit(td, initial) {
  const r = S.byId.get(+td.dataset.id);
  if (!r || r.period_type !== "Forecast") { toast("Actual periods are locked and can't be edited.", "err"); return; }
  S.editing = r.id;
  const cur = Math.round(toUnit(finalKg(r), r));
  td.innerHTML = `<input type="text" inputmode="decimal" value="${initial ?? cur}" aria-label="Forecast value">`;
  const inp = $("input", td);
  inp.focus();
  if (initial == null) inp.select();
  let done = false;
  const finish = async commit => {
    if (done) return; done = true;
    S.editing = null;
    if (!commit) { refreshCell(r.id); selectCell(r.id, { open: false }); return; }
    const raw = inp.value.trim();
    await commitValue(r, raw);
  };
  inp.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); finish(true).then(() => moveSel(1, 0)); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false); }
    else if (e.key === "Tab") { e.preventDefault(); finish(true).then(() => moveSel(0, e.shiftKey ? -1 : 1)); }
  });
  inp.addEventListener("blur", () => finish(true));
}
function parseInput(raw, r) {
  if (raw === "") return { clear: true };
  const cur = toUnit(finalKg(r), r);
  let v;
  const rel = raw.match(/^([+-]\s*\d+(?:[.,]\d+)?)\s*%$/);
  if (rel) v = cur * (1 + parseFloat(rel[1].replace(/\s/g, "").replace(",", ".")) / 100);
  else {
    const m = raw.replace(/[\s,€]/g, "").replace(/kg$/i, "").match(/^(\d+(?:\.\d+)?)([kKmM]?)$/);
    if (!m) return { error: "Enter a number such as 12500, 12.5k or +10%. Leave it empty to clear the override." };
    v = parseFloat(m[1]) * ({ k: 1e3, m: 1e6 }[m[2].toLowerCase()] || 1);
  }
  const kg = S.unit === "eur" ? v / r.price_eur_per_kg : v;
  return { kg: Math.round(kg * 10) / 10 };
}
async function commitValue(r, raw, note = null) {
  const p = parseInput(raw, r);
  if (p.error) { toast(p.error, "err"); refreshCell(r.id); selectCell(r.id, { open: false }); return; }
  const newKg = p.clear ? null : p.kg;
  if (!p.clear && Math.abs(newKg - finalKg(r)) < 0.05) { refreshCell(r.id); selectCell(r.id, { open: false }); return; }
  if (p.clear && r.override_kg == null) { refreshCell(r.id); selectCell(r.id, { open: false }); return; }
  const td = $(`#wbGrid td[data-id="${r.id}"]`);
  if (td) td.textContent = "saving…";
  try {
    const res = await api.rpc("writeback_forecast", { p_id: r.id, p_override_kg: newKg, p_user: S.user, p_expected_version: r.version, p_note: note });
    Object.assign(r, res);
    refreshCell(r.id);
    const ntd = $(`#wbGrid td[data-id="${r.id}"], #wbCards .mcell[data-id="${r.id}"]`); if (ntd) ntd.classList.add("flash");
    toast(newKg == null ? `Override cleared · ${esc(r.product_name)} ${mLabel(r.period)}` : `Saved <b>${fmtN(newKg)} kg</b> · ${esc(r.product_name)} · ${esc(r.customer)} · ${mLabel(r.period)}`);
    updateGridTotals();
    await poll();
  } catch (e) {
    if (/CONFLICT/.test(e.message)) { await refetchRows([r.id]); toast("Someone else changed this cell. The latest value is now loaded, so check it and try again.", "err"); }
    else toast("Save failed: " + esc(e.message), "err");
    refreshCell(r.id);
  }
  selectCell(r.id, { open: $("#drawer").classList.contains("open") });
}
function updateGridTotals() { if (isMobile()) { const y = window.scrollY; const strips = $$(".mc-strip").map(x => x.scrollLeft); renderCards(); $$(".mc-strip").forEach((x, i) => (x.scrollLeft = strips[i] ?? x.scrollLeft)); window.scrollTo(0, y); return; } if (!S.editing) { const sc = $("#gridScroll"); const t = sc.scrollTop, l = sc.scrollLeft; renderGrid(); sc.scrollTop = t; sc.scrollLeft = l; } }
function moveSel(dr, dc) {
  const td = $(`#wbGrid td[data-id="${S.selId}"]`);
  if (!td) return;
  let r = +td.dataset.r + dr, c = +td.dataset.c + dc;
  const M = S.gridMatrix;
  if (r < 0 || r >= M.length) return;
  c = Math.max(0, Math.min(M[0].length - 1, c));
  const id = M[r][c];
  if (id) selectCell(id, { open: $("#drawer").classList.contains("open"), scroll: false }), $(`#wbGrid td[data-id="${id}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
}
function wireGrid() {
  const g = $("#wbGrid");
  g.addEventListener("click", e => { const td = e.target.closest("td.v[data-id]"); if (td && !S.editing) selectCell(+td.dataset.id); });
  $("#wbCards").addEventListener("click", e => { const b = e.target.closest(".mcell[data-id]"); if (b) selectCell(+b.dataset.id); });
  g.addEventListener("dblclick", e => { const td = e.target.closest("td.v[data-id]"); if (td && !S.editing) startEdit(td); });
  document.addEventListener("keydown", e => {
    if (S.page !== "writeback" || S.editing || !S.selId) return;
    if (e.target.closest("input, textarea, select")) return;
    const map = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (map[e.key]) { e.preventDefault(); moveSel(...map[e.key]); return; }
    const td = $(`#wbGrid td[data-id="${S.selId}"]`);
    if (!td) return;
    if (e.key === "Enter" || e.key === "F2") { e.preventDefault(); startEdit(td); }
    else if (/^[0-9+\-]$/.test(e.key)) { e.preventDefault(); startEdit(td, e.key); }
    else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); const r = S.byId.get(S.selId); if (r.override_kg != null) commitValue(r, ""); }
  });
  let t; $("#gridSearch").addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => { S.cardLimit = 20; renderGrid(); }, 180); });
  $("#showActuals").addEventListener("change", renderGrid);
  $("#onlyChanged").addEventListener("change", renderGrid);
  $("#exportBtn").addEventListener("click", exportCsv);
  $("#bulkBtn").addEventListener("click", openBulk);
}

// ------------------------------------------------------------------ Drawer
function openDrawer(id) {
  const r = S.byId.get(id);
  if (!r) return;
  const d = $("#drawer");
  d.classList.add("open"); d.setAttribute("aria-hidden", "false");
  $("#dEyebrow").textContent = `${r.period_type} · ${mLabel(r.period)} · ${r.product_code}`;
  $("#dTitle").textContent = r.product_name;
  $("#dSub").textContent = `${r.customer} · ${r.country} (${r.region}) · ${r.channel}`;
  const isFc = r.period_type === "Forecast";
  const cm = (S.cByPlan.get(id) || []).slice().sort((a, b) => b.created_at.localeCompare(a.created_at));
  const hist = S.audit.filter(a => a.plan_id === id);
  const sib = Object.values(S.series.get(seriesKey(r)).cells).filter(x => x.id !== id).flatMap(x => (S.cByPlan.get(x.id) || []).filter(c => c.status === "Open").map(c => ({ c, x })));
  const M = (l, v, hl) => `<div class="metric ${hl ? "hl" : ""}"><div class="l">${l}</div><div class="n">${v}</div></div>`;
  $("#drawerBody").innerHTML = `
    <div class="metrics">
      ${isFc ? M("Final forecast", fmtN(finalKg(r)) + " kg", r.override_kg != null) : M("Actual", fmtN(r.actual_kg) + " kg")}
      ${M("Value", "€" + fmtN((isFc ? finalKg(r) : r.actual_kg) * r.price_eur_per_kg))}
      ${M("Statistical forecast", fmtN(r.stat_forecast_kg) + " kg")}
      ${M("Consensus", fmtN(r.consensus_kg) + " kg")}
      ${M("Planner override", r.override_kg != null ? fmtN(r.override_kg) + " kg" : "–", r.override_kg != null)}
      ${M("Prior year", fmtN(r.prior_year_kg) + " kg")}
      ${M("Price", "€" + r.price_eur_per_kg.toFixed(2) + " / kg")}
      ${M(isFc ? "vs prior year" : "Forecast error", isFc ? pct(r.prior_year_kg ? finalKg(r) / r.prior_year_kg - 1 : null) : pct(r.actual_kg ? (r.consensus_kg - r.actual_kg) / r.actual_kg : null))}
    </div>
    ${r.override_kg != null ? `<p class="sub">Last changed by <b>${esc(r.updated_by)}</b> ${when(r.updated_at)} · version ${r.version}</p>` : ""}
    ${isFc ? `<h4>Override forecast</h4>
      <div class="form-row"><label>New kg</label><input id="dOvr" type="text" inputmode="decimal" placeholder="${fmtN(finalKg(r))}"></div>
      <div class="form-row"><label>Reason</label><input id="dOvrNote" type="text" placeholder="Optional, e.g. Tender award expected"></div>
      <div class="btnrow">${r.override_kg != null ? `<button class="btn danger" id="dClear">Clear override</button>` : ""}<button class="btn primary" id="dSave">Write back</button></div>`
      : `<p class="sub">Actual months are locked and read from the ERP.</p>`}
    <h4>Add comment</h4>
    <div class="chips" id="dChips">${CATEGORIES.map((c, i) => `<button class="chip ${i === 0 ? "on" : ""}" data-c="${esc(c)}">${esc(c)}</button>`).join("")}</div>
    <textarea id="dText" placeholder="What should the S&OP team know? e.g. Christmas programme confirmed, +2 t smoked salmon in Dec"></textarea>
    <div class="btnrow" style="margin-top:6px"><button class="btn primary" id="dPost">Post comment</button></div>
    <h4>Comments on this cell (${cm.length})</h4>
    ${cm.length ? cm.map(c => commentHtml(c)).join("") : `<div class="empty">No comments yet.</div>`}
    ${sib.length ? `<h4>Open comments on other months</h4>${sib.map(({ c, x }) => `<div class="cmt" data-goto="${x.id}" style="cursor:pointer"><div class="top"><span class="tag ${CAT_CLASS[c.category] || ""}">${esc(c.category)}</span><span>${mLabel(x.period)}</span></div><div class="body">${esc(c.body)}</div></div>`).join("")}` : ""}
    <h4>Change history</h4>
    <div class="hist">${hist.length ? hist.map(a => `<div><div>${auditText(a)}</div><div class="who">${esc(a.actor)} · ${when(a.created_at)}</div></div>`).join("") : `<div class="empty">No changes recorded.</div>`}</div>`;
  const body = $("#drawerBody");
  $$(".chip", body).forEach(ch => ch.addEventListener("click", () => { $$(".chip", body).forEach(x => x.classList.remove("on")); ch.classList.add("on"); }));
  $("#dPost").addEventListener("click", () => postComment(r));
  $("#dSave")?.addEventListener("click", () => { const v = $("#dOvr").value.trim(); if (!v) { toast("Enter a value first.", "err"); return; } ensureGridCell(r); commitValue(r, v, $("#dOvrNote").value.trim() || null).then(() => openDrawer(r.id)); });
  $("#dClear")?.addEventListener("click", () => { ensureGridCell(r); commitValue(r, "", $("#dOvrNote").value.trim() || null).then(() => openDrawer(r.id)); });
  $("#dOvr")?.addEventListener("keydown", e => { if (e.key === "Enter") $("#dSave").click(); });
  $$("[data-resolve]", body).forEach(b => b.addEventListener("click", () => resolveComment(+b.dataset.resolve, r.id)));
  $$("[data-goto]", body).forEach(b => b.addEventListener("click", () => goToCell(+b.dataset.goto)));
}
function ensureGridCell() { /* commitValue tolerates a missing grid cell (e.g. drawer opened from feed) */ }
function commentHtml(c) {
  return `<div class="cmt ${c.status === "Resolved" ? "res" : ""}"><div class="top"><span class="tag ${c.status === "Resolved" ? "resolved" : CAT_CLASS[c.category] || ""}">${esc(c.category)}</span>
    <span>${esc(c.author)} · ${when(c.created_at)}</span></div><div class="body">${esc(c.body)}</div>
    <div class="top" style="margin-top:4px">${c.status === "Open" ? `<span class="status-pill">Open</span><button class="linkbtn" data-resolve="${c.id}">Mark resolved</button>` : `<span class="status-pill">Resolved by ${esc(c.resolved_by)} ${when(c.resolved_at)}</span>`}</div></div>`;
}
function auditText(a) {
  const r = S.byId.get(a.plan_id);
  switch (a.action) {
    case "OVERRIDE": case "BULK_ADJUST": return `${a.action === "BULK_ADJUST" ? "Bulk adjust" : "Override"}: ${fmtN(a.old_kg)} → <b>${fmtN(a.new_kg)} kg</b>${a.detail ? ` <span class="sub">(${esc(a.detail)})</span>` : ""}`;
    case "CLEAR_OVERRIDE": return `Override cleared: ${fmtN(a.old_kg)} → ${fmtN(a.new_kg)} kg (consensus)`;
    case "COMMENT": return `Comment: ${esc(a.detail)}`;
    case "RESOLVE": return esc(a.detail);
    default: return esc(a.action + " " + (a.detail || ""));
  }
}
async function postComment(r) {
  const body = $("#dText").value.trim();
  const cat = $("#dChips .chip.on")?.dataset.c;
  if (!body) { toast("Write a comment first.", "err"); return; }
  $("#dPost").disabled = true;
  try {
    await api.rpc("add_plan_comment", { p_id: r.id, p_category: cat, p_body: body, p_user: S.user });
    await refetchComments(); await poll();
    toast(`Comment posted · <b>${esc(cat)}</b>`);
    refreshCell(r.id); openDrawer(r.id); if (S.page !== "writeback") renderPage();
  } catch (e) { toast("Could not post comment: " + esc(e.message), "err"); $("#dPost").disabled = false; }
}
async function resolveComment(cid, rowId) {
  try {
    await api.rpc("resolve_plan_comment", { p_comment_id: cid, p_user: S.user });
    await refetchComments(); await poll();
    toast("Comment resolved");
    refreshCell(rowId); openDrawer(rowId); if (S.page !== "writeback") renderPage();
  } catch (e) { toast("Could not resolve: " + esc(e.message), "err"); }
}
function closeDrawer() { $("#drawer").classList.remove("open"); $("#drawer").setAttribute("aria-hidden", "true"); setTimeout(() => Object.values(charts).forEach(c => c.resize()), 200); }
function goToCell(id) {
  const r = S.byId.get(id);
  if (!r) return;
  if (!passes(r)) DIMS.forEach(([k]) => S.filters[k].clear());
  $("#gridSearch").value = ""; $("#onlyChanged").checked = false;
  if (r.period_type === "Actual") $("#showActuals").checked = true;
  if (isMobile()) { $("#gridSearch").value = r.product_code; S.cardLimit = 20; }
  showPage("writeback");
  renderSlicers();
  selectCell(id, { scroll: true });
}

// ------------------------------------------------------------------ Comments & audit page
function renderFeed(el, list) {
  el.innerHTML = list.length ? list.map(c => { const r = S.byId.get(c.plan_id); if (!r) return "";
    return `<div class="fitem" data-goto="${r.id}"><div class="top"><span class="tag ${c.status === "Resolved" ? "resolved" : CAT_CLASS[c.category] || ""}">${esc(c.category)}</span><span>${esc(c.author)} · ${when(c.created_at)}</span>${c.status === "Resolved" ? `<span class="status-pill">Resolved</span>` : ""}</div>
      <div class="body">${esc(c.body)}</div><div class="ctx">${esc(r.product_name)} · ${esc(r.customer)} · ${esc(r.country)} · <b>${mLabel(r.period)}</b> · ${fmtN(finalKg(r))} kg</div></div>`; }).join("")
    : `<div class="empty">No comments match the current filters.</div>`;
  $$("[data-goto]", el).forEach(x => x.addEventListener("click", () => goToCell(+x.dataset.goto)));
}
function renderComments() {
  const ids = new Set(filtered().map(r => r.id));
  const inScope = S.comments.filter(c => ids.has(c.plan_id));
  const open = inScope.filter(c => c.status === "Open");
  const counts = CATEGORIES.map(c => [c, open.filter(x => x.category === c).length]).filter(x => x[1] > 0).sort((a, b) => a[1] - b[1]);
  const c = chart("chCategories");
  c.setOption({
    animationDuration: 300,
    grid: { left: 8, right: 30, top: 4, bottom: 4, containLabel: true },
    tooltip: { ...tipBase, trigger: "item", formatter: p => `<b>${esc(p.name)}</b><br>${p.value} open` },
    xAxis: { type: "value", show: false },
    yAxis: { type: "category", data: counts.map(x => x[0]), ...axisCommon, axisLine: { show: false } },
    series: [{ type: "bar", barWidth: "60%", cursor: "pointer",
      data: counts.map(([k, v]) => ({ value: v, itemStyle: { color: !S.feedCategory || S.feedCategory === k ? "#6a4ce2" : "#d6cff8", borderRadius: [0, 3, 3, 0] } })),
      label: { show: true, position: "right", color: "#191919", fontSize: 11 } }],
  }, true);
  c.off("click"); c.on("click", p => { S.feedCategory = S.feedCategory === p.name ? null : p.name; renderComments(); });
  let list = inScope.filter(x => S.feedStatus === "All" || x.status === S.feedStatus);
  if (S.feedCategory) list = list.filter(x => x.category === S.feedCategory);
  renderFeed($("#commentFeed"), list);
  const aud = S.audit.filter(a => ids.has(a.plan_id)).slice(0, 300);
  $("#auditTable").innerHTML = `<table class="t"><thead><tr><th>When</th><th>User</th><th>Action</th><th>Product</th><th>Customer</th><th>Country</th><th>Month</th><th class="num">Old kg</th><th class="num">New kg</th><th>Detail</th></tr></thead><tbody>
    ${aud.map(a => { const r = S.byId.get(a.plan_id); if (!r) return ""; return `<tr data-goto="${r.id}" style="cursor:pointer">
      <td title="${esc(new Date(a.created_at).toLocaleString("en-GB"))}">${when(a.created_at)}</td><td>${esc(a.actor)}</td><td>${esc(a.action.replace("_", " ").toLowerCase())}</td>
      <td>${esc(r.product_name)}</td><td>${esc(r.customer)}</td><td>${esc(r.country)}</td><td>${mLabel(r.period)}</td>
      <td class="num">${a.old_kg == null ? "" : fmtN(a.old_kg)}</td><td class="num">${a.new_kg == null ? "" : fmtN(a.new_kg)}</td><td style="max-width:320px;overflow:hidden;text-overflow:ellipsis" title="${esc(a.detail)}">${esc(a.detail)}</td></tr>`; }).join("")}
    </tbody></table>`;
  $$("#auditTable [data-goto]").forEach(x => x.addEventListener("click", () => goToCell(+x.dataset.goto)));
}

// ------------------------------------------------------------------ Bulk + export
function openBulk() {
  const list = gridSeries();
  const opts = S.fcMonths.map(p => `<option value="${p}">${mLabel(p)}</option>`).join("");
  $("#bulkFrom").innerHTML = opts; $("#bulkTo").innerHTML = opts;
  $("#bulkTo").value = S.fcMonths[S.fcMonths.length - 1];
  const upd = () => {
    const ids = bulkIds(list);
    $("#bulkScope").innerHTML = `Applies to the <b>${list.length} series</b> currently visible in the grid (slicers and search are respected): <b>${ids.length} forecast cells</b>. Each cell's current final forecast is adjusted, and every change is logged.`;
  };
  $("#bulkFrom").onchange = upd; $("#bulkTo").onchange = upd; upd();
  $("#bulkModal").hidden = false;
  $("#bulkPct").focus();
  $("#bulkCancel").onclick = () => ($("#bulkModal").hidden = true);
  $("#bulkApply").onclick = async () => {
    const pctV = parseFloat($("#bulkPct").value);
    const ids = bulkIds(list);
    if (!isFinite(pctV) || pctV === 0) { toast("Enter a non-zero percentage.", "err"); return; }
    if (!ids.length) { toast("No cells in scope.", "err"); return; }
    $("#bulkApply").disabled = true;
    try {
      const n = await api.rpc("writeback_bulk_pct", { p_ids: ids, p_pct: pctV, p_user: S.user, p_note: $("#bulkNote").value.trim() || null });
      await refetchRows(ids); await poll();
      toast(`Bulk adjust ${pctV > 0 ? "+" : ""}${pctV}% applied to <b>${n} cells</b>`);
      $("#bulkModal").hidden = true; renderPage();
    } catch (e) { toast("Bulk adjust failed: " + esc(e.message), "err"); }
    $("#bulkApply").disabled = false;
  };
}
function bulkIds(list) {
  const f = $("#bulkFrom").value, t = $("#bulkTo").value;
  return list.flatMap(s => Object.values(s.cells)).filter(r => r.period_type === "Forecast" && r.period >= f && r.period <= t).map(r => r.id);
}
function exportCsv() {
  const list = gridSeries();
  const cols = ["product_code", "product_name", "species", "product_format", "channel", "region", "country", "customer", "period", "period_type", "actual_kg", "stat_forecast_kg", "consensus_kg", "override_kg", "final_forecast_kg", "price_eur_per_kg", "final_forecast_eur", "open_comments", "updated_by"];
  const lines = [cols.join(",")];
  for (const s of list) for (const r of Object.values(s.cells)) {
    const o = { ...r, final_forecast_kg: r.period_type === "Forecast" ? finalKg(r) : "", final_forecast_eur: r.period_type === "Forecast" ? (finalKg(r) * r.price_eur_per_kg).toFixed(2) : "", open_comments: openCount(r.id) };
    lines.push(cols.map(c => { const v = o[c] ?? ""; return /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v; }).join(","));
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
  a.download = `demand_plan_${CFG.planCycle}_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`Exported ${lines.length - 1} rows`);
}

// ------------------------------------------------------------------ Pages
function showPage(p) {
  if (S.page !== p && isMobile()) window.scrollTo(0, 0);
  S.page = p;
  $$(".page").forEach(x => x.classList.toggle("active", x.id === "page-" + p));
  $$(".navbtn").forEach(x => x.classList.toggle("active", x.dataset.page === p));
  $$("#pageTabs > button").forEach(x => x.classList.toggle("on", x.dataset.page === p));
  renderPage();
}
function renderPage(fromPoll) {
  if (S.page === "overview") { renderOverview(); requestAnimationFrame(() => Object.values(charts).forEach(c => c.resize())); }
  else if (S.page === "writeback") { const sc = $("#gridScroll"); const t = sc.scrollTop, l = sc.scrollLeft; renderGrid(); if (fromPoll) { sc.scrollTop = t; sc.scrollLeft = l; } }
  else if (S.page === "comments") { renderComments(); requestAnimationFrame(() => charts.chCategories?.resize()); }
  if (fromPoll && S.selId && $("#drawer").classList.contains("open") && !document.activeElement?.closest("#drawer")) openDrawer(S.selId);
}

// ------------------------------------------------------------------ Boot
function wire() {
  const sel = $("#userSelect");
  sel.innerHTML = CFG.users.map(u => `<option>${esc(u)}</option>`).join("");
  const saved = recall("dp.user"); if (saved && CFG.users.includes(saved)) S.user = saved;
  sel.value = S.user;
  sel.addEventListener("change", () => { S.user = sel.value; store("dp.user", S.user); toast(`Now acting as <b>${esc(S.user)}</b>`, "info"); if (S.page === "writeback") renderGrid(); });
  $$(".navbtn, #pageTabs > button").forEach(b => b.addEventListener("click", () => showPage(b.dataset.page)));
  $$(".seg.unit button").forEach(b => b.addEventListener("click", () => { S.unit = b.dataset.v; $$(".seg.unit button").forEach(x => x.classList.toggle("on", x.dataset.v === S.unit)); renderPage(); }));
  $("#filterToggle").addEventListener("click", e => { e.stopPropagation(); openFilterSheet(); });
  $("#sheetBackdrop").addEventListener("click", closeFilterSheet);
  $("#slicers").addEventListener("click", e => e.stopPropagation());
  mq.addEventListener("change", () => { closeFilterSheet(); renderPage(); setTimeout(() => Object.values(charts).forEach(c => c.resize()), 60); });
  $$("#commentStatusSeg button").forEach(b => b.addEventListener("click", () => { S.feedStatus = b.dataset.v; $$("#commentStatusSeg button").forEach(x => x.classList.toggle("on", x === b)); renderComments(); }));
  $("#drawerClose").addEventListener("click", closeDrawer);
  $("#refreshBtn").addEventListener("click", async () => { $("#loading").classList.remove("hide"); try { await loadAll(); renderPage(); toast("Data refreshed from Supabase", "info"); } catch (e) { toast("Refresh failed: " + esc(e.message), "err"); } $("#loading").classList.add("hide"); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !S.editing) { if (!$("#bulkModal").hidden) $("#bulkModal").hidden = true; else if ($("#slicers").classList.contains("open")) closeFilterSheet(); else closeDrawer(); } });
  wireGrid();
}
async function boot() {
  wire();
  try {
    await loadAll();
    renderSlicers();
    showPage("overview");
    setInterval(poll, CFG.pollSeconds * 1000);
  } catch (e) {
    setSync(false, "Connection failed");
    $("#loading").innerHTML = `<div style="max-width:440px;text-align:center"><b>Could not reach Supabase.</b><br>${esc(e.message)}<br><br>Check <code>config.js</code> and your network.</div>`;
    return;
  }
  $("#loading").classList.add("hide");
}
boot();
})();
