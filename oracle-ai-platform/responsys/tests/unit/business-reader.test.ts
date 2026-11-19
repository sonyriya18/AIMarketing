import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const stubs = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: stubs.lookup }));
vi.mock('node:https', () => ({ request: stubs.request }));
import { commercePageHtml, researchWebsite } from '../../server/modules/insights/business';

beforeEach(() => {
  stubs.lookup.mockReset().mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
  stubs.request.mockReset();
});

const body = '<h1>Dental plans for individuals and businesses</h1><p>Explore dental plan information and find dentists in the network. Learn about available services for families and business teams.</p>';
function pages(get: (url: URL) => { code?: number; html?: string; location?: string; contentType?: string }) {
  stubs.request.mockImplementation((url, options, callback) => {
    const req = new EventEmitter() as any;
    req.destroy = (error: Error) => queueMicrotask(() => req.emit('error', error));
    req.end = () => queueMicrotask(() => {
      const page = get(url);
      const res = new EventEmitter() as any;
      res.statusCode = page.code ?? 200;
      res.headers = { 'content-type': page.contentType ?? 'text/html', location: page.location };
      res.resume = () => undefined;
      callback(res);
      queueMicrotask(() => { res.emit('data', Buffer.from(page.html ?? body)); res.emit('end'); });
    });
    return req;
  });
}

describe('website retrieval boundary', () => {
  it('reads same-origin business pages, pins the IP and reuses retrieved context', async () => {
    pages((url) => ({ html: url.pathname === '/' ? `${body}<a href="/planos">Plans</a><a href="/sobre">About</a><a href="https://other.example.com/products">External</a><a href="/products">Extra</a>` : body }));
    const first = await researchWebsite('https://crawl.example.com/');
    expect(first.status).toBe('ready');
    expect(first.sources).toHaveLength(3);
    expect(stubs.request).toHaveBeenCalledTimes(3);
    const options = stubs.request.mock.calls[0]![1];
    const cb = vi.fn();
    options.lookup('crawl.example.com', {}, cb);
    expect(cb).toHaveBeenCalledWith(null, '8.8.8.8', 4);
    expect(options.family).toBe(4);
    expect(await researchWebsite('https://crawl.example.com/')).toBe(first);
    expect(stubs.request).toHaveBeenCalledTimes(3);
  });
  it('blocks private DNS answers before making a request', async () => {
    stubs.lookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
    expect((await researchWebsite('https://private.example.com/')).status).toBe('unavailable');
    expect(stubs.request).not.toHaveBeenCalled();
  });
  it('blocks redirects outside the official origin', async () => {
    pages(() => ({ code: 302, location: 'https://another.example.com/' }));
    expect((await researchWebsite('https://redirect.example.com/')).status).toBe('unavailable');
    expect(stubs.request).toHaveBeenCalledTimes(1);
  });
  it('checks DNS again for allowed redirects', async () => {
    stubs.lookup.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }]).mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
    pages(() => ({ code: 302, location: '/about' }));
    expect((await researchWebsite('https://rebind.example.com/')).status).toBe('unavailable');
    expect(stubs.request).toHaveBeenCalledTimes(1);
  });
  it('reports blocked websites without fabricated sources', async () => {
    pages(() => ({ code: 403 }));
    expect(await researchWebsite('https://blocked.example.com/')).toMatchObject({ status: 'unavailable', sources: [] });
  });
  it('reads actual public page content behind Oracle Commerce JavaScript shells', async () => {
    pages((url) => url.pathname.startsWith('/ccstore/')
      ? { contentType: 'application/json', html: JSON.stringify({ title: 'Dental plans', description: 'Plans for families and businesses.', regions: [{ widgets: [{ templateSrc: body, javascript: 'never execute this' }] }] }) }
      : { html: '<html id="oracle-cc"><body><script>loadCommerce()</script></body></html>' });
    const result = await researchWebsite('https://commerce.example.com/');
    expect(result.status).toBe('ready');
    expect(result.sources[0]!.url).toBe('https://commerce.example.com/ccstore/v1/pages/home');
    expect(result.sources[0]!.text).toContain('Dental plans');
    expect(result.sources[0]!.text).not.toContain('never execute');
    expect(commercePageHtml('{"title":"Care","regions":[]}')).toBe('Care');
  });
  it('rejects oversized pages', async () => {
    pages(() => ({ html: 'a'.repeat(750_001) }));
    expect((await researchWebsite('https://oversize.example.com/')).status).toBe('unavailable');
  });
  it('returns official storefront offer provenance without inventing offers for unreadable content', async () => {
    pages((url) => url.pathname.startsWith('/ccstore/')
      ? { contentType: 'application/json', html: JSON.stringify({ title: 'Dental plans', regions: [{ templateSrc: body, benefitsCardsConfiguration: "[{'1':'Pharmacy discount','2':'Up to 20% discount at participating stores.','3':'pharmacy'}]" }] }) }
      : { html: '<html id="oracle-cc"><body></body></html>' });
    const result = await researchWebsite('https://offers.example.com/');
    expect(result.offers).toHaveLength(1);
    expect(result.offers![0]).toMatchObject({ sourceUrl: 'https://offers.example.com/ccstore/v1/pages/home', landingUrl: 'https://offers.example.com/#pharmacy', text: 'Up to 20% discount at participating stores.' });
  });
});
