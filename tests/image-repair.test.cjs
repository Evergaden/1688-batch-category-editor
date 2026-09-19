const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const script = fs.readFileSync(path.join(__dirname, '..', '1688-batch-category-editor.user.js'), 'utf8');
function setup(html = '') {
  const dom = new JSDOM(html, { url: 'https://offer-new.1688.com/popular/publish.htm?id=123&operator=edit', runScripts: 'outside-only' });
  const w = dom.window;
  let stored = {};
  w.GM_getValue = () => stored;
  w.GM_setValue = (_key, value) => { stored = value; };
  w.HTMLElement.prototype.getClientRects = function () { return this.hidden ? [] : [{ width: 100, height: 100 }]; };
  w.HTMLElement.prototype.scrollIntoView = function () {};
  const instrumented = script.replace(/  if \(document.readyState === 'loading'\)[\s\S]*$/, `
    window.testApi = { imageUrl, imageKey, mainImageEntries, detailImageUrls, usableMainImage, similarImage, settingsError,
      repairMainImages, appendMainImage, fillCurrentForm, submitCurrent, autoRun, save, load, DEFAULTS, ensureCheckboxChecked,
      mockRepair: (fn) => { repairMainImages = fn; },
      mockImageReads: (read, inspect) => { readImageBlob = read; inspectImage = inspect; },
      setWait: (fn) => { waitUntil = fn; }
    };
  })();`).replace('const waitUntil =', 'let waitUntil =');
  w.eval(instrumented);
  return { dom, w, api: w.testApi };
}

const img = (name) => `https://cbu01.alicdn.com/img/${name}.jpg`;
const item = (name) => `<div class="item"><img src="${img(name)}"><button>删除</button></div>`;
function fixture() {
  return `<section><div id="main"><label>*商品主图</label>${item('a')}${item('b')}${item('c')}<button>添加图片</button><input type="file"></div>
    <div><label>白底图</label>${item('white')}</div><div><label>商品视频</label><img src="${img('cover')}"></div></section>
    <section><label>商品详情</label><div contenteditable="true"><img src="${img('a')}"><img data-src="${img('new')}" src="${img('placeholder')}"><img src="${img('new')}"></div></section>
    <aside id="v1688-panel"><label>商品主图</label><img src="${img('panel')}"></aside>`;
}

test('counts only main product images and reads detail lazy URLs without duplicates', () => {
  const { api, dom } = setup(fixture());
  assert.deepEqual(Array.from(api.mainImageEntries(), (entry) => entry.url), [img('a'), img('b'), img('c')]);
  assert.deepEqual(Array.from(api.detailImageUrls()), [img('a'), img('new')]);
  dom.window.close();
});

test('reads same-origin iframe editor without counting its toolbar images', () => {
  const { api, dom, w } = setup(fixture().replace('<div contenteditable="true">', '<div>').replace('</aside>', '</aside><section><label>图文详情</label><img src="https://cbu01.alicdn.com/icon.jpg"><iframe></iframe></section>'));
  w.document.querySelector('iframe').contentDocument.body.innerHTML = `<img src="${img('frame')}">`;
  assert.deepEqual(Array.from(api.detailImageUrls()), [img('frame')]);
  dom.window.close();
});

test('only image mode does not require weight, dimensions, category, or AI credentials', () => {
  const { api, dom } = setup();
  const settings = { ...api.DEFAULTS, mainImageOnlyMode: true, aiTitleEnabled: true, weightG: '' };
  assert.equal(api.settingsError(settings), '');
  for (const n of [0, 6, 2.5, NaN]) assert.notEqual(api.settingsError({ ...settings, mainImageTarget: n }), '');
  assert.notEqual(api.settingsError({ ...settings, mainImageOnlyMode: false }), '');
  dom.window.close();
});

test('rejects long/small images and compares thumbnail keys without changing source URLs', () => {
  const { api, dom } = setup();
  assert.equal(api.usableMainImage({ width: 1000, height: 1000 }), true);
  assert.equal(api.usableMainImage({ width: 790, height: 790 }), false);
  assert.equal(api.usableMainImage({ width: 800, height: 3200 }), false);
  assert.equal(api.imageKey(img('a') + '_300x300.jpg'), api.imageKey(img('a')));
  assert.equal(api.imageUrl('https://alicdn.com.evil.example/a.jpg'), '');
  assert.equal(api.imageUrl('javascript:alert(1)'), '');
  assert.equal(api.imageUrl('//cbu01.alicdn.com/a.jpg', 'about:blank'), 'https://cbu01.alicdn.com/a.jpg');
  assert.equal(api.similarImage('101010', '101011'), true);
  assert.equal(api.similarImage('000000', '111111'), false);
  dom.window.close();
});

test('an uncertain prior upload blocks retry and submission', async () => {
  const { api, dom } = setup(fixture());
  api.save({ mainImageOnlyMode: true, mainImageCheck: { productId: '123', status: 'uploading', dirty: true } });
  await assert.rejects(api.repairMainImages(api.load()), /上一轮图片上传结果未确认/);
  await assert.rejects(api.submitCurrent(), /主图尚未校验通过/);
  dom.window.close();
});

test('already-full clean product skips; existing unsaved repair still requires saving', async () => {
  const { api, dom } = setup(fixture());
  api.save({ mainImageTarget: 3 });
  assert.equal(await api.repairMainImages(api.load()), false);
  api.save({ mainImageCheck: { productId: '123', status: 'added', dirty: true } });
  assert.equal(await api.repairMainImages(api.load()), true);
  assert.equal(api.load().mainImageCheck.dirty, true);
  dom.window.close();
});

test('image-only test fills no other fields and pauses before submission', async () => {
  const { api, dom, w } = setup(fixture() + '<input id="product-title" value="original">');
  let called = 0;
  api.mockRepair(async () => { called++; return true; });
  await api.fillCurrentForm({ ...api.DEFAULTS, mainImageOnlyMode: true, testMode: true, batchAutoSubmit: true });
  assert.equal(called, 1);
  assert.equal(api.load().phase, 'ready-submit');
  assert.equal(w.document.querySelector('#product-title').value, 'original');
  dom.window.close();
});

test('reopened product must match persisted images before batch completion', async () => {
  const { api, dom } = setup(fixture());
  const keys = Array.from(api.mainImageEntries(), (entry) => entry.key);
  api.save({ running: true, phase: 'verify-images', queue: ['https://offer-new.1688.com/popular/publish.htm?id=123&operator=edit'], mainImageCheck: { productId: '123', keys } });
  await api.autoRun();
  assert.equal(api.load().phase, 'done');
  assert.equal(api.load().mainImageCheck, null);
  dom.window.close();
});

test('file upload adds a verified fourth image and keeps the white image untouched', async () => {
  const { api, dom, w } = setup(fixture());
  api.save({ running: true });
  api.mockImageReads(async () => ({}), async () => ({ hash: '10101010' }));
  w.DataTransfer = class {
    files = [];
    items = { add: (file) => this.files.push(file) };
  };
  const input = w.document.querySelector('input[type=file]');
  let assigned;
  Object.defineProperty(input, 'files', { get: () => assigned, set: (files) => { assigned = files; } });
  input.addEventListener('change', () => {
    assert.equal(assigned.length, 1);
    assert.equal(assigned[0].type, 'image/jpeg');
    input.insertAdjacentHTML('beforebegin', item('uploaded'));
  });
  const added = await api.appendMainImage({ blob: new w.Blob(['jpeg'], { type: 'image/jpeg' }), hash: '10101010' }, api.mainImageEntries());
  assert.equal(added.length, 4);
  assert.equal(added[0].url, img('a'));
  assert.equal(w.document.querySelector(`img[src="${img('white')}"]`).src, img('white'));
  dom.window.close();
});

test('insufficient suitable candidates causes no upload and no false success', async () => {
  const { api, dom, w } = setup(fixture());
  api.save({ running: true });
  api.mockImageReads(async (url) => url, async () => ({ width: 800, height: 4000, hash: '00000000' }));
  let uploads = 0;
  w.document.querySelector('input[type=file]').addEventListener('change', () => uploads++);
  await assert.rejects(api.repairMainImages(api.load()), /未开始上传/);
  assert.equal(uploads, 0);
  assert.equal(api.load().mainImageCheck, null);
  dom.window.close();
});

test('missing/unreadable thumbnail fails counting instead of treating it as an empty slot', () => {
  const { api, dom, w } = setup(fixture());
  w.document.querySelector('#main img').src = 'blob:upload-in-progress';
  assert.throws(() => api.mainImageEntries(), /暂停计数/);
  dom.window.close();
});

function supplyFixture(custom = '<span class="ant-checkbox"><input id="custom" type="checkbox" hidden></span><span>定制 支持基于现款的交期定制、属性定制、特色服务</span>') {
  return `<section><div><span>*供货方式</span><label><input id="stock" type="checkbox" checked>现货 库存充足商品</label>
    <div id="custom-option">${custom}</div></div></section>
    <section><label><input id="other" type="checkbox">定制</label></section>
    <aside id="v1688-panel"><label><input type="checkbox">定制</label></aside>`;
}

test('custom checkbox with long combined span label and hidden native input is checked exactly once', async () => {
  const { api, dom, w } = setup(supplyFixture());
  let clicks = 0;
  w.document.querySelector('#custom').addEventListener('click', () => clicks++);
  assert.equal(await api.ensureCheckboxChecked('定制'), true);
  assert.equal(w.document.querySelector('#custom').checked, true);
  assert.equal(w.document.querySelector('#stock').checked, true);
  assert.equal(w.document.querySelector('#other').checked, false);
  assert.equal(clicks, 1);
  assert.equal(await api.ensureCheckboxChecked('定制'), true);
  assert.equal(clicks, 1);
  dom.window.close();
});

test('native unchecked state is not overridden by an unchecked/shared selected class', async () => {
  const { api, dom, w } = setup(supplyFixture('<label class="unchecked selected"><input id="custom" type="checkbox"><span>定制支持基于现款的交期定制</span></label>'));
  assert.equal(await api.ensureCheckboxChecked('定制'), true);
  assert.equal(w.document.querySelector('#custom').checked, true);
  dom.window.close();
});

test('custom checkbox validation reacquires DOM after framework rerender', async () => {
  const { api, dom, w } = setup(supplyFixture());
  const original = w.document.querySelector('#custom');
  original.addEventListener('click', () => {
    w.document.querySelector('#custom-option').innerHTML = '<label><input id="custom" type="checkbox" checked><span>定制 支持基于现款的交期定制</span></label>';
  });
  assert.equal(await api.ensureCheckboxChecked('定制'), true);
  assert.notEqual(w.document.querySelector('#custom'), original);
  dom.window.close();
});

test('disabled custom option stops without toggling stock', async () => {
  const { api, dom, w } = setup(supplyFixture('<label><input id="custom" type="checkbox" disabled>定制 支持交期定制</label>'));
  assert.equal(await api.ensureCheckboxChecked('定制'), false);
  assert.equal(w.document.querySelector('#stock').checked, true);
  assert.equal(w.document.querySelector('#custom').checked, false);
  dom.window.close();
});

test('a framework-reverted checkbox is reported as failure without repeated clicks', async () => {
  const { api, dom, w } = setup(supplyFixture());
  let clicks = 0;
  w.document.querySelector('#custom').addEventListener('click', (event) => { clicks++; event.target.checked = false; });
  api.setWait(async (test) => test());
  assert.equal(await api.ensureCheckboxChecked('定制'), false);
  assert.equal(clicks, 1);
  dom.window.close();
});

test('role checkbox with description uses its own aria-checked state', async () => {
  const { api, dom, w } = setup(supplyFixture('<div id="custom" role="checkbox" aria-checked="false"><span>定制 支持交期定制</span></div>'));
  w.document.querySelector('#custom').addEventListener('click', (event) => event.currentTarget.setAttribute('aria-checked', 'true'));
  assert.equal(await api.ensureCheckboxChecked('定制'), true);
  dom.window.close();
});
