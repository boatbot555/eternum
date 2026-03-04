/**
 * Smart production automation for the onchain-agent.
 *
 * Exact port of the game client's "Smart" automation preset:
 *   client/apps/game/src/utils/automation-presets.ts       (tier percentages)
 *   client/apps/game/src/ui/features/infrastructure/automation/model/automation-processor.ts (plan builder)
 *
 * Algorithm:
 *  1. Load recipe configs from Torii SQL (ResourceFactoryConfig + ResourceList) — cached per toriiUrl.
 *  2. Fetch current resource balances for the realm entity.
 *  3. Apply the "smart" preset to compute per-resource allocation percentages.
 *  4. For each resource: maxCycles = floor((balance * percent%) / inputAmountPerCycle), capped by shared budget.
 *  5. Execute: burn_resource_for_resource_production (complex) + burn_labor_for_resource_production (simple).
 */

import { RESOURCE_BALANCE_COLUMNS } from "@bibliothecadao/torii";
import type { Account } from "starknet";
import type { EternumClient } from "@bibliothecadao/client";

// ---------------------------------------------------------------------------
// Constants (mirroring game client)
// ---------------------------------------------------------------------------

/** Max percent of any resource that automation is allowed to spend. */
const MAX_ALLOC_PERCENT = 90;

/** Default % of Donkey balance to spend on resource production. */
const DONKEY_DEFAULT_RESOURCE_PERCENT = 10;

const RESOURCE_PRECISION = 1_000_000_000n;

// Smart preset tier groupings (exact copy from automation-presets.ts)
const T1_RESOURCES = [3, 2, 4] as const; // Wood, Coal, Copper
const T2_RESOURCES = [7, 11, 5] as const; // Gold, ColdIron, Ironwood
const T3_RESOURCES = [19, 9, 22] as const; // Adamantine, Mithral, Dragonhide
const ARMY_T1 = [26, 29, 32] as const; // Knight, Crossbowman, Paladin
const ARMY_T2 = [27, 30, 33] as const; // KnightT2, CrossbowmanT2, PaladinT2
const ARMY_T3 = [28, 31, 34] as const; // KnightT3, CrossbowmanT3, PaladinT3

// Resources that can never be automated (Labor, Wheat, Fish, Lords, Essence, AncientFragment)
const BLOCKED = new Set([23, 35, 36, 37, 38, 24]);

// ---------------------------------------------------------------------------
// Recipe types (mirrors configManager structure)
// ---------------------------------------------------------------------------

export interface RecipeInput {
  resource: number;
  amount: number; // human-readable units (already divided by RESOURCE_PRECISION)
}

export interface ResourceRecipe {
  complexInputs: RecipeInput[];   // for burn_resource_for_resource_production
  complexOutputPerCycle: number;  // units produced per cycle
  simpleInputs: RecipeInput[];    // for burn_labor_for_resource_production
  simpleOutputPerCycle: number;
}

export type RecipeMap = Map<number, ResourceRecipe>;

// ---------------------------------------------------------------------------
// Recipe loader (fetches from Torii SQL, cached per URL)
// ---------------------------------------------------------------------------

const recipeCache = new Map<string, { recipes: RecipeMap; fetchedAt: number }>();
const RECIPE_CACHE_TTL_MS = 5 * 60_000; // 5 minutes

async function fetchJson(url: string): Promise<any> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${url}`);
  const data = await resp.json();
  if (data && typeof data === "object" && "error" in data) {
    throw new Error(`Torii error: ${JSON.stringify(data.error)}`);
  }
  return data;
}

function buildToriiUrl(toriiSqlBase: string, query: string): string {
  const base = toriiSqlBase.replace(/\/+$/, "");
  return `${base}?query=${encodeURIComponent(query)}`;
}

/**
 * Load all recipe configs from Torii SQL.
 * Fetches ResourceFactoryConfig and the corresponding ResourceList entries.
 */
export async function loadRecipes(toriiSqlUrl: string): Promise<RecipeMap> {
  const cached = recipeCache.get(toriiSqlUrl);
  if (cached && Date.now() - cached.fetchedAt < RECIPE_CACHE_TTL_MS) {
    return cached.recipes;
  }

  // 1. Fetch all ResourceFactoryConfig rows
  const factoryRows: any[] = await fetchJson(
    buildToriiUrl(
      toriiSqlUrl,
      "SELECT resource_type, complex_input_list_id, complex_input_list_count, output_per_complex_input, simple_input_list_id, simple_input_list_count, output_per_simple_input FROM `s1_eternum-ResourceFactoryConfig`",
    ),
  );

  // Collect all list IDs we need
  const listIds = new Set<number>();
  for (const row of factoryRows) {
    if (Number(row.complex_input_list_count) > 0) listIds.add(Number(row.complex_input_list_id));
    if (Number(row.simple_input_list_count) > 0) listIds.add(Number(row.simple_input_list_id));
  }

  // 2. Fetch all ResourceList entries for those IDs
  const listRows: any[] = listIds.size > 0
    ? await fetchJson(
        buildToriiUrl(
          toriiSqlUrl,
          `SELECT entity_id, \`index\`, resource_type, amount FROM \`s1_eternum-ResourceList\` WHERE entity_id IN (${[...listIds].join(",")}) ORDER BY entity_id, \`index\``,
        ),
      )
    : [];

  // Build a map: listId → ordered entries
  const listMap = new Map<number, RecipeInput[]>();
  for (const row of listRows) {
    const listId = Number(row.entity_id);
    if (!listMap.has(listId)) listMap.set(listId, []);
    const amount = Number(BigInt(row.amount) / RESOURCE_PRECISION);
    // Only include non-zero-amount inputs (0-amount entries are placeholder slots)
    if (amount > 0) {
      listMap.get(listId)!.push({ resource: Number(row.resource_type), amount });
    }
  }

  // 3. Build RecipeMap
  const recipes: RecipeMap = new Map();
  for (const row of factoryRows) {
    const resourceId = Number(row.resource_type);
    const complexListId = Number(row.complex_input_list_id);
    const complexCount = Number(row.complex_input_list_count);
    const complexOutput = Number(BigInt(row.output_per_complex_input) / RESOURCE_PRECISION);
    const simpleListId = Number(row.simple_input_list_id);
    const simpleCount = Number(row.simple_input_list_count);
    const simpleOutput = Number(BigInt(row.output_per_simple_input) / RESOURCE_PRECISION);

    recipes.set(resourceId, {
      complexInputs: complexCount > 0 ? (listMap.get(complexListId) ?? []) : [],
      complexOutputPerCycle: complexOutput,
      simpleInputs: simpleCount > 0 ? (listMap.get(simpleListId) ?? []) : [],
      simpleOutputPerCycle: simpleOutput,
    });
  }

  recipeCache.set(toriiSqlUrl, { recipes, fetchedAt: Date.now() });
  return recipes;
}

// ---------------------------------------------------------------------------
// Balance parser
// ---------------------------------------------------------------------------

/**
 * Parse a resource balance row from Torii SQL into a map of resourceId → human-readable balance.
 */
export function parseResourceBalances(row: any): Map<number, number> {
  const result = new Map<number, number>();
  for (const col of RESOURCE_BALANCE_COLUMNS) {
    const raw = row[col.column];
    if (!raw || raw === "0x0") continue;
    const human = Number(BigInt(raw) / RESOURCE_PRECISION);
    if (human > 0) result.set(col.resourceId, human);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Smart preset allocations (exact port of buildSmartPresetAllocations)
// ---------------------------------------------------------------------------

interface AllocationPercentages {
  resourceToResource: number; // % of balance to spend on complex recipe
  laborToResource: number;    // % of balance to spend on simple (labor) recipe
}

function clampPercent(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.min(Math.round(v), MAX_ALLOC_PERCENT);
}

function buildSequentialWeights(count: number, baseWeights: number[]): number[] {
  if (count <= 0) return [];
  if (count === 1) return [baseWeights[0] ?? 0];
  if (count === 2) return [baseWeights[1] ?? baseWeights[0] ?? 0, baseWeights[1] ?? baseWeights[0] ?? 0];
  const fallback = baseWeights[2] ?? baseWeights[baseWeights.length - 1] ?? 0;
  return Array.from({ length: count }, () => fallback);
}

type AllocMap = Map<number, AllocationPercentages>;

function assignTierWeights(
  target: AllocMap,
  resourceIds: readonly number[],
  weights: number[],
  mode: "resource" | "labor",
) {
  resourceIds.forEach((resourceId, i) => {
    const weight = clampPercent(weights[i] ?? 0);
    const existing = target.get(resourceId) ?? { resourceToResource: 0, laborToResource: 0 };
    target.set(resourceId, {
      resourceToResource: mode === "resource" ? weight : existing.resourceToResource,
      laborToResource: mode === "labor" ? weight : existing.laborToResource,
    });
  });
}

/**
 * Calculate the "Smart" preset allocations for a set of produced resource IDs.
 * Exact port of `buildSmartPresetAllocations` from automation-presets.ts.
 */
export function calculateSmartPreset(producedIds: number[]): AllocMap {
  const alloc: AllocMap = new Map();
  const present = new Set(producedIds.filter((id) => !BLOCKED.has(id)));

  const presentT1 = T1_RESOURCES.filter((id) => present.has(id));
  const presentT2 = T2_RESOURCES.filter((id) => present.has(id));
  const presentT3 = T3_RESOURCES.filter((id) => present.has(id));
  const presentAT1 = ARMY_T1.filter((id) => present.has(id));
  const presentAT2 = ARMY_T2.filter((id) => present.has(id));
  const presentAT3 = ARMY_T3.filter((id) => present.has(id));

  const t1Complete = T1_RESOURCES.every((id) => present.has(id));
  const hasHigher =
    presentT2.length > 0 || presentT3.length > 0 ||
    presentAT1.length > 0 || presentAT2.length > 0 || presentAT3.length > 0;

  // T1
  if (presentT1.length > 0) {
    if (!t1Complete) {
      // Incomplete T1: 5% labor each
      assignTierWeights(alloc, presentT1, presentT1.map(() => 5), "labor");
    } else if (!hasHigher) {
      // T1 only: 30% resource each
      assignTierWeights(alloc, T1_RESOURCES, [30, 30, 30], "resource");
    } else {
      // T1 + higher: 20% Wood, 20% Coal, 30% Copper (ordered: Wood, Coal, Copper)
      const ordered = [3, 2, 4] as const; // Wood, Coal, Copper
      assignTierWeights(
        alloc,
        ordered.filter((id) => present.has(id)),
        [20, 20, 30],
        "resource",
      );
    }
  }

  // T2 (only if T1 complete)
  if (t1Complete && presentT2.length > 0) {
    assignTierWeights(
      alloc,
      T2_RESOURCES.filter((id) => present.has(id)),
      buildSequentialWeights(presentT2.length, [10, 5, 3]),
      "resource",
    );
  }

  // T3 (only if T1 complete)
  if (t1Complete && presentT3.length > 0) {
    assignTierWeights(
      alloc,
      T3_RESOURCES.filter((id) => present.has(id)),
      buildSequentialWeights(presentT3.length, [10, 5, 3]),
      "resource",
    );
  }

  // Army allocations
  if (presentAT3.length > 0) {
    assignTierWeights(alloc, presentAT3, buildSequentialWeights(presentAT3.length, [50, 25, 15]), "resource");
    if (presentAT2.length > 0) assignTierWeights(alloc, presentAT2, buildSequentialWeights(presentAT2.length, [30, 15, 10]), "resource");
    if (presentAT1.length > 0) assignTierWeights(alloc, presentAT1, buildSequentialWeights(presentAT1.length, [10, 5, 3]), "resource");
  } else if (presentAT2.length > 0) {
    assignTierWeights(alloc, presentAT2, buildSequentialWeights(presentAT2.length, [30, 15, 10]), "resource");
    if (presentAT1.length > 0) assignTierWeights(alloc, presentAT1, buildSequentialWeights(presentAT1.length, [10, 5, 3]), "resource");
  } else if (presentAT1.length > 0) {
    assignTierWeights(alloc, presentAT1, buildSequentialWeights(presentAT1.length, [30, 20, 10]), "resource");
  }

  // Donkey — always resource slider at default %
  if (present.has(25)) {
    alloc.set(25, { resourceToResource: DONKEY_DEFAULT_RESOURCE_PERCENT, laborToResource: 0 });
  }

  // Ensure every produced resource has an entry
  for (const id of present) {
    if (!alloc.has(id)) alloc.set(id, { resourceToResource: 0, laborToResource: 0 });
  }

  return alloc;
}

// ---------------------------------------------------------------------------
// Production plan builder (exact port of buildRealmProductionPlan)
// ---------------------------------------------------------------------------

export interface ProductionCycle {
  resourceId: number;
  cycles: number;
}

export interface ProductionPlan {
  resourceToResource: ProductionCycle[]; // burn_resource_for_resource_production
  laborToResource: ProductionCycle[];    // burn_labor_for_resource_production
  skipped: { resourceId: number; reason: string }[];
  // Debug summary
  consumptionByResource: Record<number, number>;
  outputsByResource: Record<number, number>;
}

/**
 * Build a full production plan.
 * Exact port of `buildRealmProductionPlan` from automation-processor.ts.
 */
export function buildProductionPlan(
  producedIds: number[],
  balances: Map<number, number>,
  recipes: RecipeMap,
): ProductionPlan {
  const present = new Set(producedIds.filter((id) => !BLOCKED.has(id)));
  const alloc = calculateSmartPreset([...present]);

  const resourceToResource: ProductionCycle[] = [];
  const laborToResource: ProductionCycle[] = [];
  const skipped: ProductionPlan["skipped"] = [];
  const consumptionByResource: Record<number, number> = {};
  const outputsByResource: Record<number, number> = {};

  // Collect all resources needed as inputs so we can track shared budget
  const resourcesToTrack = new Set<number>();
  for (const [resourceId, pct] of alloc.entries()) {
    if (pct.resourceToResource > 0 || pct.laborToResource > 0) {
      resourcesToTrack.add(resourceId);
      const recipe = recipes.get(resourceId);
      if (recipe) {
        if (pct.resourceToResource > 0) recipe.complexInputs.forEach((i) => resourcesToTrack.add(i.resource));
        if (pct.laborToResource > 0) recipe.simpleInputs.forEach((i) => resourcesToTrack.add(i.resource));
      }
    }
  }

  // Build budget: each resource can spend at most MAX_ALLOC_PERCENT% of its balance
  const totalAvailable = new Map<number, number>();
  const availableBudget = new Map<number, number>();
  for (const id of resourcesToTrack) {
    const bal = balances.get(id) ?? 0;
    totalAvailable.set(id, bal);
    availableBudget.set(id, Math.floor((bal * MAX_ALLOC_PERCENT) / 100));
  }

  const getBudget = (id: number) => availableBudget.get(id) ?? 0;
  const getTotal = (id: number) => totalAvailable.get(id) ?? 0;

  const reserveAmount = (id: number, amount: number): boolean => {
    if (!Number.isFinite(amount) || amount <= 0) return false;
    const current = availableBudget.get(id) ?? 0;
    if (current < amount) return false;
    availableBudget.set(id, current - amount);
    consumptionByResource[id] = (consumptionByResource[id] ?? 0) + amount;
    return true;
  };

  // Process resources in sorted order (deterministic)
  const orderedIds = [...present].sort((a, b) => a - b);

  for (const resourceId of orderedIds) {
    const pct = alloc.get(resourceId);
    if (!pct) continue;
    const recipe = recipes.get(resourceId);

    // ---- complex recipe (burn_resource_for_resource_production) ----
    if (pct.resourceToResource > 0) {
      if (!recipe || recipe.complexInputs.length === 0 || recipe.complexOutputPerCycle <= 0) {
        skipped.push({ resourceId, reason: "No complex recipe config" });
      } else {
        let maxCycles = Infinity;
        for (const input of recipe.complexInputs) {
          if (input.amount <= 0) continue;
          const total = getTotal(input.resource);
          const budget = getBudget(input.resource);
          if (total <= 0 || budget <= 0) { maxCycles = 0; break; }
          const desired = Math.floor((total * pct.resourceToResource) / 100);
          if (desired <= 0) { maxCycles = 0; break; }
          const permitted = Math.min(desired, budget);
          maxCycles = Math.min(maxCycles, Math.floor(permitted / input.amount));
        }

        if (!Number.isFinite(maxCycles) || maxCycles <= 0) {
          skipped.push({ resourceId, reason: "Insufficient complex recipe inputs" });
        } else {
          let ok = true;
          for (const input of recipe.complexInputs) {
            if (input.amount <= 0) continue;
            if (!reserveAmount(input.resource, input.amount * maxCycles)) { ok = false; break; }
          }
          if (!ok) {
            skipped.push({ resourceId, reason: "Budget exhausted for complex recipe" });
          } else {
            const produced = recipe.complexOutputPerCycle * maxCycles;
            outputsByResource[resourceId] = (outputsByResource[resourceId] ?? 0) + produced;
            resourceToResource.push({ resourceId, cycles: maxCycles });
          }
        }
      }
    }

    // ---- simple recipe (burn_labor_for_resource_production) ----
    if (pct.laborToResource > 0) {
      if (!recipe || recipe.simpleInputs.length === 0 || recipe.simpleOutputPerCycle <= 0) {
        skipped.push({ resourceId, reason: "No simple/labor recipe config" });
      } else {
        let maxCycles = Infinity;
        for (const input of recipe.simpleInputs) {
          if (input.amount <= 0) continue;
          const total = getTotal(input.resource);
          const budget = getBudget(input.resource);
          if (total <= 0 || budget <= 0) { maxCycles = 0; break; }
          const desired = Math.floor((total * pct.laborToResource) / 100);
          if (desired <= 0) { maxCycles = 0; break; }
          const permitted = Math.min(desired, budget);
          maxCycles = Math.min(maxCycles, Math.floor(permitted / input.amount));
        }

        if (!Number.isFinite(maxCycles) || maxCycles <= 0) {
          skipped.push({ resourceId, reason: "Insufficient simple recipe inputs" });
        } else {
          let ok = true;
          for (const input of recipe.simpleInputs) {
            if (input.amount <= 0) continue;
            if (!reserveAmount(input.resource, input.amount * maxCycles)) { ok = false; break; }
          }
          if (!ok) {
            skipped.push({ resourceId, reason: "Budget exhausted for simple recipe" });
          } else {
            const produced = recipe.simpleOutputPerCycle * maxCycles;
            outputsByResource[resourceId] = (outputsByResource[resourceId] ?? 0) + produced;
            laborToResource.push({ resourceId, cycles: maxCycles });
          }
        }
      }
    }
  }

  return { resourceToResource, laborToResource, skipped, consumptionByResource, outputsByResource };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export interface SmartProductionResult {
  success: boolean;
  txHash?: string;
  plan?: ProductionPlan;
  error?: string;
}

/**
 * Run smart production for a realm.
 * Fetches live balances from Torii, loads recipes (cached), computes plan, executes.
 *
 * @param toriiSqlUrl - The Torii SQL endpoint (e.g. https://api.cartridge.gg/x/my-slot/torii/sql)
 */
export async function runSmartProduction(
  client: EternumClient,
  signer: Account,
  realmEntityId: number,
  producedResourceIds: number[],
  toriiSqlUrl: string,
): Promise<SmartProductionResult> {
  if (!toriiSqlUrl) return { success: false, error: "toriiSqlUrl is required." };

  // Load recipes from Torii (cached)
  let recipes: RecipeMap;
  try {
    recipes = await loadRecipes(toriiSqlUrl);
  } catch (err: any) {
    return { success: false, error: `Failed to load recipes: ${err?.message ?? String(err)}` };
  }

  // Fetch current balances for this realm
  let balances: Map<number, number>;
  try {
    const fetchFn = (client.sql as any).fetchResourceBalancesWithProduction ?? client.sql.fetchResourceBalances;
    const rows: any[] = await fetchFn.call(client.sql, [realmEntityId]);
    if (!rows || rows.length === 0) return { success: false, error: `No balance row found for entity ${realmEntityId}` };
    balances = parseResourceBalances(rows[0]);
  } catch (err: any) {
    return { success: false, error: `Failed to fetch balances: ${err?.message ?? String(err)}` };
  }

  // Build plan
  const plan = buildProductionPlan(producedResourceIds, balances, recipes);

  if (plan.resourceToResource.length === 0 && plan.laborToResource.length === 0) {
    const skipReasons = plan.skipped.map((s) => `${s.resourceId}: ${s.reason}`).join(", ");
    return {
      success: false,
      plan,
      error: `No executable production cycles. Skipped: [${skipReasons || "none"}]`,
    };
  }

  // Execute
  try {
    const result = await (client.provider as any).execute_realm_production_plan({
      signer,
      realm_entity_id: realmEntityId,
      resource_to_resource: plan.resourceToResource.map((p) => ({
        resource_id: p.resourceId,
        cycles: p.cycles,
      })),
      labor_to_resource: plan.laborToResource.map((p) => ({
        resource_id: p.resourceId,
        cycles: p.cycles,
      })),
    });

    const txHash = (result as any)?.transactionHash ?? (result as any)?.transaction_hash;
    if (!txHash) return { success: false, plan, error: `execute_realm_production_plan returned no txHash: ${JSON.stringify(result)}` };

    return { success: true, txHash, plan };
  } catch (err: any) {
    return { success: false, plan, error: `Execution failed: ${err?.message ?? String(err)}` };
  }
}
