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
    modulePath: "./percentile-tables.js",
    exportName: "PRECOMPUTED_PERCENTILE_TABLES"
  },
  [PERCENTILE_PROFILE_PPT6MAX]: {
    modulePath: "./percentile-tables-ppt6max.js",
    exportName: "PPT_6MAX_PERCENTILE_TABLES"
  }
};

const PROFILE_TABLE_CACHE = new Map();
const PROFILE_TABLE_LOADS = new Map();

function loadedProfileTables(profile) {
  return PROFILE_TABLE_CACHE.get(profile) || null;
}

async function loadProfileTables(profile) {
  if (PROFILE_TABLE_CACHE.has(profile)) return PROFILE_TABLE_CACHE.get(profile) || null;
  if (PROFILE_TABLE_LOADS.has(profile)) return PROFILE_TABLE_LOADS.get(profile);

  const spec = PROFILE_TABLE_MODULES[profile];
  if (!spec) {
    PROFILE_TABLE_CACHE.set(profile, null);
    return null;
  }

  const load = (async () => {
    try {
      const mod = await import(spec.modulePath);
      const tables = mod?.[spec.exportName] || null;
      PROFILE_TABLE_CACHE.set(profile, tables);
      return tables;
    } catch {
      PROFILE_TABLE_CACHE.set(profile, null);
      return null;
    } finally {
      PROFILE_TABLE_LOADS.delete(profile);
    }
  })();

  PROFILE_TABLE_LOADS.set(profile, load);
  return load;
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
    return loadedProfileTables(PERCENTILE_PROFILE_PPT6MAX)?.[v]
      || loadedProfileTables(PERCENTILE_PROFILE_OURS)?.[v]
      || null;
  }
  return loadedProfileTables(PERCENTILE_PROFILE_OURS)?.[v] || null;
}

export async function ensurePercentileTableLoaded(variant, rawProfile) {
  const v = String(variant || "").toLowerCase();
  const profile = normalizePercentileProfile(v, rawProfile);
  await loadProfileTables(profile);
  if (profile === PERCENTILE_PROFILE_PPT6MAX) {
    const ppt = loadedProfileTables(PERCENTILE_PROFILE_PPT6MAX);
    if (!ppt?.[v]) await loadProfileTables(PERCENTILE_PROFILE_OURS);
  }
  return resolvePercentileTable(v, profile);
}
