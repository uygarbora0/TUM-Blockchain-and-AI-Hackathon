import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CML, Emulator, Lucid, generateEmulatorAccountFromPrivateKey, utxoToCore, credentialToAddress, getAddressDetails } from '@lucid-evolution/lucid';
import { GuardianChain } from './guardian/chain.mjs';
import { currentWallet, assertWalletAccount } from './public/wallet-session.js';

test('stale browser wallet accounts are rejected before transaction signing', async () => {
  let address = 'aa';
  const api = { getNetworkId: async () => 0, getChangeAddress: async () => address };
  assert.equal(await currentWallet({ enable: async () => api }, 'aa'), api);
  address = 'bb';
  await assert.rejects(currentWallet({ enable: async () => api }, 'aa'), /account changed/);
  await assert.rejects(assertWalletAccount(api, 'aa'), /account changed/);
});

test('wallet change at an address absent from sign-in is discovered without trusting browser balances', async () => {
  const account = generateEmulatorAccountFromPrivateKey({ lovelace: 40_000_000n });
  const changeAddress = credentialToAddress('Preprod', getAddressDetails(account.address).paymentCredential, { type: 'Key', hash: 'ab'.repeat(28) });
  const provider = new Emulator([{ ...account, address: changeAddress }]);
  const chain = Object.assign(Object.create(GuardianChain.prototype), { network: 'Preprod' });
  const sessionWallet = chain.wallet({ changeAddress: account.address });
  const [change] = await provider.getUtxos(changeAddress);
  const context = {
    changeAddress: account.address,
    // Same reference, forged balance: provider data must win.
    utxos: [utxoToCore({ ...change, assets: { lovelace: 999_000_000n } }).to_cbor_hex()],
  };
  const wallet = chain.transactionWallet(sessionWallet, context);
  let selected;
  const lucid = { utxosAt: address => provider.getUtxos(address), selectWallet: { fromAddress: (address, inputs) => { selected = inputs; } } };
  await chain.useWallet(lucid, wallet);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].assets.lovelace, 40_000_000n);
  assert.equal(selected[0].address, changeAddress);
  assert.deepEqual(sessionWallet.addresses, [account.address]);
  assert.equal(sessionWallet.inputRefs, undefined);
});

test('three concurrent loan builds use only each signing wallet’s synchronized inputs', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'guardian-wallet-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const accounts = Array.from({ length: 4 }, () => generateEmulatorAccountFromPrivateKey({ lovelace: 300_000_000n }));
  const provider = new Emulator(accounts);
  const chain = new GuardianChain({ dir, provider, clock: () => provider.now() });
  chain.operator = chain.keyInfo(accounts[0].privateKey);
  await chain.lucid();
  provider.awaitBlock(10);
  await chain.deployOracle(500_000n);
  provider.awaitBlock();

  const wallets = await Promise.all(accounts.slice(1).map(async account => {
    const wallet = chain.wallet({ changeAddress: account.address });
    const utxos = await provider.getUtxos(account.address);
    const context = { changeAddress: account.address, utxos: utxos.map(u => utxoToCore(u).to_cbor_hex()) };
    return { account, wallet, context, utxos };
  }));
  assert.throws(() => chain.transactionWallet(wallets[0].wallet, wallets[1].context), /does not match/);
  const built = await Promise.all(wallets.map(({ wallet, context }) => chain.buildOpenLoan(chain.transactionWallet(wallet, context), { collateralAda: 50, openingHealth: 1.5 })));
  for (let i = 0; i < wallets.length; i++) {
    const { account, utxos } = wallets[i];
    const inputs = CML.Transaction.from_cbor_hex(built[i].txCbor).body().inputs();
    for (let j = 0; j < inputs.len(); j++) {
      assert.ok(utxos.some(u => u.txHash === inputs.get(j).transaction_id().to_hex() && u.outputIndex === Number(inputs.get(j).index())));
    }
    const signer = await Lucid(provider, 'Preprod');
    signer.selectWallet.fromPrivateKey(account.privateKey);
    const signed = await signer.fromTx(built[i].txCbor).sign.withWallet().complete();
    await signed.submit();
  }

  // A wallet may lag behind Blockfrost. Never silently fall back to all chain
  // inputs when none of the extension's advertised inputs are available.
  const disconnected = { ...wallets[0].wallet, inputRefs: new Set(['missing#0']) };
  await assert.rejects(chain.useWallet(await chain.lucid(), disconnected), /not synchronized/);
});
