// Re-enable before each transaction: wallet extensions can change accounts while
// the page and its server session are still connected to the previous account.
export async function currentWallet(provider, expectedAddress) {
  const api = await provider.enable();
  await assertWalletAccount(api, expectedAddress);
  return api;
}

export async function assertWalletAccount(api, expectedAddress) {
  if (await api.getNetworkId() !== 0) throw new Error('Switch your wallet to Preprod, then disconnect and reconnect it here.');
  if (!expectedAddress || (await api.getChangeAddress()).toLowerCase() !== expectedAddress.toLowerCase()) {
    throw new Error('Your wallet account changed. Disconnect and reconnect the intended wallet before trying again. Nothing was submitted.');
  }
}
