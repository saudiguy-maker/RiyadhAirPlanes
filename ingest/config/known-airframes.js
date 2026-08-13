/**
 * VERIFIED AIRFRAMES — the only identities in this system that are real.
 *
 * Everything here is sourced from published reporting and public flight
 * tracking. Anything not listed here is left with NULL identifiers rather
 * than filled with a plausible-looking guess, because a fabricated MSN that
 * looks right is worse than an empty field: it silently mis-binds real
 * ADS-B contacts for the life of the airframe.
 *
 * Provenance values:
 *   verified  — registration and stage confirmed by at least one source
 *   partial   — registration confirmed, MSN or line number still unknown
 *   projected — nothing confirmed; placeholder awaiting a production list
 *
 * Last reconciled: 2026-08-13
 */

export const VERIFIED = [
  {
    reg: "HZ-RXAA", type: "787-9", msn: null, lineNumber: 1265,
    stage: "SERVICE", provenance: "partial",
    events: [
      { stage: "DELIVERY", on: "2026-06-04", from: "KCHS", to: "OERK" },
      { stage: "SERVICE",  on: "2026-07-01", note: "inaugural OERK–EGLL" },
    ],
    note: "First new-build delivery. Departed Charleston 13:33 local, landed Riyadh 09:36 on 5 June.",
  },
  {
    reg: "HZ-RXAB", type: "787-9", msn: null, lineNumber: null,
    stage: "SERVICE", provenance: "partial",
    events: [{ stage: "DELIVERY", on: "2026-06-04", from: "KPAE", to: "OERK" }],
    note: "Delivered from Everett the same day as RXAA; the two flew in trail across the Atlantic.",
  },
  {
    reg: "HZ-RXAC", type: "787-9", msn: null, lineNumber: null,
    stage: "SERVICE", provenance: "partial",
    events: [{ stage: "DELIVERY", on: "2026-06-10", from: null, to: "OERK" }],
    note: "In fleet by 11 June. Exact delivery date and origin unconfirmed.",
  },
  {
    reg: "HZ-RXAD", type: "787-9", msn: 69474, lineNumber: null,
    stage: "SERVICE", provenance: "verified",
    events: [{ stage: "DELIVERY", on: "2026-06-17", from: "KPAE", to: "OEJN" }],
  },
  {
    reg: "HZ-RXAE", type: "787-9", msn: 69475, lineNumber: null,
    stage: "SERVICE", provenance: "verified",
    events: [
      { stage: "FIRST",    on: "2026-05-21", from: "KCHS", to: "KCHS" },
      { stage: "DELIVERY", on: "2026-06-14", from: "KCHS", to: "OEJN" },
    ],
  },
  {
    reg: "HZ-RXAF", type: "787-9", msn: 69476, lineNumber: null,
    stage: "SERVICE", provenance: "verified",
    events: [
      { stage: "FIRST",    on: "2026-06-19", from: "KCHS", to: "KCHS" },
      { stage: "DELIVERY", on: "2026-07-03", from: "KCHS", to: "OEJN" },
    ],
  },
  {
    // Still in Boeing flight test. Wears its Saudi registration and Saudi
    // hex already, but flies under a Boeing callsign — see watchlist.js.
    reg: "HZ-RXAG", type: "787-9", msn: 69477, lineNumber: null,
    hex: "716FFE", stage: "FIRST", provenance: "verified",
    events: [
      { stage: "FIRST", on: "2026-07-07", from: "KCHS", to: "KCHS" },
      { stage: "FIRST", on: "2026-07-19", from: "KCHS", to: "KCHS",
        note: "fourth flight, callsign BOE047" },
    ],
    note: "Not delivered. Do not count in delivery totals.",
  },
];

/**
 * Leased, not part of the order book. Tracked so the worker does not file it
 * as an unbound candidate every time it flies, but it must never appear in
 * delivery counts — it was an Oman Air frame taken on lease for
 * certification and crew training.
 */
export const LEASED = [
  { reg: "HZ-RXX", type: "787-9", msn: 38892, stage: "SERVICE",
    provenance: "verified", note: "ex-Oman Air, leased via Avolon, Jan 2025. Excluded from order book." },
];

export const DELIVERED_COUNT = VERIFIED.filter(
  (a) => a.stage === "SERVICE" || a.stage === "DELIVERY").length; // 6

/**
 * Registration series. Riyadh Air is allocating HZ-RXA_ sequentially.
 * Used ONLY to recognise a plausible Riyadh Air registration on a new
 * contact — never to invent one for an unbuilt airframe.
 */
export const REG_SERIES = /^HZ-RX[A-Z][A-Z]$/;

/** Observed MSN block for the 787-9s. Boundaries are inferred, not official. */
export const MSN_HINT = { "787-9": { from: 69471, to: 69510 } };
