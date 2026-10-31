# TUM Blockchain & AI Hackathon quickstart

Start with the [TUM hackathon setup guide](https://www.masumi.network/tum-hackathon).
It covers your account, Coworker, first task, and payment checkpoints.
Join the [TUM Sokosumi Workspace](https://preprod.sokosumi.com/join/GTAHB3OQFWgg8rGetMfleiqgeL6_ltdW) with your own account.

This starter suggests five team names and recommends one.
Adapt `agent/instructions.md` to build your own agent.
Use the [full agent brief](https://www.masumi.network/tum-hackathon/agent) for your coding agent.
Before handing in your project, follow the [submission checklist](https://www.masumi.network/tum-hackathon/submission).

## Start the local agent

Use Node.js 24 or newer for the agent and CLI.

1. Clone this repository and enter its directory:

   ```sh
   git clone https://github.com/masumi-network/tum-hackathon-quickstart.git
   cd tum-hackathon-quickstart
   ```

2. Install the locked dependencies and prepare private configuration:

   ```sh
   npm ci
   cp .env.example .env
   chmod 600 .env
   ```

3. In `.env`, set `ZAI_API_KEY`, `ZAI_BASE_URL`, and `ZAI_MODEL` for your OpenAI-compatible model provider.
   For a custom model absent from AI Gateway's catalog, also set `ZAI_CONTEXT_WINDOW_TOKENS` to its documented context window.
   Use a positive whole number of tokens. Leave it blank to use Eve's catalog lookup.
4. Keep `EVE_PORT` and `EVE_URL` consistent. Start the agent:

   ```sh
   npm start
   ```

The agent listens on `127.0.0.1` and loads `.env` automatically.
Keep this terminal open while you use the worker.

For extra protection, consider [Socket Firewall](https://socket.dev/products/socket-firewall) for package installs.
If installed, prefix an install command with `sfw`, such as `sfw npm ci`.

## Guardian on Preprod

`npm run dev` opens the dashboard at http://127.0.0.1:3000. Nothing in it is simulated:
prices come from Kraken, CoinGecko and Coinbase, and every balance, loan and rescue is a Cardano Preprod transaction.

Operator setup, once for the whole service:

1. Set `BLOCKFROST_API_KEY_PREPROD` in `.env` and start `npm run dev`.
2. Send 10+ test ADA from the faucet to the oracle operator address printed at startup.
3. Deploy the price oracle at the live market price from the dashboard (signed and paid by the oracle key, once).
   After that, customers pay for the shared oracle: each refresh is paid by a running customer's agent fee wallet and only co-signed by the oracle key.

Each customer (the dashboard walks them through it):

1. Connect Lace or Eternl on Preprod with test ADA, and sign the one-time sign-in message.
   It moves no funds; it proves the wallet is yours, so this browser session can act only for it.
2. Fund your own agent's fee wallet with 15 ADA (one wallet signature). Every customer gets their own agent key.
3. Open a loan: lock ADA, mint tUSD. Opening near the limit (for example health 1.30 with trigger 1.32) lets real market moves trigger a rescue.
4. Sign the mandate and fund the vault, then start the agent.
5. To leave, "Revoke everything" at the end of the setup page closes the loan, empties the vault, stops the agent and returns its fee wallet, in one transaction and one signature.

Each customer has their own agent: its own key and fee wallet, policy, activity log and vault mandate.
A customer's mandate names only their agent's key, so no agent can spend another customer's vault.
Several customers can use the dashboard at once, each in their own browser (or browser profile):
every browser gets its own session, and a session can only see and control the wallet that signed in to it.
Before each wallet transaction, the dashboard checks the selected account again and sends the wallet's current spendable inputs.
The server builds from inputs present in both the wallet and chain views. If you switch accounts, disconnect and reconnect;
if the wallet is still syncing after a transaction, wait for confirmation before the next setup step.
Agents run side by side; signing in or stopping an agent never affects another customer.
Each running agent costs about two Blockfrost reads a minute, plus two for the shared oracle and the dashboards' polling,
so plan the Blockfrost tier for the number of customers (the free 50,000 requests a day covers roughly ten).

Every 60 seconds the server fetches the market once and each running agent checks its own loan: below the trigger it moves ADA
from that customer's vault into their loan as collateral, capped by the mandate. Then the one shared oracle is refreshed on a
0.5% move or every 20 minutes (only while at least one agent runs). Running customers take turns paying for each refresh
(about 0.25 ADA) from their agent fee wallet: the one that paid least recently pays, skipping any wallet under 7 ADA (kept for
its own rescue fees) or with a rescue still confirming. If no wallet qualifies, the refresh waits; the service never pays it.
When the price is stale (for example before anyone's agent runs), any signed-in customer can press "Publish market price now":
the server builds the update at the live market price, their wallet pays the fee (about 0.25 ADA) and the oracle key co-signs.

Contracts live in `onchain/validators/` (Aiken, Plutus V3):

- `oracle.ak`: one-shot NFT price feed; only the operator key updates it, with an in-range timestamp.
- `lending.ak`: loans and tUSD. Anyone may add collateral or repay; only the borrower may borrow more, withdraw or close; anyone may liquidate below health 1.0 at a price under 30 minutes old.
- `mandate_vault.ak`: rescue funds. The agent pays only allowed recipients (your wallet and your loan), within per-transaction, per-period and expiry limits, measured as net flow. The owner can withdraw everything at any time.

Keys and state are created in `.local/guardian/` (mode 600) and never committed: the oracle key, deployment record and
oracle log at the top level, and each customer's agent key and state in `agents/<owner key hash>/`.
A shared `agent-key.json` from an earlier version moves to the folder of the owner it was serving on the next start.
Back them up while they hold test ADA. After editing a contract, run `npm run contract` (Aiken `v1.1.24`) and commit `onchain/plutus.json`.
The oracle is operated by this server, not by an independent provider such as Charli3 or Orcfax. The lending pool is this project's own contract.

Every answer the Sokosumi agent returns (the deterministic report, the help text, the follow-up explanation, and the model's natural-language replies) ends with a call to action linking the customer to this dashboard, so a paid analysis hands the customer straight to where they can act on it. The link is read from `DASHBOARD_URL` in `.env` (default `http://127.0.0.1:3000`). Localhost only resolves on the machine running the dashboard; set `DASHBOARD_URL` to a public https URL (a tunnel or a deployment) before real customers use the agent, then restart the worker. No code change is needed.

## Run the service: dashboard server + agent server

Two long-running processes serve every customer:

1. **Dashboard server** (`npm run dev`), exposed through the tunnel. `PUBLIC_HOST` is the tunnel hostname.
2. **Agent server** (`npm run worker`, with `npm start` beside it for the model), on exactly one machine: the one whose CLI vault holds the Coworker runtime key.
   In that machine's `.env`, set `WORKER_OPERATOR` to its OS username (`whoami`) and `DASHBOARD_URL` to the public dashboard URL.
   The worker refuses to start without a matching `WORKER_OPERATOR`, so a second machine can't answer the same tasks twice (the worker lock covers only one machine).

The worker finds tasks from two sources: `tasks list` (only tasks the signed-in human created) and the Coworker-key listing (every task assigned to the Coworker, including other customers' tasks).
If one listing is refused, the worker logs it once and keeps serving from the other. For a single task it can't see, run `node --env-file=.env serve-task.mjs TASK_ID`.
When the worker starts a customer's task, it immediately posts a comment linking to the dashboard, then posts the analysis as the result.

## Connect your Sokosumi Coworker

Install Sokosumi CLI `1.0.4`. This starter uses its runtime adapter.
Check compatibility before changing that version.

```sh
npm install --global @masumi_network/sokosumi@1.0.4
sokosumi --version
sokosumi skills
```

1. Follow the [setup guide](https://www.masumi.network/tum-hackathon) to sign in with your own Preprod account.
   Create your own Vendor and a private Coworker with task access.
2. Connect the Coworker to your Personal Workspace for the first test.
   Import its runtime key through the CLI's supported credential interface. Keep the key in the CLI vault.
3. Set the returned `COWORKER_ID` in `.env`.
   Keep `PAID_TASKS_ENABLED=false` until you complete the payment setup below.
4. Start the worker in a second terminal:

   ```sh
   npm run worker
   ```

5. Create a task in your Personal Workspace. Replace `YOUR_COWORKER_ID` with your Coworker ID:

   ```sh
   sokosumi --preprod tasks create --personal --coworker-id YOUR_COWORKER_ID --description "Suggest names for our hackathon team." --status READY --json
   ```

Open the task in Sokosumi and check that it reaches `COMPLETED` with an answer.
Run only one worker for this project. Keep both local services running.

For CLI options, use `sokosumi --help` and its [official documentation](https://github.com/masumi-network/sokosumi/tree/main/apps/cli).

## Switch to the TUM Workspace

Keep both organization settings blank for your first Personal Workspace test.
Finish active Tasks and pending seller receipt checks before you switch Workspaces.

1. Join the [TUM Sokosumi Workspace](https://preprod.sokosumi.com/join/GTAHB3OQFWgg8rGetMfleiqgeL6_ltdW).
   Read its actual organization ID and slug:

   ```sh
   sokosumi --preprod workspaces list --json
   ```

2. Connect your existing Coworker to that Workspace. Replace each placeholder with your returned IDs:

   ```sh
   sokosumi --preprod coworkers connect YOUR_COWORKER_ID --vendor-id YOUR_VENDOR_ID --workspace-id YOUR_ORGANIZATION_ID --json
   sokosumi --preprod workspaces check YOUR_ORGANIZATION_ID --json
   ```

   If access is `PENDING`, ask a Workspace owner or admin to approve it, then run `connect` again.
   Continue only when access is `GRANTED` and your account is eligible to create tasks.
3. Stop the worker. In `.env`, set `SOKOSUMI_ORGANIZATION_ID` and `SOKOSUMI_ORGANIZATION_SLUG` to that Workspace's ID and slug.
   Set both together. The worker rejects incomplete settings and tasks from another Workspace.
4. Restart the worker:

   ```sh
   npm run worker
   ```

5. Create a task in the TUM Workspace:

   ```sh
   sokosumi --preprod tasks create --organization-slug YOUR_WORKSPACE_SLUG --coworker-id YOUR_COWORKER_ID --description "Suggest names for our hackathon team." --status READY --json
   ```

The worker uses the organization slug for task discovery and the organization ID for runtime execution.
Comments and paid tasks use the same Coworker and Workspace checks.
To return to Personal Workspace tasks, finish active work, clear both organization settings, and restart the worker.

## Optional Preprod payments

Prepare your own [Masumi Payment Service](https://github.com/masumi-network/masumi-payment-service) with its current setup instructions.
Use a dedicated database, encryption key, and selling wallet for this project.
Keep setup secrets, including that node's `ADMIN_KEY`, in `.local/mps.env` with permission `600`.
Fund your selling wallet with test ADA.

1. Create `docs/` and `.local/` if absent.
   Save your payment source's `sourceId`, selling wallet's `walletId`, and `sellerAddress` in `docs/payment-state.json`.
   Read these identifiers from your own MPS responses.
2. Set `MPS_URL`, `AGENT_API_PORT`, `AGENT_AUTHOR`, and `BLOCKFROST_API_KEY_PREPROD` in `.env`.
   Use your own name or team name for `AGENT_AUTHOR`.
3. Create the scoped runtime key, then register the agent:

   ```sh
   node --env-file=.env --env-file=.local/mps.env payment-registration.mjs key
   node --env-file=.env --env-file=.local/mps.env payment-registration.mjs register
   ```

4. Check registration until it confirms:

   ```sh
   node --env-file=.env --env-file=.local/mps.env payment-registration.mjs
   ```

5. Complete `docs/registration-state.json` with the confirmed `agentIdentifier`, actual `supportedPaymentSourceIndex`, and selling wallet's `sellerVkey`.
   Read these from your own confirmed registry and wallet responses.
   Start `npm run api`, set `PAID_TASKS_ENABLED=true`, and restart the worker.

Enable payments only after registration confirms and the scoped runtime key is saved in `.local/mps-runtime.env`.
Never copy another project's wallet, registration, or task IDs.
If a payment or registration write has an uncertain outcome, inspect its saved state before retrying.
Complete a paid task and check the seller's net receipt before you submit payment evidence.

## Check your changes

```sh
npm test
```

These tests check local logic. Test your own model connection, Coworker task, and seller receipt through the full setup flow.
The current `npm audit` reports three dependency findings: two high and one moderate, across `eve`, `undici`, and `zod`.
Review these before public deployment. Dependency versions stay pinned in `package-lock.json`.
Keep `.env`, `.local/`, wallet secrets, and generated resource state out of git.
