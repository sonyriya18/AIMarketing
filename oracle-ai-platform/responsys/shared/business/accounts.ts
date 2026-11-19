/** Public business mappings explicitly configured for this application. Unknown accounts need a supplied URL. */
export const BUSINESS_ACCOUNTS = [
  { key: 'amil_dental', name: 'Amil', website: 'https://www.amildental.com.br/', timezone: 'America/Sao_Paulo', currency: 'BRL' },
  { key: 'endeavour_dm', name: 'Endeavour Group - DM', website: 'https://www.danmurphys.com.au/dm/home', timezone: 'Australia/Sydney', currency: 'AUD' },
] as const;

export function configuredBusiness(accountName: string) {
  const name = accountName.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
  if (name === 'amil' || name === 'amil dental') return BUSINESS_ACCOUNTS[0];
  return name === 'endeavour group - dm' ? BUSINESS_ACCOUNTS[1] : undefined;
}

export function defaultBusinessWebsite(accountName: string): string | undefined {
  return configuredBusiness(accountName)?.website;
}

export function businessWebsite(account: { name: string; brand?: { officialWebsite?: string } }): string | undefined {
  return account.brand?.officialWebsite?.trim() || defaultBusinessWebsite(account.name);
}
