// Запуск внутри GitHub Actions (bun run build) — свежий эгресс-IP для
// devnet-крана api.devnet.solana.com. ВРЕМЕННЫЙ инструмент ветки tools/faucet:
// после финансирования payer-кошелька $LILITH ветка удаляется.
const ADDR = "ERMQ3o6exmRLZpuxkQU9zsbvjG3yN7of4P9xcnM6MfxD";
const RPC = "https://api.devnet.solana.com";

const post = (method, params) =>
  fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
    .then((r) => r.json())
    .catch((e) => ({ err: String(e) }));

(async () => {
  for (let i = 1; i <= 4; i++) {
    const bal = await post("getBalance", [ADDR]);
    const v = bal?.result?.value ?? 0;
    console.log(`attempt ${i}: balance=${v} lamports`);
    if (v >= 1_000_000_000) {
      console.log("ALREADY_FUNDED");
      break;
    }
    const r = await post("requestAirdrop", [ADDR, 2_000_000_000]);
    console.log("airdrop:", JSON.stringify(r));
    await new Promise((res) => setTimeout(res, 20000));
  }
  const fin = await post("getBalance", [ADDR]);
  console.log("FINAL_BALANCE:", fin?.result?.value ?? "?");
})().catch((e) => console.error("airdrop err", e));
