// ─────────────────────────────────────────────────────────────────────────
// calc.js — Delad, ren beräkningslogik för Lager.
//
// Detta är medvetet en EGEN, liten fil separat från App.jsx: den innehåller
// bara rena funktioner (inga React-komponenter, inget UI-tillstånd) så att
// den går att testa automatiskt med `npm test`, utan att starta servern
// eller rendera appen. Kritisk logik som rör pengar (moms, marginal) hör
// hemma här — en bugg i en sådan formel är lätt att missa i en manuell
// koll men fångas direkt av ett test.
//
// Importeras både av App.jsx (för själva appen) och av tests/calc.test.js
// (för de automatiska testerna).
// ─────────────────────────────────────────────────────────────────────────

/**
 * Räknar om ett pris exklusive moms till pris inklusive moms.
 * @param {number} exVat - Pris exkl. moms (kr)
 * @param {number} rate - Momssats, t.ex. 0.25 för 25%
 * @returns {number} Pris inkl. moms, avrundat till närmaste krona
 */
export function exVatToInclVat(exVat, rate = 0.25) {
  const ex = Number(exVat) || 0;
  return Math.round(ex * (1 + rate));
}

/**
 * Räknar om ett pris inklusive moms till pris exklusive moms.
 * @param {number} inclVat - Pris inkl. moms (kr)
 * @param {number} rate - Momssats, t.ex. 0.25 för 25%
 * @returns {number} Pris exkl. moms, avrundat till närmaste krona
 */
export function inclVatToExVat(inclVat, rate = 0.25) {
  const incl = Number(inclVat) || 0;
  return Math.round(incl / (1 + rate));
}

/**
 * Momsbeloppet i kronor för ett pris inklusive moms.
 * @param {number} inclVat - Pris inkl. moms (kr)
 * @param {number} rate - Momssats, t.ex. 0.25 för 25%
 * @returns {number} Momsbelopp i kr, avrundat
 */
export function vatAmount(inclVat, rate = 0.25) {
  const incl = Number(inclVat) || 0;
  return Math.round(incl - incl / (1 + rate));
}

/**
 * Räknar ut vinst för en försäljning: (pris exkl. moms − inköpspris) × antal.
 * @param {number} priceExVat - Försäljningspris exkl. moms per st (kr)
 * @param {number} costPrice - Inköpspris per st, exkl. moms (kr)
 * @param {number} qty - Antal sålda
 * @returns {number} Vinst i kr
 */
export function calcProfit(priceExVat, costPrice, qty = 1) {
  const price = Number(priceExVat) || 0;
  const cost = Number(costPrice) || 0;
  const n = Number(qty) || 0;
  return Math.round((price - cost) * n);
}

/**
 * Räknar ut marginal i procent: vinst / intäkt × 100.
 * Returnerar 0 om intäkten är 0 eller mindre (undviker division med noll).
 * @param {number} revenue - Total intäkt (kr)
 * @param {number} profit - Total vinst (kr)
 * @returns {number} Marginal i procent, avrundad till närmaste heltal
 */
export function calcMargin(revenue, profit) {
  const rev = Number(revenue) || 0;
  const prof = Number(profit) || 0;
  if (rev <= 0) return 0;
  return Math.round((prof / rev) * 100);
}

/**
 * Hittar nästa lediga lagernummer (minsta positiva heltal som inte redan
 * används). Tar hänsyn till BÅDE aktiva artiklar och artiklar i
 * papperskorgen, så ett nummer som väntar på återställning inte kan
 * kapas av en ny artikel.
 * @param {Array<{stockNumber?: string}>} activeItems
 * @param {Array<{stockNumber?: string}>} trashedItems
 * @returns {string} Nästa lediga lagernummer, som sträng
 */
export function nextAvailableStockNumber(activeItems = [], trashedItems = []) {
  const used = new Set(
    [...activeItems, ...trashedItems]
      .map(i => parseInt(i?.stockNumber || "0", 10))
      .filter(n => Number.isFinite(n) && n > 0)
  );
  let n = 1;
  while (used.has(n)) n++;
  return String(n);
}

/**
 * Kontrollerar om ett lagernummer redan är upptaget — antingen av en
 * aktiv artikel eller av en artikel som ligger i papperskorgen.
 * @param {string} stockNumber - Numret att kontrollera
 * @param {Array<{id?: string, stockNumber?: string}>} activeItems
 * @param {Array<{stockNumber?: string}>} trashedItems
 * @param {string} [excludeId] - Id på artikeln som redigeras (undantas från aktiv-kollen)
 * @returns {{ taken: boolean, byTrash: boolean, item?: object }}
 */
export function checkStockNumberTaken(stockNumber, activeItems = [], trashedItems = [], excludeId = null) {
  const sn = (stockNumber || "").trim();
  if (!sn) return { taken: false, byTrash: false };
  const activeMatch = activeItems.find(i => i.id !== excludeId && (i.stockNumber || "").trim() === sn);
  if (activeMatch) return { taken: true, byTrash: false, item: activeMatch };
  const trashMatch = trashedItems.find(t => (t.stockNumber || "").trim() === sn);
  if (trashMatch) return { taken: true, byTrash: true, item: trashMatch };
  return { taken: false, byTrash: false };
}
