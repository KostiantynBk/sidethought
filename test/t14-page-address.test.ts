import { describe, expect, it } from 'vitest';
import { fetchPage } from '../src/model/meta/page-fetch.js';
import { fakePageIo, pageUrl, publicAddress } from './t14-page-helpers.js';

async function blocked(url: string): Promise<void> {
  const fake = fakePageIo();
  expect(await fetchPage(url, new AbortController().signal, fake.io)).toEqual({ status: 'blocked' });
  expect(fake.requests).toHaveLength(0);
}

describe('T14 SSRF address policy', () => {
  it('blocks IPv4 loopback', async () => {
    await blocked('http://127.0.0.1/');
  });

  it('blocks the 10/8 private range', async () => {
    await blocked('https://10.0.0.5/');
  });

  it('blocks the 192.168/16 private range', async () => {
    await blocked('https://192.168.1.1/');
  });

  it('blocks the 172.16/12 private range', async () => {
    await blocked('https://172.31.255.254/');
  });

  it('blocks link-local metadata endpoints', async () => {
    await blocked('http://169.254.169.254/');
  });

  it('blocks carrier-grade NAT', async () => {
    await blocked('http://100.64.0.1/');
  });

  it('blocks unspecified IPv4', async () => {
    await blocked('http://0.0.0.0/');
  });

  it('blocks IPv4 multicast', async () => {
    await blocked('http://224.0.0.1/');
  });

  it('blocks IPv4 broadcast', async () => {
    await blocked('http://255.255.255.255/');
  });

  it('blocks reserved IPv4', async () => {
    await blocked('http://240.0.0.1/');
  });

  it('blocks documentation IPv4', async () => {
    await blocked('http://192.0.2.1/');
  });

  it('blocks benchmark IPv4', async () => {
    await blocked('http://198.18.0.1/');
  });

  it('blocks special-purpose IPv4', async () => {
    await blocked('http://192.0.0.8/');
  });

  it('blocks numeric shorthand loopback after URL canonicalization', async () => {
    await blocked('http://2130706433/');
  });

  it('blocks hexadecimal loopback after URL canonicalization', async () => {
    await blocked('http://0x7f000001/');
  });

  it('blocks IPv6 loopback', async () => {
    await blocked('http://[::1]/');
  });

  it('blocks IPv6 unique-local addresses', async () => {
    await blocked('http://[fd00::1]/');
  });

  it('blocks the other half of the IPv6 unique-local range', async () => {
    await blocked('http://[fc00::1]/');
  });

  it('blocks IPv6 link-local addresses', async () => {
    await blocked('http://[fe80::1]/');
  });

  it('blocks unspecified IPv6', async () => {
    await blocked('http://[::]/');
  });

  it('blocks multicast IPv6', async () => {
    await blocked('http://[ff02::1]/');
  });

  it('blocks IPv4-mapped IPv6', async () => {
    await blocked('http://[::ffff:127.0.0.1]/');
  });

  it('blocks public IPv4 mapped into IPv6 too', async () => {
    await blocked('http://[::ffff:8.8.8.8]/');
  });

  it('blocks NAT64 transition addresses', async () => {
    await blocked('http://[64:ff9b::7f00:1]/');
  });

  it('blocks 6to4 transition addresses', async () => {
    await blocked('http://[2002:7f00:1::]/');
  });

  it('blocks documentation IPv6', async () => {
    await blocked('http://[2001:db8::1]/');
  });

  it('blocks reserved IPv6 outside global unicast', async () => {
    await blocked('http://[4000::1]/');
  });

  it('blocks FTP URLs', async () => {
    await blocked('ftp://public.example/file');
  });

  it('blocks file URLs', async () => {
    await blocked('file:///etc/passwd');
  });

  it('blocks credentials', async () => {
    await blocked('https://user:password@public.example/');
  });

  it('blocks non-default ports', async () => {
    await blocked('https://public.example:8443/');
  });

  it('blocks hostnames resolving to private IPs', async () => {
    const fake = fakePageIo();
    fake.resolve.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
    expect(await fetchPage(pageUrl, new AbortController().signal, fake.io)).toEqual({ status: 'blocked' });
    expect(fake.requests).toHaveLength(0);
  });

  it('blocks mixed public/private DNS answers', async () => {
    const fake = fakePageIo();
    fake.resolve.mockResolvedValue([
      { address: publicAddress, family: 4 },
      { address: 'fd00::1', family: 6 },
    ]);
    expect(await fetchPage(pageUrl, new AbortController().signal, fake.io)).toEqual({ status: 'blocked' });
    expect(fake.requests).toHaveLength(0);
  });

  it('blocks empty DNS answers', async () => {
    const fake = fakePageIo();
    fake.resolve.mockResolvedValue([]);
    expect(await fetchPage(pageUrl, new AbortController().signal, fake.io)).toEqual({ status: 'blocked' });
  });

  it('allows public IPv4 at the HTTP default port', async () => {
    const fake = fakePageIo();
    const result = await fetchPage(`http://${publicAddress}:80/`, new AbortController().signal, fake.io);
    expect(result.status).toBe('fetched');
    expect(fake.resolve).not.toHaveBeenCalled();
  });

  it('allows global public IPv6 at the HTTPS default port', async () => {
    const fake = fakePageIo();
    const result = await fetchPage('https://[2606:4700:4700::1111]:443/', new AbortController().signal, fake.io);
    expect(result.status).toBe('fetched');
    expect(fake.resolve).not.toHaveBeenCalled();
  });

  it('pins both Node lookup modes to the originally validated address', async () => {
    const fake = fakePageIo();
    await fetchPage(pageUrl, new AbortController().signal, fake.io);
    fake.resolve.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    const lookup = fake.requests[0]!.options.lookup!;
    lookup('provider.example', {}, (error, address, family) => {
      expect(error).toBeNull();
      expect(address).toBe(publicAddress);
      expect(family).toBe(4);
    });
    lookup('provider.example', { all: true }, (error, addresses) => {
      expect(error).toBeNull();
      expect(addresses).toEqual([{ address: publicAddress, family: 4 }]);
    });
    expect(fake.resolve).toHaveBeenCalledExactlyOnceWith('provider.example');
    expect(fake.requests[0]!.options.agent).toBe(false);
  });
});
