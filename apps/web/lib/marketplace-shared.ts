// @ts-expect-error Next should consume the built runtime bundle here; types come from the package export below.
export { normalizeFastWalletAddress } from "../../../dist/packages/shared/index.js";
export type * from "@marketplace/shared";
