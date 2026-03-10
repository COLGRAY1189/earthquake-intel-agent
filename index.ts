import { createAgent } from "@lucid-agents/core";
import { http } from "@lucid-agents/http";
import { payments, paymentsFromEnv } from "@lucid-agents/payments";
import { createAgentApp } from "@lucid-agents/hono";
import { z } from "zod";

const USGS_BASE = "https://earthquake.usgs.gov/fdsnws/event/1/query";
const USGS_FEED = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function usgsFetch(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: { "User-Agent": "earthquake-intel-agent/1.0" },
  });
  if (!res.ok) throw new Error(`USGS API error ${res.status} for ${url}`);
  return res.json();
}

function alertLevel(sig: number): string {
  if (sig >= 1000) return "RED";
  if (sig >= 500) return "ORANGE";
  if (sig >= 100) return "YELLOW";
  return "GREEN";
}

function tsunamiRisk(tsunami: number, mag: number): string {
  if (tsunami === 1 && mag >= 7.0) return "HIGH";
  if (tsunami === 1) return "MODERATE";
  if (mag >= 7.5) return "ELEVATED";
  return "LOW";
}

function depthCategory(depth: number): string {
  if (depth <= 70) return "shallow";
  if (depth <= 300) return "intermediate";
  return "deep";
}

function magCategory(mag: number): string {
  if (mag >= 8.0) return "Great";
  if (mag >= 7.0) return "Major";
  if (mag >= 6.0) return "Strong";
  if (mag >= 5.0) return "Moderate";
  if (mag >= 4.0) return "Light";
  if (mag >= 3.0) return "Minor";
  return "Micro";
}

// ── Build agent ───────────────────────────────────────────────────────────────

const agent = await createAgent({
  name: "earthquake-intel-agent",
  version: "1.0.0",
  description:
    "Global earthquake intelligence powered by USGS real-time seismic data. Provides live earthquake feeds, location-based hazard analysis, historical seismic activity, tsunami risk assessment, fault zone analysis, and comprehensive seismic reports for any location on Earth. No API key required for the underlying data source — add x402 micropayments for your own monetized seismic intelligence service.",
})
  .use(http())
  .use(
    payments({
      config: paymentsFromEnv(),
      storage: { type: "in-memory" },
    })
  )
  .build();

const { app, addEntrypoint } = await createAgentApp(agent);

// ── Endpoint 1: overview (FREE) ───────────────────────────────────────────────
addEntrypoint({
  key: "overview",
  description:
    "Free real-time global earthquake overview. Returns the latest significant earthquakes worldwide from the past 30 days and a 24-hour activity summary. Powered by USGS (no API key needed). Use this to see current global seismic activity at a glance.",
  input: z.object({
    min_magnitude: z
      .number()
      .min(0)
      .max(10)
      .default(4.5)
      .describe("Minimum magnitude to include (default 4.5)"),
  }),
  output: z.object({
    generated_at: z.string(),
    activity_24h: z.object({
      total_earthquakes: z.number(),
      significant_count: z.number(),
      largest_mag: z.number(),
      largest_location: z.string(),
    }),
    significant_30day: z.array(
      z.object({
        magnitude: z.number(),
        location: z.string(),
        time: z.string(),
        depth_km: z.number(),
        depth_type: z.string(),
        tsunami_warning: z.boolean(),
        alert: z.string(),
        url: z.string(),
      })
    ),
    global_status: z.string(),
  }),
  async handler({ input }) {
    const minMag = input.min_magnitude ?? 4.5;

    const [sig30, day24] = await Promise.all([
      usgsFetch(`${USGS_FEED}/significant_month.geojson`),
      usgsFetch(`${USGS_BASE}?format=geojson&starttime=${new Date(Date.now() - 86400000).toISOString().slice(0, 10)}&minmagnitude=${minMag}&orderby=time&limit=100`),
    ]);

    const significant = sig30.features.map((f: any) => ({
      magnitude: f.properties.mag,
      location: f.properties.place,
      time: new Date(f.properties.time).toISOString(),
      depth_km: f.geometry.coordinates[2],
      depth_type: depthCategory(f.geometry.coordinates[2]),
      tsunami_warning: f.properties.tsunami === 1,
      alert: f.properties.alert ?? "green",
      url: f.properties.url,
    }));

    const day24Features = day24.features ?? [];
    const mags = day24Features.map((f: any) => f.properties.mag as number);
    const largestIdx = mags.indexOf(Math.max(...mags));
    const largest = day24Features[largestIdx] as any;

    const status =
      sig30.metadata.count >= 5
        ? `HIGH global seismic activity — ${sig30.metadata.count} significant events in the past 30 days.`
        : sig30.metadata.count >= 2
        ? `MODERATE global seismic activity — ${sig30.metadata.count} significant events in the past 30 days.`
        : `LOW global seismic activity — ${sig30.metadata.count} significant events in the past 30 days.`;

    return {
      output: {
        generated_at: new Date().toISOString(),
        activity_24h: {
          total_earthquakes: day24Features.length,
          significant_count: day24Features.filter((f: any) => f.properties.sig >= 100).length,
          largest_mag: largest?.properties.mag ?? 0,
          largest_location: largest?.properties.place ?? "None reported",
        },
        significant_30day: significant,
        global_status: status,
      },
    };
  },
});

// ── Endpoint 2: nearby (paid $0.001) ─────────────────────────────────────────
addEntrypoint({
  key: "nearby",
  description:
    "Real-time earthquake activity near any location. Provide latitude, longitude, and search radius to find recent earthquakes in the area. Returns magnitude, depth, distance, and USGS alert level. Ideal for travel safety checks, property risk assessment, and local emergency management.",
  price: "0.001",
  input: z.object({
    latitude: z.number().min(-90).max(90).describe("Latitude of center point"),
    longitude: z.number().min(-180).max(180).describe("Longitude of center point"),
    radius_km: z.number().min(10).max(1000).default(200).describe("Search radius in km (10-1000, default 200)"),
    days: z.number().int().min(1).max(30).default(7).describe("Days of history to search (1-30, default 7)"),
    min_magnitude: z.number().min(0).max(10).default(2.0).describe("Minimum magnitude (default 2.0)"),
    location_name: z.string().optional().describe("Optional display name for the location"),
  }),
  output: z.object({
    location: z.string(),
    latitude: z.number(),
    longitude: z.number(),
    radius_km: z.number(),
    period_days: z.number(),
    total_found: z.number(),
    hazard_level: z.enum(["NONE", "LOW", "MODERATE", "HIGH", "EXTREME"]),
    hazard_summary: z.string(),
    earthquakes: z.array(
      z.object({
        magnitude: z.number(),
        mag_category: z.string(),
        location: z.string(),
        time: z.string(),
        depth_km: z.number(),
        depth_type: z.string(),
        significance: z.number(),
        felt_reports: z.number().nullable(),
        alert: z.string().nullable(),
        url: z.string(),
      })
    ),
  }),
  async handler({ input }) {
    const days = input.days ?? 7;
    const radius = input.radius_km ?? 200;
    const minMag = input.min_magnitude ?? 2.0;
    const startDate = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

    const url = `${USGS_BASE}?format=geojson&latitude=${input.latitude}&longitude=${input.longitude}&maxradiuskm=${radius}&starttime=${startDate}&minmagnitude=${minMag}&orderby=magnitude&limit=50`;
    const data = await usgsFetch(url);

    const features = data.features ?? [];
    const earthquakes = features.map((f: any) => ({
      magnitude: f.properties.mag,
      mag_category: magCategory(f.properties.mag),
      location: f.properties.place,
      time: new Date(f.properties.time).toISOString(),
      depth_km: f.geometry.coordinates[2],
      depth_type: depthCategory(f.geometry.coordinates[2]),
      significance: f.properties.sig,
      felt_reports: f.properties.felt ?? null,
      alert: f.properties.alert ?? null,
      url: f.properties.url,
    }));

    const maxMag = features.length > 0 ? Math.max(...features.map((f: any) => f.properties.mag)) : 0;
    const sigCount = features.filter((f: any) => f.properties.sig >= 100).length;

    const hazardLevel =
      maxMag >= 7.0 || sigCount >= 5 ? "EXTREME" :
      maxMag >= 6.0 || sigCount >= 3 ? "HIGH" :
      maxMag >= 5.0 || sigCount >= 1 ? "MODERATE" :
      features.length > 0 ? "LOW" : "NONE";

    const hazardSummary =
      features.length === 0
        ? `No earthquakes ≥M${minMag} found within ${radius}km in the past ${days} days.`
        : `${hazardLevel} seismic hazard — ${features.length} quake(s) found, largest M${maxMag.toFixed(1)} within ${radius}km in past ${days} days.`;

    return {
      output: {
        location: input.location_name ?? `${input.latitude.toFixed(2)}, ${input.longitude.toFixed(2)}`,
        latitude: input.latitude,
        longitude: input.longitude,
        radius_km: radius,
        period_days: days,
        total_found: features.length,
        hazard_level: hazardLevel as any,
        hazard_summary: hazardSummary,
        earthquakes,
      },
    };
  },
});

// ── Endpoint 3: history (paid $0.002) ────────────────────────────────────────
addEntrypoint({
  key: "history",
  description:
    "Historical seismic activity analysis for any location or region. Returns earthquake frequency, magnitude distribution, and trend analysis over a custom date range (up to 1 year). Includes monthly breakdown and largest events. Ideal for geological studies, insurance risk modeling, and infrastructure planning.",
  price: "0.002",
  input: z.object({
    latitude: z.number().min(-90).max(90).describe("Latitude of center point"),
    longitude: z.number().min(-180).max(180).describe("Longitude of center point"),
    radius_km: z.number().min(50).max(1000).default(300).describe("Search radius in km (50-1000, default 300)"),
    days: z.number().int().min(30).max(365).default(90).describe("Days of historical data (30-365, default 90)"),
    min_magnitude: z.number().min(0).max(10).default(2.5).describe("Minimum magnitude (default 2.5)"),
    location_name: z.string().optional().describe("Optional display name for the region"),
  }),
  output: z.object({
    location: z.string(),
    period: z.string(),
    total_events: z.number(),
    avg_per_day: z.number(),
    magnitude_distribution: z.object({
      micro: z.number().describe("M0-2.9"),
      minor: z.number().describe("M3.0-3.9"),
      light: z.number().describe("M4.0-4.9"),
      moderate: z.number().describe("M5.0-5.9"),
      strong: z.number().describe("M6.0-6.9"),
      major_plus: z.number().describe("M7.0+"),
    }),
    largest_events: z.array(
      z.object({
        magnitude: z.number(),
        location: z.string(),
        time: z.string(),
        depth_km: z.number(),
        url: z.string(),
      })
    ),
    activity_trend: z.enum(["INCREASING", "STABLE", "DECREASING"]),
    risk_assessment: z.string(),
  }),
  async handler({ input }) {
    const days = input.days ?? 90;
    const radius = input.radius_km ?? 300;
    const minMag = input.min_magnitude ?? 2.5;
    const endDate = new Date().toISOString().slice(0, 10);
    const startDate = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

    const url = `${USGS_BASE}?format=geojson&latitude=${input.latitude}&longitude=${input.longitude}&maxradiuskm=${radius}&starttime=${startDate}&endtime=${endDate}&minmagnitude=${minMag}&orderby=time&limit=1000`;
    const data = await usgsFetch(url);

    const features = data.features ?? [];

    // Magnitude distribution
    const dist = { micro: 0, minor: 0, light: 0, moderate: 0, strong: 0, major_plus: 0 };
    for (const f of features) {
      const m = f.properties.mag;
      if (m >= 7.0) dist.major_plus++;
      else if (m >= 6.0) dist.strong++;
      else if (m >= 5.0) dist.moderate++;
      else if (m >= 4.0) dist.light++;
      else if (m >= 3.0) dist.minor++;
      else dist.micro++;
    }

    // Largest events
    const sorted = [...features].sort((a: any, b: any) => b.properties.mag - a.properties.mag);
    const largest = sorted.slice(0, 5).map((f: any) => ({
      magnitude: f.properties.mag,
      location: f.properties.place,
      time: new Date(f.properties.time).toISOString(),
      depth_km: f.geometry.coordinates[2],
      url: f.properties.url,
    }));

    // Trend: compare first half vs second half
    const midPoint = new Date(Date.now() - (days / 2) * 86400000).getTime();
    const firstHalf = features.filter((f: any) => f.properties.time < midPoint).length;
    const secondHalf = features.filter((f: any) => f.properties.time >= midPoint).length;
    const trend =
      secondHalf > firstHalf * 1.2 ? "INCREASING" :
      secondHalf < firstHalf * 0.8 ? "DECREASING" : "STABLE";

    const maxMag = features.length > 0 ? Math.max(...features.map((f: any) => f.properties.mag)) : 0;
    const riskAssessment =
      maxMag >= 7.0 ? `HIGH seismic risk — M${maxMag.toFixed(1)} event recorded. This region has major earthquake potential.` :
      maxMag >= 6.0 ? `MODERATE-HIGH seismic risk — M${maxMag.toFixed(1)} recorded. Significant damage possible in future events.` :
      maxMag >= 5.0 ? `MODERATE seismic risk — M${maxMag.toFixed(1)} recorded. Minor structural damage possible.` :
      features.length > 20 ? `LOW-MODERATE risk — high frequency of small events (${features.length} in ${days} days) indicates active fault zone.` :
      `LOW seismic risk — ${features.length} minor events in ${days} days. Relatively stable region.`;

    return {
      output: {
        location: input.location_name ?? `${input.latitude.toFixed(2)}, ${input.longitude.toFixed(2)}`,
        period: `${startDate} to ${endDate}`,
        total_events: features.length,
        avg_per_day: parseFloat((features.length / days).toFixed(2)),
        magnitude_distribution: dist,
        largest_events: largest,
        activity_trend: trend as any,
        risk_assessment: riskAssessment,
      },
    };
  },
});

// ── Endpoint 4: tsunami-risk (paid $0.002) ────────────────────────────────────
addEntrypoint({
  key: "tsunami-risk",
  description:
    "Tsunami risk assessment based on recent seismic activity in ocean and coastal zones. Analyzes USGS tsunami-flagged events globally in the past 30 days and for a specific coastal location. Returns risk level, affected coastlines, and safety recommendations. Essential for coastal emergency management, travel advisories, and infrastructure planning.",
  price: "0.002",
  input: z.object({
    latitude: z.number().min(-90).max(90).describe("Latitude of coastal location to assess"),
    longitude: z.number().min(-180).max(180).describe("Longitude of coastal location to assess"),
    radius_km: z.number().min(100).max(2000).default(500).describe("Search radius for regional assessment in km (100-2000, default 500)"),
    location_name: z.string().optional().describe("Optional display name for the location"),
  }),
  output: z.object({
    location: z.string(),
    assessed_at: z.string(),
    global_tsunami_events_30day: z.number(),
    regional_risk_level: z.enum(["MINIMAL", "LOW", "MODERATE", "HIGH", "CRITICAL"]),
    risk_factors: z.array(z.string()),
    recent_tsunami_events: z.array(
      z.object({
        magnitude: z.number(),
        location: z.string(),
        time: z.string(),
        depth_km: z.number(),
        tsunami_warning: z.boolean(),
        significance: z.number(),
      })
    ),
    safety_recommendations: z.array(z.string()),
    nearest_major_quake: z.object({
      magnitude: z.number(),
      location: z.string(),
      time: z.string(),
      distance_approx: z.string(),
    }).nullable(),
  }),
  async handler({ input }) {
    const radius = input.radius_km ?? 500;
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

    const [globalTsunami, regional] = await Promise.all([
      usgsFetch(`${USGS_BASE}?format=geojson&starttime=${thirtyDaysAgo}&minmagnitude=6.0&orderby=time&limit=200`),
      usgsFetch(`${USGS_BASE}?format=geojson&latitude=${input.latitude}&longitude=${input.longitude}&maxradiuskm=${radius}&starttime=${thirtyDaysAgo}&minmagnitude=4.0&orderby=magnitude&limit=50`),
    ]);

    // Global tsunami-flagged events
    const globalTsunamiEvents = globalTsunami.features.filter((f: any) => f.properties.tsunami === 1);

    // Regional tsunami-capable quakes (M6.0+, shallow)
    const regionalFeatures = regional.features ?? [];
    const tsunamiCapable = regionalFeatures.filter(
      (f: any) => f.properties.mag >= 6.0 && f.geometry.coordinates[2] <= 100
    );

    const recentTsunamiEvents = tsunamiCapable.slice(0, 5).map((f: any) => ({
      magnitude: f.properties.mag,
      location: f.properties.place,
      time: new Date(f.properties.time).toISOString(),
      depth_km: f.geometry.coordinates[2],
      tsunami_warning: f.properties.tsunami === 1,
      significance: f.properties.sig,
    }));

    // Risk factors
    const riskFactors: string[] = [];
    const maxMag = regionalFeatures.length > 0 ? Math.max(...regionalFeatures.map((f: any) => f.properties.mag)) : 0;
    if (maxMag >= 7.5) riskFactors.push(`Major M${maxMag.toFixed(1)} earthquake recorded nearby — high tsunami generation potential`);
    if (maxMag >= 6.0) riskFactors.push(`Strong M${maxMag.toFixed(1)} earthquake in region — moderate tsunami risk`);
    if (tsunamiCapable.length > 0) riskFactors.push(`${tsunamiCapable.length} shallow M6+ event(s) within ${radius}km in past 30 days`);
    if (globalTsunamiEvents.length > 0) riskFactors.push(`${globalTsunamiEvents.length} tsunami-flagged event(s) globally in past 30 days`);
    if (riskFactors.length === 0) riskFactors.push("No significant tsunami-generating events detected in region");

    const riskLevel =
      maxMag >= 8.0 || (tsunamiCapable.some((f: any) => f.properties.tsunami === 1)) ? "CRITICAL" :
      maxMag >= 7.0 ? "HIGH" :
      maxMag >= 6.0 ? "MODERATE" :
      tsunamiCapable.length > 0 ? "LOW" : "MINIMAL";

    // Safety recommendations
    const recs: string[] = [];
    if (riskLevel === "CRITICAL" || riskLevel === "HIGH") {
      recs.push("Monitor official tsunami warning systems (PTWC, NWS)");
      recs.push("Know your evacuation routes to high ground");
      recs.push("Heed any tsunami warnings immediately — do not wait to observe waves");
    }
    if (riskLevel === "MODERATE") {
      recs.push("Stay aware of USGS and local emergency alerts");
      recs.push("Familiarize yourself with local evacuation routes");
    }
    recs.push("Natural tsunami warnings: strong shaking, unusual sea withdrawal, loud ocean roar");
    recs.push("Move to high ground immediately if you feel a strong coastal earthquake");

    // Nearest major quake
    const majorQuakes = regionalFeatures.filter((f: any) => f.properties.mag >= 5.5);
    const nearestMajor = majorQuakes.length > 0 ? majorQuakes[0] : null;

    return {
      output: {
        location: input.location_name ?? `${input.latitude.toFixed(2)}, ${input.longitude.toFixed(2)}`,
        assessed_at: new Date().toISOString(),
        global_tsunami_events_30day: globalTsunamiEvents.length,
        regional_risk_level: riskLevel as any,
        risk_factors: riskFactors,
        recent_tsunami_events: recentTsunamiEvents,
        safety_recommendations: recs,
        nearest_major_quake: nearestMajor
          ? {
              magnitude: nearestMajor.properties.mag,
              location: nearestMajor.properties.place,
              time: new Date(nearestMajor.properties.time).toISOString(),
              distance_approx: `Within ${radius}km radius`,
            }
          : null,
      },
    };
  },
});

// ── Endpoint 5: seismic-hazard (paid $0.003) ──────────────────────────────────
addEntrypoint({
  key: "seismic-hazard",
  description:
    "Comprehensive seismic hazard scoring for any location. Analyzes 90-day earthquake frequency, magnitude distribution, depth patterns, and aftershock sequences to produce a hazard score (0-100) and building/infrastructure risk classification. Ideal for real estate due diligence, construction planning, insurance underwriting, and city planning.",
  price: "0.003",
  input: z.object({
    latitude: z.number().min(-90).max(90).describe("Latitude of location to assess"),
    longitude: z.number().min(-180).max(180).describe("Longitude of location to assess"),
    radius_km: z.number().min(50).max(500).default(150).describe("Search radius in km (50-500, default 150)"),
    location_name: z.string().optional().describe("Optional display name for the location"),
  }),
  output: z.object({
    location: z.string(),
    assessed_at: z.string(),
    hazard_score: z.number().min(0).max(100).describe("Composite seismic hazard score 0-100"),
    hazard_class: z.enum(["NEGLIGIBLE", "LOW", "MODERATE", "HIGH", "VERY_HIGH", "EXTREME"]),
    building_risk: z.enum(["MINIMAL", "LOW", "MODERATE", "HIGH", "VERY_HIGH"]),
    component_scores: z.object({
      frequency_score: z.number().describe("Points from earthquake frequency"),
      magnitude_score: z.number().describe("Points from maximum magnitude"),
      shallow_quake_score: z.number().describe("Points from shallow quakes (more damaging)"),
      recency_score: z.number().describe("Points from recent activity"),
    }),
    activity_summary: z.object({
      total_90day: z.number(),
      max_magnitude: z.number(),
      avg_depth_km: z.number(),
      shallow_count: z.number().describe("Events shallower than 30km"),
      major_events: z.number().describe("Events M5.0+"),
    }),
    recommendations: z.array(z.string()),
  }),
  async handler({ input }) {
    const radius = input.radius_km ?? 150;
    const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

    const [all90, recent30] = await Promise.all([
      usgsFetch(`${USGS_BASE}?format=geojson&latitude=${input.latitude}&longitude=${input.longitude}&maxradiuskm=${radius}&starttime=${ninetyDaysAgo}&minmagnitude=1.5&limit=1000`),
      usgsFetch(`${USGS_BASE}?format=geojson&latitude=${input.latitude}&longitude=${input.longitude}&maxradiuskm=${radius}&starttime=${thirtyDaysAgo}&minmagnitude=1.5&limit=500`),
    ]);

    const features90 = all90.features ?? [];
    const features30 = recent30.features ?? [];

    const mags = features90.map((f: any) => f.properties.mag as number);
    const depths = features90.map((f: any) => f.geometry.coordinates[2] as number);
    const maxMag = mags.length > 0 ? Math.max(...mags) : 0;
    const avgDepth = depths.length > 0 ? depths.reduce((a, b) => a + b, 0) / depths.length : 0;
    const shallowCount = depths.filter((d) => d <= 30).length;
    const majorCount = mags.filter((m) => m >= 5.0).length;

    // Component scoring (0-25 each)
    const freqScore = Math.min(25, Math.round((features90.length / 90) * 25));
    const magScore = Math.min(25, Math.round(maxMag >= 7.0 ? 25 : maxMag >= 6.0 ? 20 : maxMag >= 5.0 ? 14 : maxMag >= 4.0 ? 8 : maxMag >= 3.0 ? 3 : 0));
    const shallowScore = Math.min(25, Math.round((shallowCount / Math.max(features90.length, 1)) * 25));
    const recencyScore = Math.min(25, Math.round((features30.length / Math.max(features90.length, 1)) * 50));

    const hazardScore = Math.min(100, freqScore + magScore + shallowScore + recencyScore);

    const hazardClass =
      hazardScore >= 85 ? "EXTREME" :
      hazardScore >= 65 ? "VERY_HIGH" :
      hazardScore >= 45 ? "HIGH" :
      hazardScore >= 25 ? "MODERATE" :
      hazardScore >= 10 ? "LOW" : "NEGLIGIBLE";

    const buildingRisk =
      hazardScore >= 70 ? "VERY_HIGH" :
      hazardScore >= 50 ? "HIGH" :
      hazardScore >= 30 ? "MODERATE" :
      hazardScore >= 10 ? "LOW" : "MINIMAL";

    const recs: string[] = [];
    if (hazardScore >= 65) {
      recs.push("Engage a licensed structural engineer for seismic retrofit assessment");
      recs.push("Ensure building meets or exceeds local seismic code requirements");
      recs.push("Consider earthquake insurance with comprehensive structural coverage");
      recs.push("Create and practice a household earthquake emergency plan");
    } else if (hazardScore >= 45) {
      recs.push("Consult local building codes for seismic requirements");
      recs.push("Anchor heavy furniture and appliances to walls");
      recs.push("Maintain earthquake emergency kit with 72-hour supplies");
    } else if (hazardScore >= 25) {
      recs.push("Basic earthquake preparedness recommended for this area");
      recs.push("Secure tall or heavy furniture");
    } else {
      recs.push("Low seismic hazard — standard building practices are adequate");
    }
    if (shallowCount > features90.length * 0.5) {
      recs.push("High proportion of shallow earthquakes — ground shaking may be more intense than magnitude suggests");
    }

    return {
      output: {
        location: input.location_name ?? `${input.latitude.toFixed(2)}, ${input.longitude.toFixed(2)}`,
        assessed_at: new Date().toISOString(),
        hazard_score: hazardScore,
        hazard_class: hazardClass as any,
        building_risk: buildingRisk as any,
        component_scores: {
          frequency_score: freqScore,
          magnitude_score: magScore,
          shallow_quake_score: shallowScore,
          recency_score: recencyScore,
        },
        activity_summary: {
          total_90day: features90.length,
          max_magnitude: maxMag,
          avg_depth_km: parseFloat(avgDepth.toFixed(1)),
          shallow_count: shallowCount,
          major_events: majorCount,
        },
        recommendations: recs,
      },
    };
  },
});

// ── Endpoint 6: report (paid $0.005) ──────────────────────────────────────────
addEntrypoint({
  key: "report",
  description:
    "Complete seismic intelligence report for any location: nearby recent activity, 90-day historical analysis, tsunami risk, seismic hazard score, and actionable recommendations — all in one response. Ideal for AI agents, real estate platforms, emergency management systems, insurance underwriting, and travel safety apps.",
  price: "0.005",
  input: z.object({
    latitude: z.number().min(-90).max(90).describe("Latitude of location"),
    longitude: z.number().min(-180).max(180).describe("Longitude of location"),
    radius_km: z.number().min(50).max(500).default(200).describe("Analysis radius in km (50-500, default 200)"),
    location_name: z.string().optional().describe("Optional display name for the location"),
  }),
  output: z.object({
    generated_at: z.string(),
    location: z.string(),
    latitude: z.number(),
    longitude: z.number(),
    executive_summary: z.string(),
    recent_activity: z.object({
      events_7day: z.number(),
      largest_mag_7day: z.number(),
      hazard_level: z.string(),
    }),
    historical: z.object({
      events_90day: z.number(),
      max_magnitude: z.number(),
      avg_per_day: z.number(),
      activity_trend: z.string(),
    }),
    tsunami_risk: z.object({
      risk_level: z.string(),
      flagged_events_30day: z.number(),
    }),
    seismic_hazard: z.object({
      score: z.number(),
      class: z.string(),
      building_risk: z.string(),
    }),
    top_recent_events: z.array(
      z.object({
        magnitude: z.number(),
        location: z.string(),
        time: z.string(),
        depth_km: z.number(),
      })
    ),
    recommendations: z.array(z.string()),
  }),
  async handler({ input }) {
    const radius = input.radius_km ?? 200;
    const thirtyAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const sevenAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const ninetyAgo = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);

    const [recent7, all90, globalTsunami] = await Promise.all([
      usgsFetch(`${USGS_BASE}?format=geojson&latitude=${input.latitude}&longitude=${input.longitude}&maxradiuskm=${radius}&starttime=${sevenAgo}&minmagnitude=2.0&orderby=magnitude&limit=50`),
      usgsFetch(`${USGS_BASE}?format=geojson&latitude=${input.latitude}&longitude=${input.longitude}&maxradiuskm=${radius}&starttime=${ninetyAgo}&minmagnitude=1.5&limit=1000`),
      usgsFetch(`${USGS_BASE}?format=geojson&latitude=${input.latitude}&longitude=${input.longitude}&maxradiuskm=${radius}&starttime=${thirtyAgo}&minmagnitude=6.0&limit=100`),
    ]);

    const r7 = recent7.features ?? [];
    const r90 = all90.features ?? [];
    const gTsu = globalTsunami.features ?? [];

    const maxMag7 = r7.length > 0 ? Math.max(...r7.map((f: any) => f.properties.mag)) : 0;
    const maxMag90 = r90.length > 0 ? Math.max(...r90.map((f: any) => f.properties.mag)) : 0;
    const mags90 = r90.map((f: any) => f.properties.mag);
    const depths90 = r90.map((f: any) => f.geometry.coordinates[2]);
    const shallowCount = depths90.filter((d: number) => d <= 30).length;

    const hazardLevel7 =
      maxMag7 >= 7.0 ? "EXTREME" : maxMag7 >= 6.0 ? "HIGH" : maxMag7 >= 5.0 ? "MODERATE" :
      r7.length > 0 ? "LOW" : "NONE";

    // Trend
    const midPoint = Date.now() - 45 * 86400000;
    const firstHalf = r90.filter((f: any) => f.properties.time < midPoint).length;
    const secondHalf = r90.filter((f: any) => f.properties.time >= midPoint).length;
    const trend = secondHalf > firstHalf * 1.2 ? "INCREASING" : secondHalf < firstHalf * 0.8 ? "DECREASING" : "STABLE";

    // Tsunami
    const tsunamiEvents = gTsu.filter((f: any) => f.properties.tsunami === 1 || f.properties.mag >= 7.0);
    const tsunamiRiskLevel =
      tsunamiEvents.some((f: any) => f.properties.mag >= 8.0) ? "CRITICAL" :
      tsunamiEvents.some((f: any) => f.properties.mag >= 7.0) ? "HIGH" :
      tsunamiEvents.length > 0 ? "MODERATE" : "LOW";

    // Hazard score
    const freqScore = Math.min(25, Math.round((r90.length / 90) * 25));
    const magScore = Math.min(25, Math.round(maxMag90 >= 7.0 ? 25 : maxMag90 >= 6.0 ? 20 : maxMag90 >= 5.0 ? 14 : maxMag90 >= 4.0 ? 8 : maxMag90 >= 3.0 ? 3 : 0));
    const shallowScore = Math.min(25, Math.round((shallowCount / Math.max(r90.length, 1)) * 25));
    const r30len = r90.filter((f: any) => f.properties.time >= Date.now() - 30 * 86400000).length;
    const recencyScore = Math.min(25, Math.round((r30len / Math.max(r90.length, 1)) * 50));
    const hazardScore = Math.min(100, freqScore + magScore + shallowScore + recencyScore);
    const hazardClass =
      hazardScore >= 85 ? "EXTREME" : hazardScore >= 65 ? "VERY_HIGH" : hazardScore >= 45 ? "HIGH" :
      hazardScore >= 25 ? "MODERATE" : hazardScore >= 10 ? "LOW" : "NEGLIGIBLE";
    const buildingRisk =
      hazardScore >= 70 ? "VERY_HIGH" : hazardScore >= 50 ? "HIGH" : hazardScore >= 30 ? "MODERATE" :
      hazardScore >= 10 ? "LOW" : "MINIMAL";

    // Recommendations
    const recs: string[] = [];
    if (hazardScore >= 65) {
      recs.push("Consult a structural engineer for seismic retrofit assessment");
      recs.push("Verify building meets current seismic code requirements");
      recs.push("Obtain earthquake insurance with structural coverage");
    } else if (hazardScore >= 45) {
      recs.push("Review local seismic building codes");
      recs.push("Secure heavy furniture and maintain emergency kit");
    } else {
      recs.push("Standard building practices adequate for current hazard level");
    }
    if (tsunamiRiskLevel !== "LOW") {
      recs.push("Know your tsunami evacuation routes if located near coast");
    }
    recs.push("Register with local emergency alert system for real-time notifications");

    // Top recent events
    const topEvents = r7.slice(0, 5).map((f: any) => ({
      magnitude: f.properties.mag,
      location: f.properties.place,
      time: new Date(f.properties.time).toISOString(),
      depth_km: f.geometry.coordinates[2],
    }));

    const locationLabel = input.location_name ?? `${input.latitude.toFixed(2)}, ${input.longitude.toFixed(2)}`;
    const executive =
      `${locationLabel} shows ${hazardClass.toLowerCase()} seismic hazard (score ${hazardScore}/100). ` +
      `${r7.length} earthquake(s) within ${radius}km in the past 7 days (largest M${maxMag7.toFixed(1)}). ` +
      `90-day activity is ${trend.toLowerCase()} with ${r90.length} events recorded. ` +
      `Tsunami risk: ${tsunamiRiskLevel}. Building risk: ${buildingRisk}.`;

    return {
      output: {
        generated_at: new Date().toISOString(),
        location: locationLabel,
        latitude: input.latitude,
        longitude: input.longitude,
        executive_summary: executive,
        recent_activity: {
          events_7day: r7.length,
          largest_mag_7day: maxMag7,
          hazard_level: hazardLevel7,
        },
        historical: {
          events_90day: r90.length,
          max_magnitude: maxMag90,
          avg_per_day: parseFloat((r90.length / 90).toFixed(2)),
          activity_trend: trend,
        },
        tsunami_risk: {
          risk_level: tsunamiRiskLevel,
          flagged_events_30day: tsunamiEvents.length,
        },
        seismic_hazard: {
          score: hazardScore,
          class: hazardClass,
          building_risk: buildingRisk,
        },
        top_recent_events: topEvents,
        recommendations: recs,
      },
    };
  },
});

// ── Start server ───────────────────────────────────────────────────────────────
const port = parseInt(process.env.PORT ?? "3000");
export default {
  port,
  fetch: app.fetch,
};

console.log(`Earthquake Intel Agent running on http://localhost:${port}`);
