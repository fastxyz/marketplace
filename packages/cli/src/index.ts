#!/usr/bin/env node
import { Command } from "commander";

import {
  defaultCliDependencies,
  fetchJobResult,
  initializeWallet,
  invokePaidRoute,
  setSpendControls,
  walletAddress,
  walletBalance
} from "./lib.js";

const program = new Command();
const deps = defaultCliDependencies();

program.name("fast-marketplace");

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
  .option("--network <network>", "Fast network (mainnet or testnet)", "mainnet")
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
  .option("--network <network>", "Fast network (mainnet or testnet)", "mainnet")
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
  .option("--network <network>", "Fast network (mainnet or testnet)", "mainnet")
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
  .command("invoke")
  .argument("<provider>")
  .argument("<operation>")
  .requiredOption("--body <json>")
  .option("--api-url <url>", "Marketplace API URL", "http://localhost:3000")
  .option("--network <network>", "Fast network (mainnet or testnet)", "mainnet")
  .option("--keyfile <path>")
  .option("--config <path>")
  .option("--approve-expensive", "Auto-approve expensive routes", false)
  .option("--verbose", "Print x402 client logs", false)
  .action(async (provider, operation, options) => {
    const result = await invokePaidRoute(
      {
        apiUrl: options.apiUrl,
        provider,
        operation,
        body: JSON.parse(options.body),
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
  .option("--network <network>", "Fast network (mainnet or testnet)", "mainnet")
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

try {
  await program.parseAsync(process.argv);
} catch (error) {
  deps.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
