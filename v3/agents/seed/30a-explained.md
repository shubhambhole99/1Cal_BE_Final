# Reg 30(A) — Explained (1cal model ↔ DCPR 2034 Table 12)

Source model: 1cal instance `71b3b107fae9ae647f4d1338` (sheets Area_30A, Costing_30A, Financials_30A).
Cross-checked against: **DCPR 2034, Regulation 30, TABLE NO. 12** (Floor Space Indices). The model reproduces the table **exactly**.

---

## 1. What 30(A) computes (the flow)

```
Plot Area
  − Reg 14(A) amenity deduction (on Gross Plot − Road Setback)
  − other deductions
  = Balance after deductions
  − Road Setback (handed to MCGM)
  = NET PLOT AREA   ← all 30(A) FSI is computed on this
        │
        ▼
  FSI build-up on Net Plot:
     a) Zonal (Basic) FSI
   + b) Additional FSI on payment of premium   ← road-width & city/suburb driven
   + c) TDR                                     ← road-width & city/suburb driven
   = d) TOTAL FSI               (= DCPR Table 12 "Permissible FSI" = 4+5+6)
   + e) Incentive for Road Setback (2× / 2.5× setback area)
   = f) TOTAL PERMISSIBLE BUA
   − g) Less existing BUA
   = h) Area for Sale  (+ 35% fungible) = Saleable BUA
```

Net plot in this instance = **1,900 m²** (2,000 plot − 100 setback; deductions 0).

---

## 2. Additional FSI & TDR — the tables (what actually drives 30A)

These two factors are multiplied by **net plot area** and are the only road-width / location-sensitive pieces.

### Additional FSI on payment of premium  (× net plot)
| Access road width | Island City | Suburbs & Extended Suburbs |
|---|---|---|
| less than 9 m | 0 | 0 |
| 9 m – under 12 m | **0.50** | **0.50** |
| 12 m – under 18 m | **0.62** | **0.50** |
| 18 m – under 27 m | **0.73** | **0.50** |
| 27 m and above | **0.84** | **0.50** |

### Admissible TDR  (× net plot)
| Access road width | Island City | Suburbs & Extended Suburbs |
|---|---|---|
| less than 9 m | 0 | 0 |
| 9 m – under 12 m | **0.17** | **0.50** |
| 12 m – under 18 m | **0.45** | **0.70** |
| 18 m – under 27 m | **0.64** | **0.90** |
| 27 m and above | **0.83** | **1.00** |

### Zonal (Basic) FSI
| | Island City | Suburbs |
|---|---|---|
| Basic FSI | **1.33** | **1.00** |

### ⇒ Total permissible FSI (Zonal + Additional + TDR) — DCPR Table 12 col 7
| Access road width | Island City | Suburbs |
|---|---|---|
| < 9 m | 1.33 | 1.00 |
| 9 – <12 m | 2.00 | 2.00 |
| 12 – <18 m | 2.40 | 2.20 |
| 18 – <27 m | 2.70 | 2.40 |
| ≥ 27 m | 3.00 | 2.50 |

---

## 3. The exact formulas (from the model, Area_30A)

Road width = `C11` (= ParametersOne!B9). City/Suburb = `C12` (= ParametersOne!J5).

**Additional FSI** (`Area_30A!C20`):
```
=IF(C12="City",
     IF(C11<9, 0, IF(C11<12, 0.5,  IF(C11<18, 0.62, IF(C11<27, 0.73, 0.84)))),
   IF(C12="Suburb",
     IF(C11<9, 0, IF(C11<12, 0.5,  IF(C11<18, 0.5,  IF(C11<27, 0.5,  0.5)))),
   "Invalid Input"))
```

**TDR** (`Area_30A!C21`):
```
=IF(C12="City",
     IF(C11<9, 0, IF(C11<12, 0.17, IF(C11<18, 0.45, IF(C11<27, 0.64, 0.83)))),
   IF(C12="Suburb",
     IF(C11<9, 0, IF(C11<12, 0.5,  IF(C11<18, 0.7,  IF(C11<27, 0.9,  1)))),
   "Invalid Input"))
```

**Zonal / Basic** (`C19`): `=IF(C12="City", 1.33, 1)`
**Each factor → area**: `D = factor × NetPlot (D10)`
**Total FSI (d)** (`D22`): `= D19 + D20 + D21` (Zonal + Additional + TDR areas)
**Road-setback incentive (e)** (`D23`): `=IF(City, 2.5×Setback, 2×Setback)`  (added as BUA)
**Total Permissible BUA (f)** (`D24`): `= D22 + D23`

> Bracket logic: `<9` → none; `9–<12`; `12–<18`; `18–<27`; `≥27`. A road of **exactly 18 m** falls in the **18–<27** bracket.

---

## 4. How it changes — road width & city/suburb

- **Road width** is the main lever:
  - **< 9 m** → no premium FSI, no TDR. You get only Basic (1.33 city / 1.0 suburb).
  - Each wider band unlocks more **TDR** (both regions) and, in the **City**, more **Additional FSI** too.
  - Suburb **Additional FSI is flat 0.50** above 9 m — only TDR grows with road width (0.5 → 0.7 → 0.9 → 1.0).
- **City vs Suburb**:
  - City has a higher base (1.33 vs 1.0) **and** a road-scaling Additional FSI (up to 0.84) → tops out at **3.0 FSI**.
  - Suburb tops out at **2.5 FSI**.
  - City also gets a richer road-setback incentive: **2.5× setback** vs **2× setback** in suburbs.

---

## 5. Worked example (this instance — Suburb, 18 m road, net plot 1,900 m²)

| Item | Factor | Area (m²) |
|---|---|---|
| a) Zonal (Suburb) | 1.00 | 1,900 |
| b) Additional FSI | 0.50 | 950 |
| c) TDR (18–<27) | 0.90 | 1,710 |
| **d) Total FSI = 2.40** | | **4,560** |
| e) Road-setback incentive (2 × 100) | | 200 |
| **f) Total Permissible BUA (FSI ≈ 2.51)** | | **4,760** |
| g) Less existing BUA | | −1,200 |
| h) Area for Sale | | 3,560 |
| i) + Fungible 35% | | +1,246 |
| **Saleable BUA** | | **4,806** |

---

## 6. Beyond the table (other provisions the model layers on)
- **Reg 14(A) deduction**: `IF((Plot−Setback)<4000 → 0; 4000–10000 → 5%; >10000 → 500 + 10% of excess)`.
- **BUA from Carpet**: Carpet × **1.20** (20% loading) = BUA.
- **Fungible Compensatory Area**: **35%** of entitlement/sale BUA (DCPR — residential up to 35%).
- **Construction area**: BUA × **1.5** loading (Costing_30A) → drives construction cost.
- Premiums (Costing): Fungible premium, Additional-FSI premium, TDR (General 80% + Slum 20%) cost, plus scrutiny/IOD/debris/open-space/staircase/dev-charges/CFO/NOC/LUC etc.

**Conclusion:** the 1cal 30(A) sheet is a faithful, line-by-line implementation of DCPR 2034 Table 12 / Reg 30, extended with 14A, fungible, road-setback incentive, and the full premium + cashflow build-up.

---

## 7. Worked example — OUR Juhu plot (CTS 777, step-7 params)

Inputs: Plot **1,235.9 m²**, Road **60.4 m**, **Mumbai Suburb**, Existing BUA **1,235.9**, Carpet **1,029.92**, setback 0, deductions 0 → Net plot **1,235.9 m²**.

Road 60.4 m ≥ 27 m → **top suburb bracket**:

| Component | Factor | Area (m²) |
|---|---|---|
| a) Zonal (Suburb) | 1.0 | 1,235.9 |
| b) Additional FSI | 0.5 | 617.95 |
| c) TDR (≥27 m suburb) | **1.0** | 1,235.9 |
| **Total FSI = 2.5** | | **3,089.75** |
| e) Road-setback incentive (2 × 0) | | 0 |
| **Permissible BUA** | | **3,089.75** |
| − Existing BUA | | −1,235.9 |
| Area for Sale | | 1,853.85 |
| + 35% fungible (×1.35) | | → **2,502.70** saleable BUA |

Loading ladder: Carpet **1,029.92** ×1.2 = BUA **1,235.9** ×1.5 = Construction **1,853.86**.

> Note: for a 60.4 m road the suburb **TDR is 1.0** (the 0.9 / 0.5 values are the 18–27 m and 9–12 m bands). That is what makes the total exactly **2.5**.
