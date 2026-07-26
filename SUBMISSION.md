# BITEBACK submission kit

## Copy-ready description

**Tagline:** One report. Every affected wallet. One case to resolve.

BITEBACK turns one wallet-signed disputed payment into a verifiable collective
case. The Graph discovers every wallet affected by the same deterministic
policy violation, 0G compiles and preserves the evidence, and Hedera records the
decision and executes one merchant-authorized atomic payout. An independent
Bayesian monitor also learns each EVM chain's normal behavior and warns wallets
about abnormal liveness, fees, throughput, and failures without ever creating a
claim or moving funds.

## Why it wins

- **Useful:** one complaint replaces hundreds of disconnected support tickets.
- **Verifiable:** every affected wallet, amount, rule, signature, and receipt is
  bound into one evidence hash.
- **Safe:** AI compiles the candidate rule; deterministic code finds victims and
  calculates loss; only a signed merchant decision unlocks payment.
- **Cross-chain:** source activity is monitored across configured EVM chains,
  while Hedera supplies the settlement and public audit layer.
- **Validated:** labeled Base and Optimism outages were detected in the first
  completed 5-minute bucket after onset.

## Three-minute demo

**0:00–0:20 — Problem**

Show six confirmed Base Sepolia charges across three wallets. Explain that the
normal process creates three separate complaints, investigations, and refunds.
BITEBACK begins with one signed report.

**0:20–0:55 — Collective detection**

Click **Report Wallet A charge**. Show that no incident existed before the
signature. The reported receipt defines the merchant, token, and time window;
The Graph then expands one reporter into all three affected wallets.

**0:55–1:25 — Evidence**

Open the Evidence view. Point to the compiled policy and provenance, the exact
affected set and loss, the canonical SHA-256, the verified 0G round-trip, and
the HCS audit sequence. Emphasize that the model never selects recipients or
amounts.

**1:25–1:55 — Authorized settlement**

Show **Merchant decision required**, then click **Authorize settlement**. The
merchant signs `ACCEPT` for the frozen incident, evidence hash, and exact total.
Show one successful Hedera transaction paying all three recipients atomically.

**1:55–2:30 — Proactive anomaly layer**

Open Anomalies. Show independent Base and Optimism health, finalized-head
heartbeat, credible ranges, and alert episodes. Explain the 30-day Bayesian
baseline and the labeled outage replays. Show a wallet-signed warning watch.

**2:30–3:00 — Trust boundary and close**

State the safety boundary: an anomaly can warn a wallet, but cannot create a
dispute, claim, decision, or payout. Close with: **one report, every affected
wallet, one case to resolve.**

## Judge verification

```bash
npm install
npm run check
```

For a funded live environment:

```bash
cp .env.example .env
npm run setup:demo
npm run demo:mint
npm run dev
# another terminal
npm run demo:run
```

The complete setup, required credentials, APIs, security invariants, and public
testnet identifiers are in [README.md](./README.md). The multi-chain replay
method and results are in [ANOMALY_VALIDATION.md](./ANOMALY_VALIDATION.md).

## Final submission checklist

- Keep the GitHub repository public and push the complete, reviewable history.
- Record the script above as a maximum three-minute video with readable
  transaction links and no terminal dead time.
- Provide a hosted dashboard URL or explicit local testing instructions.
- Verify every public Base, Hedera, HCS, and 0G identifier immediately before
  submission.
- Select only partner tracks whose required SDK or network use is visible in
  the demo and repository.
- Disclose any pre-existing work according to the selected ETHGlobal track.
- Remove private keys, local state, logs, and funded demo credentials from the
  repository and video.
