/**
 * Brand kits for the creative builder (decision D10). A neutral kit built from the account's
 * brand settings is the default; the Amil Dental kit exists only as an explicitly selected
 * example pack. No account is rebranded as Amil (or Oracle) unless it selects that pack.
 */
export interface BrandKit {
  name: string;
  wordmark: [string, string];
  domain: string;
  senderName: string;
  memberAreaLabel: string | null;
  trustItems: [string, string, string][];
  facts: [string, string][];
  appBanner: { title: string; subtitle: string; cardLabel: string } | null;
  shortLinkDomain: string;
  iconUrl: string | null;
  smsSender: string;
}

export interface AccountBrandSettings {
  name?: string;
  senderName?: string;
  domain?: string;
}

export function neutralBrand(accountName: string, b: AccountBrandSettings = {}): BrandKit {
  const name = b.name?.trim() || accountName;
  const domain = b.domain?.trim() || 'example.com';
  return {
    name,
    wordmark: [name, ''],
    domain,
    senderName: b.senderName?.trim() || name,
    memberAreaLabel: 'My account',
    trustItems: [],
    facts: [],
    appBanner: null,
    shortLinkDomain: `go.${domain}`,
    iconUrl: null,
    smsSender: name.slice(0, 11).toUpperCase(),
  };
}

/** Example pack only: content rebuilt from the Amil Dental files supplied with the original app. */
export const AMIL_EXAMPLE_BRAND: BrandKit = {
  name: 'Amil Dental (example pack)',
  wordmark: ['amil', ' dental'],
  domain: 'amildental.com.br',
  senderName: 'Amil Dental',
  memberAreaLabel: 'Member area',
  trustItems: [
    ['&#129463;', '40,000+', 'service points'],
    ['&#9201;', '24h', 'emergency care'],
    ['&#128205;', 'Nationwide', 'coverage'],
  ],
  facts: [
    ['2.3M', 'members'],
    ['40k+', 'service points'],
    ['40 years', 'in dental care'],
  ],
  appBanner: { title: 'Everything in the Amil Clientes app', subtitle: 'Digital member card · Boleto &amp; PIX · Find a dentist', cardLabel: 'amil<br>card' },
  shortLinkDomain: 'amil.co',
  iconUrl: 'https://www.amildental.com.br/favicon.ico',
  smsSender: 'AMIL',
};
