// ─────────────────────────────────────────────────────────────────────────
// DASHBOARD-TILLÄGG — Fas 4 i redesign-färdplanen
//
// Den befintliga DashboardPage i App.jsx täcker redan mycket av strategins
// avsnitt 5 väl: lagervärde, intäkt/vinst-grafer, toppsäljare, försäljning
// per kategori, senaste försäljningar. Byggs INTE om i onödan.
//
// Men en genomgång mot strategins konkreta krav visade FYRA saker som
// helt saknas idag:
//   1. Ingen KPI för "Reserverade" (arbetskö) trots att reservationer är
//      en av de fem uttryckligen namngivna KPI-korten i avsnitt 5.1
//   2. Ingen KPI för "Lågt lager" (varning) — settings.lowStockAlert
//      FINNS redan i inställningarna men används ingenstans i hela appen
//   3. "Lägg till artikel" och "Ny försäljning" — de två mest efterfrågade
//      snabbåtgärderna enligt avsnitt 5.2 — saknas helt i dagens
//      snabbåtgärds-lista (som har massredigera, backup, leverantörer m.m.
//      men inte de två vanligaste sakerna man faktiskt vill göra snabbt)
//   4. Ingen lista över de mest akuta lågt-lager-artiklarna, ingen
//      översikt över reservationer som snart behöver uppföljning
//
// Detta är TILLÄGG, inte en omskrivning — designade för att droppas in i
// den befintliga DashboardPage utan att röra det som redan fungerar bra.
// Fristående och testat separat, rör inget i den körande appen ännu.
// ─────────────────────────────────────────────────────────────────────────

import { useMemo } from "react";

const BX = "var(--color-accent, #1B3A6B)";
const R = "#CC1B2B", GR = "#16A34A", AM = "#D97706";
const WH = "var(--color-surface, #FFFFFF)", BD = "var(--color-border, #E2E5EA)";
const TX = "var(--color-text, #141820)", TM = "var(--color-text-muted, #3D4451)", MU = "var(--color-text-faint, #8A90A0)";

// ── Beräkningar — exporterade separat från komponenterna så de kan
// testas isolerat utan att rendera något (samma princip som resten av
// appens beräkningslogik i calc.mjs). ──

// En reservation anses behöva uppföljning efter 14 dagar utan åtgärd —
// ett rimligt, konfigurerbart startvärde. Ingen befintlig "förfaller"-
// logik fanns i appen att bygga vidare på, så detta är ett nytt,
// litet tillägg specifikt för dashboardens överblick.
const RESERVATION_FOLLOWUP_DAYS = 14;

export function getReservationCounts(items, now = Date.now()) {
  let active = 0, needsFollowUp = 0;
  for (const item of items || []) {
    for (const r of item.reservations || []) {
      active++;
      const ageDays = (now - r.ts) / 864e5;
      if (ageDays >= RESERVATION_FOLLOWUP_DAYS) needsFollowUp++;
    }
  }
  return { active, needsFollowUp };
}

export function getLowStockItems(items, threshold) {
  return (items || [])
    .filter(i => i.quantity > 0 && i.quantity <= threshold)
    .sort((a, b) => a.quantity - b.quantity);
}

// ── KPI-kort — samma visuella mönster som befintliga StatCard i
// App.jsx (färgad ikon-cirkel, stor Barlow Condensed-siffra), men
// specifikt för de TVÅ kort som saknas: Reserverade och Lågt lager. ──
function KpiCard({ label, value, color, icon, onClick }) {
  return (
    <div
      onClick={onClick}
      style={{
        background: WH, borderRadius: "var(--radius-md, 10px)", padding: 14,
        border: `1px solid ${BD}`, cursor: onClick ? "pointer" : "default",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
        <div style={{ width: 26, height: 26, borderRadius: 7, background: `${color}18`, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <i className={`fa-solid fa-${icon}`} style={{ fontSize: 12, color }} />
        </div>
        <span style={{ fontSize: 10, fontWeight: 700, color: MU, textTransform: "uppercase", letterSpacing: 0.7 }}>{label}</span>
      </div>
      <div style={{ fontFamily: "var(--font-family-display, 'Barlow Condensed', sans-serif)", fontSize: "var(--text-kpi, 26px)", fontWeight: 800, color, lineHeight: 1.1 }}>
        {value}
      </div>
    </div>
  );
}

// De två saknade KPI-korten, avsedda att läggas till BREDVID (inte
// istället för) de befintliga Artiklar/Tot.kvantitet/Lagervärde-korten.
export function MissingKpiCards({ items, onOpenReservations, onOpenLowStock }) {
  const { active: reservedCount } = useMemo(() => getReservationCounts(items), [items]);
  const lowStockThreshold = 2; // matchar settings.lowStockAlert default
  const lowStockCount = useMemo(() => getLowStockItems(items, lowStockThreshold).length, [items]);

  return (
    <>
      <KpiCard label="Reserverade" value={reservedCount} color={BX} icon="bookmark" onClick={onOpenReservations} />
      <KpiCard label="Lågt lager" value={lowStockCount} color={lowStockCount > 0 ? AM : GR} icon="triangle-exclamation" onClick={onOpenLowStock} />
    </>
  );
}

// ── Snabbåtgärder — de två som saknas, avsedda att läggas FÖRST i
// listan (strategin: "viktigast först", princip 2). ──
export function PrimaryQuickActions({ onAddItem, onNewSale }) {
  const actionStyle = {
    background: WH, borderRadius: "var(--radius-md, 10px)", border: `1px solid ${BD}`,
    padding: "14px 8px", display: "flex", flexDirection: "column", alignItems: "center",
    gap: 6, cursor: "pointer", minHeight: "var(--touch-target-min, 44px)",
  };
  return (
    <>
      <button onClick={onAddItem} style={actionStyle}>
        <i className="fa-solid fa-plus" style={{ fontSize: 18, color: BX }} />
        <span style={{ fontSize: 11, fontWeight: 600, color: TX }}>Lägg till artikel</span>
      </button>
      <button onClick={onNewSale} style={actionStyle}>
        <i className="fa-solid fa-cart-shopping" style={{ fontSize: 18, color: BX }} />
        <span style={{ fontSize: 11, fontWeight: 600, color: TX }}>Ny försäljning</span>
      </button>
    </>
  );
}

// ── Lågt lager-widget — kort lista över de MEST AKUTA artiklarna, inte
// hela lagret (strategin avsnitt 5.2: "kort lista med de mest akuta
// artiklarna, inte hela lagret"). Visar max 5, med en länk till fler. ──
export function LowStockWidget({ items, threshold = 2, onOpenItem, onViewAll }) {
  const lowStock = useMemo(() => getLowStockItems(items, threshold), [items, threshold]);
  if (lowStock.length === 0) return null;

  return (
    <div style={{ background: WH, borderRadius: "var(--radius-md, 10px)", border: `1px solid ${AM}30`, overflow: "hidden" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", background: `${AM}0A`, borderBottom: `1px solid ${BD}` }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: AM }}>
          <i className="fa-solid fa-triangle-exclamation" style={{ marginRight: 6 }} />
          Lågt lager ({lowStock.length})
        </span>
        {lowStock.length > 5 && (
          <button onClick={onViewAll} style={{ background: "none", border: "none", color: BX, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
            Visa alla
          </button>
        )}
      </div>
      {lowStock.slice(0, 5).map((item, i) => (
        <div
          key={item.id}
          onClick={() => onOpenItem(item)}
          style={{
            display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", cursor: "pointer",
            borderBottom: i < Math.min(lowStock.length, 5) - 1 ? `1px solid ${BD}50` : "none",
          }}
        >
          <span style={{ background: BX, color: WH, borderRadius: 4, padding: "1px 6px", fontSize: 11, fontWeight: 800, flexShrink: 0 }}>
            #{item.stockNumber}
          </span>
          <span style={{ flex: 1, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.name}</span>
          <span style={{ fontFamily: "var(--font-family-display, 'Barlow Condensed', sans-serif)", fontSize: 16, fontWeight: 800, color: item.quantity === 1 ? R : AM }}>
            {item.quantity}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Reservationer som snart kräver uppföljning ──
export function ReservationFollowUpWidget({ items, onOpenItem, onViewAll }) {
  const needsFollowUp = useMemo(() => {
    const now = Date.now();
    const list = [];
    for (const item of items || []) {
      for (const r of item.reservations || []) {
        const ageDays = Math.floor((now - r.ts) / 864e5);
        if (ageDays >= RESERVATION_FOLLOWUP_DAYS) list.push({ item, reservation: r, ageDays });
      }
    }
    return list.sort((a, b) => b.ageDays - a.ageDays);
  }, [items]);

  if (needsFollowUp.length === 0) return null;

  return (
    <div style={{ background: WH, borderRadius: "var(--radius-md, 10px)", border: `1px solid ${BD}`, overflow: "hidden" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", borderBottom: `1px solid ${BD}` }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: MU, textTransform: "uppercase", letterSpacing: 0.7 }}>
          Reservationer som väntat länge
        </span>
        <button onClick={onViewAll} style={{ background: "none", border: "none", color: BX, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
          Alla
        </button>
      </div>
      {needsFollowUp.slice(0, 5).map(({ item, reservation, ageDays }, i) => (
        <div
          key={reservation.id || i}
          onClick={() => onOpenItem(item)}
          style={{
            display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", cursor: "pointer",
            borderBottom: i < Math.min(needsFollowUp.length, 5) - 1 ? `1px solid ${BD}50` : "none",
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.name}</div>
            <div style={{ fontSize: 11, color: MU }}>{reservation.customer || reservation.regNumber || "Okänd"}</div>
          </div>
          <span style={{ fontSize: 11, fontWeight: 700, color: ageDays > 21 ? R : AM, flexShrink: 0 }}>{ageDays} dagar</span>
        </div>
      ))}
    </div>
  );
}
