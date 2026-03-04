/**
 * ABI-driven action registry.
 *
 * Replaces the old hardcoded register() calls with dynamic generation from
 * manifest ABIs + domain overlays. All standard game actions are handled by
 * the ABI executor (Contract.populate + account.execute). The composite
 * "move_to" action is the only hand-written handler.
 */
import type { EternumClient } from "@bibliothecadao/client";
import type { ActionResult, GameAction, ActionDefinition } from "@bibliothecadao/game-agent";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Account } from "starknet";
import { generateActions, mergeCompositeActions } from "../abi/action-gen";
import { createABIExecutor, type ABIExecutor } from "../abi/executor";
import { ETERNUM_OVERLAYS, createHiddenOverlays, num, bool, numArray, precisionAmount } from "../abi/domain-overlay";
import { getDirectionBetweenAdjacentHexes, getNeighborHexes, packTileSeed } from "@bibliothecadao/types";
import type { Manifest } from "../abi/types";
import { runSmartProduction } from "./smart-production";
import { buildWorldState, type EternumWorldState, toContract, toDisplay, getMapCenter } from "./world-state";

// ---------------------------------------------------------------------------
// Module state — populated by initializeActions()
// ---------------------------------------------------------------------------

let _executor: ABIExecutor | undefined;
let _actionDefs: ActionDefinition[] = [];
let _actionTypes = new Set<string>();
let _initialized = false;
let _toriiSqlUrl: string | undefined;

/** Token addresses from world profile, used by approve_token action. */
export interface TokenConfig {
  feeToken?: string;
  entryToken?: string;
  worldAddress?: string;
}
let _tokenConfig: TokenConfig = {};

/** Blitz contract address — populated during initializeActions from routes. */
let _blitzAddress: string | undefined;

// ---------------------------------------------------------------------------
// Cached world state — updated every tick, used for pre-flight validation.
// ---------------------------------------------------------------------------

let _cachedWorldState: EternumWorldState | undefined;

/** Cache the latest world state for pre-flight validation in action handlers. */
export function setCachedWorldState(state: EternumWorldState) {
  _cachedWorldState = state;
}

// ---------------------------------------------------------------------------
// World state provider for move_to
// ---------------------------------------------------------------------------

let _worldStateProvider: ((client: EternumClient) => Promise<EternumWorldState>) | undefined;

/**
 * Set the world state provider so move_to can fetch current tile map.
 * Call once during adapter initialization with the account address.
 */
export function setWorldStateProvider(accountAddress: string) {
  _worldStateProvider = (client: EternumClient) => buildWorldState(client, accountAddress);
}

// ---------------------------------------------------------------------------
// Debug logging
// ---------------------------------------------------------------------------

function logAction(actionType: string, result: ActionResult) {
  try {
    const debugPath = join(
      process.env.AGENT_DATA_DIR || join(process.env.HOME || "/tmp", ".eternum-agent", "data"),
      "debug",
      "actions.log",
    );
    mkdirSync(dirname(debugPath), { recursive: true });
    const ts = new Date().toISOString();
    const status = result.success ? `OK tx=${result.txHash}` : `FAIL: ${result.error}`;
    writeFileSync(debugPath, `[${ts}] ${actionType} => ${status}\n`, { flag: "a" });
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Initialize the ABI-driven action registry from a manifest.
 *
 * Must be called before getActionDefinitions() or executeAction().
 * Typically called from EternumGameAdapter constructor.
 */
export function initializeActions(
  manifest: Manifest,
  account: Account,
  options: { gameName?: string; tokenConfig?: TokenConfig; toriiSqlUrl?: string } = {},
) {
  _tokenConfig = options.tokenConfig ?? {};
  if (options.toriiSqlUrl) _toriiSqlUrl = options.toriiSqlUrl;

  // Build overlays (domain enrichments + hidden admin entrypoints)
  const hiddenOverlays = createHiddenOverlays(manifest);
  const overlays = { ...ETERNUM_OVERLAYS, ...hiddenOverlays };

  // Generate action definitions and routing table from manifest ABIs
  const generated = generateActions(manifest, {
    overlays,
    gameName: options.gameName,
  });

  // Look up the blitz contract address from routes for composite actions
  const blitzRoute = generated.routes.get("obtain_entry_token");
  const blitzAddress = blitzRoute?.contractAddress;
  _blitzAddress = blitzAddress;

  // Build dynamic description for approve_token with known addresses
  let approveDesc =
    "Approve a spender to transfer ERC-20 tokens on your behalf. " +
    "Required before Blitz registration: approve the fee token for the blitz contract, then call obtain_entry_token.";
  if (_tokenConfig.feeToken) approveDesc += ` Fee token: ${_tokenConfig.feeToken}.`;
  if (_tokenConfig.entryToken) approveDesc += ` Entry token: ${_tokenConfig.entryToken}.`;
  if (blitzAddress) approveDesc += ` Blitz contract (spender): ${blitzAddress}.`;

  // Build dynamic description for lock_entry_token with known addresses
  let lockDesc =
    "Lock an entry token NFT before registering for a Blitz game. " +
    "Call AFTER obtain_entry_token and BEFORE register. " +
    "The token_id comes from obtain_entry_token. The lock_id is always 69 (hardcoded).";
  if (_tokenConfig.entryToken) lockDesc += ` Entry token contract: ${_tokenConfig.entryToken}.`;

  // Add composite actions that orchestrate multiple base actions
  const withComposites = mergeCompositeActions(generated, [
    {
      definition: {
        type: "explorer_move",
        description:
          "Move an explorer one tile in a direction (0-5). The world state shows each explorer's 6 adjacent tiles " +
          "as 'dir0=(x,y)(biome) dir1=...' — pick the direction number for the tile you want. " +
          "Automatically uses VRF for unexplored tiles and simple travel for explored tiles.",
        params: [
          { name: "explorer_id", type: "number", description: "Explorer entity ID", required: true },
          {
            name: "direction",
            type: "number",
            description: "Direction to move: 0-5 (shown as dirN= in world state adjacent tile list)",
            required: true,
          },
          {
            name: "explore",
            type: "boolean",
            description: "Optional override. Default: auto-detected (true if tile is unexplored, false if explored)",
            required: false,
          },
        ],
      },
    },
    {
      definition: {
        type: "approve_token",
        description: approveDesc,
        params: [
          { name: "token_address", type: "string", description: "Token contract address to approve", required: true },
          {
            name: "spender",
            type: "string",
            description: "Contract address allowed to spend your tokens",
            required: true,
          },
          {
            name: "amount",
            type: "string",
            description:
              "Amount to approve in base units (wei). Use '340282366920938463463374607431768211455' for max u128 approval.",
            required: true,
          },
        ],
      },
    },
    {
      definition: {
        type: "lock_entry_token",
        description: lockDesc + " Lock ID is always 69 (hardcoded).",
        params: [
          {
            name: "token_id",
            type: "number",
            description: "Entry token ID to lock (obtained from obtain_entry_token)",
            required: true,
          },
          {
            name: "token_address",
            type: "string",
            description: "Entry token contract address (auto-filled from config if omitted)",
            required: false,
          },
        ],
      },
    },
    {
      definition: {
        type: "settle_blitz_realm",
        description:
          "Settle your realm(s) after registration. Bundles VRF randomness request, realm position assignment, " +
          "and realm creation into a single atomic multicall. Call AFTER register.",
        params: [
          {
            name: "settlement_count",
            type: "number",
            description: "Number of realms to settle (default: 1)",
            required: false,
          },
        ],
      },
    },
    {
      definition: {
        type: "run_smart_production",
        description:
          "Run smart production automation for a realm — covers ALL production buildings (Wood Mill, Copper Mine, " +
          "Coal Mine, Gold Mine, Ironwood Grove, troop buildings, etc). Queues burn cycles for every resource " +
          "the realm produces: T1 resources (Wood=3, Coal=2, Copper=4) first via labor, then T2/T3 via resource " +
          "conversion, then armies (Knight=26, Crossbowman=29, Paladin=32, etc), then Donkey=25. " +
          "Calls burn_resource_for_resource_production and/or burn_labor_for_resource_production as needed. " +
          "Call this EVERY tick to keep all production buildings running.",
        params: [
          {
            name: "realmEntityId",
            type: "number",
            description: "Realm entity ID to run production for",
            required: true,
          },
          {
            name: "producedResourceIds",
            type: "number[]",
            description:
              "Optional override — leave blank and it auto-detects from world state. " +
              "Only set this if you want to override which resources get queued.",
            required: false,
          },
          {
            name: "cyclesPerResource",
            type: "number",
            description: "Production cycles to queue per resource (default: 5). More cycles = more output per call.",
            required: false,
          },
        ],
      },
    },
  ]);

  _actionDefs = withComposites.definitions;
  _actionTypes = new Set(withComposites.routes.keys());
  // explorer_move is our composite handler (replaces raw ABI explorer_move with VRF support)
  _actionTypes.delete("explorer_move"); // Remove ABI version — re-added as composite below
  _actionTypes.add("explorer_move");    // Composite with VRF auto-detect
  _actionTypes.add("approve_token"); // Not in routes (composite)
  _actionTypes.add("lock_entry_token"); // Not in routes (composite)
  _actionTypes.add("settle_blitz_realm"); // Not in routes (composite)
  _actionTypes.add("run_smart_production"); // Not in routes (composite)

  // Create ABI executor for standard actions
  _executor = createABIExecutor(manifest, account, {
    routes: withComposites.routes,
    cachedStateProvider: () => _cachedWorldState,
    onAfterExecute: logAction,
  });

  _initialized = true;
}

// ---------------------------------------------------------------------------
// explorer_move handler — move one tile by direction number (shown in world state adjacent tiles)
// ---------------------------------------------------------------------------

async function handleExplorerMove(
  client: EternumClient,
  signer: Account,
  params: Record<string, unknown>,
): Promise<ActionResult> {
  if (!_worldStateProvider) {
    return { success: false, error: "World state provider not initialized." };
  }

  try {
    // Parse explorer_id — strip any non-numeric prefix (e.g. "army#1119" → 1119, "#1119" → 1119)
    const rawId = String(params.explorer_id ?? params.explorerId ?? "");
    const explorerId = parseInt(rawId.replace(/[^0-9]/g, ""), 10);
    if (isNaN(explorerId)) {
      return { success: false, error: `Invalid explorer_id: ${rawId}` };
    }

    // Parse direction — accept number or string like "dir0", "0", "DIR_0", etc.
    const rawDir = String(params.direction ?? "");
    const direction = parseInt(rawDir.replace(/[^0-9]/g, ""), 10);
    if (isNaN(direction) || direction < 0 || direction > 5) {
      return { success: false, error: `direction must be 0-5. Got: ${rawDir}` };
    }

    // Get current position to compute target tile coords for VRF seed
    const worldState = await _worldStateProvider(client);
    const explorer = worldState.entities.find((e) => e.entityId === explorerId && e.type === "army");
    if (!explorer) {
      return { success: false, error: `Explorer ${explorerId} not found in world state.` };
    }

    const fromCol = explorer.position.x;
    const fromRow = explorer.position.y;

    // Compute target tile coords from direction
    const neighbors = getNeighborHexes(fromCol, fromRow);
    const targetNeighbor = neighbors.find((n: any) => n.direction === direction);
    if (!targetNeighbor) {
      return { success: false, error: `Could not compute target tile for direction ${direction}` };
    }
    const targetCol = targetNeighbor.col;
    const targetRow = targetNeighbor.row;

    // Auto-detect explore: unexplored tile → explore=true (VRF), explored → explore=false (travel)
    const targetTile = worldState.tileMap.get(`${targetCol},${targetRow}`);
    const tileIsExplored = targetTile !== undefined && targetTile.biome !== 0;
    const explore = params.explore !== undefined ? bool(params.explore) : !tileIsExplored;

    const vrfSourceSalt = packTileSeed({ alt: false, col: targetCol, row: targetRow });

    const result = await client.troops.move(signer as any, {
      explorerId,
      directions: [direction],
      explore,
      vrfSourceSalt,
    });

    const txHash = (result as any)?.transactionHash ?? (result as any)?.transaction_hash;
    if (!txHash) {
      return { success: false, error: `explorer_move failed: ${JSON.stringify(result)}` };
    }

    logAction("explorer_move", { success: true, txHash });
    return {
      success: true,
      txHash,
      data: {
        txHash,
        explorerId,
        direction,
        from: `(${toDisplay(fromCol)},${toDisplay(fromRow)})`,
        to: `(${toDisplay(targetCol)},${toDisplay(targetRow)})`,
        explore,
        note: explore ? "explored new tile" : "traveled to known tile",
      },
    };
  } catch (err: any) {
    return { success: false, error: `explorer_move exception: ${err?.message ?? String(err)}` };
  }
}

// ---------------------------------------------------------------------------
// approve_token handler (composite action)
// ---------------------------------------------------------------------------

async function handleApproveToken(signer: Account, params: Record<string, unknown>): Promise<ActionResult> {
  const tokenAddress = String(params.token_address ?? params.tokenAddress ?? "");
  const spender = String(params.spender ?? "");
  const rawAmount = BigInt(String(params.amount ?? "0"));

  if (!tokenAddress || !spender) {
    return { success: false, error: "token_address and spender are required" };
  }

  // Split into uint256 (low, high) for starknet calldata
  const low = (rawAmount & ((1n << 128n) - 1n)).toString();
  const high = (rawAmount >> 128n).toString();

  try {
    const result = await signer.execute({
      contractAddress: tokenAddress,
      entrypoint: "approve",
      calldata: [spender, low, high],
    });
    const txHash = result?.transaction_hash ?? (result as any)?.transactionHash;
    return { success: true, txHash };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}

// ---------------------------------------------------------------------------
// lock_entry_token handler (composite action)
// ---------------------------------------------------------------------------

async function handleLockEntryToken(signer: Account, params: Record<string, unknown>): Promise<ActionResult> {
  const tokenAddress = String(params.token_address ?? params.tokenAddress ?? _tokenConfig.entryToken ?? "");
  const tokenId = BigInt(String(params.token_id ?? params.tokenId ?? "0"));
  const lockId = BigInt(69); // Always 69 — hardcoded constant

  if (!tokenAddress) {
    return { success: false, error: "token_address is required (or set via entryToken config)" };
  }
  if (tokenId === 0n) {
    return { success: false, error: "token_id is required and must be non-zero" };
  }

  // token_id is u256 (low, high), lock_id is felt252
  const low = (tokenId & ((1n << 128n) - 1n)).toString();
  const high = (tokenId >> 128n).toString();

  try {
    const result = await signer.execute({
      contractAddress: tokenAddress,
      entrypoint: "token_lock",
      calldata: [low, high, lockId.toString()],
    });
    const txHash = result?.transaction_hash ?? (result as any)?.transactionHash;
    return { success: true, txHash };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}

// ---------------------------------------------------------------------------
// settle_blitz_realm handler (composite action)
// ---------------------------------------------------------------------------

const VRF_PROVIDER_ADDRESS = "0x051fea4450da9d6aee758bdeba88b2f665bcbf549d2c61421aa724e9ac0ced8f";

async function handleSettleBlitzRealm(signer: Account, params: Record<string, unknown>): Promise<ActionResult> {
  const blitzAddress = _blitzAddress;
  if (!blitzAddress) {
    return { success: false, error: "Blitz contract address not found in manifest routes" };
  }

  const settlementCount = Number(params.settlement_count ?? params.settlementCount ?? 1);
  if (settlementCount < 1) {
    return { success: false, error: "settlement_count must be at least 1" };
  }

  // Step 1: VRF randomness request
  try {
    await signer.execute({
      contractAddress: VRF_PROVIDER_ADDRESS,
      entrypoint: "request_random",
      calldata: [blitzAddress, "0", signer.address],
    });
  } catch (err: any) {
    return { success: false, error: `Step 1/3 failed — VRF request_random: ${err?.message ?? String(err)}` };
  }

  // Step 2: Assign realm positions
  try {
    await signer.execute({
      contractAddress: blitzAddress,
      entrypoint: "assign_realm_positions",
      calldata: [],
    });
  } catch (err: any) {
    return { success: false, error: `Step 2/3 failed — assign_realm_positions: ${err?.message ?? String(err)}` };
  }

  // Step 3: Settle realms
  try {
    const result = await signer.execute({
      contractAddress: blitzAddress,
      entrypoint: "settle_realms",
      calldata: [settlementCount.toString()],
    });
    const txHash = result?.transaction_hash ?? (result as any)?.transactionHash;
    return { success: true, txHash, data: { settlementCount } };
  } catch (err: any) {
    return { success: false, error: `Step 3/3 failed — settle_realms: ${err?.message ?? String(err)}` };
  }
}

// ---------------------------------------------------------------------------
// move_explorer handler — uses provider for explore (VRF multicall), ABI for travel
// ---------------------------------------------------------------------------



// ---------------------------------------------------------------------------
// add_to_explorer handler — auto-compute home_direction
// ---------------------------------------------------------------------------

async function handleAddToExplorer(
  client: EternumClient,
  signer: Account,
  params: Record<string, unknown>,
): Promise<ActionResult> {
  const explorerId = num(params.to_explorer_id ?? params.toExplorerId);
  const amount = params.amount;

  if (!explorerId) {
    return { success: false, error: "to_explorer_id is required" };
  }
  if (!amount) {
    return { success: false, error: "amount is required" };
  }

  // Look up explorer and its home structure from cached world state
  if (!_cachedWorldState) {
    return { success: false, error: "World state not available. Wait for next tick." };
  }

  const explorer = _cachedWorldState.entities.find((e) => e.entityId === explorerId && e.type === "army" && e.isOwned);
  if (!explorer) {
    return { success: false, error: `Explorer #${explorerId} not found in your armies.` };
  }

  // Find the explorer's home structure — the nearest owned structure
  const ownedStructures = _cachedWorldState.entities.filter((e) => e.type === "structure" && e.isOwned);
  if (ownedStructures.length === 0) {
    return { success: false, error: "No owned structures found." };
  }

  // Try to find an adjacent structure
  let homeDirection: number | null = null;
  let homeStructure: (typeof ownedStructures)[0] | undefined;

  for (const s of ownedStructures) {
    const dir = getDirectionBetweenAdjacentHexes(
      { col: explorer.position.x, row: explorer.position.y },
      { col: s.position.x, row: s.position.y },
    );
    if (dir !== null) {
      homeDirection = dir;
      homeStructure = s;
      break;
    }
  }

  if (homeDirection === null || !homeStructure) {
    const explorerPos = `(${explorer.position.x},${explorer.position.y})`;
    const structPositions = ownedStructures.map((s) => `#${s.entityId} @(${s.position.x},${s.position.y})`).join(", ");
    return {
      success: false,
      error: `Explorer #${explorerId} at ${explorerPos} is not adjacent to any owned structure. Structures: ${structPositions}. Move the explorer adjacent first.`,
    };
  }

  // Pass through to ABI executor with computed home_direction
  if (!_executor) {
    return { success: false, error: "Action registry not initialized." };
  }
  return _executor.execute({
    type: "explorer_add",
    params: {
      to_explorer_id: explorerId,
      amount,
      home_direction: homeDirection,
    },
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return all action definitions (type + description + param schemas).
 * Used to build enriched tool descriptions for the LLM.
 */
export function getActionDefinitions(): ActionDefinition[] {
  return _actionDefs;
}

/**
 * Return the list of all registered action type strings.
 */
export function getAvailableActions(): string[] {
  return Array.from(_actionTypes);
}

/**
 * Look up a registered action handler by its type string.
 * @deprecated Use executeAction() instead.
 */
export function getActionHandler(
  type: string,
): ((client: EternumClient, signer: Account, params: Record<string, unknown>) => Promise<ActionResult>) | undefined {
  if (!_actionTypes.has(type)) return undefined;
  // Return a function that delegates to executeAction
  return (client, signer, params) => executeAction(client, signer, { type, params });
}

/**
 * Execute a GameAction by dispatching to the ABI executor or composite handler.
 * Returns a failed ActionResult if the action type is unknown.
 */
export async function executeAction(client: EternumClient, signer: Account, action: GameAction): Promise<ActionResult> {
  // Composite actions handled specially
  if (action.type === "explorer_move") {
    const result = await handleExplorerMove(client, signer, action.params);
    logAction(action.type, result);
    return result;
  }

  // explorer_add — auto-compute home_direction from world state
  if (action.type === "explorer_add") {
    const result = await handleAddToExplorer(client, signer, action.params);
    logAction(action.type, result);
    return result;
  }

  if (action.type === "approve_token") {
    const result = await handleApproveToken(signer, action.params);
    logAction(action.type, result);
    return result;
  }

  if (action.type === "lock_entry_token") {
    const result = await handleLockEntryToken(signer, action.params);
    logAction(action.type, result);
    return result;
  }

  if (action.type === "settle_blitz_realm") {
    const result = await handleSettleBlitzRealm(signer, action.params);
    logAction(action.type, result);
    return result;
  }

  if (action.type === "run_smart_production") {
    // Accept both camelCase and snake_case from agent
    const realmEntityId = num(action.params.realmEntityId ?? action.params.realm_entity_id);

    // Auto-detect produced resource IDs from world state if not provided
    let producedResourceIds = (action.params.producedResourceIds as number[] | undefined);
    if (!producedResourceIds || producedResourceIds.length === 0) {
      if (_worldStateProvider) {
        const worldState = await _worldStateProvider(client);
        const realm = worldState.entities.find((e) => e.entityId === realmEntityId && e.type === "structure");
        producedResourceIds = realm?.producedResourceIds ?? [];
      }
    }

    const toriiUrl = _toriiSqlUrl ?? "";
    if (!toriiUrl) {
      return { success: false, error: "Torii SQL URL not configured. Pass toriiSqlUrl in initializeActions options." };
    }

    const result = await runSmartProduction(client, signer, realmEntityId, producedResourceIds ?? [], toriiUrl);
    logAction(action.type, result);
    return result;
  }

  // Standard ABI actions
  if (!_executor) {
    return {
      success: false,
      error: "Action registry not initialized. Call initializeActions() first.",
    };
  }

  // The ABI executor's onAfterExecute hook handles logging for standard actions
  return _executor.execute(action);
}
