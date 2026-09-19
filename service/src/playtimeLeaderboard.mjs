/** Merge registered MineLatino accounts with measured launcher playtime. */
export function mergePlaytimeLeaderboard(entries, accounts) {
  const activeNames = new Set(accounts.filter(account => account.status === 'active')
    .map(account => account.nick.toLowerCase()));
  const hiddenNames = new Set(accounts.filter(account => account.status !== 'active'
    && !activeNames.has(account.nick.toLowerCase())).map(account => account.nick.toLowerCase()));
  const byName = new Map();
  for (const entry of entries) {
    if (typeof entry?.name !== 'string' || !Number.isFinite(entry.playtime) || entry.playtime < 0) continue;
    if (hiddenNames.has(entry.name.toLowerCase())) continue;
    byName.set(entry.name.toLowerCase(), {
      name: entry.name,
      playtime: entry.playtime,
      updatedAt: entry.updatedAt || '',
    });
  }
  for (const account of accounts) {
    if (account.status !== 'active') continue;
    const key = account.nick.toLowerCase();
    const existing = byName.get(key);
    byName.set(key, {
      name: account.nick,
      playtime: existing?.playtime ?? 0,
      updatedAt: existing?.updatedAt || '',
    });
  }
  return [...byName.values()]
    .sort((a, b) => b.playtime - a.playtime || a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }))
    .map((entry, index) => ({ rank: index + 1, ...entry }));
}
