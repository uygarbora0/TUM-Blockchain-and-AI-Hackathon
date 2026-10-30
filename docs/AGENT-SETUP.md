# Sokosumi and Masumi setup

The local Liquidation Guardian dashboard and deterministic reports work without an account, model, or wallet. This guide connects the same calculation to the restored hackathon starter's task and payment paths. It does not establish that an account, registration, paid task, or seller receipt already exists.

Account/resource creation, registration, task submission, funds transfers, publishing, and deployment need the participant's authorization. Follow the current [official hackathon setup guide](https://www.masumi.network/tum-hackathon) and read `sokosumi skills` and command help before provisioning. Keep each project's Vendor, Coworker, wallets, database, and registration separate.

## 1. Prepare local configuration

Use Node.js 24 or newer. From the repository root:

```sh
npm ci
cp .env.example .env
chmod 600 .env
```

If `.env` already exists, edit it rather than overwriting it. Keep private state under the ignored `.local/` directory. The starter also expects its generated `docs/payment-state.json` and `docs/registration-state.json`; these files are ignored and must never be committed.

For structured position JSON and `guardian demo`, no model is needed. For natural-language explanations, configure `ZAI_API_KEY`, `ZAI_BASE_URL`, and `ZAI_MODEL`; set `ZAI_CONTEXT_WINDOW_TOKENS` when a custom model requires it. Keep `EVE_PORT` and `EVE_URL` consistent and run the optional model runtime:

```sh
npm run agent
```

The authored `agent/tools/calculate_risk.ts` tool calls the same deterministic engine. The model can explain the calculation; it has no wallet signing or lending execution tools.

## 2. Connect a private Coworker

The restored starter supports Sokosumi CLI `1.0.4`; do not upgrade it independently of the runtime adapter.

```sh
npm install --global @masumi_network/sokosumi@1.0.4
sokosumi --version
sokosumi skills
sokosumi --help
```

Use your own Sokosumi Preprod account. Follow the official guide to create this project's dedicated Vendor and private Coworker, connect the Coworker to your Personal Workspace, and import its runtime key through the supported CLI credential interface. Do not inspect the credential vault or paste secrets into source files.

Set `COWORKER_ID` in `.env` to the identifier returned for this project. Leave `SOKOSUMI_ORGANIZATION_ID` and `SOKOSUMI_ORGANIZATION_SLUG` blank for the first Personal Workspace task. Set `PAID_TASKS_ENABLED=false` until payment setup is confirmed.

Start one worker in a separate terminal:

```sh
npm run worker
```

Wait for `Continuous worker running`. After task-submission authorization, replace the placeholder and send the deterministic demonstration:

```sh
sokosumi --preprod tasks create --personal --coworker-id YOUR_COWORKER_ID --description "guardian demo" --status READY --json
```

The result should identify synthetic data, show the 30% collateral price drop, compare bounded rescue options, and state that no funds moved. Save the completed task ID and result privately. Without model configuration, a natural-language follow-up explains the recorded snapshot; a complete replacement JSON position recalculates it. It never marks the previous snapshot as fresh.

## 3. Prepare this project's payment service

Use the current [Masumi Payment Service instructions](https://github.com/masumi-network/masumi-payment-service). Provision a dedicated database, encryption key, payment source, and selling wallet after authorization. Use Cardano **Preprod**, fund the wallet with test ADA, and keep that node's admin configuration in `.local/mps.env` with file permissions `600`.

Create the private state directories if needed, then save identifiers from your own responses:

```json
{
  "sourceId": "YOUR_PAYMENT_SOURCE_ID",
  "walletId": "YOUR_SELLING_WALLET_ID",
  "sellerAddress": "YOUR_SELLER_ADDRESS"
}
```

Save this as ignored `docs/payment-state.json`. The placeholders are not usable account resources. In `.env`, configure `MPS_URL`, `AGENT_API_PORT`, `BLOCKFROST_API_KEY_PREPROD`, and your actual team/person name in `AGENT_AUTHOR`. Registration rejects a missing author.

After authorization, create the scoped key and register Liquidation Guardian:

```sh
node --env-file=.env --env-file=.local/mps.env payment-registration.mjs key
node --env-file=.env --env-file=.local/mps.env payment-registration.mjs register
node --env-file=.env --env-file=.local/mps.env payment-registration.mjs
```

The last command reads registration status. Wait for `RegistrationConfirmed`. Complete ignored `docs/registration-state.json` with the confirmed `agentIdentifier`, actual `supportedPaymentSourceIndex`, and selling wallet's `sellerVkey`, using only your own confirmed responses. Preserve the saved dedicated `walletId` and other state.

The API binds to loopback, as in the starter. This is a local development setup, not a publicly deployed marketplace endpoint. A public endpoint requires a separate reviewed hosting and authorization step.

## 4. Run a paid task and verify the receipt

Run the standard seller endpoint when using the Standard agent API route:

```sh
npm run api
```

Set `PAID_TASKS_ENABLED=true` and restart the worker. Enabled payments fail closed when confirmed registration or the runtime-key file is missing. With no model configured, paid inputs must be a complete position JSON object or `guardian demo`; an unsupported natural-language input is rejected before quoting payment.

The restored task payment flow requests **1 test USDM**, waits for confirmed escrow, calculates the report, submits its result hash, and checks the task's seller receipt using the existing settlement verifier. A report or completed task alone is not proof of seller payment.

The Standard `/start_job` API preserves the starter contract: `input_data` contains only a string `prompt`, alongside the purchaser's hexadecimal nonce. `/input_schema` describes the Liquidation Guardian job. Reusing a nonce with a different input is rejected; uncertain payment writes require inspection rather than automatic replay. Standard API completion confirms result submission, not seller settlement.

Keep evidence together under ignored private state:

- Completed task ID and exact result.
- Confirmed payment transaction hash and network.
- Verified seller receipt/net token amount from the settlement check.
- Any failure or uncertainty, without claiming success prematurely.

The service fee pays for analysis. Emergency collateral or repayment reserves are a separate user-controlled balance; neither task payment nor registration authorizes the agent to spend them.

## 5. Switch to the TUM Workspace

Finish active tasks and pending receipt checks before changing Workspace. After joining the event Workspace through the official guide, read its actual identifiers:

```sh
sokosumi --preprod workspaces list --json
```

After authorization, connect this project's existing Coworker and check access:

```sh
sokosumi --preprod coworkers connect YOUR_COWORKER_ID --vendor-id YOUR_VENDOR_ID --workspace-id YOUR_ORGANIZATION_ID --json
sokosumi --preprod workspaces check YOUR_ORGANIZATION_ID --json
```

Continue when access is `GRANTED`. Stop the worker, set both `SOKOSUMI_ORGANIZATION_ID` and `SOKOSUMI_ORGANIZATION_SLUG`, and restart it. The worker checks Coworker and Workspace on task discovery, runtime actions, comments, and paid operations.

```sh
sokosumi --preprod tasks create --organization-slug YOUR_WORKSPACE_SLUG --coworker-id YOUR_COWORKER_ID --description "guardian demo" --status READY --json
```

To return to Personal Workspace, finish active work, clear both organization settings, and restart.

## Recovery and limits

The starter journals before external writes. If a job has a `*-pending` phase or a registration/key write has an uncertain outcome, inspect the corresponding service and private journal before recovery. Do not delete state to force a retry: that can duplicate payments or requests.

Run `npm test` after behavior changes. Local tests do not establish live model connectivity, a Sokosumi task, chain confirmation, or seller settlement. Real lending position discovery, oracle validation, transaction building, and wallet authorization still require a verified protocol adapter. This project exposes no live rescue transaction route.
