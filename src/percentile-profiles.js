export const PERCENTILE_PROFILE_OURS = "ours";
export const PERCENTILE_PROFILE_PPT6MAX = "ppt6max";

const PROFILE_META = {
  [PERCENTILE_PROFILE_OURS]: {
    id: PERCENTILE_PROFILE_OURS,
    label: "Ours (equity vs random)",
    detail: "Percentile order by combo equity vs random hand"
  },
  [PERCENTILE_PROFILE_PPT6MAX]: {
    id: PERCENTILE_PROFILE_PPT6MAX,
    label: "PPT 6-max (evolution)",
    detail: "ProPokerTools 6-max evolution ordering"
  }
};

const PROFILE_OPTIONS_BY_VARIANT = {
  holdem: [PERCENTILE_PROFILE_OURS],
  plo4: [PERCENTILE_PROFILE_OURS, PERCENTILE_PROFILE_PPT6MAX],
  plo5: [PERCENTILE_PROFILE_OURS, PERCENTILE_PROFILE_PPT6MAX],
  plo6: [PERCENTILE_PROFILE_OURS]
};

const PROFILE_TABLE_MODULES = {
  [PERCENTILE_PROFILE_OURS]: {
    plo4: {
      modulePath: "./percentile-tables-ours-plo4.js",
      exportName: "PRECOMPUTED_PERCENTILE_TABLE_PLO4"
    },
    plo5: {
      modulePath: "./percentile-tables-ours-plo5.js",
      exportName: "PRECOMPUTED_PERCENTILE_TABLE_PLO5"
    }
  },
  [PERCENTILE_PROFILE_PPT6MAX]: {
    plo4: {
      modulePath: "./percentile-tables-ppt6max-plo4.js",
      exportName: "PPT_6MAX_PERCENTILE_TABLE_PLO4"
    },
    plo5: {
      modulePath: "./percentile-tables-ppt6max-plo5.js",
      exportName: "PPT_6MAX_PERCENTILE_TABLE_PLO5"
    }
  }
};

const PROFILE_TABLE_CACHE = new Map();
const PROFILE_TABLE_LOADS = new Map();
let BUILD_VERSION_LOAD = null;

function profileTableCacheKey(profile, variant) {
  return `${profile}|${variant}`;
}

function loadedProfileTable(profile, variant) {
  return PROFILE_TABLE_CACHE.get(profileTableCacheKey(profile, variant)) || null;
}

async function loadProfileTable(profile, variant) {
  const key = profileTableCacheKey(profile, variant);
  if (PROFILE_TABLE_CACHE.has(key)) return PROFILE_TABLE_CACHE.get(key) || null;
  if (PROFILE_TABLE_LOADS.has(key)) return PROFILE_TABLE_LOADS.get(key);

  const spec = PROFILE_TABLE_MODULES[profile]?.[variant];
  if (!spec) {
    PROFILE_TABLE_CACHE.set(key, null);
    return null;
  }

  const load = (async () => {
    try {
      const version = await loadBuildVersion();
      const modulePath = withVersionQuery(spec.modulePath, version);
      const mod = await import(modulePath);
      const table = mod?.[spec.exportName] || null;
      PROFILE_TABLE_CACHE.set(key, table);
      return table;
    } catch {
      PROFILE_TABLE_CACHE.set(key, null);
      return null;
    } finally {
      PROFILE_TABLE_LOADS.delete(key);
    }
  })();

  PROFILE_TABLE_LOADS.set(key, load);
  return load;
}

async function loadBuildVersion() {
  if (BUILD_VERSION_LOAD) return BUILD_VERSION_LOAD;
  BUILD_VERSION_LOAD = (async () => {
    try {
      const res = await fetch("/build-info.json", { cache: "no-store" });
      if (!res.ok) return "";
      const data = await res.json();
      return String(data?.gitSha || data?.deployedAtUtc || "").trim();
    } catch {
      return "";
    }
  })();
  return BUILD_VERSION_LOAD;
}

function withVersionQuery(path, version) {
  const v = String(version || "").trim();
  if (!v) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}v=${encodeURIComponent(v)}`;
}

export function percentileProfileOptionsForVariant(variant) {
  const key = String(variant || "").toLowerCase();
  const ids = PROFILE_OPTIONS_BY_VARIANT[key] || [PERCENTILE_PROFILE_OURS];
  return ids.map((id) => PROFILE_META[id]).filter(Boolean);
}

export function normalizePercentileProfile(variant, rawProfile) {
  const key = String(variant || "").toLowerCase();
  const wanted = String(rawProfile || "").trim().toLowerCase();
  const allowed = PROFILE_OPTIONS_BY_VARIANT[key] || [PERCENTILE_PROFILE_OURS];
  if (allowed.includes(wanted)) return wanted;
  return allowed[0] || PERCENTILE_PROFILE_OURS;
}

export function percentileProfileLabel(id) {
  return PROFILE_META[id]?.label || PROFILE_META[PERCENTILE_PROFILE_OURS].label;
}

export function resolvePercentileTable(variant, rawProfile) {
  const v = String(variant || "").toLowerCase();
  const profile = normalizePercentileProfile(v, rawProfile);
  if (profile === PERCENTILE_PROFILE_PPT6MAX) {
    return loadedProfileTable(PERCENTILE_PROFILE_PPT6MAX, v)
      || loadedProfileTable(PERCENTILE_PROFILE_OURS, v)
      || null;
  }
  return loadedProfileTable(PERCENTILE_PROFILE_OURS, v) || null;
}

export async function ensurePercentileTableLoaded(variant, rawProfile) {
  const v = String(variant || "").toLowerCase();
  const profile = normalizePercentileProfile(v, rawProfile);
  await loadProfileTable(profile, v);
  if (profile === PERCENTILE_PROFILE_PPT6MAX) {
    const ppt = loadedProfileTable(PERCENTILE_PROFILE_PPT6MAX, v);
    if (!ppt) await loadProfileTable(PERCENTILE_PROFILE_OURS, v);
  }
  return resolvePercentileTable(v, profile);
}
