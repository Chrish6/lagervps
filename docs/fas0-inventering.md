# Fas 0 — Inventering av nuvarande vyer och funktioner

Genomgång av samtliga 33 registrerade sidor i appen. Frekvens och prioritet är bedömd utifrån hur systemet faktiskt används dagligen (Halmstad/Laholm, sälj/lager-personal, admin/platsadmin).

## Teckenförklaring
- **Frekvens**: Daglig / Vecka / Sällan
- **Målgrupp**: Alla / Lager / Sälj / Admin / Huvudadmin
- **Redesign-prioritet**: matchar färdplanens faser (0 = ingen förändring behövs ännu)

---

## A. Kärnarbetsflöde — högst prioritet i redesignen

| Sida | Syfte | Frekvens | Målgrupp | Fas |
|---|---|---|---|---|
| `InventoryPage` | Huvudlagerlistan — sök, filter, bläddra | Daglig | Alla | Fas 5 |
| `DetailPage` | Enskild dels sida — visa, sälj, reservera, redigera | Daglig | Alla | Fas 6 |
| `ScanPage` | QR/streckkodsskanning | Daglig | Lager | Fas 6 |
| `SellPage` | Sälj en specifik del direkt | Daglig | Sälj | Fas 7 |
| `CheckoutPage` | Kassa — flera delar i en försäljning | Daglig | Sälj | Fas 7 |
| `ReceiptPage` | Kvitto efter försäljning | Daglig | Sälj | Fas 7 |
| `ReservationsPage` | Aktiva reservationer, arbetskö | Daglig | Lager/Sälj | Fas 7 |
| `VariantsPage` | Flera exemplar av samma artikel | Vecka | Alla | Fas 6 |
| `DashboardPage` | Översikt vid inloggning | Daglig | Alla | Fas 4 |

## B. Platshantering — byggt nyligen, redan modernt mönster

| Sida | Syfte | Frekvens | Målgrupp | Fas |
|---|---|---|---|---|
| `LocationViewPage` | Platser — vad finns var, flytta, byt namn | Vecka | Lager | Fas 5 (redan nära målbild) |
| `NoLocationPage` | Delar utan tilldelad plats | Vecka | Lager | Fas 5 |
| `MissingItemsPage` | Borttappade delar | Sällan | Lager | Fas 5 |
| `LocationQrLabelsPage` | Bulk-utskrift QR för platser | Sällan | Lager/Admin | Fas 8 |
| `QrLabelsPage` | QR-etiketter för delar | Sällan | Lager/Admin | Fas 8 |

**Notering:** Platser-modulen byggdes senast i vårt arbete och har redan flera mönster som matchar strategin (väljläge, tydliga tomma-lägen, inline-redigering). Bra referenspunkt för hur övriga listor bör kännas efter redesign.

## C. Redigering och massoperationer

| Sida | Syfte | Frekvens | Målgrupp | Fas |
|---|---|---|---|---|
| `EditPage` | Lägg till / redigera en del | Daglig | Lager/Admin | Fas 6 (formulär-principer, avsnitt 9) |
| `FilterPage` | Filtrera lagerlistan | Daglig | Alla | Fas 5 |
| `BulkEditPage` | Massredigera flera delar | Vecka | Lager/Admin | Fas 5 |
| `ImportPage` | Importera delar (Excel/CSV) | Sällan | Admin | Fas 8 |
| `TrashPage` | Papperskorg, återställ borttaget | Vecka | Admin | Fas 8 |

## D. Kunder, leverantörer, försäljningshistorik

| Sida | Syfte | Frekvens | Målgrupp | Fas |
|---|---|---|---|---|
| `CustomersPage` | Kundregister | Vecka | Sälj/Admin | Fas 8 |
| `SuppliersPage` | Leverantörsregister | Sällan | Admin | Fas 8 |
| `SalesLogPage` | Försäljningshistorik, sök gamla köp | Vecka | Sälj/Admin | Fas 8 |
| `ReportsPage` | Lagervärde, nyckeltal | Vecka | Admin | Fas 8 |
| `ActivityLogPage` | Vem gjorde vad-logg | Sällan | Admin | Fas 8 |

## E. Administration — konton, roller, behörigheter

| Sida | Syfte | Frekvens | Målgrupp | Fas |
|---|---|---|---|---|
| `UsersPage` | Lista användare | Sällan | Huvudadmin/Platsadmin | Fas 8 |
| `EditUserPage` | Skapa/redigera användare | Sällan | Huvudadmin/Platsadmin | Fas 8 |
| `PermsPage` | Enskild användares specialbehörigheter | Sällan | Huvudadmin | Fas 8 |
| `RolesPage` | Lista roller | Sällan | Huvudadmin | Fas 8 |
| `EditRolePage` | Redigera en rolls behörigheter | Sällan | Huvudadmin | Fas 8 |
| `ProfilePage` | Egen profil, lösenord, notisinställning | Vecka | Alla | Fas 8 |

## F. Systeminställningar — sällan besökta, men kritiska när de behövs

| Sida | Syfte | Frekvens | Målgrupp | Fas |
|---|---|---|---|---|
| `SettingsPage` | Företagsuppgifter, marginal, valuta | Sällan | Huvudadmin | Fas 8 |
| `ManageListsPage` | Kategorier, platstyper m.m. | Sällan | Huvudadmin | Fas 8 |
| `MenuLayoutPage` | Anpassa menyns utseende | Sällan | Huvudadmin | Fas 8 |
| `KgkPage` | KGK-integration (fordonsdata) | Sällan | Huvudadmin | Fas 8 |
| `EmailNotifyPage` | E-postkonfiguration (Gmail) | Sällan | Huvudadmin | Fas 8 |
| `BackupPage` | Backup/återställning | Sällan, men KRITISK | Huvudadmin | Fas 8 — **extra försiktighet**, rör känslig drift |

## G. Inloggning

| Sida | Syfte | Frekvens | Målgrupp | Fas |
|---|---|---|---|---|
| `LoginPage` | Inloggning | Daglig (per session) | Alla | Fas 3 (App Shell) |

---

## Sällan använda funktioner som INTE bör prioriteras tidigt
Baserat på faktisk användningshistorik i vårt arbete tillsammans:
- `KgkPage`, `EmailNotifyPage`, `MenuLayoutPage` — konfigureras en gång, rörs sällan igen
- `ImportPage` — används vid större engångsimporter, inte löpande
- `ActivityLogPage` — mest för felsökning i efterhand

## Funktioner som redan fungerar bra och inte bör "fixas i onödan"
- **Platser-modulen** (avsnitt B ovan) — redan byggd med moderna mönster (väljläge, naturlig sortering, tydlig tomma-tillstånd). Bör användas som **referens** för hur resten av listorna ska kännas, snarare än att byggas om från grunden.
- **Globalt sparskydd** (helskärmsspärr vid alla skriv-anrop) — redan konsekvent implementerat på den lägsta nivån, gäller automatiskt överallt.

## Kritiska affärsregler att aldrig tappa under redesignen
Dessa måste fungera identiskt efter varje enskild vy flyttas till ny struktur:
1. Multi-lager-behörighet (platsadmin ser/redigerar bara sitt eget lager, huvudadmin ser allt)
2. Lagernummer-sekvens per lager (Laholm = LH-prefix, Halmstad = ren siffra)
3. Regnummer ELLER kundnamn krävs (minst ett) vid sälj/reservera
4. Anonym försäljning skapar aldrig en kundpost
5. Korsvis-lager-mejl (opt-in per användare i profilen)
6. Globalt sparskydd får aldrig kringgås av en ny komponent som glömmer koppla in sig

---

*Nästa steg: Fas 1 — designtokens (färger, typografi, spacing, radius, skuggor) baserat på de färgkonstanter som redan finns i koden idag.*
