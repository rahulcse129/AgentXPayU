/**
 * CLEARING_MODE=emulator (default) | live | off.
 * `live` is reserved for a MetalClearing adapter over metal-pay's createClearingClient /
 * depositToClearing / withdrawFromClearing once Metal opens clearing on testnet. Until then it
 * refuses to start rather than silently falling back, so SIMULATED is never shown as LIVE.
 */
import { ClearingEmulator } from "./emulator.ts";
import type { ClearingPort } from "./port.ts";
import { EMULATOR_TEST_KEY, Eip712Signer } from "./signer.ts";

export type ClearingMode = "emulator" | "live" | "off";

export function clearingFromEnv(env: NodeJS.ProcessEnv = process.env): ClearingPort | undefined {
  const mode = (env.CLEARING_MODE ?? "emulator") as ClearingMode;
  if (mode === "off") return undefined;
  if (mode === "emulator") return new ClearingEmulator(new Eip712Signer(EMULATOR_TEST_KEY));
  if (mode === "live") {
    throw new Error(
      "CLEARING_MODE=live: Metal clearing is not available to builders on testnet (see docs/STATUS.md). Use CLEARING_MODE=emulator.",
    );
  }
  throw new Error(`unknown CLEARING_MODE ${mode}`);
}
