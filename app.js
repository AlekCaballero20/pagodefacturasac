'use strict';

/* ===========================
   FACTURAS AC · APP CORE
   Evolución Premium Dashboard
=========================== */

/* ===========================
   CONFIG
=========================== */
const scriptURL =
  "https://script.google.com/macros/s/AKfycbw6W_Yf0c1kho1vJdD3uAHFY_dT-5U2v_15Dp7ubt9siWV7I9Bg402XWvNfEWqB9EQqWQ/exec";

/* ===========================
   STATE GLOBAL
=========================== */
const STATE = {
  facturas: [],
  filtered: [],
  stats: null,
};

/* ===========================
   DOM HELPERS
=========================== */
const $ = (sel, ctx = document) => ctx.querySelector(sel);

/* Tabla */
const $tbody = $("#tbody");
const $empty = $("#emptyState");

/* UI */
const $msg = $("#mensaje");
const $loader = $("#loader");
const $main = $("#main");

/* Filtros */
const $q = $("#q");
const $fEstado = $("#fEstado");
const $fMetodo = $("#fMetodo");
const $btnClearFilters = $("#btnClearFilters");

/* Header actions */
const $btnRefresh = $("#btnRefresh");

/* KPIs */
const $kpiTotalMes = $("#kpiTotalMes");
const $kpiDeltaMes = $("#kpiDeltaMes");
const $kpiPagadas = $("#kpiPagadas");
const $kpiTotalFacturas = $("#kpiTotalFacturas");
const $kpiPendientes = $("#kpiPendientes");
const $kpiValorPendiente = $("#kpiValorPendiente");
const $kpiMetodoTop = $("#kpiMetodoTop");

/* Modal Stats */
const $btnStats = $("#btnStats");
const $statsModal = $("#statsModal");
const $statsBody = $("#statsBody");
const $statsMetodos = $("#statsMetodos");
const $statsPendientes = $("#statsPendientes");
const $btnCloseStats = $("#btnCloseStats");

/* Tabs */
const $tabs = document.querySelectorAll(".tab");
const $tabPanels = document.querySelectorAll(".tab-panel");

/* ===========================
   FORMATTERS
=========================== */
const money = new Intl.NumberFormat("es-CO", {
  style: "currency",
  currency: "COP",
  maximumFractionDigits: 0,
});

function fmtCOP(n) {
  return money.format(Number(n || 0));
}

function parseCOP(str) {
  if (str == null) return null;
  const digits = String(str).replace(/[^\d]/g, "");
  if (!digits) return null;
  return Number(digits);
}

/* ===========================
   TOAST MSG
=========================== */
function showMsg(text, type = "ok") {
  if (!$msg) return;
  $msg.textContent = text;
  $msg.className = "";
  $msg.classList.add(type);
  $msg.classList.remove("hide");

  clearTimeout(showMsg._t);
  showMsg._t = setTimeout(() => $msg.classList.add("hide"), 3200);
}

function setBusy(isBusy) {
  if ($main) $main.setAttribute("aria-busy", isBusy ? "true" : "false");
  if ($loader) $loader.classList.toggle("hide", !isBusy);
}

/* ===========================
   FECHAS
=========================== */
function esPagoDelMes(fechaStr) {
  if (!fechaStr) return false;

  const base = String(fechaStr).trim().split(" ")[0];
  const p = base.split("/");
  if (p.length < 3) return false;

  const [, mes, anio] = p.map(Number);
  const hoy = new Date();

  return mes === hoy.getMonth() + 1 && anio === hoy.getFullYear();
}

/* ===========================
   API GAS
=========================== */
async function fetchJSON(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

async function fetchFacturas() {
  const data = await fetchJSON(`${scriptURL}?action=listar`);
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.rows)) return data.rows;
  throw new Error("Formato inesperado (listar)");
}

async function registrarPago(row) {
  const params = new URLSearchParams({ action: "registrar", row: String(row) });
  const json = await fetchJSON(`${scriptURL}?${params.toString()}`);
  if (!json.ok) throw new Error(json.error || "Error al registrar");
  return json;
}

async function editarValor(row, nuevoValor) {
  const params = new URLSearchParams({
    action: "editar",
    row: String(row),
    valor: String(nuevoValor),
  });

  const json = await fetchJSON(`${scriptURL}?${params.toString()}`);
  if (!json.ok) throw new Error(json.error || "Error al editar valor");
  return json;
}

async function editarMetodo(row, metodo) {
  const params = new URLSearchParams({
    action: "editarMetodo",
    row: String(row),
    metodo: String(metodo || ""),
  });

  const json = await fetchJSON(`${scriptURL}?${params.toString()}`);
  if (!json.ok) throw new Error(json.error || "Error al editar método");
  return json;
}

async function fetchStats() {
  const json = await fetchJSON(`${scriptURL}?action=stats`);
  if (!json.ok) throw new Error(json.error || "No se pudo cargar stats");
  return json;
}

/* ===========================
   RENDER TABLE
=========================== */
function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function rowHTML(f) {
  const ultimo = f.ultimo ?? "";
  const pagadoEsteMes = esPagoDelMes(ultimo);

  const estadoBadge = pagadoEsteMes
    ? `<span class="badge ok">Pagado</span>`
    : `<span class="badge pendiente">Pendiente</span>`;

  const valorNumerico =
    Number(isNaN(f.valor) ? parseCOP(f.valor) : f.valor) || 0;

  const metodoTxt = (f.metodo ?? "").toString();

  return `
    <tr data-row="${f.row}">
      <td>${escapeHtml(f.nombre ?? "")}</td>
      <td>${escapeHtml(f.referencia ?? "")}</td>

      <td class="editable valor"
          contenteditable="true"
          data-valor="${valorNumerico}">
        ${fmtCOP(valorNumerico)}
      </td>

      <td class="editable metodo"
          contenteditable="true"
          data-metodo="${escapeHtml(metodoTxt)}">
        ${escapeHtml(metodoTxt || "—")}
      </td>

      <td class="fecha">${escapeHtml(ultimo)}</td>
      <td class="estado">${estadoBadge}</td>

      <td>
        <button class="btn" data-row="${f.row}" data-action="registrar">
          Registrar
        </button>
      </td>
    </tr>
  `;
}

function renderTable(list) {
  if (!list.length) {
    $tbody.innerHTML = "";
    $empty?.classList.remove("hide");
    return;
  }

  $empty?.classList.add("hide");
  $tbody.innerHTML = list.map(rowHTML).join("");
}

/* ===========================
   FILTROS
=========================== */
function buildMetodoOptions() {
  if (!$fMetodo) return;

  const methods = new Set();

  STATE.facturas.forEach((f) => {
    if (f.metodo) methods.add(f.metodo.trim());
  });

  const sorted = [...methods].sort();

  $fMetodo.innerHTML =
    `<option value="all">Todos</option>` +
    sorted.map((m) => `<option value="${m}">${m}</option>`).join("");
}

function applyFilters() {
  const q = ($q?.value || "").toLowerCase().trim();
  const estado = $fEstado?.value || "all";
  const metodo = $fMetodo?.value || "all";

  STATE.filtered = STATE.facturas.filter((f) => {
    const pagado = esPagoDelMes(f.ultimo);

    if (estado === "pagado" && !pagado) return false;
    if (estado === "pendiente" && pagado) return false;

    if (metodo !== "all" && (f.metodo ?? "") !== metodo) return false;

    if (q) {
      const hay =
        (f.nombre ?? "").toLowerCase().includes(q) ||
        (f.referencia ?? "").toLowerCase().includes(q);
      if (!hay) return false;
    }

    return true;
  });

  renderTable(STATE.filtered);
}

/* ===========================
   KPIs DASHBOARD
=========================== */
function updateKPIs() {
  const total = STATE.facturas.length;

  const pagadas = STATE.facturas.filter((f) =>
    esPagoDelMes(f.ultimo)
  ).length;

  const pendientes = total - pagadas;

  const totalMes = STATE.facturas
    .filter((f) => esPagoDelMes(f.ultimo))
    .reduce((acc, f) => acc + parseCOP(f.valor) || 0, 0);

  const valorPendiente = STATE.facturas
    .filter((f) => !esPagoDelMes(f.ultimo))
    .reduce((acc, f) => acc + parseCOP(f.valor) || 0, 0);

  $kpiTotalMes.textContent = fmtCOP(totalMes);
  $kpiPagadas.textContent = pagadas;
  $kpiTotalFacturas.textContent = total;
  $kpiPendientes.textContent = pendientes;
  $kpiValorPendiente.textContent = fmtCOP(valorPendiente);

  // Método top
  const byMetodo = {};
  STATE.facturas.forEach((f) => {
    if (!f.metodo) return;
    const val = parseCOP(f.valor) || 0;
    byMetodo[f.metodo] = (byMetodo[f.metodo] || 0) + val;
  });

  const top = Object.entries(byMetodo).sort((a, b) => b[1] - a[1])[0];
  $kpiMetodoTop.textContent = top ? top[0] : "—";

  $kpiDeltaMes.textContent = "vs mes anterior: (próximamente)";
}

/* ===========================
   MODAL + TABS
=========================== */
function openStatsModal() {
  $statsModal?.classList.remove("hide");
  document.body.style.overflow = "hidden";
}

function closeStatsModal() {
  $statsModal?.classList.add("hide");
  document.body.style.overflow = "";
}

function switchTab(key) {
  $tabs.forEach((t) => {
    t.classList.toggle("is-active", t.dataset.tab === key);
    t.setAttribute("aria-selected", t.dataset.tab === key);
  });

  $tabPanels.forEach((p) => {
    p.classList.toggle("hide", !p.id.toLowerCase().includes(key));
  });
}

async function loadStats() {
  $statsBody.innerHTML = `<p class="muted">Cargando estadísticas…</p>`;

  try {
    const s = await fetchStats();
    STATE.stats = s;

    $statsBody.innerHTML = `
      <div class="stats-grid">
        <div class="stat"><div class="k">Total histórico</div><div class="v">${fmtCOP(s.totalPagado)}</div></div>
        <div class="stat"><div class="k">Pagos este mes</div><div class="v">${s.pagosEsteMes}</div></div>
        <div class="stat"><div class="k">Total este mes</div><div class="v">${fmtCOP(s.totalEsteMes)}</div></div>
        <div class="stat"><div class="k">Registros</div><div class="v">${s.totalRegistros}</div></div>
      </div>
    `;

    // Métodos (placeholder)
    $statsMetodos.innerHTML = `<p class="muted">Próximamente: breakdown por método 💳</p>`;

    // Pendientes
    $statsPendientes.innerHTML = `
      <p><strong>Pendientes este mes:</strong> ${STATE.facturas.length - s.pagosEsteMes}</p>
    `;
  } catch (err) {
    $statsBody.innerHTML = `<p class="muted">❌ Error: ${escapeHtml(
      err.message
    )}</p>`;
  }
}

/* ===========================
   EVENTOS
=========================== */

/* Registrar pago */
document.addEventListener("click", async (ev) => {
  const btn = ev.target.closest("button[data-action='registrar']");
  if (!btn) return;

  const row = +btn.dataset.row;
  const tr = btn.closest("tr");

  btn.disabled = true;
  btn.textContent = "⏳";

  try {
    const { fecha } = await registrarPago(row);

    tr.querySelector(".fecha").textContent = fecha;
    tr.querySelector(".estado").innerHTML = esPagoDelMes(fecha)
      ? `<span class="badge ok">Pagado</span>`
      : `<span class="badge pendiente">Pendiente</span>`;

    showMsg("Pago registrado ✅", "ok");

    await boot(); // recargar todo
  } catch (err) {
    showMsg("Error: " + err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Registrar";
  }
});

/* Filtros */
$q?.addEventListener("input", applyFilters);
$fEstado?.addEventListener("change", applyFilters);
$fMetodo?.addEventListener("change", applyFilters);

$btnClearFilters?.addEventListener("click", () => {
  $q.value = "";
  $fEstado.value = "all";
  $fMetodo.value = "all";
  applyFilters();
});

/* Refresh */
$btnRefresh?.addEventListener("click", boot);

/* Modal */
$btnStats?.addEventListener("click", async () => {
  openStatsModal();
  switchTab("resumen");
  await loadStats();
});

$btnCloseStats?.addEventListener("click", closeStatsModal);

document.addEventListener("click", (ev) => {
  if (ev.target.closest("[data-close='stats']")) closeStatsModal();
});

document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") closeStatsModal();
});

/* Tabs */
$tabs.forEach((t) => {
  t.addEventListener("click", () => switchTab(t.dataset.tab));
});

/* ===========================
   BOOT
=========================== */
async function boot() {
  try {
    setBusy(true);

    STATE.facturas = await fetchFacturas();
    buildMetodoOptions();
    updateKPIs();
    applyFilters();

  } catch (err) {
    console.error(err);
    showMsg("Error cargando: " + err.message, "error");
  } finally {
    setBusy(false);
  }
}

boot();
