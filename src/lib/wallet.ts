// Read-only wallet connection through Stellar Wallets Kit (Freighter, xBull,
// Albedo, LOBSTR, Rabet, Hana and the other default modules). The app only
// asks the wallet for its public key: it never builds, signs or submits a
// transaction. The kit is loaded on first use to keep the first paint light.

type Kit = typeof import('@creit.tech/stellar-wallets-kit/sdk').StellarWalletsKit;

let kitPromise: Promise<Kit> | null = null;

function loadKit(): Promise<Kit> {
  if (!kitPromise) {
    kitPromise = (async () => {
      const [{ StellarWalletsKit }, { defaultModules }, types] = await Promise.all([
        import('@creit.tech/stellar-wallets-kit/sdk'),
        import('@creit.tech/stellar-wallets-kit/modules/utils'),
        import('@creit.tech/stellar-wallets-kit/types'),
      ]);
      StellarWalletsKit.init({
        modules: defaultModules(),
        network: types.Networks.PUBLIC,
        authModal: { showInstallLabel: true, hideUnsupportedWallets: false },
        theme: {
          background: '#131E33',
          'background-secondary': '#17243D',
          'foreground-strong': '#F2F2F0',
          foreground: '#F2F2F0',
          'foreground-secondary': '#9DA9BE',
          primary: '#3D74FF',
          'primary-foreground': '#FFFFFF',
          transparent: 'rgba(0,0,0,0)',
          lighter: '#1D2C49',
          light: '#1D2C49',
          'light-gray': '#2E4468',
          gray: '#6C7A93',
          danger: '#F87171',
          border: '#223452',
          shadow: '0 24px 64px rgba(0,0,0,.45)',
          'border-radius': '12px',
          'font-family': "Satoshi, system-ui, sans-serif",
        },
      });
      return StellarWalletsKit;
    })();
    kitPromise.catch(() => {
      kitPromise = null;
    });
  }
  return kitPromise;
}

export interface Connected {
  address: string;
  walletId: string | null;
  walletName: string | null;
}

/** Opens the kit's wallet picker and resolves with the selected account's public key. */
export async function connectWallet(): Promise<Connected> {
  const kit = await loadKit();
  const { address } = await kit.authModal();
  let walletId: string | null = null;
  let walletName: string | null = null;
  try {
    const mod = kit.selectedModule;
    walletId = mod.productId ?? null;
    walletName = mod.productName ?? null;
  } catch {
    // The kit exposes no selected module after some flows; the address is what matters.
  }
  return { address, walletId, walletName };
}

export async function disconnectWallet(): Promise<void> {
  if (!kitPromise) return;
  const kit = await kitPromise;
  await kit.disconnect();
}
