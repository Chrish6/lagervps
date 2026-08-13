// ─────────────────────────────────────────────────────────────────────────
// tests/calc.test.js — Automatiska tester för den kritiska beräknings-
// logiken (moms, marginal, lagernummer). Körs med Node.js inbyggda
// testverktyg — inget extra att installera.
//
// Kör alla tester:      npm test
// Kör bara den här:     node --test tests/calc.test.js
//
// Syftet är att fånga regressioner tidigt — om någon framtida ändring av
// t.ex. moms-uträkningen råkar bli fel, ska ett test här misslyckas
// INNAN ändringen når produktion, inte efter.
// ─────────────────────────────────────────────────────────────────────────

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  exVatToInclVat,
  inclVatToExVat,
  vatAmount,
  calcProfit,
  calcMargin,
  nextAvailableStockNumber,
  checkStockNumberTaken,
} from "../src/calc.mjs";

describe("exVatToInclVat — pris exkl. moms → inkl. moms (25%)", () => {
  test("vanligt exempel: 1000 kr exkl. moms → 1250 kr inkl. moms", () => {
    assert.equal(exVatToInclVat(1000), 1250);
  });
  test("0 kr ger 0 kr", () => {
    assert.equal(exVatToInclVat(0), 0);
  });
  test("avrundar till närmaste krona", () => {
    assert.equal(exVatToInclVat(333), 416); // 333*1.25 = 416.25 -> 416
  });
  test("hanterar annan momssats (12%)", () => {
    assert.equal(exVatToInclVat(1000, 0.12), 1120);
  });
  test("tom/ogiltig input ger 0", () => {
    assert.equal(exVatToInclVat(""), 0);
    assert.equal(exVatToInclVat(null), 0);
    assert.equal(exVatToInclVat(undefined), 0);
  });
});

describe("inclVatToExVat — pris inkl. moms → exkl. moms (25%)", () => {
  test("vanligt exempel: 1250 kr inkl. moms → 1000 kr exkl. moms", () => {
    assert.equal(inclVatToExVat(1250), 1000);
  });
  test("0 kr ger 0 kr", () => {
    assert.equal(inclVatToExVat(0), 0);
  });
  test("är (ungefär) inversen av exVatToInclVat för runda tal", () => {
    const ex = 800;
    const incl = exVatToInclVat(ex);
    assert.equal(inclVatToExVat(incl), ex);
  });
});

describe("vatAmount — momsbelopp i kronor", () => {
  test("1250 kr inkl. moms → 250 kr i moms", () => {
    assert.equal(vatAmount(1250), 250);
  });
  test("0 kr ger 0 kr i moms", () => {
    assert.equal(vatAmount(0), 0);
  });
});

describe("calcProfit — vinst per försäljning", () => {
  test("pris 800 kr, inköp 500 kr, 1 st → 300 kr vinst", () => {
    assert.equal(calcProfit(800, 500, 1), 300);
  });
  test("skalar med antal: 2 st ger dubbel vinst", () => {
    assert.equal(calcProfit(800, 500, 2), 600);
  });
  test("negativ vinst (sålt under inköpspris) räknas korrekt", () => {
    assert.equal(calcProfit(400, 500, 1), -100);
  });
  test("saknat inköpspris räknas som 0", () => {
    assert.equal(calcProfit(800, undefined, 1), 800);
  });
});

describe("calcMargin — marginal i procent", () => {
  test("1000 kr intäkt, 250 kr vinst → 25%", () => {
    assert.equal(calcMargin(1000, 250), 25);
  });
  test("0 kr intäkt → 0% (ingen division med noll)", () => {
    assert.equal(calcMargin(0, 100), 0);
  });
  test("negativ intäkt → 0%, inte NaN eller krasch", () => {
    assert.equal(calcMargin(-50, 10), 0);
  });
  test("100% marginal när hela intäkten är vinst", () => {
    assert.equal(calcMargin(500, 500), 100);
  });
});

describe("nextAvailableStockNumber — nästa lediga lagernummer", () => {
  test("tom lista ger nummer 1", () => {
    assert.equal(nextAvailableStockNumber([], []), "1");
  });
  test("hoppar över upptagna nummer i tur och ordning", () => {
    const items = [{ stockNumber: "1" }, { stockNumber: "2" }, { stockNumber: "3" }];
    assert.equal(nextAvailableStockNumber(items, []), "4");
  });
  test("fyller i en lucka mitt i sekvensen", () => {
    const items = [{ stockNumber: "1" }, { stockNumber: "3" }];
    assert.equal(nextAvailableStockNumber(items, []), "2");
  });
  test("tar hänsyn till papperskorgen — kapar INTE ett nummer som väntar där", () => {
    const active = [{ stockNumber: "1" }];
    const trash = [{ stockNumber: "2" }];
    assert.equal(nextAvailableStockNumber(active, trash), "3");
  });
  test("ignorerar ogiltiga/tomma nummer utan att krascha", () => {
    const items = [{ stockNumber: "" }, { stockNumber: "abc" }, { stockNumber: null }];
    assert.equal(nextAvailableStockNumber(items, []), "1");
  });
});

describe("checkStockNumberTaken — kollisionskontroll", () => {
  test("ledigt nummer ger taken:false", () => {
    const r = checkStockNumberTaken("5", [{ id:"a", stockNumber:"1" }], []);
    assert.equal(r.taken, false);
  });
  test("upptaget av aktiv artikel ger taken:true, byTrash:false", () => {
    const r = checkStockNumberTaken("1", [{ id:"a", stockNumber:"1" }], []);
    assert.equal(r.taken, true);
    assert.equal(r.byTrash, false);
  });
  test("upptaget av artikel i papperskorgen ger taken:true, byTrash:true", () => {
    const r = checkStockNumberTaken("7", [], [{ stockNumber:"7", name:"Gammal strålkastare" }]);
    assert.equal(r.taken, true);
    assert.equal(r.byTrash, true);
    assert.equal(r.item.name, "Gammal strålkastare");
  });
  test("den egna artikeln (excludeId) räknas inte som krock mot sig själv", () => {
    const r = checkStockNumberTaken("1", [{ id:"a", stockNumber:"1" }], [], "a");
    assert.equal(r.taken, false);
  });
  test("tomt nummer räknas aldrig som upptaget", () => {
    const r = checkStockNumberTaken("", [{ id:"a", stockNumber:"" }], []);
    assert.equal(r.taken, false);
  });
});
