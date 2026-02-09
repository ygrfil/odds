import { PRECOMPUTED_PERCENTILE_TABLES } from "./percentile-tables.js";
import { PPT_6MAX_PERCENTILE_TABLES } from "./percentile-tables-ppt6max.js";

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
    return PPT_6MAX_PERCENTILE_TABLES?.[v] || PRECOMPUTED_PERCENTILE_TABLES?.[v] || null;
  }
  return PRECOMPUTED_PERCENTILE_TABLES?.[v] || null;
}
