import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import {
  Lucid, Blockfrost, Data, Constr, CML, applyParamsToScript, validatorToAddress, validatorToScriptHash,
  getAddressDetails, credentialToAddress, generatePrivateKey, unixTimeToSlot, slotToUnixTime, verifyData,
} from '@lucid-evolution/lucid';
import { GuardianError } from './errors.mjs';

const BLUEPRINT = new URL('../onchain/plutus.json', import.meta.url);
const ADA = 1_000_000n;
const hex = text => Buffer.from(text).toString('hex');
const ORACLE_TOKEN = hex('price');
const DEBT_TOKEN = hex('tUSD');
const LOAN_TOKEN = hex('LOAN');
// Mirrors onchain/lib/guardian/types.ak.
const THRESHOLD_BPS = 8000n;
export const MIN_OPEN_HEALTH_BPS = 11000n;
export const MAX_PRICE_AGE_MS = 1_800_000;
// Wallet floors for the agent and oracle keys: fees plus script collateral.
const AGENT_FLOOR = 6n * ADA;
const OPERATOR_FLOOR = 8n * ADA;
// A customer's agent pays a shared oracle refresh only above this, so its own rescue fees stay covered.
const ORACLE_PAYER_FLOOR = AGENT_FLOOR + ADA;
// The vault keeps this much so its continuing output stays above min-UTxO.
const VAULT_KEEP = 2n * ADA;
export const KEY_HASH = /^[0-9a-f]{56}$/;

/** Health factor in basis points (10000 = 1.0); null when debt-free. */
export function healthBps(collateral, debt, priceMicro) {
  return debt <= 0n ? null : collateral * priceMicro * THRESHOLD_BPS / (debt * 1_000_000n);
}

/** Lovelace of collateral needed for `targetBps` at `priceMicro`. */
export function collateralFor(targetBps, debt, priceMicro) {
  const numerator = targetBps * debt * 1_000_000n;
  const denominator = priceMicro * THRESHOLD_BPS;
  return (numerator + denominator - 1n) / denominator;
}

// ---- Plutus data -----------------------------------------------------------

const credentialData = c => new Constr(c.type === 'Key' ? 0 : 1, [c.hash]);
const dataCredential = d => ({ type: d.index === 0 ? 'Key' : 'Script', hash: d.fields[0] });

function addressToData(bech32) {
  const { paymentCredential, stakeCredential } = getAddressDetails(bech32);
  if (!paymentCredential) throw new GuardianError('Recipient must be a payment address.');
  const stake = stakeCredential ? new Constr(0, [new Constr(0, [credentialData(stakeCredential)])]) : new Constr(1, []);
  return new Constr(0, [credentialData(paymentCredential), stake]);
}

function dataToAddress(d, network) {
  const [payment, stake] = d.fields;
  return credentialToAddress(network, dataCredential(payment), stake.index === 0 ? dataCredential(stake.fields[0].fields[0]) : undefined);
}

export function encodeMandate(m) {
  return Data.to(new Constr(0, [
    m.agent, BigInt(m.maxPerTx), BigInt(m.periodLimit), BigInt(m.periodMs), BigInt(m.periodStart),
    BigInt(m.spentInPeriod), m.recipients.map(addressToData), BigInt(m.expiry),
  ]));
}

export function decodeMandate(cbor, network) {
  const d = Data.from(cbor);
  if (!(d instanceof Constr) || d.index !== 0 || d.fields.length !== 8) throw new Error('Not a mandate datum');
  const [agent, maxPerTx, periodLimit, periodMs, periodStart, spentInPeriod, recipients, expiry] = d.fields;
  return { agent, maxPerTx, periodLimit, periodMs, periodStart, spentInPeriod, recipients: recipients.map(r => dataToAddress(r, network)), expiry };
}

const encodePrice = (price, updatedAt) => Data.to(new Constr(0, [price, BigInt(updatedAt)]));
function decodePrice(cbor) {
  const d = Data.from(cbor);
  if (!(d instanceof Constr) || d.fields.length !== 2) throw new Error('Not a price datum');
  return { price: d.fields[0], updatedAt: Number(d.fields[1]) };
}

const encodeLoan = (borrower, debt) => Data.to(new Constr(0, [borrower, debt]));
function decodeLoan(cbor) {
  const d = Data.from(cbor);
  if (!(d instanceof Constr) || d.fields.length !== 2) throw new Error('Not a loan datum');
  return { borrower: d.fields[0], debt: d.fields[1] };
}

const agentSpend = (amount, recipient) => Data.to(new Constr(0, [amount, BigInt(recipient)]));
const OWNER_SPEND = Data.to(new Constr(1, []));
const SUPPORT = Data.to(new Constr(0, []));
const BORROWER_UPDATE = Data.to(new Constr(1, []));
const UNIT = Data.void();

/** Mirrors the vault validator's period rule so the agent writes the datum it accepts. */
export function nextMandate(m, amount, lowerMs) {
  const newPeriod = BigInt(lowerMs) >= m.periodStart + m.periodMs;
  return { ...m, periodStart: newPeriod ? BigInt(lowerMs) : m.periodStart, spentInPeriod: (newPeriod ? 0n : m.spentInPeriod) + amount };
}

/** Lovelace the mandate still lets the agent move in one transaction right now. */
export function mandateAllowance(m, lowerMs, upperMs) {
  if (BigInt(upperMs) > m.expiry) return 0n;
  const spent = BigInt(lowerMs) >= m.periodStart + m.periodMs ? 0n : m.spentInPeriod;
  const left = m.periodLimit - spent;
  return left < m.maxPerTx ? (left > 0n ? left : 0n) : m.maxPerTx;
}

// ---- Keys and state files ---------------------------------------------------

function loadOrCreateKey(file) {
  if (!existsSync(file)) {
    writeFileSync(file, JSON.stringify({ privateKey: generatePrivateKey(), createdAt: new Date().toISOString() }), { mode: 0o600, flag: 'wx' });
  }
  chmodSync(file, 0o600);
  const { privateKey } = JSON.parse(readFileSync(file, 'utf8'));
  return privateKey;
}

function writePrivateJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(temporary, file);
}

const toLovelace = (ada, name, min = 0) => {
  if (typeof ada !== 'number' || !Number.isFinite(ada) || ada <= min || ada > 1e9) throw new GuardianError(`${name} must be an ADA amount above ${min}.`);
  return BigInt(Math.round(ada * 1e6));
};
const sum = (utxos, unit = 'lovelace') => utxos.reduce((total, u) => total + (u.assets[unit] ?? 0n), 0n);
const plain = value => JSON.parse(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v));

/**
 * Every Guardian transaction. Owner transactions are returned unsigned for
 * the browser wallet. Agent and oracle transactions are signed here with keys
 * that never leave `.local/guardian/`. Each owner has their own agent key
 * under `agents/<owner key hash>/`; the oracle operator key is shared.
 */
export class GuardianChain {
  constructor({ network = 'Preprod', dir, provider, clock = Date.now, blueprint = JSON.parse(readFileSync(BLUEPRINT, 'utf8')) } = {}) {
    this.network = network;
    this.clock = clock;
    this.dir = dir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.provider = provider ?? (process.env.BLOCKFROST_API_KEY_PREPROD
      ? new Blockfrost('https://cardano-preprod.blockfrost.io/api/v0', process.env.BLOCKFROST_API_KEY_PREPROD) : null);
    const code = title => {
      const validator = blueprint.validators.find(v => v.title === title);
      if (!validator) throw new Error(`${title} is missing from onchain/plutus.json. Run npm run contract.`);
      return validator.compiledCode;
    };
    this.code = { vault: code('mandate_vault.mandate_vault.spend'), oracle: code('oracle.oracle.mint'), lending: code('lending.lending.mint') };
    this.agents = new Map();
    this.operator = this.keyInfo(loadOrCreateKey(join(dir, 'oracle-key.json')));
    this.deploymentFile = join(dir, 'deployment.json');
    this.deployment = existsSync(this.deploymentFile) ? JSON.parse(readFileSync(this.deploymentFile, 'utf8')) : null;
    if (this.deployment && (this.deployment.network !== network || this.deployment.operatorKeyHash !== this.operator.keyHash)) {
      throw new Error('deployment.json belongs to another network or oracle key. Move it aside before starting.');
    }
    this.pending = new Map();
    this.queue = Promise.resolve();
  }

  keyInfo(privateKey) {
    const keyHash = CML.PrivateKey.from_bech32(privateKey).to_public().hash().to_hex();
    return { privateKey, keyHash, address: credentialToAddress(this.network, { type: 'Key', hash: keyHash }) };
  }

  /** This owner's agent key, created on first use. Their mandate names only this key. */
  agentFor(ownerKeyHash) {
    if (!KEY_HASH.test(ownerKeyHash)) throw new GuardianError('Owner key hash is invalid.');
    let agent = this.agents.get(ownerKeyHash);
    if (!agent) {
      const agentDir = join(this.dir, 'agents', ownerKeyHash);
      mkdirSync(agentDir, { recursive: true, mode: 0o700 });
      agent = this.keyInfo(loadOrCreateKey(join(agentDir, 'agent-key.json')));
      this.agents.set(ownerKeyHash, agent);
    }
    return agent;
  }

  get configured() { return Boolean(this.provider); }

  // Lucid's selected wallet is instance state, so chain work runs one task at a time.
  serial(task) {
    const run = this.queue.then(task);
    this.queue = run.catch(() => {});
    return run;
  }

  async lucid() {
    if (!this.provider) throw new GuardianError('Set BLOCKFROST_API_KEY_PREPROD in .env to connect to Cardano Preprod.', 503);
    this.instance ??= Lucid(this.provider, this.network);
    return this.instance;
  }

  /** Slot-aligned validity bounds, as the validators will see them. */
  window(minutes = 5) {
    const now = this.clock();
    const align = t => slotToUnixTime(this.network, unixTimeToSlot(this.network, t));
    return { lower: align(now - 60_000), now: align(now), upper: align(now + minutes * 60_000) };
  }

  // ---- Scripts ----

  script(code, params) {
    const validator = { type: 'PlutusV3', script: applyParamsToScript(code, params) };
    return { validator, hash: validatorToScriptHash(validator), address: validatorToAddress(this.network, validator) };
  }

  vaultScript(ownerKeyHash) { return this.script(this.code.vault, [ownerKeyHash]); }

  requireDeployment() {
    if (!this.deployment) throw new GuardianError('Deploy the price oracle first.', 409);
    return this.deployment;
  }

  oracleScript() {
    const { seed } = this.requireDeployment();
    return this.script(this.code.oracle, [this.operator.keyHash, new Constr(0, [seed.txHash, BigInt(seed.outputIndex)])]);
  }

  lendingScript() { return this.script(this.code.lending, [this.requireDeployment().oraclePolicy]); }

  loanAddress(borrowerKeyHash) {
    return credentialToAddress(this.network, { type: 'Script', hash: this.lendingScript().hash }, { type: 'Key', hash: borrowerKeyHash });
  }

  // ---- Wallets ----

  /** Validate a CIP-30 wallet description and derive the owner key. */
  wallet({ changeAddress, usedAddresses = [] } = {}) {
    const toBech32 = value => {
      if (typeof value !== 'string' || value.length > 300) throw new GuardianError('Wallet address is invalid.');
      let bech32;
      try { bech32 = /^[0-9a-f]+$/i.test(value) ? CML.Address.from_hex(value).to_bech32(undefined) : value; getAddressDetails(bech32); } catch { throw new GuardianError('Wallet address is invalid.'); }
      const details = getAddressDetails(bech32);
      if (details.networkId !== (this.network === 'Mainnet' ? 1 : 0)) throw new GuardianError(`Switch your wallet to ${this.network}.`);
      return { bech32, details };
    };
    const change = toBech32(changeAddress);
    if (change.details.paymentCredential?.type !== 'Key') throw new GuardianError('Connect a wallet with a key-based payment address.');
    if (!Array.isArray(usedAddresses) || usedAddresses.length > 50) throw new GuardianError('Too many wallet addresses.');
    const addresses = [...new Set([change.bech32, ...usedAddresses.map(a => toBech32(a).bech32)])];
    return { address: change.bech32, addresses, ownerKeyHash: change.details.paymentCredential.hash };
  }

  /** True when a CIP-30 signData result over `payload` was made by the wallet's payment key. */
  verifyOwnership(wallet, payload, { signature, key } = {}) {
    if (typeof signature !== 'string' || typeof key !== 'string' || signature.length > 4000 || key.length > 400 || !/^[0-9a-f]+$/i.test(signature + key)) return false;
    try { return verifyData(CML.Address.from_bech32(wallet.address).to_hex(), wallet.ownerKeyHash, payload, { signature, key }); } catch { return false; }
  }

  async walletUtxos(lucid, wallet) {
    return (await Promise.all(wallet.addresses.map(a => lucid.utxosAt(a)))).flat();
  }

  async useWallet(lucid, wallet) {
    lucid.selectWallet.fromAddress(wallet.address, await this.walletUtxos(lucid, wallet));
  }

  /** `cosigner` is an agent owner key hash whose agent key also signs at submission. */
  remember(kind, tx, cosigner = null) {
    const txHash = tx.toHash();
    const txCbor = tx.toCBOR();
    this.pending.set(txHash, { kind, cbor: txCbor, createdAt: this.clock(), cosigner });
    for (const [key, item] of this.pending) if (this.clock() - item.createdAt > 15 * 60_000) this.pending.delete(key);
    return { txHash, txCbor, kind, fee: tx.toTransaction().body().fee().toString() };
  }

  // ---- Reads ----

  async readOracle(lucid) {
    if (!this.deployment) return null;
    const { address } = this.oracleScript();
    const unit = this.deployment.oraclePolicy + ORACLE_TOKEN;
    const utxo = (await lucid.utxosAt(address)).find(u => u.assets[unit] === 1n && u.datum);
    if (!utxo) return null;
    const { price, updatedAt } = decodePrice(utxo.datum);
    return { utxo, price, updatedAt, ageMs: this.clock() - updatedAt, fresh: this.clock() - updatedAt < MAX_PRICE_AGE_MS };
  }

  async readLoans(lucid, ownerKeyHash) {
    if (!this.deployment) return [];
    const { hash } = this.lendingScript();
    return (await lucid.utxosAt(this.loanAddress(ownerKeyHash))).flatMap(utxo => {
      try {
        if (utxo.assets[hash + LOAN_TOKEN] !== 1n || !utxo.datum) return [];
        const loan = decodeLoan(utxo.datum);
        return loan.borrower === ownerKeyHash ? [{ utxo, debt: loan.debt, collateral: utxo.assets.lovelace }] : [];
      } catch { return []; }
    });
  }

  async readMandate(lucid, ownerKeyHash) {
    const { address } = this.vaultScript(ownerKeyHash);
    const utxos = await lucid.utxosAt(address);
    const candidates = utxos.flatMap(utxo => {
      try {
        const mandate = utxo.datum && decodeMandate(utxo.datum, this.network);
        return mandate && mandate.agent === this.agentFor(ownerKeyHash).keyHash ? [{ utxo, mandate }] : [];
      } catch { return []; }
    }).sort((a, b) => (b.utxo.assets.lovelace > a.utxo.assets.lovelace ? 1 : -1));
    return { utxos, active: candidates[0] ?? null };
  }

  /** Everything the dashboard shows, read live from the chain. */
  async overview(wallet) {
    const agent = wallet ? this.agentFor(wallet.ownerKeyHash) : null;
    const base = {
      network: this.network, configured: this.configured,
      agent: agent && { address: agent.address, keyHash: agent.keyHash, lovelace: null },
      oracle: { operator: this.operator.address, operatorKeyHash: this.operator.keyHash, lovelace: null, deployed: Boolean(this.deployment) },
      contracts: Object.fromEntries(Object.entries(this.code).map(([k, v]) => [k, v.length / 2])),
    };
    if (!this.configured) return plain(base);
    const lucid = await this.lucid();
    if (agent) base.agent.lovelace = sum(await lucid.utxosAt(agent.address));
    base.oracle.lovelace = sum(await lucid.utxosAt(this.operator.address));
    const oracle = await this.readOracle(lucid);
    if (this.deployment) {
      Object.assign(base.oracle, { address: this.oracleScript().address, policy: this.deployment.oraclePolicy, lendingHash: this.lendingScript().hash, deployTx: this.deployment.txHash });
      if (oracle) Object.assign(base.oracle, { price: oracle.price, updatedAt: oracle.updatedAt, fresh: oracle.fresh, ref: `${oracle.utxo.txHash}#${oracle.utxo.outputIndex}` });
    }
    if (!wallet) return plain(base);
    const walletUtxos = await this.walletUtxos(lucid, wallet);
    const tusdUnit = this.deployment ? this.lendingScript().hash + DEBT_TOKEN : null;
    const vault = this.vaultScript(wallet.ownerKeyHash);
    const { utxos, active } = await this.readMandate(lucid, wallet.ownerKeyHash);
    const loans = await this.readLoans(lucid, wallet.ownerKeyHash);
    const window = this.window();
    const loanAddress = this.deployment ? this.loanAddress(wallet.ownerKeyHash) : null;
    return plain({
      ...base,
      wallet: { address: wallet.address, ownerKeyHash: wallet.ownerKeyHash, lovelace: sum(walletUtxos), tusd: tusdUnit ? sum(walletUtxos, tusdUnit) : 0n },
      loans: loans.map(l => ({
        ref: `${l.utxo.txHash}#${l.utxo.outputIndex}`, address: loanAddress, collateral: l.collateral, debt: l.debt,
        healthBps: oracle ? healthBps(l.collateral, l.debt, oracle.price) : null,
        liquidationPriceMicro: l.collateral > 0n ? l.debt * 1_000_000n * 10000n / (l.collateral * THRESHOLD_BPS) : null,
      })),
      vault: {
        address: vault.address, scriptHash: vault.hash, lovelace: sum(utxos),
        utxos: utxos.map(u => {
          let mandate = null;
          try { if (u.datum) mandate = decodeMandate(u.datum, this.network); } catch {}
          return { ref: `${u.txHash}#${u.outputIndex}`, lovelace: u.assets.lovelace, mandate: mandate && { ...mandate, forThisAgent: mandate.agent === agent.keyHash, coversLoan: Boolean(loanAddress && mandate.recipients.includes(loanAddress)) } };
        }),
        allowance: active ? mandateAllowance(active.mandate, window.lower, window.upper) : 0n,
      },
    });
  }

  // ---- Oracle (signed by the operator key) ----

  deployOracle(priceMicro) {
    return this.serial(async () => {
      if (this.deployment) {
        const lucid = await this.lucid();
        if (await this.readOracle(lucid)) throw new GuardianError('The oracle is already deployed.', 409);
        if (this.clock() - Date.parse(this.deployment.deployedAt) < 10 * 60_000) throw new GuardianError('The last deployment is still confirming. Wait a few minutes.', 409);
      }
      const lucid = await this.lucid();
      lucid.selectWallet.fromPrivateKey(this.operator.privateKey);
      const funds = await lucid.utxosAt(this.operator.address);
      if (sum(funds) < OPERATOR_FLOOR) throw new GuardianError('The oracle operator wallet needs 8+ ADA. The server operator funds it from the Preprod faucet; its address is printed at startup.', 409);
      const seed = funds[0];
      const previous = this.deployment;
      this.deployment = { network: this.network, operatorKeyHash: this.operator.keyHash, seed: { txHash: seed.txHash, outputIndex: seed.outputIndex } };
      try {
        const oracle = this.oracleScript();
        this.deployment.oraclePolicy = oracle.hash;
        const w = this.window();
        const tx = await lucid.newTx()
          .collectFrom([seed])
          .mintAssets({ [oracle.hash + ORACLE_TOKEN]: 1n }, UNIT)
          .attach.MintingPolicy(oracle.validator)
          .pay.ToContract(oracle.address, { kind: 'inline', value: encodePrice(priceMicro, w.now) }, { lovelace: 2n * ADA, [oracle.hash + ORACLE_TOKEN]: 1n })
          .addSignerKey(this.operator.keyHash)
          .validFrom(w.lower).validTo(w.upper)
          .complete();
        const signed = await tx.sign.withWallet().complete();
        // Record before submitting: the seed fixes every script hash.
        this.deployment = { ...this.deployment, txHash: signed.toHash(), deployedAt: new Date(this.clock()).toISOString() };
        writePrivateJson(this.deploymentFile, this.deployment);
        await signed.submit();
        return { txHash: this.deployment.txHash, oraclePolicy: oracle.hash, lendingHash: this.lendingScript().hash };
      } catch (error) {
        // Nothing was recorded unless signing succeeded; restore the prior state.
        if (!this.deployment?.txHash) this.deployment = previous;
        throw error;
      }
    });
  }

  /**
   * Publish a new price. The contract needs only the operator's signature, so
   * with `payerOwnerKeyHash` that customer's agent fee wallet pays the fee and
   * collateral and the operator key just co-signs; without it the operator pays.
   */
  publishPrice(priceMicro, payerOwnerKeyHash) {
    return this.serial(async () => {
      const lucid = await this.lucid();
      const oracle = await this.readOracle(lucid);
      if (!oracle) throw new GuardianError('The oracle is not on-chain yet.', 409);
      const { validator, address } = this.oracleScript();
      const payer = payerOwnerKeyHash ? this.agentFor(payerOwnerKeyHash) : this.operator;
      lucid.selectWallet.fromPrivateKey(payer.privateKey);
      const w = this.window();
      const tx = await lucid.newTx()
        .collectFrom([oracle.utxo], UNIT)
        .attach.SpendingValidator(validator)
        .pay.ToContract(address, { kind: 'inline', value: encodePrice(priceMicro, w.now) }, oracle.utxo.assets)
        .addSignerKey(this.operator.keyHash)
        .validFrom(w.lower).validTo(w.upper)
        .complete();
      const signing = payer === this.operator ? tx.sign.withWallet() : tx.sign.withWallet().sign.withPrivateKey(this.operator.privateKey);
      const txHash = await signing.complete().then(s => s.submit());
      return { txHash, price: priceMicro, updatedAt: w.now };
    });
  }

  // ---- Owner transactions (unsigned; the browser wallet signs) ----

  /**
   * Top up this owner's own agent fee wallet. It pays the agent's rescues and,
   * in turn with the other running customers, the shared oracle refreshes.
   */
  buildFundAgent(wallet) {
    return this.serial(async () => {
      const lucid = await this.lucid();
      const agent = this.agentFor(wallet.ownerKeyHash);
      if (sum(await lucid.utxosAt(agent.address)) >= ORACLE_PAYER_FLOOR) throw new GuardianError('Your agent fee wallet is already funded.', 409);
      await this.useWallet(lucid, wallet);
      const tx = await lucid.newTx().pay.ToAddress(agent.address, { lovelace: 15n * ADA }).complete();
      return { ...this.remember('fund-agent', tx), agent: (15n * ADA).toString() };
    });
  }

  /** Lock ADA as collateral and mint tUSD so the loan opens at `openingHealth`. */
  buildOpenLoan(wallet, { collateralAda, openingHealth } = {}) {
    return this.serial(async () => {
      const lucid = await this.lucid();
      const collateral = toLovelace(collateralAda, 'Collateral', 4);
      if (typeof openingHealth !== 'number' || !(openingHealth >= Number(MIN_OPEN_HEALTH_BPS) / 10000) || openingHealth > 10) throw new GuardianError('Opening health must be between 1.10 and 10.');
      if ((await this.readLoans(lucid, wallet.ownerKeyHash)).length) throw new GuardianError('Close your current loan before opening another.', 409);
      const oracle = await this.readOracle(lucid);
      if (!oracle) throw new GuardianError('The oracle is not on-chain yet.', 409);
      const w = this.window();
      // The validity range must end inside the oracle's freshness window.
      const upper = Math.min(w.upper, oracle.updatedAt + MAX_PRICE_AGE_MS - 60_000);
      if (upper <= w.now) throw new GuardianError('The oracle price is too old. Start the agent or publish a fresh price.', 409);
      const openingBps = BigInt(Math.floor(openingHealth * 10000));
      const debt = collateral * oracle.price * THRESHOLD_BPS / (openingBps * 1_000_000n);
      if (debt < 1_000_000n) throw new GuardianError('This loan would be under 1 tUSD. Add more collateral.');
      const lending = this.lendingScript();
      await this.useWallet(lucid, wallet);
      const tx = await lucid.newTx()
        .readFrom([oracle.utxo])
        .mintAssets({ [lending.hash + DEBT_TOKEN]: debt, [lending.hash + LOAN_TOKEN]: 1n }, UNIT)
        .attach.MintingPolicy(lending.validator)
        .pay.ToContract(this.loanAddress(wallet.ownerKeyHash), { kind: 'inline', value: encodeLoan(wallet.ownerKeyHash, debt) }, { lovelace: collateral, [lending.hash + LOAN_TOKEN]: 1n })
        .addSignerKey(wallet.ownerKeyHash)
        .validFrom(w.lower).validTo(upper)
        .complete();
      return { ...this.remember('open-loan', tx), debt: debt.toString(), healthBps: healthBps(collateral, debt, oracle.price).toString() };
    });
  }

  /** Repay the whole debt with tUSD from the wallet and take the collateral back. */
  buildCloseLoan(wallet) {
    return this.serial(async () => {
      const lucid = await this.lucid();
      const [loan] = await this.readLoans(lucid, wallet.ownerKeyHash);
      if (!loan) throw new GuardianError('You have no open loan.', 409);
      const lending = this.lendingScript();
      const held = sum(await this.walletUtxos(lucid, wallet), lending.hash + DEBT_TOKEN);
      if (held < loan.debt) throw new GuardianError(`Closing needs ${Number(loan.debt) / 1e6} tUSD; your wallet holds ${Number(held) / 1e6}.`, 409);
      await this.useWallet(lucid, wallet);
      const tx = await lucid.newTx()
        .collectFrom([loan.utxo], BORROWER_UPDATE)
        .mintAssets({ [lending.hash + DEBT_TOKEN]: -loan.debt, [lending.hash + LOAN_TOKEN]: -1n }, UNIT)
        .attach.SpendingValidator(lending.validator)
        .addSignerKey(wallet.ownerKeyHash)
        .complete();
      return this.remember('close-loan', tx);
    });
  }

  /** Lock ADA in the vault under a mandate for this owner's agent. Their loan is an allowed recipient. */
  buildDeposit(wallet, input = {}) {
    return this.serial(async () => {
      const lucid = await this.lucid();
      const amount = toLovelace(input.amountAda, 'Deposit', 3);
      const maxPerTx = toLovelace(input.maxPerTxAda, 'Per-transaction limit');
      const periodLimit = toLovelace(input.periodLimitAda, 'Period limit');
      if (periodLimit < maxPerTx) throw new GuardianError('The period limit must be at least the per-transaction limit.');
      const { periodHours, expiryDays } = input;
      if (!Number.isInteger(periodHours) || periodHours < 1 || periodHours > 24 * 365) throw new GuardianError('Period must be 1 hour to 1 year.');
      if (!Number.isInteger(expiryDays) || expiryDays < 1 || expiryDays > 365) throw new GuardianError('Expiry must be 1 to 365 days.');
      const now = this.clock();
      const mandate = {
        agent: this.agentFor(wallet.ownerKeyHash).keyHash, maxPerTx, periodLimit, periodMs: BigInt(periodHours) * 3_600_000n,
        periodStart: BigInt(now), spentInPeriod: 0n, recipients: [wallet.address, this.loanAddress(wallet.ownerKeyHash)],
        expiry: BigInt(now + expiryDays * 86_400_000),
      };
      await this.useWallet(lucid, wallet);
      const tx = await lucid.newTx()
        .pay.ToContract(this.vaultScript(wallet.ownerKeyHash).address, { kind: 'inline', value: encodeMandate(mandate) }, { lovelace: amount })
        .complete();
      return this.remember('deposit', tx);
    });
  }

  /** Spend every vault UTxO back to the wallet. This also revokes the agent. */
  buildWithdraw(wallet) {
    return this.serial(async () => {
      const lucid = await this.lucid();
      const { validator, address } = this.vaultScript(wallet.ownerKeyHash);
      const utxos = await lucid.utxosAt(address);
      if (!utxos.length) throw new GuardianError('The vault is empty.', 409);
      await this.useWallet(lucid, wallet);
      const tx = await lucid.newTx().collectFrom(utxos, OWNER_SPEND).attach.SpendingValidator(validator).addSignerKey(wallet.ownerKeyHash).complete();
      return this.remember('withdraw', tx);
    });
  }

  /**
   * Revoke everything in one transaction the owner signs once: repay and close
   * the loan, empty the vault (which revokes the agent's mandate), and return
   * the agent fee wallet's ADA. The agent key co-signs at submission.
   */
  buildRevokeAll(wallet) {
    return this.serial(async () => {
      const lucid = await this.lucid();
      const [loan] = await this.readLoans(lucid, wallet.ownerKeyHash);
      const vault = this.vaultScript(wallet.ownerKeyHash);
      const vaultUtxos = await lucid.utxosAt(vault.address);
      const agent = this.agentFor(wallet.ownerKeyHash);
      const agentUtxos = await lucid.utxosAt(agent.address);
      if (!loan && !vaultUtxos.length && !agentUtxos.length) throw new GuardianError('Nothing to revoke: no loan, an empty vault and an empty agent fee wallet.', 409);
      const lending = this.lendingScript();
      if (loan) {
        const held = sum(await this.walletUtxos(lucid, wallet), lending.hash + DEBT_TOKEN);
        if (held < loan.debt) throw new GuardianError(`Revoking closes your loan, which needs ${Number(loan.debt) / 1e6} tUSD; your wallet holds ${Number(held) / 1e6}. Nothing was changed. To pull your rescue funds now, use "Withdraw all & revoke agent" in step 05.`, 409);
      }
      await this.useWallet(lucid, wallet);
      let tx = lucid.newTx().addSignerKey(wallet.ownerKeyHash);
      if (loan) tx = tx
        .collectFrom([loan.utxo], BORROWER_UPDATE)
        .mintAssets({ [lending.hash + DEBT_TOKEN]: -loan.debt, [lending.hash + LOAN_TOKEN]: -1n }, UNIT)
        .attach.SpendingValidator(lending.validator);
      if (vaultUtxos.length) tx = tx.collectFrom(vaultUtxos, OWNER_SPEND).attach.SpendingValidator(vault.validator);
      // Change, including everything from the agent fee wallet, goes to the owner's wallet.
      if (agentUtxos.length) tx = tx.collectFrom(agentUtxos).addSignerKey(agent.keyHash);
      const built = await tx.complete();
      return {
        ...this.remember('revoke', built, agentUtxos.length ? wallet.ownerKeyHash : null),
        loanClosed: Boolean(loan), vaultLovelace: sum(vaultUtxos).toString(), agentLovelace: sum(agentUtxos).toString(),
      };
    });
  }

  /** Attach the wallet's witness set to a transaction this service built, then submit. */
  async submitOwner(txCbor, witnessSet) {
    if (typeof txCbor !== 'string' || typeof witnessSet !== 'string' || !/^[0-9a-f]+$/i.test(txCbor) || !/^[0-9a-f]+$/i.test(witnessSet)) throw new GuardianError('Signed transaction is invalid.');
    const lucid = await this.lucid();
    let unsigned;
    try { unsigned = lucid.fromTx(txCbor); } catch { throw new GuardianError('Signed transaction is invalid.'); }
    const hash = unsigned.toHash();
    const pending = this.pending.get(hash);
    if (pending?.cbor !== txCbor) throw new GuardianError('Unknown or expired transaction. Build it again.', 409);
    const assembled = unsigned.assemble([witnessSet]);
    const signed = pending.cosigner ? assembled.sign.withPrivateKey(this.agentFor(pending.cosigner).privateKey) : assembled;
    const txHash = await signed.complete().then(s => s.submit());
    this.pending.delete(hash);
    return { txHash, kind: pending.kind };
  }

  // ---- Agent transactions (signed by the agent key) ----

  async submitAgent(lucid, agent, build) {
    lucid.selectWallet.fromPrivateKey(agent.privateKey);
    try {
      const tx = await build(lucid.newTx()).complete();
      return { status: 'submitted', txHash: await tx.sign.withWallet().complete().then(s => s.submit()) };
    } catch (error) {
      const message = String(error?.message || error);
      if (/script|validator|evaluat|uplc/i.test(message)) return { status: 'rejected_by_contract', reason: message.slice(0, 600) };
      throw error;
    }
  }

  /**
   * Move `amount` lovelace from the vault into the owner's loan as collateral.
   * Both contracts check it: the vault enforces the mandate, the lending
   * contract ensures the loan only gains collateral.
   */
  agentRescue(ownerKeyHash, amount) {
    return this.serial(async () => {
      const lucid = await this.lucid();
      const { active } = await this.readMandate(lucid, ownerKeyHash);
      if (!active) return { status: 'blocked', reason: 'No vault mandate for this agent.' };
      const [loan] = await this.readLoans(lucid, ownerKeyHash);
      if (!loan) return { status: 'blocked', reason: 'No open loan.' };
      const loanAddress = this.loanAddress(ownerKeyHash);
      const recipient = active.mandate.recipients.indexOf(loanAddress);
      if (recipient < 0) return { status: 'blocked', reason: 'The mandate does not allow paying into your loan. Withdraw and sign a new mandate.' };
      if (active.utxo.assets.lovelace - amount < VAULT_KEEP) return { status: 'blocked', reason: 'Not enough ADA left in the vault.' };
      const vault = this.vaultScript(ownerKeyHash);
      const lending = this.lendingScript();
      const agent = this.agentFor(ownerKeyHash);
      const w = this.window();
      const upper = Math.min(w.upper, Number(active.mandate.expiry));
      const result = await this.submitAgent(lucid, agent, tx => tx
        .collectFrom([active.utxo], agentSpend(amount, recipient))
        .collectFrom([loan.utxo], SUPPORT)
        .attach.SpendingValidator(vault.validator)
        .attach.SpendingValidator(lending.validator)
        .pay.ToContract(loanAddress, { kind: 'inline', value: loan.utxo.datum }, { ...loan.utxo.assets, lovelace: loan.collateral + amount })
        .pay.ToContract(vault.address, { kind: 'inline', value: encodeMandate(nextMandate(active.mandate, amount, w.lower)) }, { ...active.utxo.assets, lovelace: active.utxo.assets.lovelace - amount })
        .addSignerKey(agent.keyHash)
        .validFrom(w.lower).validTo(upper));
      return { ...result, amount: amount.toString(), loanRef: `${loan.utxo.txHash}#${loan.utxo.outputIndex}` };
    });
  }

  /** The agent's view of one owner: oracle, loan and mandate allowance. Pass `shared.oracle` to reuse one read across agents. */
  async agentView(ownerKeyHash, shared = {}) {
    const lucid = await this.lucid();
    const oracle = 'oracle' in shared ? shared.oracle : await this.readOracle(lucid);
    const loans = await this.readLoans(lucid, ownerKeyHash);
    const { active } = await this.readMandate(lucid, ownerKeyHash);
    const w = this.window();
    return {
      oracle, loans, mandate: active?.mandate ?? null,
      vaultLovelace: active?.utxo.assets.lovelace ?? 0n,
      allowance: active ? mandateAllowance(active.mandate, w.lower, Math.min(w.upper, Number(active.mandate.expiry))) : 0n,
    };
  }

  /** The oracle keeper's view: the shared price feed. */
  async oracleView() {
    return { oracle: await this.readOracle(await this.lucid()) };
  }

  async agentLovelace(ownerKeyHash) {
    return sum(await (await this.lucid()).utxosAt(this.agentFor(ownerKeyHash).address));
  }
}

export { ADA, VAULT_KEEP, OPERATOR_FLOOR, AGENT_FLOOR, ORACLE_PAYER_FLOOR };
