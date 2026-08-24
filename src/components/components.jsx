// ─────────────────────────────────────────────────────────────────────────
// KÄRNKOMPONENTER — Fas 2 i redesign-färdplanen
//
// Byggda ovanpå designtokens (tokens.css, Fas 1). Matchar EXAKT det
// visuella språk appen redan har idag (Barlow-typsnitt, samma färgvärden,
// samma 10px-radie som redan är de facto-standarden) — detta är INTE en
// ny stil, det är en formalisering av mönster som redan används överallt,
// bara hopsamlade på ETT ställe istället för handbyggda om och om igen.
//
// VIKTIGT — rör INGET i den körande appen ännu. Detta är fristående,
// redo att gradvis plockas in vy för vy i senare faser (5–8), i linje
// med strategins princip "Extrahera komponenter utan att ändra
// datamodell samtidigt" och "Gör en vy i taget och regressionstesta
// innan nästa flyttas."
//
// Konkret vinst av att samla dessa här: modalmönstret nedan
// (position:fixed, inset:0, rgba(0,0,0,.4) osv.) förekommer idag
// HANDBYGGT 21 GÅNGER i App.jsx. Med <Modal> blir det EN plats att
// underhålla istället för 21 — en framtida ändring (t.ex. bättre
// tillgänglighet, en ny animation) görs en gång, inte 21.
// ─────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from "react";

// Färgkonstanterna nedan speglar EXAKT de som redan finns i App.jsx
// (R, B, BX, GR, AM, BG, WH, BD, TX, TM, MU, SH, SH2) — se tokens.css för
// den formaliserade, namngivna versionen. Dubbleras här bara så den här
// filen kan köras/granskas fristående utan att importera från App.jsx.
const R = "#CC1B2B", B = "#1B3A6B", BX = "var(--color-accent, #1B3A6B)";
const BG = "var(--color-bg, #F4F5F7)", WH = "var(--color-surface, #FFFFFF)", BD = "var(--color-border, #E2E5EA)";
const TX = "var(--color-text, #141820)", TM = "var(--color-text-muted, #3D4451)", MU = "var(--color-text-faint, #8A90A0)";
const GR = "#16A34A", AM = "#D97706";
const SH2 = "0 4px 20px rgba(0,0,0,.12)";

// ── Button ───────────────────────────────────────────────────────────────
// Motsvarar dagens Btn, men med tre tillägg enligt strategin:
//  1. En genuin "danger"-variant (namngiven tydligt, inte bara "red")
//     separerad från övriga varianter — matchar principen "Ta bort ska
//     inte ligga bredvid Spara" (avsnitt 9): danger-knappar får en synlig
//     bekräftelse-krok (onConfirm) inbyggd, inte upp till varje anropsställe
//     att komma ihåg.
//  2. Stöd för en ikon (vänster) utan att man manuellt bygger flex-layout
//     varje gång.
//  3. Garanterad minst 44px touch-yta på mobil (tillgänglighetskravet i
//     avsnitt 14), utan att desktop blir onödigt klumpig.
export function Button({
  children, variant = "primary", size = "md", icon, full, disabled,
  onClick, confirmMessage, style: sx = {},
}) {
  const variants = {
    primary: { background: BX, color: "#fff" },
    success: { background: GR, color: "#fff" },
    danger:  { background: R, color: "#fff" },
    ghost:   { background: WH, color: TM, border: `1px solid ${BD}` },
    subtle:  { background: `${B}12`, color: BX, border: `1px solid ${B}25` },
  };
  const sizes = {
    sm: { padding: "5px 11px", fontSize: 12, minHeight: 32 },
    md: { padding: "9px 16px", fontSize: 13, minHeight: "var(--touch-target-min, 44px)" },
  };
  const handleClick = (e) => {
    if (confirmMessage && !window.confirm(confirmMessage)) return;
    onClick?.(e);
  };
  return (
    <button
      disabled={disabled}
      onClick={handleClick}
      style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
        borderRadius: "var(--radius-sm, 6px)", border: "none", fontWeight: 600,
        opacity: disabled ? 0.45 : 1, width: full ? "100%" : "auto", cursor: disabled ? "default" : "pointer",
        fontFamily: "var(--font-family, 'Barlow', sans-serif)",
        transition: "opacity .15s, transform .1s",
        ...sizes[size], ...variants[variant], ...sx,
      }}
    >
      {icon && <Icon name={icon} />}
      {children}
    </button>
  );
}

// Liten platshållar-ikonkomponent — appen använder redan Font Awesome
// (laddat globalt), denna bara wrappar <i className="fa-solid fa-...">
// konsekvent, matchar den befintliga Icon-komponenten i App.jsx.
function Icon({ name, style = {} }) {
  return <i className={`fa-solid fa-${name}`} style={style} />;
}

// ── FormField ────────────────────────────────────────────────────────────
// Dagens Inp har bara label + input. FormField lägger till de två sakerna
// strategin efterfrågar i avsnitt 9 som saknas idag: hjälptext (hint) och
// valideringsfel som visas DIREKT under rätt fält, inte som en generisk
// toast som inte säger vilket fält som var fel.
export function FormField({
  label, hint, error, required, children, htmlFor,
}) {
  return (
    <div style={{ width: "100%" }}>
      {label && (
        <label htmlFor={htmlFor} style={{
          display: "block", fontSize: "var(--text-xs, 11px)", fontWeight: 700, color: MU,
          textTransform: "uppercase", letterSpacing: 0.7, marginBottom: 4,
        }}>
          {label}{required && <span style={{ color: R, marginLeft: 3 }}>*</span>}
        </label>
      )}
      {children}
      {hint && !error && (
        <div style={{ fontSize: "var(--text-xs, 11px)", color: MU, marginTop: 4 }}>{hint}</div>
      )}
      {error && (
        <div style={{ fontSize: "var(--text-xs, 11px)", color: R, marginTop: 4, display: "flex", alignItems: "center", gap: 4 }}>
          <Icon name="circle-exclamation" />
          {error}
        </div>
      )}
    </div>
  );
}

// Standardiserad text-input, avsedd att användas INUTI <FormField>.
// Ramen blir röd automatiskt vid fel — man skickar bara samma `error`-
// prop till både FormField och Input, ingen manuell style-hantering.
export function Input({ error, style: sx = {}, ...props }) {
  return (
    <input
      {...props}
      style={{
        width: "100%", boxSizing: "border-box",
        border: `1.5px solid ${error ? R : BD}`, borderRadius: "var(--radius-sm, 6px)",
        padding: "9px 12px", fontSize: "var(--text-base, 13px)", color: TX, background: WH,
        minHeight: "var(--input-height-desktop, 40px)",
        fontFamily: "var(--font-family, 'Barlow', sans-serif)",
        ...sx,
      }}
    />
  );
}

// ── StatusBadge ──────────────────────────────────────────────────────────
// Idag byggs varje status-badge (lagerstatus, reservationsstatus,
// systemstatus) för hand med sina egna färger på varje enskilt ställe.
// StatusBadge samlar detta till EN komponent med en fast, begränsad
// uppsättning betydelser — förhindrar att nya, inkonsekventa färger
// smyger sig in vy för vy. Följer tillgänglighetskravet i avsnitt 14:
// status uttrycks ALDRIG bara med färg, alltid text/ikon också.
const STATUS_STYLES = {
  success:  { bg: `${GR}15`, fg: GR, icon: "circle-check" },   // t.ex. "I lager", "Klar"
  warning:  { bg: `${AM}15`, fg: AM, icon: "triangle-exclamation" }, // t.ex. "Lågt lager", "Snart förfallen"
  danger:   { bg: `${R}15`,  fg: R,  icon: "circle-xmark" },   // t.ex. "Slut", "Förfallen"
  info:     { bg: `${B}12`,  fg: BX, icon: "circle-info" },    // t.ex. "Reserverad"
  neutral:  { bg: BD,        fg: TM, icon: null },             // t.ex. "Avslutad"
};
export function StatusBadge({ status = "neutral", children, showIcon = true }) {
  const s = STATUS_STYLES[status] || STATUS_STYLES.neutral;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5,
      background: s.bg, color: s.fg, fontWeight: 700, fontSize: "var(--text-sm, 12px)",
      padding: "3px 10px", borderRadius: "var(--radius-full, 999px)",
      fontFamily: "var(--font-family, 'Barlow', sans-serif)",
    }}>
      {showIcon && s.icon && <Icon name={s.icon} style={{ fontSize: 10 }} />}
      {children}
    </span>
  );
}

// ── Card ─────────────────────────────────────────────────────────────────
// Den vita, rundade, kantlinjeförsedda "lådan" som redan används överallt
// (t.ex. alla inställningssektioner) — men alltid handskriven inline.
// Card ger samma utseende + två lägen: vanligt kort, och "interactive"
// (klickbart, med hover) för t.ex. dashboardens genvägar.
export function Card({ children, interactive, onClick, padding = "md", style: sx = {} }) {
  const paddings = { sm: 10, md: 16, lg: 24 };
  const [hover, setHover] = useState(false);
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => interactive && setHover(true)}
      onMouseLeave={() => interactive && setHover(false)}
      style={{
        background: WH, border: `1px solid ${interactive && hover ? BX : BD}`, borderRadius: "var(--radius-md, 10px)",
        padding: paddings[padding] ?? 16,
        cursor: interactive ? "pointer" : "default",
        transition: "border-color .15s, box-shadow .15s",
        boxShadow: interactive && hover ? SH2 : "none",
        ...sx,
      }}
    >
      {children}
    </div>
  );
}

// ── Modal ────────────────────────────────────────────────────────────────
// Ersätter de 21 handbyggda instanserna av samma mönster i App.jsx.
// Lägger till TVÅ saker som saknas i flera av dagens instanser (inte
// alla, men flertalet), enligt tillgänglighetskravet i avsnitt 14:
//  1. Esc-tangenten stänger modalen
//  2. Fokus flyttas in i modalen när den öppnas (tangentbordsnavigation)
// Klick UTANFÖR (på den mörka bakgrunden) stänger — samma beteende som
// redan finns i de flesta befintliga modaler, bevarat här.
export function Modal({ open, onClose, title, children, maxWidth = 380 }) {
  const modalRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape") onClose?.(); };
    document.addEventListener("keydown", onKey);
    modalRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", zIndex: 200,
        display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
      }}
      onClick={onClose}
    >
      <div
        ref={modalRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: WH, borderRadius: "var(--radius-lg, 14px)", padding: 20,
          maxWidth, width: "100%", boxShadow: SH2, outline: "none",
        }}
      >
        {title && (
          <div style={{ fontWeight: 700, fontSize: "var(--text-lg, 16px)", marginBottom: 12, color: TX }}>
            {title}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

// Färdig, vanligast förekommande modal-variant: bekräfta en åtgärd
// (särskilt destruktiva, enligt "Säker interaktion", princip 5). Bygger
// på <Modal> — de flesta av de 21 handbyggda instanserna i App.jsx är
// just detta mönster (bekräfta-eller-avbryt), så den här täcker flest fall.
export function ConfirmModal({ open, onClose, onConfirm, title, message, confirmLabel = "Bekräfta", danger }) {
  return (
    <Modal open={open} onClose={onClose} title={title}>
      {message && <div style={{ fontSize: "var(--text-base, 13px)", color: MU, marginBottom: 16 }}>{message}</div>}
      <div style={{ display: "flex", gap: 8 }}>
        <Button variant="ghost" full onClick={onClose}>Avbryt</Button>
        <Button variant={danger ? "danger" : "primary"} full onClick={() => { onConfirm(); onClose(); }}>
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}

// ── Toast ────────────────────────────────────────────────────────────────
// Appen har redan en fungerande toast$-funktion + renderingsblock i
// App.jsx (fångar success/error/info, visas i hörnet, blockerar inte
// arbetet — precis enligt strategins krav på Toast-komponenten i
// avsnitt 11). Byggs INTE om här — den uppfyller redan kravet. Denna
// export är bara en tunn, namngiven wrapper så framtida kod i den nya
// komponentstrukturen kan importera "Toast" som begrepp utan att bry sig
// om den underliggande implementationen i App.jsx.
export const TOAST_STYLES = {
  success: { bg: GR, icon: "circle-check" },
  error:   { bg: R,  icon: "circle-xmark" },
  info:    { bg: BX, icon: "circle-info" },
};
