// ─────────────────────────────────────────────────────────────────────────
// MOBILNAVIGATION — Fas 3 i redesign-färdplanen
//
// Detta är den DEL av App Shell som faktiskt SAKNAS idag. Sidebar (för
// desktop) och TopBar finns redan i App.jsx och matchar strategin väl —
// byggs INTE om här. Men på mobil finns i dagsläget ingen ständigt synlig
// navigation alls: bara en "grip"-ikon i TopBar som öppnar en dold,
// tryck-för-att-visa meny (menuOpen i InventoryPage). Strategin (avsnitt
// 13) efterfrågar uttryckligen: "Bottom navigation med 4–5 huvudval:
// Översikt, Lager, Sälj, Reservationer, Mer" — ständigt synlig, inte
// gömd bakom ett extra tryck.
//
// VIKTIGT — fristående, rör INGET i den körande appen ännu. Återanvänder
// den BEFINTLIGA slide-up-menyn för "Mer" (inte en duplicerad lösning) —
// den täcker redan alla sällan använda funktioner väl.
// ─────────────────────────────────────────────────────────────────────────

import { useMemo } from "react";

const BX = "var(--color-accent, #1B3A6B)";
const R = "#CC1B2B";
const WH = "var(--color-surface, #FFFFFF)";
const BD = "var(--color-border, #E2E5EA)";
const MU = "var(--color-text-faint, #8A90A0)";

// De fyra möjliga huvudvalen, i prioritetsordning. "Lager" visas ALLTID
// (motsvarar navItems.always i dagens Sidebar-logik). De övriga tre visas
// bara om användaren faktiskt har behörighet — exakt samma behörighets-
// uttryck som redan används i Sidebar, så beteendet blir identiskt
// oavsett om man är på desktop eller mobil.
function buildNavItems({ isAdmin, can, cartCount, trashCount }) {
  const candidates = [
    { key: "dashboard", icon: "chart-line", label: "Översikt", route: "dashboard",
      show: isAdmin || can("canViewDashboard") },
    { key: "inventory", icon: "house", label: "Lager", route: "inventory",
      show: true, always: true },
    { key: "checkout", icon: "cart-shopping", label: "Sälj", route: "checkout",
      show: can("canUseCheckout") || isAdmin, badge: cartCount },
    { key: "reservations", icon: "bookmark", label: "Reserv.", route: "reservations",
      show: isAdmin || can("canViewReservations") },
    { key: "scan", icon: "qrcode", label: "Skanna", route: "scan",
      show: isAdmin || can("canScan") },
  ];
  const available = candidates.filter(i => i.always || i.show);
  // Max 4 platser + "Mer" = 5 totalt, enligt strategins spec. Om fler än
  // 4 är tillgängliga för den här användaren visas de fyra viktigaste
  // (ordningen i candidates-listan ovan ÄR prioritetsordningen) — resten
  // nås ändå via "Mer", inget försvinner, bara flyttas dit.
  return available.slice(0, 4);
}

// Enskild nav-knapp — minst 44px touch-yta enligt tillgänglighetskravet,
// aktivt läge visas med BÅDE färg OCH position (inte bara färg, matchar
// principen att status aldrig ska uttryckas enbart genom färg).
function NavButton({ icon, label, badge, active, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1, display: "flex", flexDirection: "column", alignItems: "center",
        justifyContent: "center", gap: 3, minHeight: "var(--touch-target-min, 44px)",
        padding: "6px 4px", background: "none", border: "none", cursor: "pointer",
        color: active ? BX : MU, position: "relative",
        fontFamily: "var(--font-family, 'Barlow', sans-serif)",
      }}
    >
      <span style={{ position: "relative" }}>
        <i className={`fa-solid fa-${icon}`} style={{ fontSize: 18 }} />
        {badge > 0 && (
          <span style={{
            position: "absolute", top: -6, right: -8, background: R, color: WH,
            borderRadius: "50%", width: 15, height: 15, fontSize: 9, fontWeight: 800,
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>{badge > 9 ? "9+" : badge}</span>
        )}
      </span>
      <span style={{ fontSize: 10, fontWeight: active ? 700 : 500 }}>{label}</span>
      {active && (
        <span style={{
          position: "absolute", top: 0, left: "30%", right: "30%", height: 2,
          background: BX, borderRadius: "0 0 3px 3px",
        }} />
      )}
    </button>
  );
}

// ── MobileNav ────────────────────────────────────────────────────────────
// currentRoute: namnet på den aktiva sidan (matchar stack[stack.length-1].name
// i den befintliga navigeringslogiken).
// onNavigate(route): anropas med routnamnet — samma push(route)-mönster
// som redan används genomgående i App.jsx, inget nytt navigeringssystem.
// onOpenMore(): öppnar den BEFINTLIGA slide-up-menyn (menuOpen) — denna
// komponent äger inte den logiken, bara triggar den.
export function MobileNav({ currentRoute, onNavigate, onOpenMore, isAdmin, can, cartCount = 0, trashCount = 0 }) {
  const navItems = useMemo(
    () => buildNavItems({ isAdmin, can, cartCount, trashCount }),
    [isAdmin, can, cartCount, trashCount]
  );

  return (
    <nav
      className="mobile-only"
      style={{
        position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 150,
        display: "flex", background: WH, borderTop: `1px solid ${BD}`,
        paddingBottom: "env(safe-area-inset-bottom)",
        boxShadow: "0 -2px 12px rgba(0,0,0,.06)",
      }}
    >
      {navItems.map(item => (
        <NavButton
          key={item.key}
          icon={item.icon}
          label={item.label}
          badge={item.badge}
          active={currentRoute === item.route}
          onClick={() => onNavigate(item.route)}
        />
      ))}
      <NavButton icon="grip" label="Mer" active={false} onClick={onOpenMore} />
    </nav>
  );
}

// ── AppShell ─────────────────────────────────────────────────────────────
// Den sammansatta strukturen från strategins avsnitt 4 (layoutdiagrammet):
// Sidebar (desktop) + Topbar + innehållsyta, ELLER Topbar + innehåll +
// MobileNav (mobil). Detta ÄR i praktiken samma struktur AppInner redan
// har idag (showSidebar-villkoret, sidan-renderas-i-mitten-mönstret) —
// AppShell formaliserar den strukturen som en egen, namngiven komponent
// istället för att den ligger utspridd inuti den stora AppInner-
// funktionen, vilket gör den lättare att resonera om och testa separat
// när Fas 5+ börjar flytta enskilda vyer hit.
//
// children = den aktiva sidans innehåll (dvs. det som idag renderas av
// den stora routing-switchen i AppInner, oförändrat).
export function AppShell({
  children, isMobile, currentUser, sidebar, currentRoute, onNavigate,
  onOpenMore, isAdmin, can, cartCount, trashCount,
}) {
  return (
    <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
      {!isMobile && currentUser && (
        <div style={{ width: 220, flexShrink: 0, background: WH, borderRight: `1px solid ${BD}`, overflowY: "auto" }}>
          {sidebar}
        </div>
      )}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
        {children}
        {isMobile && currentUser && (
          <MobileNav
            currentRoute={currentRoute}
            onNavigate={onNavigate}
            onOpenMore={onOpenMore}
            isAdmin={isAdmin}
            can={can}
            cartCount={cartCount}
            trashCount={trashCount}
          />
        )}
      </div>
    </div>
  );
}
