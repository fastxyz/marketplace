#!/usr/bin/env -S node --import tsx
import { runCli } from "../src/index.ts";

await runCli(process.argv);
