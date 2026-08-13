import Redis from "ioredis";
import { EventEmitter } from "node:events";
import { SITES, POLLED_SITES, shouldPoll } from "./config/sites.js";
import { isCandidate, KNOWN_HEX, FLEET_TYPES, hexBlockOf, REG_PREFIX } from "./config/watchlist.js";
import { locate, isAirborne } from "./lib/geo.js";
import { operatorOfReg, operatorOfCallsign } from "./config/operators.js";
import { Dedup } from "./lib/dedup.js";
import { inferAll, STAGE_INDEX, siteName } from "./lib/infer.js";
import { AirplanesLive, AdsbFi, AdsbExchange, ProviderPool } from "./lib/providers.js";

const TICK_MS = Number(process.env.TICK_MS ?? 5000);
const KM_TO_NM = 0.539957;

export class IngestWorker extends EventEmitter {
  constructor({ redis, db, providers }) {
    super();
    this.r = redis;
    this.db = db; // { getAirframeByHex, createCandidate, insertStageEvent, setStage }
    this.pool = providers;
    this.dedup = new Dedup(redis, STAGE_INDEX);
    this.running = false;
    this.ticks = 0;
  }

  start() {
    this.running = true;
    this.loop();
    this.sweeper = setInterval(() => this.sweepClosedSorties(), 60_000);
  }

  stop() {
    this.running = false;
    clearInterval(this.sweeper);
  }

  async loop() {
    while (this.running) {
      const started = Date.now();
      try {
        await this.tick();
      } catch (err) {
        this.emit("error", err);
      }
      const rest = Math.max(0, TICK_MS - (Date.now() - started));
      await new Promise((r) => setTimeout(r, rest));
    }
  }

  async tick() {
    const sweep = POLLED_SITES.filter((icao) => shouldPoll(icao, this.ticks));
    this.ticks++;
    for (const icao of sweep) {
      const s = SITES[icao];
      const blips = await this.pool.near(
        s.circle.lat,
        s.circle.lon,
        s.circle.radius_km * KM_TO_NM,
      );
      for (const blip of blips) await this.handle(blip);
    }
    this.emit("tick", { at: Date.now(), swept: sweep.length, health: Object.fromEntries(this.pool.health) });
  }

  /* ---------- one aircraft, one fix ---------- */

  async handle(blip) {
    if (!isCandidate(blip)) return;

    const place = locate(blip.lat, blip.lon);
    if (!place) return;

    // A test-block frame only counts at a site that builds its type.
    const block = hexBlockOf(blip.hex);
    const site = SITES[place.icao];
    if (block !== "SAUDI" && !site.types.includes(blip.t)) return;

    const airframe = await this.bind(blip, place);
    if (!airframe) return;

    await this.db.recordFix?.(airframe.id, blip);

    const airborne = isAirborne(blip);
    let closedSortie = null;

    if (airborne) {
      const isNew = await this.dedup.firstEverAirborne(blip.hex, blip.ts);
      await this.dedup.openSortie(blip.hex, { departed: place.icao, ts: blip.ts });
      await this.dedup.touchSortie(blip.hex, { callsign: blip.flight });
      await this.dedup.touchSortie(blip.hex, {
        lastSeen: blip.ts,
        maxAlt: Math.max(0, Number(blip.alt_baro) || 0),
        arrived: place.icao,
      });
      await this.consider({ blip, place, sortie: null, airframe, neverSeenBefore: isNew, airborne: true });
    } else {
      closedSortie = await this.dedup.closeSortie(blip.hex, blip.ts);
      await this.consider({ blip, place, sortie: closedSortie, airframe, neverSeenBefore: false, airborne: false });
    }
  }

  /**
   * Map a hex to an airframe. Explicit bindings win. An unbound candidate is
   * never auto-assigned to an order line — it goes to a review queue, because
   * a wrong binding poisons the timeline for the life of the airframe.
   */
  async bind(blip, place) {
    const known = KNOWN_HEX[blip.hex] ?? (await this.db.getAirframeByHex(blip.hex));
    if (known) return known;

    if (blip.reg && REG_PREFIX.RIYADH_AIR.test(blip.reg)) {
      const byReg = await this.db.getAirframeByReg?.(blip.reg);
      if (byReg) {
        await this.db.bindHex?.(byReg.id, blip.hex);
        this.emit("bound", { airframe: byReg, hex: blip.hex, via: "registration" });
        return byReg;
      }
    }

    await this.db.createCandidate({
      hex: blip.hex,
      reg: blip.reg,
      operator: operatorOfReg(blip.reg),
      type: FLEET_TYPES[blip.t]?.type ?? blip.t,
      site: place.icao,
      first_seen: blip.ts,
    });
    this.emit("candidate", { hex: blip.hex, type: blip.t, site: place.icao });
    return null;
  }

  /** Run inference, then let the dedup layer decide whether it is news. */
  async consider({ blip, place, sortie, airframe, neverSeenBefore, airborne }) {
    const ctx = { currentStage: airframe.current_stage, neverSeenBefore, airborne };
    const hit = inferAll({ blip, place, sortie, ctx });
    if (!hit) return;

    if (hit.confidence < 0.8) {
      await this.db.insertStageEvent({
        airframe_id: airframe.id,
        stage: hit.stage,
        occurred_at: blip.ts,
        source: "ADSB",
        site_icao: place.icao,
        confidence: hit.confidence,
        provisional: true,
        raw_ref: hit.why,
      });
      this.emit("provisional", { airframe, ...hit });
      return;
    }

    const won = await this.dedup.claim(airframe.id, hit.stage, blip.ts);
    if (!won) return;

    await this.db.insertStageEvent({
      airframe_id: airframe.id,
      stage: hit.stage,
      occurred_at: blip.ts,
      source: "ADSB",
      site_icao: place.icao,
      confidence: hit.confidence,
      provisional: false,
      raw_ref: hit.why,
    });
    await this.db.setStage(airframe.id, hit.stage);

    this.emit("milestone", {
      airframe_id: airframe.id,
      operator: airframe.operator
        ?? operatorOfCallsign(blip.flight)
        ?? operatorOfReg(blip.reg),
      registration: blip.reg,
      hex: blip.hex,
      type: FLEET_TYPES[blip.t]?.type,
      stage: hit.stage,
      site: siteName(place.icao),
      at: blip.ts,
      why: hit.why,
    });
  }

  /** Aircraft that dropped off coverage mid-sortie still need their flight
   *  closed, or the delivery arrival never fires. */
  async sweepClosedSorties() {
    const keys = await this.r.keys("sortie:*");
    for (const k of keys) {
      const raw = await this.r.get(k);
      if (!raw) continue;
      const s = JSON.parse(raw);
      if (Date.now() - s.lastSeen < 45 * 60_000) continue;
      await this.r.del(k);
      this.emit("sortie-expired", s);
    }
  }
}

/* ---------- wiring ---------- */

export function createWorker({ db, redisUrl = "redis://localhost:6379" }) {
  const redis = new Redis(redisUrl);
  const pool = new ProviderPool([
    new AirplanesLive(),
    new AdsbFi(),
    ...(process.env.RAPIDAPI_KEY ? [new AdsbExchange(process.env.RAPIDAPI_KEY)] : []),
  ]);
  return new IngestWorker({ redis, db, providers: pool });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const memory = new Map();
  const stub = {
    getAirframeByHex: async (h) => memory.get(h) ?? null,
    getAirframeByReg: async () => null,
    createCandidate: async (c) => console.log("[candidate]", c.hex, c.type, c.site),
    insertStageEvent: async (e) => console.log("[event]", e.stage, e.airframe_id, e.raw_ref),
    setStage: async () => {},
    recordFix: async () => {},
  };
  const w = createWorker({ db: stub });
  w.on("milestone", (m) => console.log("MILESTONE", m.stage, m.registration ?? m.hex, m.why));
  w.on("error", (e) => console.error("worker error:", e.message));
  w.start();
  console.log(`watching ${POLLED_SITES.join(" ")} every ${TICK_MS}ms`);
}
