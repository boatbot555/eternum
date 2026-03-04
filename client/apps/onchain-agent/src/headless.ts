import { EternumClient } from "@bibliothecadao/client";
import { createHeartbeatLoop, createGameAgent, type HeartbeatJob } from "@bibliothecadao/game-agent";
import { getModel } from "@mariozechner/pi-ai";
import { readFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import path from "node:path";
import { Account, RpcProvider, uint256, CallData, hash, typedData, TypedDataRevision, encode, addAddressPadding, type AccountInterface } from "starknet";
import { CartridgeSessionAccount } from "@cartridge/controller-wasm/session";
import { ControllerFactory } from "@cartridge/controller-wasm";
import "./session/browser-shims";
import { createShutdownGate } from "./shutdown-gate";
import { type AgentConfig, loadConfig } from "./config";
import { EternumGameAdapter } from "./adapter/eternum-adapter";
import { MutableGameAdapter } from "./adapter/mutable-adapter";
import { ControllerSession } from "./session";
import { readArtifacts, writeArtifacts } from "./session/artifacts";
import { buildSessionPoliciesFromRoutes } from "./session/controller-session";
import { generateActions } from "./abi/action-gen";
import { ETERNUM_OVERLAYS, createHiddenOverlays } from "./abi/domain-overlay";
import { createPrivateKeyAccount } from "./session/privatekey-auth";
import { findWorldByName, buildWorldProfile, buildResolvedManifest } from "./world/discovery";
import { deriveChainIdFromRpcUrl } from "./world/normalize";
import { createInspectTools } from "./tools/inspect-tools";
import { createCombatTools } from "./tools/combat-tools";
import { createMcpTools, type McpConnection } from "./tools/mcp-tools";
import { getActionDefinitions } from "./adapter/action-registry";
import { formatEternumTickPrompt, formatEternumTickDiff, type EternumWorldState } from "./adapter/world-state";
import { JsonEmitter } from "./output/json-emitter";
import { createApiServer } from "./api/server";
import { startStdinReader } from "./input/stdin-reader";
import type { CliOptions } from "./cli-args";
import { seedDataDir } from "./cli";
import { createRuntimeConfigManager } from "./runtime-config";

function loadReferenceHandbooks(dataDir: string): string {
  const taskDir = path.join(dataDir, "tasks");
  if (!existsSync(taskDir)) return "";

  const sections: string[] = [];
  let files: string[];
  try {
    files = readdirSync(taskDir)
      .filter((f: string) => f.endsWith(".md"))
      .sort();
  } catch {
    return "";
  }

  for (const file of files) {
    const raw = readFileSync(path.join(taskDir, file), "utf-8");
    const autoloadMatch = raw.match(/^---\n[\s\S]*?autoload:\s*(true|false)[\s\S]*?\n---/);
    if (autoloadMatch && autoloadMatch[1] === "true") continue;
    if (!raw.startsWith("---\n")) continue;

    const domain = file.replace(/\.md$/, "");
    const content = raw.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
    if (content) {
      sections.push(`<reference domain="${domain}">\n${content}\n</reference>`);
    }
  }

  if (sections.length === 0) return "";
  return `## Reference Handbooks (study these before acting)\n\n${sections.join("\n\n")}`;
}

/**
 * Auto top-up fee tokens from master account on non-mainnet chains.
 * Mirrors the game client's auto-top-up in use-world-registration.ts.
 */
async function autoTopUpFeeTokens(
  rpcUrl: string,
  toriiBaseUrl: string,
  agentAddress: string,
  feeTokenAddress: string | undefined,
  emitter: JsonEmitter,
): Promise<void> {
  const masterAddress = process.env.MASTER_ADDRESS;
  const masterPrivateKey = process.env.MASTER_PRIVATE_KEY;
  if (!masterAddress || !masterPrivateKey) return;
  if (!feeTokenAddress) return;

  try {
    // Query fee amount from world config
    const sqlUrl = `${toriiBaseUrl}/sql?query=${encodeURIComponent(
      'SELECT "blitz_registration_config.fee_amount" AS fee_amount FROM "s1_eternum-WorldConfig" LIMIT 1;',
    )}`;
    const resp = await fetch(sqlUrl);
    if (!resp.ok) return;
    const rows = (await resp.json()) as Record<string, unknown>[];
    const rawFee = rows[0]?.fee_amount;
    if (!rawFee) return;
    const feeAmount = BigInt(String(rawFee));
    if (feeAmount === 0n) return;

    // Check agent's current fee token balance via RPC
    const rpcProvider = new RpcProvider({ nodeUrl: rpcUrl });
    const balanceResult = await rpcProvider.callContract({
      contractAddress: feeTokenAddress,
      entrypoint: "balance_of",
      calldata: [agentAddress],
    });
    const balance = BigInt(balanceResult[0] ?? "0");

    if (balance >= feeAmount) return; // Already funded

    // Transfer shortfall from master account
    const shortfall = feeAmount - balance;
    const masterAccount = new Account({ provider: rpcProvider, address: masterAddress, signer: masterPrivateKey });
    const amount = uint256.bnToUint256(shortfall);
    await masterAccount.execute({
      contractAddress: feeTokenAddress,
      entrypoint: "transfer",
      calldata: CallData.compile([agentAddress, amount.low, amount.high]),
    });

    emitter.emit({
      type: "startup",
      message: `Auto top-up: transferred ${(Number(shortfall) / 1e18).toFixed(2)} fee tokens from master account`,
    });

    // Brief wait for indexing
    await new Promise((r) => setTimeout(r, 2000));
  } catch (err) {
    emitter.emit({
      type: "error",
      message: `Auto top-up failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

export async function mainHeadless(options: CliOptions): Promise<void> {
  let config = loadConfig();

  // Scope data dir per-world so multiple agents don't share state
  if (options.world) {
    config.dataDir = path.join(config.dataDir, options.world);
  }

  // Propagate world-scoped dataDir so debug log helpers pick it up
  process.env.AGENT_DATA_DIR = config.dataDir;

  // Ensure all runtime directories exist even if `init` was never run
  seedDataDir(config.dataDir);
  mkdirSync(config.sessionBasePath, { recursive: true });

  const emitter = new JsonEmitter({
    verbosity: options.verbosity,
    write: (line) => process.stdout.write(line + "\n"),
  });

  // Read or bootstrap artifacts from session directory
  const worldDir = path.join(config.sessionBasePath, options.world!);
  let artifacts: ReturnType<typeof readArtifacts>;

  try {
    artifacts = readArtifacts(worldDir);
    emitter.emit({ type: "startup", message: `Loaded artifacts for ${options.world}` });
  } catch {
    // Artifacts don't exist — bootstrap them via world discovery
    emitter.emit({ type: "startup", message: `No artifacts for ${options.world}, bootstrapping via discovery...` });

    const world = await findWorldByName(options.world!);
    if (!world) {
      emitter.emit({ type: "error", message: `World "${options.world}" not found on any chain` });
      throw new Error(`World "${options.world}" not found`);
    }

    const profile = await buildWorldProfile(world.chain, world.name);
    const manifest = await buildResolvedManifest(world.chain, profile);
    const { routes } = generateActions(manifest as any, {
      overlays: { ...ETERNUM_OVERLAYS, ...createHiddenOverlays(manifest as any) },
      gameName: config.gameName,
    });
    const policies = buildSessionPoliciesFromRoutes(routes, {
      worldProfile: profile,
    });

    writeArtifacts(worldDir, {
      profile,
      manifest,
      policy: policies as unknown as Record<string, unknown>,
      auth: {
        url: "",
        status: "pending",
        worldName: world.name,
        chain: world.chain,
        createdAt: new Date().toISOString(),
      },
    });

    artifacts = readArtifacts(worldDir);
    emitter.emit({ type: "startup", message: `Bootstrapped artifacts for ${options.world} (${world.chain})` });
  }

  // Override config from artifacts
  config.rpcUrl = artifacts.profile.rpcUrl ?? config.rpcUrl;
  config.toriiUrl = `${artifacts.profile.toriiBaseUrl}/sql`;
  config.worldAddress = artifacts.profile.worldAddress;
  config.chainId = deriveChainIdFromRpcUrl(config.rpcUrl) ?? config.chainId;
  config.chain = artifacts.profile.chain;

  // Create account (session or privatekey)
  let account: AccountInterface;
  let session: ControllerSession | null = null;

  if (options.auth === "privatekey") {
    const privateKey = process.env.PRIVATE_KEY ?? "";
    const accountAddress = process.env.ACCOUNT_ADDRESS ?? "";
    account = createPrivateKeyAccount(config.rpcUrl, privateKey, accountAddress);
  } else {
    const sessionBasePath = path.join(config.sessionBasePath, options.world!);
    const { routes: sessionRoutes } = generateActions(artifacts.manifest, {
      overlays: { ...ETERNUM_OVERLAYS, ...createHiddenOverlays(artifacts.manifest as any) },
      gameName: config.gameName,
    });
    const sessionPolicies = buildSessionPoliciesFromRoutes(sessionRoutes, {
      worldProfile: artifacts.profile,
    });
    session = new ControllerSession({
      rpcUrl: config.rpcUrl,
      chainId: config.chainId,
      gameName: config.gameName,
      basePath: sessionBasePath,
      manifest: artifacts.manifest,
      worldProfile: artifacts.profile,
      policies: sessionPolicies,
    });

    // Check if session.json has authorization (from passwordLogin/createSession).
    // If so, use CartridgeSessionAccount.new() directly — this path doesn't
    // rely on on-chain registration lookup and is more reliable.
    const sessionFilePath = path.join(sessionBasePath, "session.json");
    let usedDirectSession = false;

    try {
      const raw = readFileSync(sessionFilePath, "utf-8");
      const data = JSON.parse(raw);
      const signerData = typeof data.signer === "string" ? JSON.parse(data.signer) : data.signer;
      const sessData = typeof data.session === "string" ? JSON.parse(data.session) : data.session;

      emitter.emit({ type: "startup", message: `session.json check: address=${sessData.address}, auth=${!!sessData.authorization}, keys=${Object.keys(sessData).join(",")}` });
      if (sessData.authorization && Array.isArray(sessData.authorization)) {
        // Re-login via WASM to get a live Controller with wildcard session.
        emitter.emit({ type: "startup", message: `Re-logging in via WASM for live Controller...` });

        // ControllerFactory and browser-shims are statically imported at top

        const cartridgePassword = process.env.CARTRIDGE_PASSWORD;
        if (!cartridgePassword) {
          throw new Error("CARTRIDGE_PASSWORD env var required for session execution");
        }

        // Read controller.json for username, address, classHash, ownerKey
        const ctrlPath = path.join(sessionBasePath, "controller.json");
        const authData = JSON.parse(readFileSync(ctrlPath, "utf-8"));
        const csExpiresAtLogin = BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 3600);

        emitter.emit({ type: "startup", message: `Login: user=${authData.username}, addr=${authData.address?.slice(0,12)}...` });
        const loginResult = await ControllerFactory.login(
          authData.username,
          authData.classHash ?? "0x743c83c41ce99ad470aa308823f417b2141e02e04571f5c0004e743556e7faf",
          config.rpcUrl,
          authData.address,
          { signer: { starknet: { privateKey: authData.ownerPrivateKey } } },
          "https://api.cartridge.gg",
          csExpiresAtLogin,
          true,  // is_controller_registered
          false, // create_wildcard_session — we'll call createSession explicitly
          null,  // app_id
        );
        const controllerAccount = loginResult.intoValues()[0].intoAccount();

        const wasmPolicies = [
          ...Object.entries(sessionPolicies.contracts ?? {}).flatMap(
            ([target, contract]: [string, any]) =>
              contract.methods.map((m: any) => ({
                target,
                method: hash.getSelectorFromName(m.entrypoint),
                authorized: true,
              })),
          ),
          ...(sessionPolicies.messages ?? []).map((p: any) => {
            const domainHash = typedData.getStructHash(p.types, "StarknetDomain", p.domain, TypedDataRevision.ACTIVE);
            const typeHash = typedData.getTypeHash(p.types, p.primaryType, TypedDataRevision.ACTIVE);
            return { scope_hash: hash.computePoseidonHash(domainHash, typeHash), authorized: true };
          }),
        ];

        const csExpiresAt = BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 3600);
        await controllerAccount.createSession("axis", wasmPolicies, csExpiresAt);
        emitter.emit({ type: "startup", message: `Wildcard session created in live Controller` });

        const sessionRpc = new RpcProvider({ nodeUrl: config.rpcUrl });
        const sessionAccount = Object.create(sessionRpc) as AccountInterface;
        sessionAccount.address = sessData.address;
        (sessionAccount as any).execute = async (calls: any) => {
          const normCalls = (Array.isArray(calls) ? calls : [calls]).map((c: any) => ({
            entrypoint: c.entrypoint,
            contractAddress: addAddressPadding(c.contractAddress),
            calldata: CallData.toHex(c.calldata ?? []),
          }));
          try {
            return await controllerAccount.executeFromOutsideV3(normCalls);
          } catch (e1: any) {
            try {
              return await controllerAccount.executeFromOutsideV2(normCalls);
            } catch (e2: any) {
              const err1 = e1?.message ?? String(e1);
              const err2 = e2?.message ?? String(e2);
              throw new Error(`V3: ${err1.slice(0, 150)} | V2: ${err2.slice(0, 150)}`);
            }
          }
        };

        account = sessionAccount;
        usedDirectSession = true;
        emitter.emit({ type: "startup", message: "Using live Controller with wildcard session" });
      }
    } catch (directErr) {
      // Log error for debugging — fall through to probe()
      emitter.emit({
        type: "error",
        message: `Direct session setup failed: ${directErr instanceof Error ? directErr.message : String(directErr)} | stack: ${(directErr as any)?.stack?.slice(0, 300) ?? "none"}`,
      });
    }

    if (!usedDirectSession) {
      // Try probe() first (uses SessionAccount WASM newAsRegistered path).
      try {
        const probed = await session.probe();
        if (probed) {
          account = probed;
        } else {
          const authUrl = artifacts.auth?.url || "(run `axis auth " + options.world + "` to generate)";
          emitter.emit({
            type: "error",
            message:
              `No active session for ${options.world}. Auth required.\n` +
              `  1. Open this URL in a browser: ${authUrl}\n` +
              `  2. Approve the session\n` +
              `  3. Run: axis auth ${options.world} --redirect-url="<redirect URL from browser>"`,
          });
          throw new Error(`No active session for ${options.world}. Run axis auth first.`);
        }
      } catch (probeError) {
        emitter.emit({
          type: "error",
          message: `probe() failed: ${probeError instanceof Error ? (probeError.stack ?? probeError.message) : String(probeError)}`,
        });
        try {
          const raw = readFileSync(sessionFilePath, "utf-8");
          const data = JSON.parse(raw);
          const signer = typeof data.signer === "string" ? JSON.parse(data.signer) : data.signer;
          const sess = typeof data.session === "string" ? JSON.parse(data.session) : data.session;
          account = createPrivateKeyAccount(config.rpcUrl, signer.privKey, sess.address);
          emitter.emit({ type: "session", status: "active", message: "Using raw session keypair (WASM fallback)" });
        } catch (fallbackErr) {
          throw new Error(`Session probe failed and fallback failed: ${fallbackErr}`);
        }
      }
    }
  }

  // Auto top-up fee tokens on non-mainnet chains (mirrors game client logic)
  if (artifacts.profile.chain !== "mainnet") {
    await autoTopUpFeeTokens(
      config.rpcUrl,
      artifacts.profile.toriiBaseUrl,
      account.address,
      artifacts.profile.feeTokenAddress,
      emitter,
    );
  }

  // Create Eternum client
  const client = await EternumClient.create({
    rpcUrl: config.rpcUrl,
    toriiUrl: config.toriiUrl,
    worldAddress: config.worldAddress,
    manifest: artifacts.manifest as any,
    vrfProviderAddress: "0x051fea4450da9d6aee758bdeba88b2f665bcbf549d2c61421aa724e9ac0ced8f",
  });
  client.connect(account as any);

  // Fetch game config to sync tick interval with on-chain armies tick
  const sqlBaseUrl = `${artifacts.profile.toriiBaseUrl}/sql`;
  const { fetchWorldConfig, getWorldConfig } = await import("./adapter/world-config");
  await fetchWorldConfig(sqlBaseUrl);
  const gameTickMs = getWorldConfig().armiesTickInSeconds * 1000;
  if (gameTickMs > 0) config.tickIntervalMs = gameTickMs;

  const tokenConfig = artifacts.profile
    ? {
        feeToken: artifacts.profile.feeTokenAddress,
        entryToken: artifacts.profile.entryTokenAddress,
        worldAddress: config.worldAddress,
      }
    : undefined;

  // Find the blitz contract address from manifest for registration flow
  const blitzContract = (artifacts.manifest as any).contracts?.find(
    (c: any) => typeof c.tag === "string" && c.tag.includes("blitz_realm_systems"),
  );
  const blitzAddress: string = blitzContract?.address ?? "";
  const adapter = new EternumGameAdapter(
    client,
    account as any,
    account.address,
    artifacts.manifest as any,
    config.gameName,
    tokenConfig,
  );
  const mutableAdapter = new MutableGameAdapter(adapter);

  emitter.emit({
    type: "startup",
    world: options.world,
    chain: artifacts.profile.chain,
    address: account.address,
  });

  // Create game agent
  const model = (getModel as Function)(config.modelProvider, config.modelId);
  let isFirstTick = true;
  const formatTickPromptWithHandbooks = (state: EternumWorldState, prevState: EternumWorldState | null): string => {
    const base = formatEternumTickDiff(state, prevState);
    const needsRegistration = state.player.structures === 0 && state.player.armies === 0;

    if (needsRegistration) {
      // Build registration instructions with known token addresses
      const feeToken = tokenConfig?.feeToken ?? "the fee token";
      const entryToken = tokenConfig?.entryToken ?? "the entry token";
      const spender = blitzAddress || "the blitz contract";
      return `${base}\n\nCRITICAL: You have 0 structures and 0 armies. You are NOT registered in the game yet. You MUST register RIGHT NOW before doing anything else:\n\nStep 1: approve_token (token_address: "${feeToken}", spender: "${spender}", amount: "10000000000000000000")\nStep 2: obtain_entry_token (no params) — mints an entry token NFT to you\nStep 3: Find your minted token_id. Use inspect_sql to query your entry token balance.\nStep 4: lock_entry_token (token_id: <from step 3>, lock_id: 69)\nStep 5: register (name: your player name, entry_token_id: <from step 3>, cosmetic_token_ids: [])\nStep 6: settle_blitz_realm (settlement_count: 1) — bundles VRF + assign positions + settle atomically\n\nThe lock_id is always 69 (constant). If obtain_entry_token fails with "transfer amount exceeds balance", your account has insufficient fee tokens — report the error and stop.\n\nDo NOT study handbooks, do NOT list actions, do NOT write learnings. Just register.`;
    }

    if (isFirstTick) {
      isFirstTick = false;
      const handbooks = loadReferenceHandbooks(config.dataDir);
      if (handbooks) {
        return `${handbooks}\n\n---\n\n${base}\n\nIMPORTANT: This is your first tick. Study the reference handbooks above carefully before taking any actions. Write key insights to tasks/learnings.md so you retain them.`;
      }
    }
    return base;
  };

  let game: ReturnType<typeof createGameAgent> | null = null;

  const runtimeConfigManager = createRuntimeConfigManager({
    getConfig: () => config,
    setConfig: (c) => {
      config = c;
    },
    getAgent: () => game,
    onMessage: (msg) => emitter.emit({ type: "config", message: msg }),
  });

  const mcp = await createMcpTools(config.toriiUrl);
  game = createGameAgent({
    adapter: mutableAdapter,
    dataDir: config.dataDir,
    model,
    tickIntervalMs: config.tickIntervalMs,
    runtimeConfigManager,
    extraTools: [...createInspectTools(client, account.address), ...createCombatTools(client), ...mcp.tools],
    actionDefs: getActionDefinitions(),
    formatTickPrompt: formatTickPromptWithHandbooks,
    onTickError: (err) => {
      emitter.emit({ type: "error", message: `Tick error: ${err.message}` });
    },
  });

  const { agent, ticker, dispose: disposeAgent } = game!;

  // Subscribe to agent events and map to emitter
  agent.subscribe((event) => {
    switch (event.type) {
      case "agent_start":
        break;
      case "agent_end":
        break;
      case "tool_execution_start":
        emitter.emit({
          type: "action",
          tick: ticker.tickCount,
          action: event.toolName,
          params: event.args,
          status: "started",
        });
        break;
      case "tool_execution_end":
        emitter.emit({
          type: "action",
          tick: ticker.tickCount,
          action: event.toolName,
          status: event.isError ? "fail" : "ok",
        });
        break;
      case "message_end":
        if (event.message.role === "assistant") {
          const content = event.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text" && block.text.trim()) {
                emitter.emit({
                  type: "decision",
                  tick: ticker.tickCount,
                  reasoning: block.text.slice(0, 500),
                  actions: [],
                });
              }
            }
          }
        }
        break;
    }
  });

  // Heartbeat
  const heartbeat = createHeartbeatLoop({
    getHeartbeatPath: () => path.join(config.dataDir, "HEARTBEAT.md"),
    onRun: async (job: HeartbeatJob) => {
      emitter.emit({ type: "heartbeat", job: job.id, mode: job.mode });
      const modeGuidance =
        job.mode === "observe"
          ? "Observe-only heartbeat: do not execute on-chain actions. You may read and update markdown/task files."
          : "Action-enabled heartbeat: you may execute actions if justified.";
      const heartbeatPrompt = [
        `## Heartbeat Job: ${job.id}`,
        `Schedule: ${job.schedule}`,
        `Mode: ${job.mode}`,
        modeGuidance,
        "Follow the job instructions below:",
        job.prompt,
      ].join("\n\n");
      await game!.enqueuePrompt(heartbeatPrompt);
    },
    onError: (error) => {
      emitter.emit({ type: "error", message: `Heartbeat error: ${error.message}` });
    },
  });

  // Shutdown gate
  const gate = createShutdownGate();

  const shutdown = async () => {
    emitter.emit({ type: "shutdown", reason: "requested" });
    heartbeat.stop();
    ticker.stop();
    await disposeAgent();
    client.disconnect();
    await mcp.close();
    if (apiClose) await apiClose();
    if (stdinClose) stdinClose();
    gate.shutdown();
  };

  // HTTP API
  let apiClose: (() => Promise<void>) | null = null;
  if (options.apiPort) {
    const { close } = createApiServer(
      {
        enqueuePrompt: async (content) => {
          emitter.emit({ type: "prompt", source: "http", content });
          await game!.enqueuePrompt(content);
        },
        getStatus: () => ({
          tick: ticker.tickCount,
          session: "active",
          loopEnabled: config.loopEnabled,
          world: options.world,
        }),
        getState: () => ({}),
        shutdown,
        applyConfig: async (changes) => runtimeConfigManager.applyChanges(changes),
        emitter,
      },
      options.apiPort,
      options.apiHost ?? "127.0.0.1",
    );
    apiClose = close;
    emitter.emit({
      type: "startup",
      message: `HTTP API listening on ${options.apiHost ?? "127.0.0.1"}:${options.apiPort}`,
    });
  }

  // Stdin reader
  let stdinClose: (() => void) | null = null;
  if (options.stdin || !process.stdin.isTTY) {
    stdinClose = startStdinReader({
      enqueuePrompt: async (content) => {
        emitter.emit({ type: "prompt", source: "stdin", content });
        await game!.enqueuePrompt(content);
      },
      applyConfig: async (changes) => runtimeConfigManager.applyChanges(changes),
      shutdown,
    });
  }

  // Start loops
  if (config.loopEnabled) {
    ticker.start();
  }
  heartbeat.start();

  // Signal handlers
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return gate.promise;
}
