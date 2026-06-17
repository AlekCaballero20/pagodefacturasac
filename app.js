'use strict';

/* =============================================================================
  FACTURAS AC · app.js — v2.0
  ---------------------------------------------------------------------------
  Cambios respecto a version anterior:
  - Logica de ciclo real por dia de corte (calcularFechaVencimiento, calcularInicioCiclo)
  - 5 estados: pagado / pendiente / proximo / urgente / vencido
  - Modal de confirmacion de pago con fecha editable (openPayModal)
  - Correccion bug critico: editarMetodo ya funciona (action=editarMetodo ahora
    existe en el backend)
  - Stats mejoradas: buildStatsResumen usa datos reales del Historico
  - buildStatsMeses usa porMes del backend (historico real, no solo ultimos pagos)
  - buildStatsMetodos usa porMetodo del backend
  - computeFrontStats corregido (totalPagado era suma de todos, pagados o no)
  - prettyMonthKey formatea "YYYY-MM" -> "Ene 2026"
============================================================================= */

/* ===========================
   CONFIG
=========================== */
const scriptURL =
  "https://script.google.com/macros/s/AKfycbwITNiO3hucv8XQCggYeZgF-x9XhS1Sc8NW4-ja8GHsnJrTSWw0wViqpQsIVJXfSaqAOg/exec";

/* ===========================
   STATE GLOBAL
=========================== */
const STATE = {
  facturas   : [],
  filtered   : [],
  historial  : [],
  historialFiltered: [],
  stats      : null,   // stats del backend (Historico), cacheadas
  methods    : [],     // lista de metodos unicos (para selects)
  lastStatsAt: 0,
};

/* ===========================
   DOM HELPERS
=========================== */
const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

const $tbody          = $("#tbody");
const $empty          = $("#emptyState");
const $msg            = $("#mensaje");
const $loader         = $("#loader");
const $main           = $("#main");
const $q              = $("#q");
const $fEstado        = $("#fEstado");
const $fMetodo        = $("#fMetodo");
const $btnClearFilters= $("#btnClearFilters");
const $btnRefresh     = $("#btnRefresh");
const $kpiTotalMes    = $("#kpiTotalMes");
const $kpiDeltaMes    = $("#kpiDeltaMes");
const $kpiPagadas     = $("#kpiPagadas");
const $kpiTotalFacturas= $("#kpiTotalFacturas");
const $kpiPendientes  = $("#kpiPendientes");
const $kpiValorPendiente= $("#kpiValorPendiente");
const $kpiMetodoTop   = $("#kpiMetodoTop");
const $btnStats       = $("#btnStats");
const $btnHistory     = $("#btnHistory");
const $statsModal     = $("#statsModal");
const $statsBody      = $("#statsBody");
const $statsMetodos   = $("#statsMetodos");
const $statsMeses     = $("#statsMeses");
const $statsPendientes= $("#statsPendientes");
const $btnCloseStats  = $("#btnCloseStats");
const $tabs           = $$(".tab");
const $tabPanels      = $$(".tab-panel");
const $editHint       = $("#editHint");

/* ===========================
   MEDIA / MOBILE
=========================== */
const mqMobile = window.matchMedia ? window.matchMedia("(max-width: 720px)") : null;
function isMobileUI() {
  return mqMobile ? mqMobile.matches : window.innerWidth <= 720;
}

/* ===========================
   FORMATTERS
=========================== */
const money = new Intl.NumberFormat("es-CO", {
  style: "currency", currency: "COP", maximumFractionDigits: 0,
});

function fmtCOP(n) { return money.format(Number(n || 0)); }

function parseCOP(str) {
  if (str == null) return null;
  const digits = String(str).replace(/[^\d]/g, "");
  if (!digits) return null;
  return Number(digits);
}

/* ===========================
   TOAST / BUSY
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
   UTILIDADES DE FECHA
=========================== */
/**
 * Parsea "d/M/yyyy" (con o sin hora) -> Date.
 */
function parseFechaPago(fechaStr) {
  if (!fechaStr) return null;
  const base = String(fechaStr).trim().split(" ")[0];
  const p = base.split("/");
  if (p.length < 3) return null;
  const dd = Number(p[0]), mm = Number(p[1]), yyyy = Number(p[2]);
  if (!dd || !mm || !yyyy) return null;
  return new Date(yyyy, mm - 1, dd);
}

function monthKeyFromDate(d) {
  if (!(d instanceof Date) || isNaN(d)) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

const MESES = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];

function prettyMonthKey(key) {
  if (!key || key === 'Sin fecha') return key || '—';
  const [y, m] = String(key).split('-');
  if (!y || !m) return key;
  const idx = Number(m) - 1;
  return `${MESES[idx] || m} ${y}`;
}

/**
 * Convierte "YYYY-MM-DD" (valor de input[type=date]) -> "D/M/YYYY" para el backend.
 */
function htmlDateToDMY(htmlDate) {
  if (!htmlDate) return null;
  const [y, m, d] = String(htmlDate).split('-');
  if (!y || !m || !d) return null;
  return `${Number(d)}/${Number(m)}/${y}`;
}

function dmyToHtmlDate(fechaStr) {
  const d = parseFechaPago(fechaStr);
  if (!d) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Obtiene la fecha de hoy en formato "YYYY-MM-DD" para input[type=date].
 */
function todayForInput() {
  const h = new Date();
  const y  = h.getFullYear();
  const m  = String(h.getMonth() + 1).padStart(2, '0');
  const d  = String(h.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/* ===========================
   LOGICA DE CICLO DE VENCIMIENTO
   ------------------------------------------
   Dado diaCorte (1-31) y la fecha de referencia:

   Si hoy.dia <= diaCorte:
     - El ciclo actual vence este mes (ajustado al ultimo dia valido)
     - El ciclo anterior vencio el mes pasado

   Si hoy.dia > diaCorte:
     - El ciclo actual vence el mes siguiente
     - El ciclo anterior vencio este mes

   "Pagada en ciclo actual" = fechaPago >= (vencimientoAnterior + 1 dia)
=========================== */

/**
 * Calcula la proxima fecha de vencimiento del ciclo actual.
 * Maneja meses cortos: diaCorte 31 en febrero -> ultimo dia de feb.
 */
function calcularFechaVencimientoMes(diaCorte, year, monthIndex) {
  if (!diaCorte || diaCorte < 1 || diaCorte > 31) return null;
  const ultimoDia = new Date(year, monthIndex + 1, 0).getDate();
  return new Date(year, monthIndex, Math.min(Number(diaCorte), ultimoDia));
}

/**
 * Calcula el inicio del ciclo actual (= dia siguiente al vencimiento anterior).
 * JS maneja overflow: new Date(2026, 1, 29) -> 1 de marzo. Correcto.
 */
function yaEsPagadoMesActual(fechaStr, ref = new Date()) {
  const fechaPago = parseFechaPago(fechaStr);
  if (!fechaPago) return false;
  return (
    fechaPago.getFullYear() === ref.getFullYear() &&
    fechaPago.getMonth() === ref.getMonth()
  );
}

/**
 * ¿La factura ya fue pagada en su ciclo actual?
 * - Con diaCorte: fechaPago >= inicio del ciclo actual.
 * - Sin diaCorte: fallback a mes calendario.
 */
function calcularFechaVencimiento(diaCorte, ref = new Date()) {
  return calcularFechaVencimientoMes(diaCorte, ref.getFullYear(), ref.getMonth());
}

/**
 * Estado completo de una factura.
 * Retorna { estado, diasRestantes, fechaVence }
 *   estado: 'pagado' | 'pendiente' | 'proximo' | 'urgente' | 'vencido'
 */
function calcularEstado(f) {
  if (f && f.activa === false) return { estado: 'inactiva', diasRestantes: null, fechaVence: null };
  const diaCorte = f.diaCorte ? Number(f.diaCorte) : null;
  const hoyRef   = new Date();
  const hoy      = new Date(hoyRef.getFullYear(), hoyRef.getMonth(), hoyRef.getDate());
  const pagado   = yaEsPagadoMesActual(f.ultimo, hoyRef);

  if (!diaCorte) return { estado: pagado ? 'pagado' : 'pendiente', diasRestantes: null, fechaVence: null };

  const fechaVenceMesActual = calcularFechaVencimientoMes(diaCorte, hoy.getFullYear(), hoy.getMonth());
  if (!fechaVenceMesActual) return { estado: 'pendiente', diasRestantes: null, fechaVence: null };

  // Si ya pagaste este mes, se mantiene "Pagado" y mostramos referencia del próximo mes.
  if (pagado) {
    const nextRef = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 1);
    const fechaVenceSiguiente = calcularFechaVencimientoMes(diaCorte, nextRef.getFullYear(), nextRef.getMonth());
    const diffNext = fechaVenceSiguiente
      ? Math.ceil((fechaVenceSiguiente - hoy) / 86400000)
      : null;
    return { estado: 'pagado', diasRestantes: diffNext, fechaVence: fechaVenceSiguiente };
  }

  const fv   = new Date(fechaVenceMesActual.getFullYear(), fechaVenceMesActual.getMonth(), fechaVenceMesActual.getDate());
  const diff = Math.ceil((fv - hoy) / 86400000);

  let estado = 'pendiente';
  if      (diff < 0)  estado = 'vencido';
  else if (diff <= 2) estado = 'urgente';
  else if (diff <= 5) estado = 'proximo';

  return { estado, diasRestantes: diff, fechaVence: fechaVenceMesActual };
}

/* ===========================
   HELPERS DE RENDER PARA ESTADO
=========================== */
const BADGE_CLASS = {
  inactiva : 'inactiva',
  pagado   : 'ok',
  pendiente: 'pendiente',
  proximo  : 'proximo',
  urgente  : 'urgente',
  vencido  : 'vencido',
};

const BADGE_LABEL = {
  inactiva : 'Inactiva',
  pagado   : 'Pagado',
  pendiente: 'Pendiente',
  proximo  : 'Proximo',
  urgente  : 'Urgente',
  vencido  : 'Vencido',
};

function buildEstadoBadge(estado) {
  const cls = BADGE_CLASS[estado] || 'pendiente';
  const lbl = BADGE_LABEL[estado] || estado;
  return `<span class="badge ${cls}">${lbl}</span>`;
}

function fmtDateShort(d) {
  if (!(d instanceof Date) || isNaN(d)) return '—';
  return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
}

function buildVenceTexto(estado, diasRestantes, fechaVence) {
  if (!(fechaVence instanceof Date) || isNaN(fechaVence)) return 'Configurar dia';

  const fecha = fmtDateShort(fechaVence);
  if (estado === 'pagado') return `${fecha} · pagado`;
  if (diasRestantes === null) return fecha;
  if (diasRestantes < 0)  return `${fecha} · Vencido`;
  if (diasRestantes === 0) return `${fecha} · Hoy`;
  return `${fecha} · ${diasRestantes}d`;
}

/* ===========================
   API GAS
=========================== */
async function fetchJSON(url) {
  const TIMEOUT_MS = 12000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { cache: "no-store", signal: controller.signal });
    if (!res.ok) {
      if (res.status === 404) {
        throw new Error("Apps Script no encontrado (404). Revisa la URL /exec y vuelve a desplegar la Web App.");
      }
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.json();
  } catch (err) {
    if (err && err.name === "AbortError") {
      throw new Error("Tiempo de espera agotado al conectar con Apps Script");
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchJSONWithRetry(url, retries = 1) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fetchJSON(url);
    } catch (err) {
      lastErr = err;
      if (i === retries) break;
      await new Promise(r => setTimeout(r, 600));
    }
  }
  throw lastErr;
}

async function fetchFacturas() {
  const data = await fetchJSONWithRetry(`${scriptURL}?action=listar`, 1);
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.rows)) return data.rows;
  throw new Error("Formato inesperado (listar)");
}

/**
 * Registra un pago. fechaDMY es opcional ("D/M/YYYY"); sin ella el backend usa hoy.
 */
async function registrarPago(row, fechaDMY, metodo, valorPagado, comentario) {
  const params = new URLSearchParams({ action: "registrar", row: String(row) });
  if (fechaDMY) params.append("fechaPago", fechaDMY);
  if (metodo != null && String(metodo).trim() !== "") params.append("metodo", String(metodo).trim());
  if (valorPagado != null && Number.isFinite(Number(valorPagado))) params.append("valorPagado", String(valorPagado));
  if (comentario != null && String(comentario).trim() !== "") params.append("comentario", String(comentario).trim());
  const json = await fetchJSON(`${scriptURL}?${params.toString()}`);
  if (!json.ok) throw new Error(json.error || "Error al registrar");
  return json;
}

async function fetchHistorial() {
  const json = await fetchJSONWithRetry(`${scriptURL}?action=historial`, 1);
  if (!json.ok) throw new Error(json.error || "No se pudo cargar historial");
  return Array.isArray(json.rows) ? json.rows : [];
}

async function editarPago(row, data) {
  const params = new URLSearchParams({ action: "editarPago", row: String(row) });
  if (data.fechaPago) params.append("fechaPago", data.fechaPago);
  if (data.valorPagado != null) params.append("valorPagado", String(data.valorPagado));
  if (data.metodo != null) params.append("metodo", String(data.metodo || ""));
  if (data.comentario != null) params.append("comentario", String(data.comentario || ""));
  const json = await fetchJSON(`${scriptURL}?${params.toString()}`);
  if (!json.ok) throw new Error(json.error || "Error al editar pago");
  return json;
}

async function toggleFactura(row, activa) {
  const params = new URLSearchParams({
    action: "toggleFactura",
    row: String(row),
    activa: activa ? "Si" : "No",
  });
  const json = await fetchJSON(`${scriptURL}?${params.toString()}`);
  if (!json.ok) throw new Error(json.error || "Error al cambiar estado");
  return json;
}

async function editarValor(row, nuevoValor) {
  const params = new URLSearchParams({
    action: "editar", row: String(row), valor: String(nuevoValor),
  });
  const json = await fetchJSON(`${scriptURL}?${params.toString()}`);
  if (!json.ok) throw new Error(json.error || "Error al editar valor");
  return json;
}

async function editarMetodo(row, metodo) {
  const params = new URLSearchParams({
    action: "editarMetodo", row: String(row), metodo: String(metodo || ""),
  });
  const json = await fetchJSON(`${scriptURL}?${params.toString()}`);
  if (!json.ok) throw new Error(json.error || "Error al editar metodo");
  return json;
}

async function fetchStats() {
  const json = await fetchJSONWithRetry(`${scriptURL}?action=stats`, 1);
  if (!json.ok) throw new Error(json.error || "No se pudo cargar stats");
  return json;
}

/* ===========================
   UTILIDADES GENERALES
=========================== */
function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeMetodo(s) {
  const t = String(s ?? "").trim();
  return t === "—" ? "" : t;
}

function valorNum(f) {
  const n = Number(isNaN(f?.valor) ? parseCOP(f?.valor) : f?.valor);
  return Number.isFinite(n) ? n : 0;
}

function setHintByMode() {
  if (!$editHint) return;
  if (isMobileUI()) {
    $editHint.innerHTML = `Tip: en celular toca <strong>Valor</strong> o <strong>Metodo</strong> para editar.`;
  } else {
    $editHint.innerHTML = `Tip: edita <strong>Valor</strong> y <strong>Metodo</strong> directo en la tabla. Enter guarda, Esc revierte.`;
  }
}

function debounce(fn, wait = 200) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
}

/* ===========================
   RENDER DE TABLA
=========================== */
function rowHTML(f) {
  const { estado, diasRestantes, fechaVence } = calcularEstado(f);
  const v         = valorNum(f);
  const metodoTxt = normalizeMetodo(f.metodo);
  const ultimo    = f.ultimo ?? '';

  const venceTxt  = buildVenceTexto(estado, diasRestantes, fechaVence);
  const estadoHTML= buildEstadoBadge(estado);

  return `
    <tr data-row="${escapeHtml(f.row)}" class="${f.activa === false ? 'is-inactive' : ''}">
      <td data-label="Factura">${escapeHtml(f.nombre ?? '')}</td>
      <td data-label="Referencia">${escapeHtml(f.referencia ?? '')}</td>

      <td data-label="Valor"
          class="editable valor"
          contenteditable="${isMobileUI() ? "false" : "true"}"
          data-valor="${v}">
        ${fmtCOP(v)}
      </td>

      <td data-label="Metodo"
          class="editable metodo"
          contenteditable="${isMobileUI() ? "false" : "true"}"
          data-metodo="${escapeHtml(metodoTxt)}">
        ${escapeHtml(metodoTxt || '—')}
      </td>

      <td data-label="Ultimo pago" class="fecha">${escapeHtml(ultimo)}</td>
      <td data-label="Vence en" class="vence">${escapeHtml(venceTxt)}</td>
      <td data-label="Estado" class="estado">${estadoHTML}</td>

      <td data-label="Accion">
        <button class="btn" data-row="${escapeHtml(f.row)}" data-action="registrar">
          Registrar
        </button>
        <button class="btn ghost" data-row="${escapeHtml(f.row)}" data-action="toggle-factura">
          ${f.activa === false ? 'Habilitar' : 'Inactivar'}
        </button>
      </td>
    </tr>
  `;
}

function renderTable(list) {
  if (!$tbody) return;
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
  STATE.facturas.forEach(f => {
    const m = normalizeMetodo(f.metodo);
    if (m) methods.add(m);
  });
  const sorted = Array.from(methods).sort((a, b) => a.localeCompare(b, "es"));
  STATE.methods = sorted;
  $fMetodo.innerHTML =
    `<option value="all">Todos</option>` +
    sorted.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join("");
}

function applyFilters() {
  const q      = ($q?.value || "").toLowerCase().trim();
  const estado = $fEstado?.value || "all";
  const metodo = $fMetodo?.value || "all";

  STATE.filtered = STATE.facturas.filter(f => {
    // Filtro de estado (usa ciclo real)
    if (estado !== "all") {
      const { estado: estadoF } = calcularEstado(f);
      if (estado === "sin-pagar") {
        if (estadoF === "pagado" || estadoF === "inactiva") return false;
      } else {
        if (estadoF !== estado) return false;
      }
    }

    // Filtro de metodo
    const m = normalizeMetodo(f.metodo);
    if (metodo !== "all" && m !== metodo) return false;

    // Busqueda libre
    if (q) {
      const hay =
        String(f.nombre ?? "").toLowerCase().includes(q) ||
        String(f.referencia ?? "").toLowerCase().includes(q);
      if (!hay) return false;
    }

    return true;
  });

  renderTable(STATE.filtered);
}

/* ===========================
   KPIs DASHBOARD
=========================== */

/**
 * Recorre STATE.facturas y calcula stats del ciclo actual usando calcularEstado().
 */
function computeCicloStats() {
  let pagadas = 0, pendientes = 0, proximas = 0, urgentes = 0, vencidas = 0;
  let valorPagado = 0, valorPendiente = 0;
  const alertas = [];

  STATE.facturas.filter(f => f.activa !== false).forEach(f => {
    const { estado, diasRestantes, fechaVence } = calcularEstado(f);
    const v = valorNum(f);
    if (estado === 'pagado') {
      pagadas++;
      valorPagado += v;
    } else {
      pendientes++;
      valorPendiente += v;
      if (estado === 'proximo')   { proximas++;  alertas.push({ ...f, estado, diasRestantes, fechaVence }); }
      if (estado === 'urgente')   { urgentes++;  alertas.push({ ...f, estado, diasRestantes, fechaVence }); }
      if (estado === 'vencido')   { vencidas++;  alertas.push({ ...f, estado, diasRestantes, fechaVence }); }
    }
  });

  return { pagadas, pendientes, proximas, urgentes, vencidas, valorPagado, valorPendiente, alertas };
}

function updateKPIs() {
  const ciclo = computeCicloStats();
  const total = STATE.facturas.filter(f => f.activa !== false).length;

  if ($kpiTotalMes)      $kpiTotalMes.textContent      = fmtCOP(ciclo.valorPagado);
  if ($kpiPagadas)       $kpiPagadas.textContent        = String(ciclo.pagadas);
  if ($kpiTotalFacturas) $kpiTotalFacturas.textContent  = String(total);
  if ($kpiPendientes)    $kpiPendientes.textContent     = String(ciclo.pendientes);
  if ($kpiValorPendiente)$kpiValorPendiente.textContent = fmtCOP(ciclo.valorPendiente);

    // Metodo top: preferimos Historico real si existe
  const topBack = STATE.stats?.porMetodo?.[0]?.metodo;
  if ($kpiMetodoTop) {
    if (topBack && topBack !== 'Sin metodo' && topBack !== 'Sin método') {
      $kpiMetodoTop.textContent = topBack;
    } else {
      const byMetodo = {};
      STATE.facturas.forEach(f => {
        const m = normalizeMetodo(f.metodo);
        if (!m) return;
        byMetodo[m] = (byMetodo[m] || 0) + valorNum(f);
      });
      const top = Object.entries(byMetodo).sort((a, b) => b[1] - a[1])[0];
      $kpiMetodoTop.textContent = top ? top[0] : '—';
    }
  }

  if ($kpiDeltaMes) {
    if (ciclo.vencidas > 0 || ciclo.urgentes > 0 || ciclo.proximas > 0) {
      $kpiDeltaMes.textContent = `Alertas: ${ciclo.vencidas} vencidas · ${ciclo.urgentes} urgentes · ${ciclo.proximas} proximas`;
    } else {
      $kpiDeltaMes.textContent = 'Sin alertas cercanas';
    }
  }
}

/* ===========================
   STATS — PANELES DEL MODAL
=========================== */

/**
 * Panel Resumen: usa datos del Historico (backStats) + ciclo actual (frontend).
 */
function buildStatsResumen(backStats = null) {
  if (!$statsBody) return;

  const ciclo = computeCicloStats();
  const totalFacturas = STATE.facturas.filter(f => f.activa !== false).length;

  // Historico: preferimos backend si esta disponible
  const totalPagadoHistorico = backStats?.totalPagado   || 0;
  const numPagosTotal        = backStats?.numPagos       || 0;
  const promedio             = backStats?.promedioPago   || 0;

  // Este mes: backend tiene datos del Historico real
  const totalEsteMes = backStats?.totalEsteMes ?? ciclo.valorPagado;
  const pagosEsteMes = backStats?.pagosEsteMes ?? ciclo.pagadas;

  // Top gastos del historico
  const topFacturas = (backStats?.porFactura || []).slice(0, 5);

  // Alertas destacadas
  const alertaCards = [];
  if (ciclo.vencidas > 0) {
    alertaCards.push(`<div class="stat" style="border-color:#dc2626;background:#fff5f5;">
      <div class="k">Vencidas</div>
      <div class="v">${ciclo.vencidas}</div>
    </div>`);
  }
  if (ciclo.urgentes > 0) {
    alertaCards.push(`<div class="stat" style="border-color:#fb923c;background:#fff7ed;">
      <div class="k">Urgentes (0-2d)</div>
      <div class="v">${ciclo.urgentes}</div>
    </div>`);
  }
  if (ciclo.proximas > 0) {
    alertaCards.push(`<div class="stat" style="border-color:#fde047;background:#fffbeb;">
      <div class="k">Proximas (3-5d)</div>
      <div class="v">${ciclo.proximas}</div>
    </div>`);
  }

  const topHtml = topFacturas.length
    ? `<div class="mini-table" style="margin-top:.75rem;">
        <div class="row head"><span>Top gastos historico</span><span>Total pagado</span></div>
        ${topFacturas.map(f =>
          `<div class="row"><span>${escapeHtml(f.factura)}</span><strong>${fmtCOP(f.total)}</strong></div>`
        ).join('')}
      </div>`
    : '';

  $statsBody.innerHTML = `
    <div class="stats-grid">
      <div class="stat"><div class="k">Pagado este mes (hist.)</div><div class="v">${fmtCOP(totalEsteMes)}</div></div>
      <div class="stat"><div class="k">Pendiente este ciclo</div><div class="v">${fmtCOP(ciclo.valorPendiente)}</div></div>
      <div class="stat"><div class="k">Pagadas / Total</div><div class="v">${ciclo.pagadas} / ${totalFacturas}</div></div>
      <div class="stat"><div class="k">Total historico</div><div class="v">${fmtCOP(totalPagadoHistorico)}</div></div>
      <div class="stat"><div class="k">Pagos registrados</div><div class="v">${numPagosTotal}</div></div>
      <div class="stat"><div class="k">Promedio por pago</div><div class="v">${fmtCOP(promedio)}</div></div>
      ${alertaCards.join('')}
    </div>
    ${topHtml}
    <p class="muted" style="margin:.75rem 0 0;font-size:.8rem;">
      ${backStats
        ? 'Historico desde servidor · Ciclo calculado en tiempo real'
        : '⚠️ Datos locales — backend no respondio o sin registros en Historico'}
    </p>
  `;
}

/**
 * Panel Metodos: usa porMetodo del Historico (backend) si esta disponible.
 */
function buildStatsMetodos(backStats = null) {
  if (!$statsMetodos) return;

  let rows;

  if (backStats?.porMetodo?.length > 0) {
    rows = backStats.porMetodo;
  } else {
    // Fallback: agrupacion local por valor base (menos preciso)
    const map = {};
    STATE.facturas.forEach(f => {
      const m = normalizeMetodo(f.metodo) || 'Sin metodo';
      if (!map[m]) map[m] = { metodo: m, total: 0, count: 0 };
      map[m].total += valorNum(f);
      map[m].count += 1;
    });
    rows = Object.values(map).sort((a, b) => b.total - a.total);
  }

  if (!rows.length) {
    $statsMetodos.innerHTML = `<p class="muted">No hay datos de metodos.</p>`;
    return;
  }

  $statsMetodos.innerHTML = `
    <div class="mini-table">
      <div class="row head"><span>Metodo (pagos)</span><span>Total pagado</span></div>
      ${rows.map(r =>
        `<div class="row">
          <span>${escapeHtml(r.metodo)} <span class="muted">(${r.count})</span></span>
          <strong>${fmtCOP(r.total)}</strong>
        </div>`
      ).join('')}
    </div>
    <p class="muted" style="margin:.6rem 0 0;font-size:.8rem;">
      ${backStats?.porMetodo?.length > 0 ? 'Del Historico real' : 'Calculo local (aproximado)'}
    </p>
  `;
}

/**
 * Panel Meses: usa porMes del Historico (backend) si esta disponible.
 * El fallback local solo muestra el ULTIMO pago de cada factura - es menos preciso.
 */
function buildStatsMeses(backStats = null) {
  if (!$statsMeses) return;

  let rows;

  if (backStats?.porMes?.length > 0) {
    rows = [...backStats.porMes].sort((a, b) => b.ym.localeCompare(a.ym));
  } else {
    // Fallback: ultimo pago por factura (solo refleja el ultimo mes de cada una)
    const map = {};
    STATE.facturas.forEach(f => {
      const d   = parseFechaPago(f.ultimo);
      const key = monthKeyFromDate(d);
      if (!key) return;
      map[key] = (map[key] || { ym: key, total: 0, count: 0 });
      map[key].total += valorNum(f);
      map[key].count += 1;
    });
    rows = Object.values(map).sort((a, b) => b.ym.localeCompare(a.ym));
  }

  if (!rows.length) {
    $statsMeses.innerHTML = `<p class="muted">Aun no hay pagos con fecha registrados.</p>`;
    return;
  }

  $statsMeses.innerHTML = `
    <div class="mini-table">
      <div class="row head"><span>Mes</span><span>Total (pagos)</span></div>
      ${rows.map(r =>
        `<div class="row">
          <span>${escapeHtml(prettyMonthKey(r.ym))}</span>
          <strong>${fmtCOP(r.total)} <span class="muted">(${r.count})</span></strong>
        </div>`
      ).join('')}
    </div>
    <p class="muted" style="margin:.6rem 0 0;font-size:.8rem;">
      ${backStats?.porMes?.length > 0 ? 'Del Historico real' : 'Calculo local (solo ultimo pago por factura)'}
    </p>
  `;
}

/**
 * Panel Pendientes: muestra alertas (vencidas/urgentes/proximas) + top por valor.
 */
function buildStatsPendientes() {
  if (!$statsPendientes) return;

  const ciclo    = computeCicloStats();
  const alertas  = ciclo.alertas.sort((a, b) => {
    const order = { vencido: 0, urgente: 1, proximo: 2 };
    return (order[a.estado] || 9) - (order[b.estado] || 9);
  });

  const sinPagar = STATE.facturas
    .filter(f => calcularEstado(f).estado !== 'pagado')
    .sort((a, b) => valorNum(b) - valorNum(a))
    .slice(0, 10);

  // KPIs de estado
  const kpis = `
    <div class="stats-grid">
      <div class="stat"><div class="k">Sin pagar</div><div class="v">${ciclo.pendientes}</div></div>
      <div class="stat"><div class="k">Valor pendiente</div><div class="v">${fmtCOP(ciclo.valorPendiente)}</div></div>
      ${ciclo.vencidas > 0 ? `<div class="stat" style="border-color:#dc2626;background:#fff5f5;"><div class="k">⚠️ Vencidas</div><div class="v">${ciclo.vencidas}</div></div>` : ''}
      ${ciclo.urgentes > 0 ? `<div class="stat" style="border-color:#fb923c;background:#fff7ed;"><div class="k">Urgentes (0-2d)</div><div class="v">${ciclo.urgentes}</div></div>` : ''}
    </div>`;

  // Lista de alertas
  const alertasHtml = alertas.length
    ? `<div class="mini-table" style="margin-top:.75rem;">
        <div class="row head"><span>Requieren atencion</span><span>Valor · dias</span></div>
        ${alertas.map(f => {
          const dias = f.diasRestantes < 0
            ? `hace ${Math.abs(f.diasRestantes)}d`
            : f.diasRestantes === 0 ? 'hoy'
            : `${f.diasRestantes}d`;
          return `<div class="row">
            <span>${escapeHtml(f.nombre || '—')} ${buildEstadoBadge(f.estado)}</span>
            <strong>${fmtCOP(valorNum(f))} <span class="muted">(${dias})</span></strong>
          </div>`;
        }).join('')}
      </div>`
    : '';

  // Top pendientes por valor
  const topHtml = sinPagar.length
    ? `<div class="mini-table" style="margin-top:.75rem;">
        <div class="row head"><span>Pendientes · Top por valor</span><span>Valor</span></div>
        ${sinPagar.map(f => `
          <div class="row">
            <span>${escapeHtml(f.nombre || '—')} <span class="muted">(${escapeHtml(f.referencia || '—')})</span></span>
            <strong>${fmtCOP(valorNum(f))}</strong>
          </div>`).join('')}
      </div>`
    : `<p class="muted" style="margin-top:.75rem;">No hay pendientes.</p>`;

  $statsPendientes.innerHTML = kpis + alertasHtml + topHtml;
}

/**
 * Recalcula todos los paneles con los stats cacheados (sin llamada al backend).
 * Util tras pagos/ediciones cuando el modal ya esta abierto.
 */
function refreshStatsPanels() {
  const back = STATE.stats;
  buildStatsResumen(back);
  buildStatsMetodos(back);
  buildStatsMeses(back);
  buildStatsPendientes();
}

/* ===========================
   MODAL STATS — APERTURA Y TABS
=========================== */
function openStatsModal() {
  $statsModal?.classList.remove("hide");
  document.body.style.overflow = "hidden";
}
function closeStatsModal() {
  $statsModal?.classList.add("hide");
  document.body.style.overflow = "";
}
function isStatsModalOpen() {
  return $statsModal && !$statsModal.classList.contains("hide");
}

function switchTab(key) {
  $tabs.forEach(t => {
    const active = t.dataset.tab === key;
    t.classList.toggle("is-active", active);
    t.setAttribute("aria-selected", active ? "true" : "false");
  });
  $tabPanels.forEach(p => {
    p.classList.toggle("hide", !p.id.toLowerCase().includes(key));
  });
}

async function loadStats() {
  // Estado de carga
  if ($statsBody)      $statsBody.innerHTML      = `<p class="muted">Cargando estadisticas...</p>`;
  if ($statsMetodos)   $statsMetodos.innerHTML   = `<p class="muted">Cargando...</p>`;
  if ($statsMeses)     $statsMeses.innerHTML     = `<p class="muted">Cargando...</p>`;
  if ($statsPendientes)$statsPendientes.innerHTML= `<p class="muted">Cargando...</p>`;

  // Intentar backend (tiene datos reales del Historico)
  let back = null;
  try {
    back = await fetchStats();
    STATE.stats = back;
  } catch (_) {
    back = null;
  }

  buildStatsResumen(back);
  buildStatsMetodos(back);
  buildStatsMeses(back);
  buildStatsPendientes();

  STATE.lastStatsAt = Date.now();
}

function refreshStatsIfOpen() {
  if (!isStatsModalOpen()) return;
  const now = Date.now();
  if (now - (STATE.lastStatsAt || 0) < 250) return;
  refreshStatsPanels();
  STATE.lastStatsAt = Date.now();
}

/* ===========================
   MODAL DE CONFIRMACION DE PAGO
   Permite elegir la fecha real del pago (default: hoy).
=========================== */
function ensurePayModal() {
  let $m = $("#payModal");
  if ($m) return $m;

  const el = document.createElement("div");
  el.id = "payModal";
  el.className = "modal hide";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-labelledby", "payTitle");

  el.innerHTML = `
    <div class="modal-backdrop" data-close="pay"></div>
    <div class="modal-card" role="document">
      <div class="modal-head">
        <div>
          <h2 id="payTitle">Registrar pago</h2>
          <p class="muted" id="paySub" style="margin:6px 0 0">—</p>
        </div>
        <button class="btn icon" type="button" aria-label="Cerrar" data-close="pay">✕</button>
      </div>
      <div class="modal-body">
        <div class="field" style="margin-bottom:.5rem;">
          <span class="label">Fecha de pago</span>
          <input id="payFecha" type="date" />
        </div>
        <div class="field" style="margin-bottom:.5rem;">
          <span class="label">Valor pagado</span>
          <input id="payValor" type="text" inputmode="numeric" autocomplete="off" placeholder="Ej: 50000" />
        </div>
        <div class="field" style="margin-bottom:.5rem;">
          <span class="label">Comentario</span>
          <textarea id="payComentario" rows="3" placeholder="Ej: pago parcial, soporte pendiente, recargo..."></textarea>
        </div>
        <p class="muted hint" style="margin:0;">
          Puedes ajustar fecha y valor real pagado. El valor base no se modifica.
        </p>
      </div>
      <div class="modal-foot">
        <button id="payCancel" class="btn ghost" type="button" data-close="pay">Cancelar</button>
        <button id="payConfirm" class="btn" type="button">✅ Confirmar pago</button>
      </div>
    </div>
  `;

  document.body.appendChild(el);
  return el;
}

function openPayModal({ row, nombre, valor }) {
  const $m = ensurePayModal();
  $m.dataset.row = String(row);
  $("#paySub", $m).textContent = `${nombre} · Base: ${fmtCOP(valor)}`;
  $("#payFecha", $m).value = todayForInput();
  $("#payValor", $m).value = String(Number(valor || 0));
  $("#payComentario", $m).value = "";

  $m.classList.remove("hide");
  document.body.style.overflow = "hidden";

  $("#payConfirm", $m).onclick = confirmPayModal;
}

function closePayModal() {
  const $m = $("#payModal");
  if (!$m) return;
  $m.classList.add("hide");
  document.body.style.overflow = "";
}

async function confirmPayModal() {
  const $m = $("#payModal");
  if (!$m) return;

  const row          = Number($m.dataset.row);
  const $fechaInput  = $("#payFecha", $m);
  const $valorInput  = $("#payValor", $m);
  const $comentarioInput = $("#payComentario", $m);
  const $btnConfirm  = $("#payConfirm", $m);

  const fechaDMY = htmlDateToDMY($fechaInput.value);
  if (!fechaDMY) {
    showMsg("Selecciona una fecha valida", "error");
    return;
  }

  const valorPagado = parseCOP($valorInput.value);
  if (valorPagado == null || valorPagado < 0) {
    showMsg("Ingresa un valor pagado valido", "error");
    return;
  }

  $btnConfirm.disabled    = true;
  $btnConfirm.textContent = "⏳";

  try {
    const f = getFacturaByRow(row);
    const metodoPago = normalizeMetodo(f?.metodo);
    const { fecha } = await registrarPago(row, fechaDMY, metodoPago, valorPagado, $comentarioInput.value);

    // Actualizar STATE y re-renderizar
    if (f) f.ultimo = String(fecha || "");
    STATE.stats = null;
    STATE.historial = [];

    showMsg(`Pago registrado: ${fmtCOP(valorPagado)} ✅`, "ok");
    updateKPIs();
    applyFilters();
    if (isStatsModalOpen()) await loadStats();
    closePayModal();
  } catch (err) {
    showMsg("Error: " + err.message, "error");
  } finally {
    $btnConfirm.disabled    = false;
    $btnConfirm.textContent = "✅ Confirmar pago";
  }
}

/* ===========================
   MODAL DE EDICION (Valor/Metodo en movil)
=========================== */
function ensureEditModal() {
  let $m = $("#editModal");
  if ($m) return $m;

  const el = document.createElement("div");
  el.id = "editModal";
  el.className = "modal hide";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-labelledby", "editTitle");

  el.innerHTML = `
    <div class="modal-backdrop" data-close="edit"></div>
    <div class="modal-card" role="document">
      <div class="modal-head">
        <div>
          <h2 id="editTitle">Editar</h2>
          <p class="muted" id="editSub" style="margin:6px 0 0">—</p>
        </div>
        <button class="btn icon" type="button" aria-label="Cerrar" data-close="edit">✕</button>
      </div>
      <div class="modal-body">
        <div class="field" style="margin-bottom:.75rem;">
          <span class="label" id="editLabel">Campo</span>
          <input id="editValor" class="hide" type="text" inputmode="numeric" autocomplete="off" placeholder="Ej: 150000" />
          <select id="editMetodo" class="hide"></select>
        </div>
        <p class="muted hint" id="editHelp" style="margin:0;">—</p>
      </div>
      <div class="modal-foot">
        <button id="editCancel" class="btn ghost" type="button" data-close="edit">Cancelar</button>
        <button id="editSave" class="btn" type="button">Guardar</button>
      </div>
    </div>
  `;

  document.body.appendChild(el);
  return el;
}

function openEditModal({ row, field, currentValue }) {
  const $m      = ensureEditModal();
  const $title  = $("#editTitle", $m);
  const $sub    = $("#editSub", $m);
  const $label  = $("#editLabel", $m);
  const $help   = $("#editHelp", $m);
  const $inpValor  = $("#editValor", $m);
  const $selMetodo = $("#editMetodo", $m);
  const $btnSave   = $("#editSave", $m);

  $m.dataset.row   = String(row);
  $m.dataset.field = field;
  $inpValor.classList.add("hide");
  $selMetodo.classList.add("hide");

  if (field === "valor") {
    $title.textContent = "Editar valor";
    $sub.textContent   = "Escribe el valor en COP (sin puntos también sirve).";
    $label.textContent = "Valor";
    $help.textContent  = "Tip: puedes pegar el numero tal cual. Yo me encargo del formato.";
    $inpValor.value    = String(parseCOP(currentValue) ?? "");
    $inpValor.classList.remove("hide");
    setTimeout(() => { $inpValor.focus(); $inpValor.select(); }, 0);
  } else if (field === "metodo") {
    $title.textContent = "Editar metodo";
    $sub.textContent   = "Selecciona el metodo de pago.";
    $label.textContent = "Metodo";
    $help.textContent  = "Si falta un metodo, escribelo en la hoja y luego actualiza.";
    $selMetodo.innerHTML =
      `<option value="">—</option>` +
      STATE.methods.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join("");
    $selMetodo.value = normalizeMetodo(currentValue) || "";
    $selMetodo.classList.remove("hide");
    setTimeout(() => $selMetodo.focus(), 0);
  }

  $m.classList.remove("hide");
  document.body.style.overflow = "hidden";

  $btnSave.onclick = saveEditFromModal;
}

function closeEditModal() {
  const $m = $("#editModal");
  if (!$m) return;
  $m.classList.add("hide");
  document.body.style.overflow = "";
}

async function saveEditFromModal() {
  const $m = $("#editModal");
  if (!$m) return;

  const row   = Number($m.dataset.row);
  const field = $m.dataset.field;
  const $inpValor  = $("#editValor", $m);
  const $selMetodo = $("#editMetodo", $m);

  try {
    if (field === "valor") {
      const n = parseCOP($inpValor.value);
      if (n == null || n <= 0) { showMsg("Pon un valor valido", "error"); return; }
      await editarValor(row, n);
      const f = STATE.facturas.find(x => Number(x.row) === row);
      if (f) f.valor = n;
      showMsg("Valor actualizado ✅", "ok");
    } else if (field === "metodo") {
      const m = normalizeMetodo($selMetodo.value);
      await editarMetodo(row, m);
      const f = STATE.facturas.find(x => Number(x.row) === row);
      if (f) f.metodo = m;
      showMsg("Metodo actualizado ✅", "ok");
      buildMetodoOptions();
    }
    updateKPIs();
    applyFilters();
    if (isStatsModalOpen()) await loadStats();
    closeEditModal();
  } catch (err) {
    showMsg("Error: " + err.message, "error");
  }
}

/* ===========================
   DESKTOP INLINE EDIT (contenteditable)
=========================== */
function isEditableCell(td) {
  return td?.classList?.contains("editable");
}

function setEditingState(td, isEditing) {
  td?.classList.toggle("editing", !!isEditing);
}

function getRowFromTR(tr) {
  if (!tr) return null;
  const row = Number(tr.dataset.row);
  return Number.isFinite(row) ? row : null;
}

function getFacturaByRow(row) {
  return STATE.facturas.find(f => Number(f.row) === Number(row)) || null;
}

async function saveEditableCell(td) {
  const tr  = td.closest("tr");
  const row = getRowFromTR(tr);
  if (!row) return;
  const f = getFacturaByRow(row);
  if (!f) return;

  if (td.classList.contains("valor")) {
    const n = parseCOP(td.textContent);
    if (n == null || n <= 0) {
      showMsg("Valor invalido", "error");
      const old = valorNum(f);
      td.textContent = fmtCOP(old);
      td.dataset.valor = String(old);
      return;
    }
    if (n === valorNum(f)) return;
    await editarValor(row, n);
    f.valor = n;
    td.textContent   = fmtCOP(n);
    td.dataset.valor = String(n);
    showMsg("Valor actualizado ✅", "ok");
  }

  if (td.classList.contains("metodo")) {
    const m    = normalizeMetodo(td.textContent);
    const prev = normalizeMetodo(f.metodo);
    if (m === prev) return;
    await editarMetodo(row, m);
    f.metodo = m;
    td.textContent   = m || "—";
    td.dataset.metodo = m;
    buildMetodoOptions();
    showMsg("Metodo actualizado ✅", "ok");
  }

  updateKPIs();
  applyFilters();
  if (isStatsModalOpen()) await loadStats();
}

function revertEditableCell(td) {
  const tr  = td.closest("tr");
  const row = getRowFromTR(tr);
  const f   = getFacturaByRow(row);
  if (!f) return;

  if (td.classList.contains("valor")) {
    const old = valorNum(f);
    td.textContent   = fmtCOP(old);
    td.dataset.valor = String(old);
  }
  if (td.classList.contains("metodo")) {
    const m = normalizeMetodo(f.metodo);
    td.textContent    = m || "—";
    td.dataset.metodo = m;
  }
}

/* ===========================
   HISTORIAL
=========================== */
function ensureHistoryModal() {
  let $m = $("#historyModal");
  if ($m) return $m;

  const el = document.createElement("div");
  el.id = "historyModal";
  el.className = "modal hide";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-labelledby", "historyTitle");
  el.innerHTML = `
    <div class="modal-backdrop" data-close="history"></div>
    <div class="modal-card modal-card-wide" role="document">
      <div class="modal-head">
        <div>
          <h2 id="historyTitle">Historial de pagos</h2>
          <p class="muted" id="historySub" style="margin:6px 0 0">Todos los pagos registrados.</p>
        </div>
        <button class="btn icon" type="button" aria-label="Cerrar" data-close="history">✕</button>
      </div>
      <div class="modal-body">
        <div class="history-filters">
          <label class="field">
            <span class="label">Buscar</span>
            <input id="historySearch" type="search" placeholder="Factura, referencia, comentario..." />
          </label>
          <label class="field">
            <span class="label">Mes</span>
            <select id="historyMonth"><option value="all">Todos</option></select>
          </label>
          <label class="field">
            <span class="label">Metodo</span>
            <select id="historyMethod"><option value="all">Todos</option></select>
          </label>
        </div>
        <div id="historyBody" class="history-body">
          <p class="muted">Cargando historial...</p>
        </div>
      </div>
      <div class="modal-foot">
        <button id="historyRefresh" class="btn ghost" type="button">Actualizar</button>
        <button class="btn" type="button" data-close="history">Cerrar</button>
      </div>
    </div>
  `;

  document.body.appendChild(el);
  $("#historySearch", el)?.addEventListener("input", debounce(applyHistoryFilters, 160));
  $("#historyMonth", el)?.addEventListener("change", applyHistoryFilters);
  $("#historyMethod", el)?.addEventListener("change", applyHistoryFilters);
  $("#historyRefresh", el)?.addEventListener("click", () => loadHistory(true));
  return el;
}

function openHistoryModal() {
  ensureHistoryModal().classList.remove("hide");
  document.body.style.overflow = "hidden";
}

function closeHistoryModal() {
  const $m = $("#historyModal");
  if (!$m) return;
  $m.classList.add("hide");
  document.body.style.overflow = "";
}

function historyMonthKey(row) {
  return monthKeyFromDate(parseFechaPago(row.fecha));
}

function buildHistoryFilters() {
  const $m = ensureHistoryModal();
  const months = new Set();
  const methods = new Set();
  STATE.historial.forEach(r => {
    const mk = historyMonthKey(r);
    if (mk) months.add(mk);
    const metodo = normalizeMetodo(r.metodo);
    if (metodo) methods.add(metodo);
  });

  const $month = $("#historyMonth", $m);
  const $method = $("#historyMethod", $m);
  const currentMonth = $month?.value || "all";
  const currentMethod = $method?.value || "all";

  if ($month) {
    const opts = Array.from(months).sort((a, b) => b.localeCompare(a));
    $month.innerHTML = `<option value="all">Todos</option>` +
      opts.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(prettyMonthKey(m))}</option>`).join("");
    $month.value = opts.includes(currentMonth) ? currentMonth : "all";
  }
  if ($method) {
    const opts = Array.from(methods).sort((a, b) => a.localeCompare(b, "es"));
    $method.innerHTML = `<option value="all">Todos</option>` +
      opts.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join("");
    $method.value = opts.includes(currentMethod) ? currentMethod : "all";
  }
}

function applyHistoryFilters() {
  const $m = ensureHistoryModal();
  const q = ($("#historySearch", $m)?.value || "").toLowerCase().trim();
  const month = $("#historyMonth", $m)?.value || "all";
  const method = $("#historyMethod", $m)?.value || "all";

  STATE.historialFiltered = STATE.historial.filter(r => {
    if (month !== "all" && historyMonthKey(r) !== month) return false;
    if (method !== "all" && normalizeMetodo(r.metodo) !== method) return false;
    if (!q) return true;
    return [r.factura, r.referencia, r.fecha, r.metodo, r.comentario, r.valorPagado]
      .some(v => String(v ?? "").toLowerCase().includes(q));
  });
  renderHistory();
}

function renderHistory() {
  const $body = $("#historyBody", ensureHistoryModal());
  const rows = STATE.historialFiltered.length || ($("#historySearch")?.value || $("#historyMonth")?.value !== "all" || $("#historyMethod")?.value !== "all")
    ? STATE.historialFiltered
    : STATE.historial;

  if (!rows.length) {
    $body.innerHTML = `<p class="muted">No hay pagos para mostrar.</p>`;
    return;
  }

  const ordered = [...rows].sort((a, b) => {
    const da = parseFechaPago(a.fecha)?.getTime() || 0;
    const db = parseFechaPago(b.fecha)?.getTime() || 0;
    return db - da || Number(b.row || 0) - Number(a.row || 0);
  });

  $body.innerHTML = `
    <div class="history-table-wrap">
      <table class="tabla history-table">
        <thead>
          <tr>
            <th>Fecha</th>
            <th>Factura</th>
            <th>Valor pagado</th>
            <th>Metodo</th>
            <th>Comentario</th>
            <th>Accion</th>
          </tr>
        </thead>
        <tbody>
          ${ordered.map(r => `
            <tr data-history-row="${escapeHtml(r.row)}">
              <td data-label="Fecha">${escapeHtml(r.fecha || '—')}</td>
              <td data-label="Factura">
                <strong>${escapeHtml(r.factura || '—')}</strong>
                <span class="muted history-ref">${escapeHtml(r.referencia || '')}</span>
              </td>
              <td data-label="Valor pagado">${fmtCOP(r.valorPagado)}</td>
              <td data-label="Metodo">${escapeHtml(normalizeMetodo(r.metodo) || '—')}</td>
              <td data-label="Comentario">${escapeHtml(r.comentario || '—')}</td>
              <td data-label="Accion">
                <button class="btn ghost" type="button" data-action="edit-history" data-row="${escapeHtml(r.row)}">Editar</button>
              </td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

async function loadHistory(force = false) {
  const $m = ensureHistoryModal();
  const $body = $("#historyBody", $m);
  if ($body) $body.innerHTML = `<p class="muted">Cargando historial...</p>`;
  try {
    if (force || !STATE.historial.length) {
      STATE.historial = await fetchHistorial();
    }
    buildHistoryFilters();
    applyHistoryFilters();
    const $sub = $("#historySub", $m);
    if ($sub) $sub.textContent = `${STATE.historial.length} pagos registrados.`;
  } catch (err) {
    if ($body) $body.innerHTML = `<p class="muted">Error cargando historial: ${escapeHtml(err.message)}</p>`;
  }
}

function ensureHistoryEditModal() {
  let $m = $("#historyEditModal");
  if ($m) return $m;
  const el = document.createElement("div");
  el.id = "historyEditModal";
  el.className = "modal hide";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-labelledby", "historyEditTitle");
  el.innerHTML = `
    <div class="modal-backdrop" data-close="history-edit"></div>
    <div class="modal-card" role="document">
      <div class="modal-head">
        <div>
          <h2 id="historyEditTitle">Editar pago</h2>
          <p class="muted" id="historyEditSub" style="margin:6px 0 0">—</p>
        </div>
        <button class="btn icon" type="button" aria-label="Cerrar" data-close="history-edit">✕</button>
      </div>
      <div class="modal-body">
        <label class="field" style="margin-bottom:.65rem;">
          <span class="label">Fecha</span>
          <input id="historyEditFecha" type="date" />
        </label>
        <label class="field" style="margin-bottom:.65rem;">
          <span class="label">Valor pagado</span>
          <input id="historyEditValor" type="text" inputmode="numeric" />
        </label>
        <label class="field" style="margin-bottom:.65rem;">
          <span class="label">Metodo</span>
          <input id="historyEditMetodo" type="text" />
        </label>
        <label class="field">
          <span class="label">Comentario</span>
          <textarea id="historyEditComentario" rows="4"></textarea>
        </label>
      </div>
      <div class="modal-foot">
        <button class="btn ghost" type="button" data-close="history-edit">Cancelar</button>
        <button id="historyEditSave" class="btn" type="button">Guardar</button>
      </div>
    </div>
  `;
  document.body.appendChild(el);
  return el;
}

function openHistoryEditModal(row) {
  const item = STATE.historial.find(r => Number(r.row) === Number(row));
  if (!item) return;
  const $m = ensureHistoryEditModal();
  $m.dataset.row = String(row);
  $("#historyEditSub", $m).textContent = `${item.factura || '—'} · ${item.referencia || 'Sin referencia'}`;
  $("#historyEditFecha", $m).value = dmyToHtmlDate(item.fecha);
  $("#historyEditValor", $m).value = String(Number(item.valorPagado || 0));
  $("#historyEditMetodo", $m).value = normalizeMetodo(item.metodo);
  $("#historyEditComentario", $m).value = String(item.comentario || "");
  $("#historyEditSave", $m).onclick = saveHistoryEdit;
  $m.classList.remove("hide");
}

function closeHistoryEditModal() {
  const $m = $("#historyEditModal");
  if (!$m) return;
  $m.classList.add("hide");
}

async function saveHistoryEdit() {
  const $m = $("#historyEditModal");
  if (!$m) return;
  const row = Number($m.dataset.row);
  const fechaPago = htmlDateToDMY($("#historyEditFecha", $m).value);
  const valorPagado = parseCOP($("#historyEditValor", $m).value);
  if (!fechaPago) { showMsg("Selecciona una fecha valida", "error"); return; }
  if (valorPagado == null || valorPagado < 0) { showMsg("Ingresa un valor valido", "error"); return; }

  try {
    await editarPago(row, {
      fechaPago,
      valorPagado,
      metodo: $("#historyEditMetodo", $m).value,
      comentario: $("#historyEditComentario", $m).value,
    });
    const item = STATE.historial.find(r => Number(r.row) === row);
    if (item) {
      item.fecha = fechaPago;
      item.valorPagado = valorPagado;
      item.metodo = $("#historyEditMetodo", $m).value;
      item.comentario = $("#historyEditComentario", $m).value;
    }
    STATE.stats = null;
    showMsg("Pago actualizado", "ok");
    closeHistoryEditModal();
    buildHistoryFilters();
    applyHistoryFilters();
    if (isStatsModalOpen()) await loadStats();
  } catch (err) {
    showMsg("Error: " + err.message, "error");
  }
}

/* ===========================
   EVENTOS
=========================== */

// Click en boton Registrar -> abre modal de pago
document.addEventListener("click", ev => {
  const btn = ev.target.closest("button[data-action='registrar']");
  if (!btn) return;

  const row = Number(btn.dataset.row);
  const tr  = btn.closest("tr");
  if (!Number.isFinite(row) || !tr) return;

  const f = getFacturaByRow(row);
  if (!f) return;

  openPayModal({ row, nombre: f.nombre || "—", valor: valorNum(f) });
});

document.addEventListener("click", async ev => {
  const btn = ev.target.closest("button[data-action='toggle-factura']");
  if (!btn) return;
  const row = Number(btn.dataset.row);
  const f = getFacturaByRow(row);
  if (!f) return;
  const next = f.activa === false;
  btn.disabled = true;
  try {
    await toggleFactura(row, next);
    f.activa = next;
    showMsg(next ? "Factura habilitada" : "Factura inactiva", "ok");
    updateKPIs();
    applyFilters();
    refreshStatsIfOpen();
  } catch (err) {
    showMsg("Error: " + err.message, "error");
  } finally {
    btn.disabled = false;
  }
});

document.addEventListener("click", ev => {
  const btn = ev.target.closest("button[data-action='edit-history']");
  if (!btn) return;
  openHistoryEditModal(btn.dataset.row);
});

// Click en celdas editables
document.addEventListener("click", ev => {
  const td = ev.target.closest("td.editable");
  if (!td) return;

  if (isMobileUI()) {
    const row = getRowFromTR(td.closest("tr"));
    if (!row) return;
    if (td.classList.contains("valor")) {
      openEditModal({ row, field: "valor", currentValue: td.dataset.valor || td.textContent });
    } else if (td.classList.contains("metodo")) {
      openEditModal({ row, field: "metodo", currentValue: td.dataset.metodo || td.textContent });
    }
    return;
  }

  setEditingState(td, true);
});

// Desktop: Enter guarda / Esc revierte
document.addEventListener("keydown", async ev => {
  if (!isMobileUI()) {
    const td = document.activeElement;
    if (isEditableCell(td)) {
      if (ev.key === "Enter") {
        ev.preventDefault();
        setEditingState(td, false);
        try { await saveEditableCell(td); }
        catch (err) { showMsg("Error: " + err.message, "error"); revertEditableCell(td); }
        td.blur();
      }
      if (ev.key === "Escape") {
        ev.preventDefault();
        setEditingState(td, false);
        revertEditableCell(td);
        td.blur();
        showMsg("Edicion cancelada", "ok");
      }
    }
  }
  // Cerrar modales con Escape
  if (ev.key === "Escape") {
    closeStatsModal();
    closeEditModal();
    closePayModal();
    closeHistoryEditModal();
    closeHistoryModal();
  }
});

// Desktop: blur guarda
document.addEventListener("focusout", async ev => {
  if (isMobileUI()) return;
  const td = ev.target;
  if (!isEditableCell(td)) return;
  setEditingState(td, false);
  try { await saveEditableCell(td); }
  catch (err) { showMsg("Error: " + err.message, "error"); revertEditableCell(td); }
});

// Filtros
const applyFiltersDebounced = debounce(applyFilters, 180);
$q?.addEventListener("input", applyFiltersDebounced);
$fEstado?.addEventListener("change", applyFilters);
$fMetodo?.addEventListener("change", applyFilters);

$btnClearFilters?.addEventListener("click", () => {
  if ($q)      $q.value      = "";
  if ($fEstado)$fEstado.value = "all";
  if ($fMetodo)$fMetodo.value = "all";
  applyFilters();
});

// Refresh
$btnRefresh?.addEventListener("click", boot);

// Modal stats
$btnStats?.addEventListener("click", async () => {
  openStatsModal();
  switchTab("resumen");
  await loadStats();
});

$btnHistory?.addEventListener("click", async () => {
  openHistoryModal();
  await loadHistory();
});

$btnCloseStats?.addEventListener("click", closeStatsModal);

document.addEventListener("click", ev => {
  if (ev.target.closest("[data-close='stats']")) closeStatsModal();
  if (ev.target.closest("[data-close='edit']"))  closeEditModal();
  if (ev.target.closest("[data-close='pay']"))   closePayModal();
  if (ev.target.closest("[data-close='history']")) closeHistoryModal();
  if (ev.target.closest("[data-close='history-edit']")) closeHistoryEditModal();
});

// Tabs stats
$tabs.forEach(t => t.addEventListener("click", () => switchTab(t.dataset.tab)));

// Cambio de breakpoint
if (mqMobile) {
  mqMobile.addEventListener("change", () => {
    setHintByMode();
    applyFilters();
    refreshStatsIfOpen();
  });
}

/* ===========================
   BOOT
=========================== */
async function boot() {
  try {
    setBusy(true);
    STATE.facturas = await fetchFacturas();

    // Normalizar campos esperados
    STATE.facturas = STATE.facturas.map(f => ({
      ...f,
      nombre    : f.nombre     ?? "",
      referencia: f.referencia ?? "",
      metodo    : normalizeMetodo(f.metodo),
      ultimo    : f.ultimo     ?? "",
      diaCorte  : f.diaCorte   ?? null,
      activa    : f.activa !== false,
      row       : f.row,
    }));
    const sinDiaVencimiento = STATE.facturas.filter(f => !(Number(f.diaCorte) >= 1 && Number(f.diaCorte) <= 31)).length;
    if (sinDiaVencimiento > 0) {
      showMsg(`Faltan ${sinDiaVencimiento} facturas con dia de vencimiento`, 'error');
    }

    buildMetodoOptions();
    updateKPIs();
    setHintByMode();
    applyFilters();

    // Cargamos stats en segundo plano para no bloquear la tabla principal.
    (async () => {
      try {
        STATE.stats = await fetchStats();
        updateKPIs();
        if (isStatsModalOpen()) await loadStats();
      } catch (_) {
        STATE.stats = null;
      }
    })();
  } catch (err) {
    console.error(err);
    showMsg("Error cargando: " + err.message, "error");
  } finally {
    setBusy(false);
  }
}

boot();










