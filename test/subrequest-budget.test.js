import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchListingsPage } from '../src/scraper.js';

function mockDb() {
  const statement = {
    bind() { return this; },
    async run() { return { meta: { changes: 1 } }; }
  };
  return { prepare() { return statement; } };
}

function divarResponse() {
  return {
    list_widgets: [{
      widget_type: 'POST_ROW',
      data: { title: 'آپارتمان', action: { payload: { token: 'tok1', web_info: { district_persian: 'جنت‌آباد' } } } }
    }]
  };
}

test('numeric district id avoids the extra places-web.json subrequest', async (t) => {
  const urls = [];
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify(divarResponse()), { status: 200 });
  };

  const data = await fetchListingsPage({ DB: mockDb() }, '1', 'residential-rent', 1, ['92']);

  assert.ok(data, 'a numeric district must still return the search payload');
  assert.deepEqual(urls, ['https://api.divar.ir/v8/postlist/w/search']);
});

test('slug district still resolves through places-web.json', async (t) => {
  const urls = [];
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    const body = String(url).includes('places-web')
      ? [{ id: 92, parent: '1', type: '4', slug: 'beryanak' }]
      : divarResponse();
    return new Response(JSON.stringify(body), { status: 200 });
  };

  await fetchListingsPage({ DB: mockDb() }, '1', 'residential-rent', 1, ['beryanak']);

  assert.equal(urls.length, 2);
  assert.ok(urls[0].includes('places-web.json'));
});