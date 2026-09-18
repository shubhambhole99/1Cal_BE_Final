# DCPR 2034 Scheme Selection Decision Logic

## Complete Decision Tree

### Level 1: Land Title

```
Land Title?
├── MHADA ──────────────→ Go to MHADA Branch
├── Private ─────────────→ Go to Private Branch
├── Government/MCGM ─────→ Go to Government Branch
└── SRA/Slum ────────────→ Go to Slum Branch
```

### MHADA Branch

```
MHADA Land:
├── Primary: 33(5) — MHADA Development/Redevelopment
│   ├── FSI: 3.0 on gross plot
│   ├── If plot ≥ 4000 sqm AND road ≥ 18m → can go to 4.0 FSI (with Govt approval)
│   └── At least 60% BUA must be EWS/LIG/MIG
├── Alternative (Island City only, if cessed): 33(7) — Cessed Building
│   ├── Buildings must exist prior to 30/09/1969
│   └── FSI: 3.0 on gross plot
└── If cluster eligible (plot ≥ 4000/6000 sqm): 33(9) — Cluster Development
    ├── FSI: 4.0 on gross plot
    └── Requires 18m road (or 12m dead-end near 18m)
```

### Private Branch

```
Private Land:
├── Cess Tenants (buildings assessed under MHAD Act)?
│   ├── Island City → 33(7) — Cessed Building Redevelopment
│   │   ├── FSI: 3.0 on gross plot
│   │   └── MHADA gets prescribed share of surplus
│   ├── Suburbs/Extended → 33(7A) — Dilapidated Building
│   │   ├── FSI: As per Reg 30(A) Table 12 (road-width dependent)
│   │   └── Must be dilapidated/unsafe OR 30+ years old
│   └── Combo for 4.0 FSI:
│       ├── 30(A) + 33(7A) + 33(12B) — with PAP re-accommodation
│       └── 30(A) + 33(7A) + 33(20B) — with Affordable Housing
│
├── Non-Cess Tenants?
│   ├── Primary: 33(7A) — Dilapidated Building
│   │   ├── Suburbs/Extended: tenant-occupied buildings
│   │   └── City: non-cessed tenant-occupied buildings
│   └── Combo for 4.0 FSI: same as above
│
├── Housing Society Members?
│   ├── Primary: 33(7B) — Society Redevelopment
│   │   ├── FSI: As per Reg 30(A) Table 12
│   │   ├── Must be 30+ years old
│   │   └── Incentive: 15% of existing BUA or 10 sqm/tenement (whichever more)
│   └── Combo for 4.0 FSI:
│       ├── 30(A) + 33(7B) + 33(12B)
│       └── 30(A) + 33(7B) + 33(20B)
│
├── Slum Dwellers on Private Land?
│   ├── Primary: 33(10) — SRA Slum Rehabilitation
│   └── If cluster eligible: 33(9)
│
├── No Tenants (Vacant)?
│   ├── If CBD/Commercial zone: 33(19) — CBD Commercial FSI (up to 5.0)
│   ├── If want transit camp revenue: 33(11) — PTC
│   └── If want AH on private land: 33(20B)
│
└── PAP/Project Affected?
    └── Primary: 33(12B) — Tolerated Structure Re-accommodation
```

### Government Branch

```
Government/MCGM Land:
├── For AH/R&R (Affordable Housing / Rehabilitation & Resettlement):
│   └── 33(20A) — AH on Govt land
│       ├── Plot ≤ 2000 sqm + 12m road: up to 3.0 FSI
│       └── Plot > 2000 sqm + 18m road: up to 4.0 FSI
├── For Transit Camp construction:
│   └── 33(11) — PTC
│       ├── FSI up to 4.0
│       └── 63/37 or 50/50 PTC/Sale split
└── If MCGM leasehold with slum:
    └── 33(10) via SRA
```

### Slum Branch

```
SRA/Slum Land:
├── Standard: 33(10) — Slum Rehabilitation
│   ├── FSI: up to 4.0
│   ├── Rehab: 27.88 sqm per eligible hutment dweller
│   └── Approved by SRA (CEO)
├── Dharavi specifically: 33(10A) — Dharavi Notified Area
│   └── Special provisions under DRP
├── If cluster eligible: 33(9) — Cluster Development
└── High density: 33(10) with density-based calculation
    └── 650/hectare density → determines rehab count
```

## Cluster Eligibility Check (33(9))

Cluster development can apply across ANY land title when these conditions are met:

| Condition | City (Island City) | Suburbs / Extended Suburbs |
|-----------|-------------------|---------------------------|
| Min Plot Area | ≥ 4,000 sqm | ≥ 6,000 sqm |
| Min Road Width | ≥ 18m (or 12m dead-end within 50m of 18m road) | Same |
| Building Mix | Can include cess + non-cess + slum + govt structures | Same |
| FSI | 4.0 on gross plot | 4.0 on gross plot |

Cluster allows mixed tenure — MHADA + private + slum plots can all be combined in one CDS.

## Combo Scheme Logic (Reaching 4.0 FSI on Private Land)

When 30(A) base FSI (typically 2.7 for 27m road) isn't enough:

| Combo | Base | Overlay | Cap | Developer Sale | Authority Share |
|-------|------|---------|-----|---------------|-----------------|
| 30(A)+7A+12B | 30(A) FSI + 70% rehab incentive | 33(12B) PAP | 4.0 | 1/3 of overlay FSI | 2/3 PAP tenements to MCGM |
| 30(A)+7A+20B | 30(A) FSI + 70% rehab incentive | 33(20B) AH | 4.0 | 37% of overlay FSI | 63% AH tenements to MCGM |
| 30(A)+7B+12B | 30(A) FSI + 7B incentive | 33(12B) PAP | 4.0 | 1/3 of overlay FSI | 2/3 PAP tenements to MCGM |
| 30(A)+7B+20B | 30(A) FSI + 7B incentive | 33(20B) AH | 4.0 | 37% of overlay FSI | 63% AH tenements to MCGM |

The overlay FSI = 4.0 - (30A base + rehab incentive consumption). The authority share generates PAPs or AH tenements that must be constructed and handed over free.

## Eligibility Formulas (for Excel implementation)

```
33(5):  Land=MHADA AND (City OR Suburbs OR Extended)
33(7):  Tenant=Cess AND Location=City
33(7A): (Tenant=Non-Cess OR (Tenant=Cess AND Location≠City)) AND (Age≥30 OR Dilapidated=Yes)
33(7B): Tenant=Housing Society AND Age≥30
33(9):  ((City AND Plot≥4000) OR (Suburbs AND Plot≥6000)) AND Road≥12
33(10): Tenant=Slum Dweller
33(11): Road≥12 AND Zone≠CBD (any non-reserved/SDZ land)
33(12B): Tenant=PAP/Project Affected
33(19): (Zone=CBD OR Zone=Commercial OR Zone=Residential) AND Tenant=None
33(20B): Land=Private AND Road≥12
Combos: Base scheme eligible AND Road≥12
```

## Entitlement Conversion (Carpet → BUA → Total BUA → MOFA)

Standard conversion pipeline:
  Entitlement Carpet → ×1.2 (BUA) → ×1.35 (Total BUA with fungible) → ÷1.2 (MOFA carpet)

Note: Since 1.2 cancels out algebraically, MOFA carpet = Entitlement Carpet × 1.35 (shortcut).
The BUA steps matter for FSI consumption tracking; the MOFA is what the tenant receives.

### 33(5) MHADA Entitlement
- IF existing ≥ 35 sqm: Entitlement Carpet = carpet × (1 + 35% + layout%)
- IF existing < 35 sqm: bumped to 35 sqm, gets ONLY layout% (NOT 35%)
- Layout%: 0% (<4000 sqm), 15% (4000-2ha), 25% (2-5ha), 35% (5-10ha), 45% (>10ha)
- Then: ×1.2 (BUA) → ×1.35 (Total BUA) → ÷1.2 (MOFA carpet)

### 33(7), 33(7A) Additional by Plot Count
- 1 plot: +5%, 2-5 plots: +8%, 6+ plots: +15%
- Entitlement Carpet = MAX(existing, 27.88) × (1 + additional%)
- Then: ×1.2 (BUA) → ×1.35 (Total BUA) → ÷1.2 (MOFA carpet)

### 33(9) Cluster Additional by Cluster Size
- 4000-5000 sqm: +10%, 5000-1ha: +15%, 1-2ha: +20%, 2-5ha: +25%, 5-10ha: +30%, >10ha: +35%
- Entitlement Carpet = MAX(existing, 27.88) × (1 + cluster%)
- Then: ×1.2 (BUA) → ×1.35 (Total BUA) → ÷1.2 (MOFA carpet)

### Schemes WITHOUT entitlement (all others)
- 33(7B), 33(10), 33(11), 33(12B), 33(19), 33(20B): tenants get fungible on existing area
- Existing carpet → ×1.2 (BUA) → ×1.35 (Total BUA with fungible) → ÷1.2 (MOFA carpet)

## Priority Ranking Logic

When multiple schemes are eligible, rank by:
1. **Highest developer sale area** — schemes that maximize saleable BUA
2. **Lowest authority sharing** — minimize MHADA/SRA/MCGM handover
3. **Simplest approval process** — fewer authorities involved
4. **Lower premium burden** — less upfront cash outflow

Typical priority (highest to lowest):
- 33(9) Cluster (4.0 FSI, good dev share if LR/RC favorable)
- 33(7) Cessed (3.0 FSI but all surplus to dev after MHADA share)
- 33(7A) + combo (up to 4.0 with PAP/AH overlay)
- 33(10) SRA (4.0 FSI but SRA process complexity)
- 33(11) PTC (good if no tenants, revenue from transit camp)
- 33(20B) AH (4.0 but 63% goes to authority)
- 33(19) CBD (5.0 FSI but commercial only, 50% ASR premium)
