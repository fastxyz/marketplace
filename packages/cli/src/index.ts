#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

import { Command } from "commander";

import {
  defaultCliDependencies,
  fetchJobResult,
  initializeWallet,
  searchMarketplace,
  setSpendControls,
  showMarketplaceItem,
  useMarketplaceRoute,
  walletAddress,
  walletBalance,
  type CliDependencies
} from "./lib.js";
import {
  submitProviderService,
  syncProviderSpec,
  verifyProviderService
} from "./provider.js";

function parseJsonOption(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function createProgram(deps: CliDependencies = defaultCliDependencies()): Command {
  const program = new Command();
  program.name("fast-marketplace");

  program
    .command("search")
    .argument("[query]")
    .option("--api-url <url>", "Marketplace API URL", "http://localhost:3000")
    .option("--category <name>")
    .option("--billing-type <type>")
    .option("--mode <mode>")
    .option("--settlement-mode <mode>")
    .option("--limit <number>")
    .action(async (query, options) => {
      const result = await searchMarketplace(
        {
          apiUrl: options.apiUrl,
          q: query,
          category: options.category,
          billingType: options.billingType,
          mode: options.mode,
          settlementMode: options.settlementMode,
          limit: options.limit ? Number(options.limit) : undefined
        },
        deps
      );
      deps.print(JSON.stringify(result, null, 2));
    });

  program
    .command("show")
    .argument("<ref>")
    .option("--api-url <url>", "Marketplace API URL", "http://localhost:3000")
    .action(async (ref, options) => {
      const result = await showMarketplaceItem(
        {
          apiUrl: options.apiUrl,
          ref
        },
        deps
      );
      deps.print(JSON.stringify(result, null, 2));
    });

  const walletProgram = program.command("wallet");

  walletProgram
    .command("init")
    .option("--keyfile <path>")
    .option("--config <path>")
    .option("--network <network>", "Fast network (mainnet or testnet)", "mainnet")
    .action(async (options) => {
      const result = await initializeWallet({
        keyfilePath: options.keyfile,
        configPath: options.config,
        network: options.network
      });
      deps.print(JSON.stringify(result, null, 2));
    });

  walletProgram
    .command("load")
    .option("--keyfile <path>")
    .option("--config <path>")
    .option("--network <network>", "Fast network (mainnet or testnet)")
    .action(async (options) => {
      const result = await walletAddress({
        keyfilePath: options.keyfile,
        configPath: options.config,
        network: options.network
      });
      deps.print(JSON.stringify(result, null, 2));
    });

  walletProgram
    .command("address")
    .option("--keyfile <path>")
    .option("--config <path>")
    .option("--network <network>", "Fast network (mainnet or testnet)")
    .action(async (options) => {
      const result = await walletAddress({
        keyfilePath: options.keyfile,
        configPath: options.config,
        network: options.network
      });
      deps.print(JSON.stringify(result, null, 2));
    });

  walletProgram
    .command("balance")
    .option("--keyfile <path>")
    .option("--config <path>")
    .option("--network <network>", "Fast network (mainnet or testnet)")
    .option("--token <symbol>", "Token symbol override")
    .action(async (options) => {
      const result = await walletBalance({
        keyfilePath: options.keyfile,
        configPath: options.config,
        network: options.network,
        token: options.token
      });
      deps.print(JSON.stringify(result, null, 2));
    });

  program
    .command("config")
    .description("Manage local CLI configuration")
    .command("spend")
    .option("--config <path>")
    .option("--max-per-call <amount>")
    .option("--daily-cap <amount>")
    .option("--allowlist <items>")
    .option("--manual-approval-above <amount>")
    .action(async (options) => {
      const result = await setSpendControls({
        configPath: options.config,
        maxPerCall: options.maxPerCall,
        dailyCap: options.dailyCap,
        allowlist: options.allowlist ? String(options.allowlist).split(",").map((item) => item.trim()) : undefined,
        manualApprovalAbove: options.manualApprovalAbove
      });
      deps.print(JSON.stringify(result, null, 2));
    });

  program
    .command("use")
    .argument("<ref>")
    .requiredOption("--input <json>")
    .option("--api-url <url>", "Marketplace API URL", "http://localhost:3000")
    .option("--network <network>", "Fast network (mainnet or testnet)")
    .option("--keyfile <path>")
    .option("--config <path>")
    .option("--approve-expensive", "Auto-approve expensive routes", false)
    .option("--verbose", "Print x402 client logs", false)
    .action(async (ref, options) => {
      const result = await useMarketplaceRoute(
        {
          apiUrl: options.apiUrl,
          ref,
          body: parseJsonOption(options.input, "--input"),
          keyfilePath: options.keyfile,
          configPath: options.config,
          network: options.network,
          autoApproveExpensive: Boolean(options.approveExpensive),
          verbose: Boolean(options.verbose)
        },
        deps
      );
      deps.print(JSON.stringify(result, null, 2));
    });

  const jobProgram = program.command("job");

  jobProgram
    .command("get")
    .argument("<jobToken>")
    .option("--api-url <url>", "Marketplace API URL", "http://localhost:3000")
    .option("--network <network>", "Fast network (mainnet or testnet)")
    .option("--keyfile <path>")
    .option("--config <path>")
    .action(async (jobToken, options) => {
      const result = await fetchJobResult(
        {
          apiUrl: options.apiUrl,
          jobToken,
          keyfilePath: options.keyfile,
          configPath: options.config,
          network: options.network
        },
        deps
      );
      deps.print(JSON.stringify(result, null, 2));
    });

  const providerProgram = program.command("provider");

  providerProgram
    .command("sync")
    .requiredOption("--spec <path>")
    .option("--api-url <url>", "Marketplace API URL")
    .option("--network <network>", "Fast network (mainnet or testnet)")
    .option("--keyfile <path>")
    .option("--config <path>")
    .action(async (options) => {
      const result = await syncProviderSpec(
        {
          specPath: options.spec,
          apiUrl: options.apiUrl,
          keyfilePath: options.keyfile,
          configPath: options.config,
          network: options.network,
          rpcUrl: undefined
        },
        deps
      );
      deps.print(JSON.stringify(result, null, 2));
    });

  providerProgram
    .command("verify")
    .requiredOption("--service <slug-or-id>")
    .option("--api-url <url>", "Marketplace API URL")
    .option("--network <network>", "Fast network (mainnet or testnet)")
    .option("--keyfile <path>")
    .option("--config <path>")
    .action(async (options) => {
      const result = await verifyProviderService(
        {
          serviceRef: options.service,
          apiUrl: options.apiUrl,
          keyfilePath: options.keyfile,
          configPath: options.config,
          network: options.network,
          rpcUrl: undefined
        },
        deps
      );
      deps.print(JSON.stringify(result, null, 2));
    });

  providerProgram
    .command("submit")
    .requiredOption("--service <slug-or-id>")
    .option("--api-url <url>", "Marketplace API URL")
    .option("--network <network>", "Fast network (mainnet or testnet)")
    .option("--keyfile <path>")
    .option("--config <path>")
    .action(async (options) => {
      const result = await submitProviderService(
        {
          serviceRef: options.service,
          apiUrl: options.apiUrl,
          keyfilePath: options.keyfile,
          configPath: options.config,
          network: options.network,
          rpcUrl: undefined
        },
        deps
      );
      deps.print(JSON.stringify(result, null, 2));
    });

  return program;
}

export async function runCli(argv = process.argv, deps: CliDependencies = defaultCliDependencies()) {
  const program = createProgram(deps);
  try {
    await program.parseAsync(argv);
  } catch (error) {
    deps.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

export function shouldRunCli(argv = process.argv, moduleUrl = import.meta.url): boolean {
  const invokedPath = argv[1];
  if (!invokedPath) {
    return false;
  }

  try {
    return realpathSync(invokedPath) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return moduleUrl === pathToFileURL(invokedPath).href;
  }
}

if (shouldRunCli(process.argv, import.meta.url)) {
  await runCli(process.argv);
}
