import { expect, it } from 'vitest';
import { fetchPage } from '../src/model/meta/page-fetch.js';
import { fakePageIo, pageUrl, publicAddress } from './t14-page-helpers.js';

const denied = [
  ['Azure WireServer', '168.63.129.16'],
  ['protocol assignment lower boundary', '192.0.0.0'],
  ['protocol assignment upper boundary', '192.0.0.255'],
  ['benchmark lower boundary', '198.18.0.0'],
  ['benchmark upper boundary', '198.19.255.255'],
  ['reserved lower boundary', '240.0.0.0'],
  ['reserved upper boundary', '255.255.255.254'],
  ['limited broadcast', '255.255.255.255'],
  ['Alibaba metadata in CGNAT', '100.100.100.200'],
  ['link-local instance metadata', '169.254.169.254'],
  ['AWS task credentials in link-local', '169.254.170.2'],
] as const;

for (const [name, address] of denied) {
  it(`blocks the literal ${name} address before any HTTP request`, async () => {
    const fake = fakePageIo();
    const result = await fetchPage(`http://${address}/?comp=versions`, new AbortController().signal, fake.io);
    expect(result).toEqual({ status: 'blocked' });
    expect(fake.requests).toHaveLength(0);
    expect(fake.resolve).not.toHaveBeenCalled();
  });

  it(`blocks a hostname resolving to ${name} before any HTTP request`, async () => {
    const fake = fakePageIo();
    fake.resolve.mockResolvedValue([{ address, family: 4 }]);
    const result = await fetchPage(pageUrl, new AbortController().signal, fake.io);
    expect(result).toEqual({ status: 'blocked' });
    expect(fake.requests).toHaveLength(0);
  });

  it(`blocks a public page redirect to the literal ${name} address`, async () => {
    const fake = fakePageIo([{
      status: 302,
      headers: { location: `http://${address}/?comp=versions` },
    }]);
    const result = await fetchPage(pageUrl, new AbortController().signal, fake.io);
    expect(result).toEqual({ status: 'blocked' });
    expect(fake.requests.map(request => request.url)).toEqual([pageUrl]);
  });

  it(`blocks a public page redirect to a hostname resolving to ${name}`, async () => {
    const fake = fakePageIo([{
      status: 302,
      headers: { location: 'http://platform.example/?comp=versions' },
    }]);
    fake.resolve.mockResolvedValueOnce([{ address: publicAddress, family: 4 }])
      .mockResolvedValueOnce([{ address, family: 4 }]);
    const result = await fetchPage(pageUrl, new AbortController().signal, fake.io);
    expect(result).toEqual({ status: 'blocked' });
    expect(fake.requests.map(request => request.url)).toEqual([pageUrl]);
    expect(fake.resolve).toHaveBeenCalledTimes(2);
  });
}
