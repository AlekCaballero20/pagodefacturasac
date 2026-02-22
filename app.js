'use strict';

/* =============================================================================
  FACTURAS AC · app.js (Premium Light · Mobile-first UX)
  Mejoras clave:
  - Tabla -> Cards en móvil (agrega data-label a cada <td> para CSS)
  - Edición “decente” en móvil (sin contenteditable): modal rápido para Valor/Método
  - contenteditable más robusto en desktop (Enter guarda / Esc revierte / blur guarda)
  - Filtros con debounce + render eficiente
  - KPIs corregidos (bug de precedencia con ||) + cálculos más estables
  - Método options: normaliza, ordena y sincroniza con modal
============================================================================= */

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
  methods: [], // lista de métodos (para select y modal)
};

/* ===========================
   DOM HELPERS
=========================== */
const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

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
const $statsMeses = $("#statsMeses");
const $statsPendientes = $("#statsPendientes");
const $btnCloseStats = $("#btnCloseStats");

/* Tabs */
const $tabs = $$(".tab");
const $tabPanels = $$(".tab-panel");

/* Hint */
const $editHint = $("#editHint");

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
function parseFechaPago(fechaStr) {
  // Espera "dd/mm/yyyy" (y quizá con hora "dd/mm/yyyy hh:mm:ss")
  if (!fechaStr) return null;
  const base = String(fechaStr).trim().split(" ")[0];
  const p = base.split("/");
  if (p.length < 3) return null;

  const dd = Number(p[0]);
  const mm = Number(p[1]);
  const yyyy = Number(p[2]);
  if (!dd || !mm || !yyyy) return null;

  // Date(yyyy, mm-1, dd) evita zonas raras con parse() y formatos locales.
  return new Date(yyyy, mm - 1, dd);
}

function esPagoDelMes(fechaStr) {
  const d = parseFechaPago(fechaStr);
  if (!d) return false;

  const hoy = new Date();
  return d.getMonth() === hoy.getMonth() && d.getFullYear() === hoy.getFullYear();
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
   UTILIDADES
=========================== */
function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeMetodo(s) {
  const t = String(s ?? "").trim();
  return t;
}

function setHintByMode() {
  if (!$editHint) return;
  if (isMobileUI()) {
    $editHint.innerHTML = `Tip: en celular toca <strong>Valor</strong> o <strong>Método</strong> para editar (más fácil que pelear con el teclado).`;
  } else {
    $editHint.innerHTML = `Tip: edita <strong>Valor</strong> y <strong>Método</strong> directo en la tabla. Enter guarda, Esc revierte.`;
  }
}

/* Debounce básico */
function debounce(fn, wait = 200) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

/* ===========================
   RENDER TABLE (with data-label)
=========================== */
function rowHTML(f) {
  const ultimo = f.ultimo ?? "";
  const pagadoEsteMes = esPagoDelMes(ultimo);

  const estadoBadge = pagadoEsteMes
    ? `<span class="badge ok">Pagado</span>`
    : `<span class="badge pendiente">Pendiente</span>`;

  const valorNumerico =
    Number(isNaN(f.valor) ? parseCOP(f.valor) : f.valor) || 0;

  const metodoTxt = normalizeMetodo(f.metodo);

  // Ojo: data-label es CLAVE para el CSS "cards" en móvil
  // También guardamos valores crudos para edición
  return `
    <tr data-row="${escapeHtml(f.row)}">
      <td data-label="Factura">${escapeHtml(f.nombre ?? "")}</td>
      <td data-label="Referencia">${escapeHtml(f.referencia ?? "")}</td>

      <td data-label="Valor"
          class="editable valor"
          contenteditable="${isMobileUI() ? "false" : "true"}"
          data-valor="${valorNumerico}">
        ${fmtCOP(valorNumerico)}
      </td>

      <td data-label="Método"
          class="editable metodo"
          contenteditable="${isMobileUI() ? "false" : "true"}"
          data-metodo="${escapeHtml(metodoTxt)}">
        ${escapeHtml(metodoTxt || "—")}
      </td>

      <td data-label="Último pago" class="fecha">${escapeHtml(ultimo)}</td>
      <td data-label="Estado" class="estado">${estadoBadge}</td>

      <td data-label="Acción">
        <button class="btn" data-row="${escapeHtml(f.row)}" data-action="registrar">
          Registrar
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

  STATE.facturas.forEach((f) => {
    const m = normalizeMetodo(f.metodo);
    if (m) methods.add(m);
  });

  const sorted = Array.from(methods).sort((a, b) => a.localeCompare(b, "es"));
  STATE.methods = sorted;

  $fMetodo.innerHTML =
    `<option value="all">Todos</option>` +
    sorted.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join("");
}

function applyFilters() {
  const q = ($q?.value || "").toLowerCase().trim();
  const estado = $fEstado?.value || "all";
  const metodo = $fMetodo?.value || "all";

  STATE.filtered = STATE.facturas.filter((f) => {
    const pagado = esPagoDelMes(f.ultimo);

    if (estado === "pagado" && !pagado) return false;
    if (estado === "pendiente" && pagado) return false;

    const m = normalizeMetodo(f.metodo);
    if (metodo !== "all" && m !== metodo) return false;

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
function updateKPIs() {
  const total = STATE.facturas.length;

  const pagadas = STATE.facturas.reduce((acc, f) => acc + (esPagoDelMes(f.ultimo) ? 1 : 0), 0);
  const pendientes = Math.max(0, total - pagadas);

  const totalMes = STATE.facturas
    .filter((f) => esPagoDelMes(f.ultimo))
    .reduce((acc, f) => acc + (parseCOP(f.valor) || 0), 0);

  const valorPendiente = STATE.facturas
    .filter((f) => !esPagoDelMes(f.ultimo))
    .reduce((acc, f) => acc + (parseCOP(f.valor) || 0), 0);

  if ($kpiTotalMes) $kpiTotalMes.textContent = fmtCOP(totalMes);
  if ($kpiPagadas) $kpiPagadas.textContent = String(pagadas);
  if ($kpiTotalFacturas) $kpiTotalFacturas.textContent = String(total);
  if ($kpiPendientes) $kpiPendientes.textContent = String(pendientes);
  if ($kpiValorPendiente) $kpiValorPendiente.textContent = fmtCOP(valorPendiente);

  // Método top (por total pagado histórico, no solo mes)
  const byMetodo = {};
  STATE.facturas.forEach((f) => {
    const m = normalizeMetodo(f.metodo);
    if (!m) return;
    const val = parseCOP(f.valor) || 0;
    byMetodo[m] = (byMetodo[m] || 0) + val;
  });

  const top = Object.entries(byMetodo).sort((a, b) => b[1] - a[1])[0];
  if ($kpiMetodoTop) $kpiMetodoTop.textContent = top ? top[0] : "—";

  if ($kpiDeltaMes) $kpiDeltaMes.textContent = "vs mes anterior: (próximamente)";
}

/* ===========================
   MODAL + TABS (Stats)
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
    const active = t.dataset.tab === key;
    t.classList.toggle("is-active", active);
    t.setAttribute("aria-selected", active ? "true" : "false");
  });

  $tabPanels.forEach((p) => {
    // ids: tabResumen / tabMetodos / tabMeses / tabPendientes
    p.classList.toggle("hide", !p.id.toLowerCase().includes(key));
  });
}

async function loadStats() {
  if ($statsBody) $statsBody.innerHTML = `<p class="muted">Cargando estadísticas…</p>`;

  try {
    const s = await fetchStats();
    STATE.stats = s;

    if ($statsBody) {
      $statsBody.innerHTML = `
        <div class="stats-grid">
          <div class="stat"><div class="k">Total histórico</div><div class="v">${fmtCOP(s.totalPagado)}</div></div>
          <div class="stat"><div class="k">Pagos este mes</div><div class="v">${escapeHtml(s.pagosEsteMes)}</div></div>
          <div class="stat"><div class="k">Total este mes</div><div class="v">${fmtCOP(s.totalEsteMes)}</div></div>
          <div class="stat"><div class="k">Registros</div><div class="v">${escapeHtml(s.totalRegistros)}</div></div>
        </div>
      `;
    }

    if ($statsMetodos) $statsMetodos.innerHTML = `<p class="muted">Próximamente: breakdown por método 💳</p>`;
    if ($statsMeses) $statsMeses.innerHTML = `<p class="muted">Próximamente: histórico por mes 📅</p>`;

    if ($statsPendientes) {
      const pendientesEsteMes = STATE.facturas.filter((f) => !esPagoDelMes(f.ultimo)).length;
      $statsPendientes.innerHTML = `<p><strong>Pendientes este mes:</strong> ${pendientesEsteMes}</p>`;
    }
  } catch (err) {
    if ($statsBody) $statsBody.innerHTML = `<p class="muted">❌ Error: ${escapeHtml(err.message)}</p>`;
  }
}

/* ===========================
   MOBILE EDIT MODAL (Valor/Método)
   - Reusa estilos .modal del CSS
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
        <div class="field" style="margin-bottom: .75rem;">
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
  const $m = ensureEditModal();
  const $title = $("#editTitle", $m);
  const $sub = $("#editSub", $m);
  const $label = $("#editLabel", $m);
  const $help = $("#editHelp", $m);

  const $inpValor = $("#editValor", $m);
  const $selMetodo = $("#editMetodo", $m);
  const $btnSave = $("#editSave", $m);

  // guardamos contexto en dataset del modal
  $m.dataset.row = String(row);
  $m.dataset.field = field;

  // reset
  $inpValor.classList.add("hide");
  $selMetodo.classList.add("hide");

  if (field === "valor") {
    $title.textContent = "Editar valor";
    $sub.textContent = "Escribe el valor en COP (sin puntos también sirve).";
    $label.textContent = "Valor";
    $help.textContent = "Tip: puedes pegar el número tal cual. Yo me encargo del formato. 🙂";

    $inpValor.value = String(parseCOP(currentValue) ?? "");
    $inpValor.classList.remove("hide");

    // enfoque
    setTimeout(() => {
      $inpValor.focus();
      $inpValor.select();
    }, 0);
  } else if (field === "metodo") {
    $title.textContent = "Editar método";
    $sub.textContent = "Selecciona el método de pago.";
    $label.textContent = "Método";
    $help.textContent = "Si falta un método, escríbelo en la hoja o en el registro y luego actualizas.";

    // construir opciones
    const opts =
      `<option value="">—</option>` +
      STATE.methods.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join("");

    $selMetodo.innerHTML = opts;
    $selMetodo.value = normalizeMetodo(currentValue) || "";

    $selMetodo.classList.remove("hide");

    setTimeout(() => $selMetodo.focus(), 0);
  }

  // abrir
  $m.classList.remove("hide");
  document.body.style.overflow = "hidden";

  // Guardar
  $btnSave.onclick = async () => {
    await saveEditFromModal();
  };
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

  const row = Number($m.dataset.row);
  const field = $m.dataset.field;

  const $inpValor = $("#editValor", $m);
  const $selMetodo = $("#editMetodo", $m);

  try {
    if (field === "valor") {
      const n = parseCOP($inpValor.value);
      if (n == null || n <= 0) {
        showMsg("Pon un valor válido 😅", "error");
        return;
      }
      await editarValor(row, n);
      // sync local
      const f = STATE.facturas.find((x) => Number(x.row) === row);
      if (f) f.valor = n;
      showMsg("Valor actualizado ✅", "ok");
    } else if (field === "metodo") {
      const m = normalizeMetodo($selMetodo.value);
      await editarMetodo(row, m);
      const f = STATE.facturas.find((x) => Number(x.row) === row);
      if (f) f.metodo = m;
      showMsg("Método actualizado ✅", "ok");
      buildMetodoOptions(); // por si cambió catálogo
    }

    // re-render (y respeta filtros)
    updateKPIs();
    applyFilters();
    closeEditModal();
  } catch (err) {
    showMsg("Error: " + err.message, "error");
  }
}

/* Cierre del modal edit */
document.addEventListener("click", (ev) => {
  if (ev.target.closest("[data-close='edit']")) closeEditModal();
});
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") closeEditModal();
});

/* ===========================
   DESKTOP INLINE EDIT (contenteditable)
=========================== */
function isEditableCell(td) {
  return td && td.classList && td.classList.contains("editable");
}

function setEditingState(td, isEditing) {
  if (!td) return;
  td.classList.toggle("editing", !!isEditing);
}

function getRowFromTR(tr) {
  if (!tr) return null;
  const row = Number(tr.dataset.row);
  return Number.isFinite(row) ? row : null;
}

function getFacturaByRow(row) {
  return STATE.facturas.find((f) => Number(f.row) === Number(row)) || null;
}

async function saveEditableCell(td) {
  const tr = td.closest("tr");
  const row = getRowFromTR(tr);
  if (!row) return;

  const f = getFacturaByRow(row);
  if (!f) return;

  if (td.classList.contains("valor")) {
    const raw = td.textContent;
    const n = parseCOP(raw);
    if (n == null || n <= 0) {
      showMsg("Valor inválido 😵‍💫", "error");
      // revert
      const old = Number(isNaN(f.valor) ? parseCOP(f.valor) : f.valor) || 0;
      td.textContent = fmtCOP(old);
      td.dataset.valor = String(old);
      return;
    }

    const prev = parseCOP(f.valor) || 0;
    if (n === prev) return;

    await editarValor(row, n);
    f.valor = n;

    td.textContent = fmtCOP(n);
    td.dataset.valor = String(n);

    showMsg("Valor actualizado ✅", "ok");
  }

  if (td.classList.contains("metodo")) {
    const raw = td.textContent;
    const m = normalizeMetodo(raw === "—" ? "" : raw);
    const prev = normalizeMetodo(f.metodo);

    if (m === prev) return;

    await editarMetodo(row, m);
    f.metodo = m;

    td.textContent = m || "—";
    td.dataset.metodo = m;

    buildMetodoOptions();
    showMsg("Método actualizado ✅", "ok");
  }

  updateKPIs();
  applyFilters();
}

function revertEditableCell(td) {
  const tr = td.closest("tr");
  const row = getRowFromTR(tr);
  const f = getFacturaByRow(row);
  if (!f) return;

  if (td.classList.contains("valor")) {
    const old = Number(isNaN(f.valor) ? parseCOP(f.valor) : f.valor) || 0;
    td.textContent = fmtCOP(old);
    td.dataset.valor = String(old);
  }

  if (td.classList.contains("metodo")) {
    const m = normalizeMetodo(f.metodo);
    td.textContent = m || "—";
    td.dataset.metodo = m;
  }
}

/* ===========================
   EVENTOS
=========================== */

/* Registrar pago */
document.addEventListener("click", async (ev) => {
  const btn = ev.target.closest("button[data-action='registrar']");
  if (!btn) return;

  const row = Number(btn.dataset.row);
  const tr = btn.closest("tr");
  if (!Number.isFinite(row) || !tr) return;

  btn.disabled = true;
  const oldTxt = btn.textContent;
  btn.textContent = "⏳";

  try {
    const { fecha } = await registrarPago(row);

    // actualizar DOM rápido
    const $fecha = tr.querySelector(".fecha");
    const $estado = tr.querySelector(".estado");
    if ($fecha) $fecha.textContent = String(fecha || "");
    if ($estado) {
      $estado.innerHTML = esPagoDelMes(fecha)
        ? `<span class="badge ok">Pagado</span>`
        : `<span class="badge pendiente">Pendiente</span>`;
    }

    // sync local
    const f = getFacturaByRow(row);
    if (f) f.ultimo = fecha;

    showMsg("Pago registrado ✅", "ok");

    // recalcular sin recargar todo el universo
    updateKPIs();
    applyFilters();
  } catch (err) {
    showMsg("Error: " + err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = oldTxt || "Registrar";
  }
});

/* Click en celdas editables: móvil abre modal; desktop entra en edición normal */
document.addEventListener("click", (ev) => {
  const td = ev.target.closest("td.editable");
  if (!td) return;

  if (isMobileUI()) {
    // Modal edit
    const tr = td.closest("tr");
    const row = getRowFromTR(tr);
    if (!row) return;

    if (td.classList.contains("valor")) {
      openEditModal({
        row,
        field: "valor",
        currentValue: td.dataset.valor || td.textContent,
      });
    } else if (td.classList.contains("metodo")) {
      openEditModal({
        row,
        field: "metodo",
        currentValue: td.dataset.metodo || td.textContent,
      });
    }
    return;
  }

  // Desktop: marcar estado editing (para estilo)
  setEditingState(td, true);
});

/* Desktop: Enter guarda / Esc revierte */
document.addEventListener("keydown", async (ev) => {
  if (isMobileUI()) return;

  const td = document.activeElement;
  if (!isEditableCell(td)) return;

  if (ev.key === "Enter") {
    ev.preventDefault();
    setEditingState(td, false);
    try {
      await saveEditableCell(td);
    } catch (err) {
      showMsg("Error: " + err.message, "error");
      revertEditableCell(td);
    }
    td.blur();
  }

  if (ev.key === "Escape") {
    ev.preventDefault();
    setEditingState(td, false);
    revertEditableCell(td);
    td.blur();
    showMsg("Edición cancelada", "ok");
  }
});

/* Desktop: blur guarda (si cambió) */
document.addEventListener("focusout", async (ev) => {
  if (isMobileUI()) return;

  const td = ev.target;
  if (!isEditableCell(td)) return;

  setEditingState(td, false);
  try {
    await saveEditableCell(td);
  } catch (err) {
    showMsg("Error: " + err.message, "error");
    revertEditableCell(td);
  }
});

/* Filtros */
const applyFiltersDebounced = debounce(applyFilters, 180);

$q?.addEventListener("input", applyFiltersDebounced);
$fEstado?.addEventListener("change", applyFilters);
$fMetodo?.addEventListener("change", applyFilters);

$btnClearFilters?.addEventListener("click", () => {
  if ($q) $q.value = "";
  if ($fEstado) $fEstado.value = "all";
  if ($fMetodo) $fMetodo.value = "all";
  applyFilters();
});

/* Refresh */
$btnRefresh?.addEventListener("click", boot);

/* Modal stats */
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

/* Reaccionar a cambios de breakpoint para UX */
if (mqMobile) {
  mqMobile.addEventListener("change", () => {
    setHintByMode();
    // re-render para que contenteditable se ajuste y data-label siga ok
    applyFilters();
  });
}

/* ===========================
   BOOT
=========================== */
async function boot() {
  try {
    setBusy(true);

    STATE.facturas = await fetchFacturas();

    // Normalizar campos esperados (por si llegan nulls raros)
    STATE.facturas = STATE.facturas.map((f) => ({
      ...f,
      nombre: f.nombre ?? "",
      referencia: f.referencia ?? "",
      metodo: normalizeMetodo(f.metodo),
      ultimo: f.ultimo ?? "",
      row: f.row,
    }));

    buildMetodoOptions();
    updateKPIs();
    setHintByMode();
    applyFilters();
  } catch (err) {
    console.error(err);
    showMsg("Error cargando: " + err.message, "error");
  } finally {
    setBusy(false);
  }
}

boot();