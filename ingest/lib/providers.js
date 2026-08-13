/**
 * Feed adapters. All three return the same normalised blip shape, so the
 * worker never knows which one is answering.
 *
 *   airplanes.live  free, community, ~1 req/sec, no key
 *   adsb.fi         free, community, no key — use as the failover
 *   ADSB Exchange   paid via RapidAPI, best coverage over Charleston
 *
 * Run two providers concurrently and union the results. Community networks
 * have gaps exactly where you care: Charleston is well covered, Toulouse is
 * good, Hamburg-Finkenwerder is patchy at low altitude.
 */

const UA = "riyadh-air-delivery-watch/1.0";

class RateLimiter {
  constructor(perSecond) { this.gap = 1000 / perSecond; this.next = 0; }
  async wait() {
    const now = Date.now();
    const at = Math.max(now, this.next);
    this.next = at + this.gap;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  }
}

async function getJSON(url, { retries = 3 } = {}) {
  let delay = 800;
  for (let i = 0; i <= retries; i++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(url, { headers: { "User-Agent": UA }, signal: ctrl.signal });
      clearTimeout(t);
      if (res.status === 429) throw new Error("rate limited");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (i === retries) throw err;
      await new Promise((r) => setTimeout(r, delay + Math.random() * 400));
      delay *= 2;
    }
  }
}

/** Normalise whatever the provider returns into one shape. */
const normalise = (a) => ({
  hex: (a.hex ?? a.icao ?? "").toUpperCase().replace(/^~/, ""),
  reg: a.r ?? a.reg ?? null,
  t: a.t ?? a.type ?? null,
  flight: (a.flight ?? "").trim() || null,
  lat: a.lat, lon: a.lon,
  alt_baro: a.alt_baro, alt_geom: a.alt_geom,
  gs: a.gs, track: a.track,
  seen: a.seen ?? 0,
  ts: Date.now(),
});

export class AirplanesLive {
  constructor() { this.name = "airplanes.live"; this.rl = new RateLimiter(1); }
  async near(lat, lon, radiusNm) {
    await this.rl.wait();
    const r = Math.min(250, Math.round(radiusNm));
    const url = `https://api.airplanes.live/v2/point/${lat}/${lon}/${r}`;
    const j = await getJSON(url);
    return (j.ac ?? []).map(normalise);
  }
  async byHex(hex) {
    await this.rl.wait();
    const j = await getJSON(`https://api.airplanes.live/v2/hex/${hex.toLowerCase()}`);
    return (j.ac ?? []).map(normalise);
  }
}

export class AdsbFi {
  constructor() { this.name = "adsb.fi"; this.rl = new RateLimiter(1); }
  async near(lat, lon, radiusNm) {
    await this.rl.wait();
    const r = Math.min(250, Math.round(radiusNm));
    const j = await getJSON(`https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${r}`);
    return (j.aircraft ?? j.ac ?? []).map(normalise);
  }
}

export class AdsbExchange {
  constructor(key) { this.name = "adsbexchange"; this.key = key; this.rl = new RateLimiter(2); }
  async near(lat, lon, radiusNm) {
    if (!this.key) return [];
    await this.rl.wait();
    const url = `https://adsbexchange-com1.p.rapidapi.com/v2/lat/${lat}/lon/${lon}/dist/${Math.round(radiusNm)}/`;
    const res = await fetch(url, {
      headers: {
        "X-RapidAPI-Key": this.key,
        "X-RapidAPI-Host": "adsbexchange-com1.p.rapidapi.com",
        "User-Agent": UA,
      },
    });
    if (!res.ok) throw new Error(`ADSBX HTTP ${res.status}`);
    const j = await res.json();
    return (j.ac ?? []).map(normalise);
  }
}

/** Union results from every healthy provider, newest fix per hex wins. */
export class ProviderPool {
  constructor(providers) { this.providers = providers; this.health = new Map(); }

  async near(lat, lon, radiusNm) {
    const settled = await Promise.allSettled(
      this.providers.map((p) => p.near(lat, lon, radiusNm)),
    );
    const merged = new Map();
    settled.forEach((s, i) => {
      const p = this.providers[i];
      if (s.status === "rejected") {
        this.health.set(p.name, { ok: false, err: s.reason?.message, at: Date.now() });
        return;
      }
      this.health.set(p.name, { ok: true, at: Date.now(), count: s.value.length });
      for (const b of s.value) {
        if (!b.hex || b.lat == null) continue;
        const prev = merged.get(b.hex);
        if (!prev || (b.seen ?? 99) < (prev.seen ?? 99)) merged.set(b.hex, b);
      }
    });
    return [...merged.values()];
  }
}
