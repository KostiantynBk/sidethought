import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import type { LookupAddress } from 'node:dns';

export class BlockedPage extends Error {
  constructor() {
    super('page_blocked');
  }
}

export type PageResolver = (hostname: string) => Promise<LookupAddress[]>;
export const resolvePageHost: PageResolver = hostname => lookup(hostname, {
  all: true,
  verbatim: true,
});

const blockedV4 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) blockedV4.addSubnet(address, prefix, 'ipv4');
// Azure host-node WireServer/platform VIP is public-looking, but is not an Internet page.
// https://learn.microsoft.com/en-us/azure/virtual-network/what-is-ip-address-168-63-129-16
blockedV4.addAddress('168.63.129.16', 'ipv4');
// 255.255.255.255 is already denied by 240/4; keep the broadcast boundary explicit.
blockedV4.addAddress('255.255.255.255', 'ipv4');

const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const blockedV6 = new BlockList();
// Fail closed for special-purpose/transition ranges, including Teredo, ORCHID and 6to4.
blockedV6.addSubnet('2001::', 23, 'ipv6');
blockedV6.addSubnet('2001:db8::', 32, 'ipv6');
blockedV6.addSubnet('2002::', 16, 'ipv6');
blockedV6.addSubnet('3fff::', 20, 'ipv6');

export function publicPageAddress(address: string): boolean {
  if (address.includes('%')) return false;
  const family = isIP(address);
  if (family === 4) return !blockedV4.check(address, 'ipv4');
  // Global-unicast allowlist also excludes mapped IPv4, NAT64, unspecified, local and multicast IPv6.
  return family === 6 && globalV6.check(address, 'ipv6') && !blockedV6.check(address, 'ipv6');
}

export function pageUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BlockedPage();
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) {
    throw new BlockedPage();
  }
  url.hash = '';
  return url;
}

export async function pageAddress(url: URL, resolve: PageResolver): Promise<LookupAddress> {
  const hostname = url.hostname.replace(/^\[|\]$/gu, '');
  const family = isIP(hostname);
  const addresses = family ? [{
    address: hostname,
    family,
  }] : await resolve(hostname);
  // Reject mixed public/private answers too, not merely the selected address.
  if (!addresses.length || addresses.some(value => !publicPageAddress(value.address)
    || isIP(value.address) !== value.family)) throw new BlockedPage();
  return addresses[0]!;
}
