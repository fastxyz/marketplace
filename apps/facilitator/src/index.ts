import express from "express";
import { createFacilitatorServer } from "@fastxyz/x402-facilitator";

const port = Number(process.env.FACILITATOR_PORT ?? process.env.PORT ?? 4020);
const fastRpcUrl = process.env.FACILITATOR_FAST_RPC_URL;
const evmPrivateKey = process.env.FACILITATOR_EVM_PRIVATE_KEY as `0x${string}` | undefined;

const app = express();
app.use(express.json());
app.use(
  createFacilitatorServer({
    ...(fastRpcUrl ? { fastRpcUrl } : {}),
    ...(evmPrivateKey ? { evmPrivateKey } : {})
  })
);

app.listen(port, () => {
  console.log(`Marketplace facilitator listening on http://localhost:${port}`);
});
