// ==UserScript==
// @name         1688 批量修改类目与商品信息
// @namespace    violet.local.1688
// @version      0.6.1
// @description  在1688工作台中用AI或文字替换批量修改标题，也可修改类目、属性、发货时间和件重尺。
// @match        https://work.1688.com/*
// @match        https://*.1688.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @connect      token.sensenova.cn
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  const KEY = 'violet_1688_batch_category_editor_v1';
  const DEFAULTS = {
    categoryKeyword: '个人护理加工',
    categoryLeaf: '个人护理加工',
    categoryPath: '个护/家清>个护家清加工>个人护理加工',
    requiredText: '/',
    lengthCm: '5.3',
    widthCm: '5.3',
    heightCm: '9.5',
    weightG: '',
    customMode: false,
    colorCategoryValue: '',
    measurementUnit: '个',
    titleReplaceEnabled: true,
    titleOnlyMode: false,
    aiTitleEnabled: false,
    aiApiKey: '',
    aiBaseUrl: 'https://token.sensenova.cn/v1/chat/completions',
    aiModel: 'deepseek-v4-flash',
    aiRequestIntervalMs: 12000,
    aiLastRequestAt: 0,
    aiStyleReference: 'GOOGEER 身体护理胶囊 温和呵护维持身体良好状态日常护理胶囊\nGOOGEER 身体养护软糖 温和呵护身体提升能量活力营养补充软糖\nGoogeer身体养护胶囊 调理呵护身体提升活力日常膳食营养补充胶囊\nGoogeer身体衡养膳食胶囊 日常补充护理关节促进钙质吸收顺畅运动\nGOOGEER 镁复合物护理胶囊 日常呵护身体舒适夜间睡眠放松状态',
    titleFind: '软胶囊',
    titleReplace: '胶囊',
    autoSubmit: false,
    batchAutoSubmit: true,
    testMode: false,
    overwriteAttributes: false,
    panelCollapsed: false,
    queue: [],
    current: 0,
    running: false,
    phase: 'idle',
    log: []
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitForPageAge = async (minimumMs) => {
    const age = performance.now();
    if (age < minimumMs) await sleep(minimumMs - age);
  };
  const waitUntil = async (test, timeoutMs = 8000, intervalMs = 250) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = test();
      if (result) return result;
      await sleep(intervalMs);
    }
    return null;
  };
  const navigate = (url) => {
    try { window.top.location.href = url; }
    catch (_) { location.href = url; }
  };
  const load = () => ({ ...DEFAULTS, ...(GM_getValue(KEY, {}) || {}) });
  const save = (patch) => {
    const next = { ...load(), ...patch };
    GM_setValue(KEY, next);
    return next;
  };
  const visible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const compact = (s) => clean(s).replace(/\s+/g, '');
  const escapeHtml = (s) => String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  const all = (selector, root = document) => {
    const found = [...root.querySelectorAll(selector)];
    for (const element of root.querySelectorAll('*')) {
      if (element.shadowRoot) found.push(...all(selector, element.shadowRoot));
    }
    return found;
  };
  const text = () => clean([...document.body.children]
    .filter((el) => el.id !== 'v1688-panel')
    .map((el) => el.innerText || '')
    .join(' '));

  const isCategorySelectorPage = () => {
    const search = all('input').filter(visible).find((el) =>
      clean(el.placeholder) === '类目搜索，可输入关键词搜索类目'
    );
    const continueButton = candidatesByText('确认类目 继续完善')
      .find((el) => visible(el) && compact(el.textContent).includes('确认类目继续完善'));
    return !!search && !!continueButton;
  };

  const pageShowsCategoryNear = (label, categoryPath) => {
    const body = compact(text());
    const marker = compact(label);
    const segments = String(categoryPath || '').split('>').map(compact).filter(Boolean);
    const index = body.indexOf(marker);
    if (index < 0 || !segments.length) return false;
    const nearby = body.slice(index + marker.length, index + marker.length + 320);
    let cursor = 0;
    for (const segment of segments) {
      const foundAt = nearby.indexOf(segment, cursor);
      if (foundAt < 0) return false;
      cursor = foundAt + segment.length;
    }
    return true;
  };

  const pageHasExpectedCategory = (settings) =>
    pageShowsCategoryNear('您选择的类目', settings.categoryPath);

  const searchSuggestionShowsTarget = (settings) => {
    const search = all('input').filter(visible).find((el) =>
      clean(el.placeholder) === '类目搜索，可输入关键词搜索类目'
    );
    if (!search || !clean(search.value)) return false;
    const expected = compact(settings.categoryPath);
    return all('a,li,div,span')
      .filter(visible)
      .filter((el) => !el.closest('#v1688-panel'))
      .some((el) => compact(el.textContent) === expected);
  };

  const hasSelectedCategoryState = (element) => {
    for (let node = element, depth = 0; node && depth < 4; depth += 1, node = node.parentElement) {
      const stateText = `${node.className || ''} ${node.getAttribute?.('data-status') || ''}`;
      if (/selected|active|checked|current|highlight/i.test(stateText)) return true;
      if (node.getAttribute?.('aria-selected') === 'true' || node.getAttribute?.('aria-checked') === 'true') return true;
      if (node.querySelector?.('svg,[class*=check],[class*=Check]')) return true;
      const background = getComputedStyle(node).backgroundColor;
      const rgb = background.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
      if (rgb) {
        const [, r, g, b, alpha = '1'] = rgb;
        const blueTint = Number(alpha) > 0 && Number(b) > Number(r) + 4 && Number(b) >= Number(g);
        if (blueTint) return true;
      }
    }
    return false;
  };

  const categoryCascadeShowsPath = (settings) => {
    if (searchSuggestionShowsTarget(settings)) return false;
    const segments = String(settings.categoryPath || '').split('>').map(clean).filter(Boolean);
    if (segments.length < 3) return false;
    const commonMarker = candidatesByText('常用类目')
      .filter((el) => !el.closest('#v1688-panel'))
      .find((el) => compact(el.textContent).startsWith('常用类目'));
    const cascadeTop = commonMarker ? commonMarker.getBoundingClientRect().bottom + 15 : 0;
    return segments.every((segment) => candidatesByText(segment)
      .filter((el) => !el.closest('#v1688-panel'))
      .some((el) => clean(el.textContent) === segment &&
        el.getBoundingClientRect().top > cascadeTop && hasSelectedCategoryState(el)));
  };

  const categorySelectionVerified = (settings) =>
    categoryCascadeShowsPath(settings) || pageShowsCategoryNear('已选类目', settings.categoryPath);

  function log(message, level = 'info') {
    const state = load();
    const line = `${new Date().toLocaleTimeString()} ${level === 'error' ? '❌' : level === 'warn' ? '⚠️' : '•'} ${message}`;
    save({ log: [...state.log.slice(-39), line] });
    const box = document.querySelector('#v1688-log');
    if (box) {
      box.textContent = load().log.join('\n');
      box.scrollTop = box.scrollHeight;
    }
  }

  function dispatchValue(el, value) {
    if (!el || !visible(el)) return false;
    const previous = el.value;
    el.focus();
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const prototypeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    const ownSetter = Object.getOwnPropertyDescriptor(el, 'value')?.set;
    if (prototypeSetter && ownSetter !== prototypeSetter) prototypeSetter.call(el, value);
    else if (ownSetter) ownSetter.call(el, value);
    else if (prototypeSetter) prototypeSetter.call(el, value);
    else el.value = value;
    if (el._valueTracker?.setValue) el._valueTracker.setValue(previous);
    try {
      el.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        composed: true,
        data: value,
        inputType: 'insertText'
      }));
    } catch (_) {
      el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: value.slice(-1) || 'Unidentified', bubbles: true }));
    el.blur();
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true, composed: true }));
    return true;
  }

  function candidatesByText(label, root = document) {
    return all('label,span,div,p,td,th,button,a', root)
      .filter(visible)
      .filter((el) => clean(el.textContent) === label || clean(el.textContent).includes(label))
      .sort((a, b) => clean(a.textContent).length - clean(b.textContent).length);
  }

  function findField(label, root = document) {
    for (const marker of candidatesByText(label, root)) {
      if (marker.tagName === 'LABEL' && marker.htmlFor) {
        const direct = document.getElementById(marker.htmlFor);
        if (direct && visible(direct)) return direct;
      }
      let node = marker;
      for (let i = 0; node && i < 6; i += 1, node = node.parentElement) {
        const fields = all('input:not([type=hidden]),textarea,select,[role=combobox]', node).filter(visible);
        if (fields.length === 1) return fields[0];
        if (fields.length > 1 && clean(node.textContent).length < 220) return fields[0];
      }
    }
    return null;
  }

  function clickText(label, { exact = true, root = document } = {}) {
    const tags = 'button,a,span,div,li,label,[role=button],input[type=button],input[type=submit]';
    const found = all(tags, root).filter(visible).filter((el) => {
      const t = clean(el.textContent || el.value || el.getAttribute('aria-label') || el.title);
      return exact ? (t === label || compact(t) === compact(label)) : (t.includes(label) || compact(t).includes(compact(label)));
    }).sort((a, b) => clean(a.textContent).length - clean(b.textContent).length)[0];
    if (!found) return false;
    found.click();
    return true;
  }

  function activateElement(element) {
    if (!element || !visible(element)) return false;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = element.getBoundingClientRect();
    const init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2
    };
    const Pointer = window.PointerEvent || window.MouseEvent;
    element.dispatchEvent(new Pointer('pointerdown', init));
    element.dispatchEvent(new MouseEvent('mousedown', init));
    element.dispatchEvent(new Pointer('pointerup', init));
    element.dispatchEvent(new MouseEvent('mouseup', init));
    element.click();
    return true;
  }

  let lastActivationTrace = '';

  async function activateWithAncestorsUntil(element, predicate, waitMs = 1200) {
    const rect = element.getBoundingClientRect();
    const pointTargets = document.elementsFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2
    );
    const ancestorTargets = [];
    for (let target = element, depth = 0; target && depth < 8; depth += 1, target = target.parentElement) {
      ancestorTargets.push(target);
    }
    const targets = [...new Set([element, ...pointTargets, ...ancestorTargets])]
      .filter((target) => target && target !== document.body && target !== document.documentElement)
      .filter((target) => !target.closest?.('#v1688-panel'))
      .filter(visible)
      .slice(0, 10);
    lastActivationTrace = targets.map((target) => {
      const cls = typeof target.className === 'string' ? target.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
      return `${target.tagName || '?'}${cls ? `.${cls}` : ''}`;
    }).join(' > ');
    for (const target of targets) {
      activateElement(target);
      if (await waitUntil(predicate, waitMs, 150)) return true;
    }
    return false;
  }

  const activateUntilSelected = (element, settings) =>
    activateWithAncestorsUntil(element, () => categorySelectionVerified(settings));

  function clickCategoryWarningConfirm() {
    const dialogs = all('[role=dialog],.next-dialog,.ant-modal,.ant-modal-content,[class*=dialog],[class*=Dialog],[class*=modal],[class*=Modal]')
      .filter(visible)
      .filter((el) => clean(el.textContent).includes('重选类目可能导致部分信息丢失'))
      .sort((a, b) => clean(a.textContent).length - clean(b.textContent).length);
    const dialog = dialogs[0] || document;
    if (clickText('确认', { exact: true, root: dialog })) return true;
    if (clickText('确定', { exact: true, root: dialog })) return true;

    // 弹窗的正文和底部按钮在部分 1688 组件中是兄弟节点，因此再从整个页面查找。
    if (clickText('确认', { exact: true, root: document })) return true;
    if (clickText('确定', { exact: true, root: document })) return true;

    const primarySelector = 'button,[role=button],input[type=button],input[type=submit],.next-btn-primary,.ant-btn-primary,[class*=primary],[class*=Primary],[class*=btn],[class*=Btn],[class*=button],[class*=Button]';
    const choosePrimary = (root) => all(primarySelector, root)
      .filter(visible)
      .filter((el) => !/cancel|取消/i.test(compact(el.textContent || el.value || el.getAttribute('aria-label'))))
      .sort((a, b) => {
        const aConfirm = /确认|确定|继续/.test(compact(a.textContent || a.value)) ? -1 : 0;
        const bConfirm = /确认|确定|继续/.test(compact(b.textContent || b.value)) ? -1 : 0;
        return aConfirm - bConfirm;
      })[0];
    const primary = choosePrimary(dialog);
    if (!primary) return false;
    primary.click();
    return true;
  }

  function visibleButtonSummary() {
    return all('button,[role=button],input[type=button],input[type=submit],[class*=btn],[class*=button]')
      .filter(visible)
      .map((el) => compact(el.textContent || el.value || el.getAttribute('aria-label')))
      .filter(Boolean)
      .filter((value, index, array) => array.indexOf(value) === index)
      .slice(0, 20)
      .join('、');
  }

  function setTextField(label, value, overwrite = false) {
    const field = findField(label);
    if (!field || !('value' in field)) return false;
    if (!overwrite && clean(field.value)) return true;
    return dispatchValue(field, value);
  }

  async function chooseDropdown(label, optionText) {
    const field = findField(label);
    if (field?.tagName === 'SELECT') {
      const option = [...field.options].find((o) => clean(o.textContent) === optionText || clean(o.textContent).includes(optionText));
      if (!option) return false;
      field.value = option.value;
      field.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    const marker = candidatesByText(label).find((el) => clean(el.textContent) === label) || candidatesByText(label)[0];
    const clickTarget = field || marker?.parentElement || marker;
    if (!clickTarget) return false;
    const findOption = () => candidatesByText(optionText)
      .filter((el) => !el.closest('#v1688-panel'))
      .find((el) => compact(el.textContent) === compact(optionText));
    const opened = await activateWithAncestorsUntil(clickTarget, () => !!findOption(), 500);
    if (!opened) return false;
    const option = findOption();
    if (!option) return false;
    const chosen = () => {
      if (field && compact(field.value) === compact(optionText)) return true;
      let node = marker;
      for (let depth = 0; node && depth < 5; depth += 1, node = node.parentElement) {
        const content = compact(node.textContent);
        if (content.includes(compact(label)) && content.includes(compact(optionText)) && content.length < 100) return true;
      }
      return false;
    };
    return activateWithAncestorsUntil(option, chosen, 600);
  }

  function productAttributeRoot() {
    const marker = candidatesByText('产品属性').find((el) => clean(el.textContent) === '产品属性');
    if (!marker) return document;
    let node = marker.parentElement;
    for (let i = 0; node && i < 8; i += 1, node = node.parentElement) {
      const count = all('input:not([type=hidden]),textarea,select,[role=combobox]', node).filter(visible).length;
      if (count >= 6 && clean(node.textContent).includes('加工方式')) return node;
    }
    return document;
  }

  async function fillRequiredAttributes(settings) {
    const labels = ['加工方式', '加工类型', '加工定制', '打样周期', '生产周期', '生产品类'];
    const root = productAttributeRoot();
    let filled = 0;
    for (const label of labels) {
      const field = findField(label, root);
      if (!field || !('value' in field)) {
        log(`未找到属性“${label}”`, 'warn');
        continue;
      }
      if (!clean(field.value) || settings.overwriteAttributes) {
        dispatchValue(field, settings.requiredText);
        await sleep(100);
        filled += 1;
      }
    }
    // 兼容同一类目后续新增的普通文本必填属性；仅限“产品属性”区域。
    const excluded = /商品标题|价格|库存|货号|品牌|功效|重量|长\(cm\)|宽\(cm\)|高\(cm\)/;
    const extraFields = all('input:not([type=hidden]):not([type=radio]):not([type=checkbox]),textarea', root).filter(visible);
    for (const field of extraFields) {
      let item = field.parentElement;
      for (let i = 0; item && i < 5; i += 1, item = item.parentElement) {
        const required = field.required || field.getAttribute('aria-required') === 'true' ||
          !!item.querySelector('.ant-form-item-required,.next-form-item-label.required,[class*="form-item-label"][class*="required"]');
        if (!required) continue;
        const itemText = clean(item.textContent);
        if (!excluded.test(itemText) && (!clean(field.value) || settings.overwriteAttributes)) {
          dispatchValue(field, settings.requiredText);
          await sleep(100);
          filled += 1;
        }
        break;
      }
    }
    log(`产品属性已处理：${filled} 个字段写入“${settings.requiredText}”`);
  }

  async function fillSpecialCosmetic() {
    const ok = await chooseDropdown('特殊用途化妆品', '否');
    log(ok ? '特殊用途化妆品：否' : '未找到“特殊用途化妆品/否”控件', ok ? 'info' : 'warn');
  }

  async function fillDeliveryTime() {
    const header = all('th,[role=columnheader],div,span')
      .filter(visible)
      .filter((el) => !el.closest('#v1688-panel'))
      .filter((el) => compact(el.textContent) === '发货时间')
      .sort((a, b) => clean(a.textContent).length - clean(b.textContent).length)[0];

    let cell = null;
    const headerCell = header?.closest('th,[role=columnheader]');
    if (headerCell) {
      const headerRow = headerCell.parentElement;
      const column = [...headerRow.children].indexOf(headerCell);
      const table = headerCell.closest('table,[role=table],[role=grid]');
      if (table && column >= 0) {
        cell = all('tr,[role=row]', table)
          .filter(visible)
          .map((row) => [...row.children][column])
          .find((candidate) => candidate && candidate !== headerCell &&
            (compact(candidate.textContent).includes('请选择发货时间') || compact(candidate.textContent).includes('48小时发货')));
      }
    }

    const placeholders = all('input,[role=combobox],span,div')
      .filter(visible)
      .filter((el) => !el.closest('#v1688-panel'))
      .filter((el) => {
        const value = `${el.value || ''} ${el.placeholder || ''} ${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`;
        return compact(value).includes('请选择发货时间') && (el.matches('input,[role=combobox]') || clean(el.textContent).length < 80);
      });
    const headerRect = header?.getBoundingClientRect();
    const placeholder = placeholders.sort((a, b) => {
      if (!headerRect) return clean(a.textContent).length - clean(b.textContent).length;
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      const hx = headerRect.left + headerRect.width / 2;
      return Math.abs((ar.left + ar.width / 2) - hx) - Math.abs((br.left + br.width / 2) - hx);
    })[0];
    cell ||= placeholder?.closest('td,[role=cell],[role=gridcell]') || null;

    const controlSelectors = '[role=combobox],input,.next-select,.ant-select,[class*=select],[class*=Select]';
    const control = (cell && all(controlSelectors, cell).filter(visible)[0]) ||
      placeholder?.closest('[role=combobox],.next-select,.ant-select,[class*=select],[class*=Select]') ||
      placeholder || cell;
    const controlText = () => compact(`${control?.value || ''} ${control?.textContent || ''} ${cell?.textContent || ''}`);
    if (controlText().includes('48小时发货')) {
      log('发货时间：48小时发货（已选）');
      return;
    }
    if (!control) {
      log('未定位到“发货时间”表格单元格', 'warn');
      return;
    }

    control.scrollIntoView({ block: 'center', inline: 'center' });
    const findOption = () => all('[role=option],li,.next-menu-item,.ant-select-item,div,span')
      .filter(visible)
      .filter((el) => !el.closest('#v1688-panel'))
      .filter((el) => compact(el.textContent) === '48小时发货')
      .sort((a, b) => clean(a.textContent).length - clean(b.textContent).length)[0];
    const opened = await activateWithAncestorsUntil(control, () => !!findOption(), 1200);
    if (!opened) {
      log('已定位发货时间下拉框，但展开后没有出现“48小时发货”选项', 'warn');
      return;
    }
    const optionText = findOption();
    const option = optionText?.closest('[role=option],li,.next-menu-item,.ant-select-item') || optionText;
    const ok = await activateWithAncestorsUntil(option, () => controlText().includes('48小时发货'), 1500);
    log(ok ? '发货时间：48小时发货（选择并校验成功）' : '已点击“48小时发货”，但下拉框校验未通过', ok ? 'info' : 'warn');
  }

  async function ensureCheckboxChecked(labelText) {
    const findMarker = () => candidatesByText(labelText)
      .filter((el) => !el.closest('#v1688-panel'))
      .find((el) => compact(el.textContent) === compact(labelText));
    const marker = findMarker();
    if (!marker) return false;

    const distance = (a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      const ax = ar.left + ar.width / 2;
      const ay = ar.top + ar.height / 2;
      const bx = br.left + br.width / 2;
      const by = br.top + br.height / 2;
      return Math.hypot(ax - bx, ay - by);
    };
    const clickableFor = (control) => {
      const wrapped = control.closest('label,[role=checkbox],.next-checkbox,.ant-checkbox,[class*=checkbox],[class*=Checkbox]');
      return wrapped && visible(wrapped) ? wrapped : control;
    };
    const findControl = () => {
      const currentMarker = findMarker();
      if (!currentMarker) return null;
      const directLabel = currentMarker.closest('label');
      const direct = directLabel && all('input[type=checkbox],[role=checkbox]', directLabel)[0];
      if (direct) return direct;

      let scope = currentMarker.parentElement;
      for (let depth = 0; scope && depth < 7; depth += 1, scope = scope.parentElement) {
        const controls = all('input[type=checkbox],[role=checkbox]', scope)
          .filter((el) => !el.closest('#v1688-panel'));
        if (controls.length) {
          return controls
            .map((control) => ({ control, clickTarget: clickableFor(control) }))
            .filter(({ clickTarget }) => visible(clickTarget))
            .sort((a, b) => distance(a.clickTarget, currentMarker) - distance(b.clickTarget, currentMarker))[0]?.control || null;
        }
      }
      return null;
    };
    const checked = () => {
      const control = findControl();
      const wrapper = control && clickableFor(control);
      const native = control?.matches('input[type=checkbox]') ? control : control?.querySelector('input[type=checkbox]');
      const lineage = [control, wrapper, wrapper?.parentElement].filter(Boolean);
      return !!native?.checked || lineage.some((el) => el.getAttribute?.('aria-checked') === 'true') ||
        lineage.some((el) => /checked|selected/.test(String(el.className || '').toLowerCase()));
    };
    if (checked()) return true;
    const control = findControl();
    if (!control) return false;
    const clickTarget = clickableFor(control);
    if (await activateWithAncestorsUntil(clickTarget, checked, 1200)) return true;
    // 部分 Next/React 组件将原生 input 设为不可见，但仍会处理程序化 click。
    control.click();
    return waitUntil(checked, 1200, 150);
  }

  function findColorCategoryInput() {
    const marker = candidatesByText('颜色分类')
      .filter((el) => !el.closest('#v1688-panel'))
      .find((el) => compact(el.textContent) === '颜色分类');
    if (!marker) return null;
    let root = marker.parentElement;
    for (let depth = 0; root && depth < 6; depth += 1, root = root.parentElement) {
      const inputs = all('input:not([type=hidden])', root).filter(visible);
      const existing = inputs.find((input) => clean(input.value) && !/请输入颜色分类/.test(input.placeholder || ''));
      if (existing) return existing;
      if (inputs.length && clean(root.textContent).includes('颜色分类')) {
        const first = inputs.find((input) => !/请输入颜色分类/.test(input.placeholder || ''));
        if (first) return first;
      }
    }
    return null;
  }

  function findMeasurementUnitInput() {
    const markers = candidatesByText('计量单位')
      .filter((el) => !el.closest('#v1688-panel'))
      .filter((el) => compact(el.textContent) === '计量单位');
    for (const marker of markers) {
      if (marker.tagName === 'LABEL' && marker.htmlFor) {
        const direct = document.getElementById(marker.htmlFor);
        if (direct && visible(direct) && !direct.closest('#v1688-panel')) return direct;
      }
      let node = marker;
      for (let depth = 0; node && depth < 5; depth += 1, node = node.parentElement) {
        const inputs = all('input:not([type=hidden]),textarea', node)
          .filter(visible)
          .filter((el) => !el.closest('#v1688-panel'));
        if (inputs.length === 1) return inputs[0];
      }
    }
    return null;
  }

  async function writeControlledInput(field, value, refind) {
    if (!field) return false;
    dispatchValue(field, value);
    await sleep(500);
    let fresh = refind?.() || field;
    if (clean(fresh?.value) === clean(value)) return true;
    fresh = fresh || field;
    fresh.focus();
    const proto = fresh instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    const previous = fresh.value;
    if (setter) setter.call(fresh, value); else fresh.value = value;
    if (fresh._valueTracker?.setValue) fresh._valueTracker.setValue(previous);
    fresh.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    fresh.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    fresh.blur();
    await sleep(600);
    fresh = refind?.() || fresh;
    return clean(fresh?.value) === clean(value);
  }

  async function fillColorCategory(settings) {
    if (!settings.colorCategoryValue) return true;
    const field = findColorCategoryInput();
    const ok = await writeControlledInput(field, settings.colorCategoryValue, findColorCategoryInput);
    log(ok ? `颜色分类：${settings.colorCategoryValue}` : '颜色分类写入后校验失败', ok ? 'info' : 'warn');
    return ok;
  }

  async function fillMeasurementUnit(settings) {
    const value = settings.measurementUnit || '个';
    const field = findMeasurementUnitInput();
    const ok = await writeControlledInput(field, value, findMeasurementUnitInput);
    log(ok ? `计量单位：${value}` : '未找到“计量单位”输入框或写入失败', ok ? 'info' : 'warn');
    return ok;
  }

  function getDeliveryTableInfo() {
    const header = all('th,[role=columnheader],div,span')
      .filter(visible)
      .find((el) => compact(el.textContent) === '发货时间');
    let table = header?.closest('table,[role=table],[role=grid]');
    if (!table && header) {
      let root = header.parentElement;
      for (let depth = 0; root && depth < 6; depth += 1, root = root.parentElement) {
        const text = clean(root.textContent);
        if (text.includes('购买数量') && text.includes('预览') && all('input:not([type=hidden])', root).filter(visible).length) {
          table = root; break;
        }
      }
    }
    if (!header || !table) return null;
    const headerRow = header.closest('tr,[role=row]') || header.parentElement;
    const cells = [...headerRow.children];
    const timeColumn = cells.findIndex((cell) => compact(cell.textContent) === '发货时间');
    const quantityColumn = cells.findIndex((cell) => compact(cell.textContent) === '购买数量');
    const rows = () => all('tr,[role=row]', table)
      .filter(visible)
      .filter((row) => row !== headerRow && all('input:not([type=hidden])', row).filter(visible).length >= 1);
    return { table, timeColumn, quantityColumn, rows };
  }

  async function chooseDeliveryForRow(info, row, optionText) {
    const rowIndex = Math.max(0, info.rows().indexOf(row));
    const currentRow = () => getDeliveryTableInfo()?.rows()[rowIndex] || row;
    if (compact(currentRow().textContent).includes(compact(optionText))) return true;
    const cells = [...currentRow().children];
    const cell = cells[info.timeColumn] || row;
    const control = all('[role=combobox],input,.next-select,.ant-select,[class*=select],[class*=Select]', cell)
      .filter(visible)[0] || cell;
    const findOption = () => all('[role=option],li,.next-menu-item,.ant-select-item,div,span')
      .filter(visible)
      .filter((el) => !el.closest('#v1688-panel'))
      .filter((el) => !el.closest('table,[role=table],[role=grid]'))
      .filter((el) => compact(el.textContent) === compact(optionText))
      .sort((a, b) => clean(a.textContent).length - clean(b.textContent).length)[0];
    const opened = await activateWithAncestorsUntil(control, () => !!findOption(), 1200);
    if (!opened) return false;
    const optionTextNode = findOption();
    const option = optionTextNode?.closest('[role=option],li,.next-menu-item,.ant-select-item') || optionTextNode;
    return activateWithAncestorsUntil(option, () => compact(currentRow().textContent).includes(compact(optionText)), 1800);
  }

  async function fillCustomDeliveryTiers() {
    let info = getDeliveryTableInfo();
    if (!info) {
      log('定制发货：未找到发货服务表格', 'warn'); return false;
    }
    let rows = info.rows();
    if (!rows.length) {
      log('定制发货：未找到数量分档行', 'warn'); return false;
    }
    if (rows.length < 2) {
      const plus = all('button,a,[role=button],span,div', rows[0])
        .filter(visible)
        .filter((el) => ['+', '＋', '新增', '添加'].includes(compact(el.textContent || el.getAttribute('aria-label') || el.title)))
        .sort((a, b) => clean(a.textContent).length - clean(b.textContent).length)[0];
      if (!plus || !await activateWithAncestorsUntil(plus, () => (getDeliveryTableInfo()?.rows().length || 0) >= 2, 1800)) {
        log('定制发货：未能通过“+”增加第二档', 'warn'); return false;
      }
      info = getDeliveryTableInfo();
      rows = info.rows();
    }

    const firstQtyCell = [...rows[0].children][info.quantityColumn] || rows[0];
    const qtyInputs = all('input:not([type=hidden])', firstQtyCell).filter(visible);
    const upper = qtyInputs[1] || qtyInputs.find((input) => /库存上限/.test(input.placeholder || ''));
    if (!upper || !await writeControlledInput(upper, '2', () => {
      const latest = getDeliveryTableInfo();
      const latestRow = latest?.rows()[0];
      const latestCell = latestRow && ([...latestRow.children][latest.quantityColumn] || latestRow);
      return latestCell ? all('input:not([type=hidden])', latestCell).filter(visible)[1] : null;
    })) {
      log('定制发货：第一档库存上限“2”写入失败', 'warn'); return false;
    }
    await sleep(500);
    info = getDeliveryTableInfo();
    rows = info.rows();
    const firstOk = await chooseDeliveryForRow(info, rows[0], '48小时发货');
    info = getDeliveryTableInfo();
    rows = info?.rows() || [];
    const secondOk = rows[1] && await chooseDeliveryForRow(info, rows[1], '72小时发货');
    log(firstOk && secondOk ? '定制发货：1～2个48小时，3个以上72小时' : '定制发货分档设置未完全成功', firstOk && secondOk ? 'info' : 'warn');
    return !!(firstOk && secondOk);
  }

  function fillPackage(settings) {
    const marker = candidatesByText('件重尺').find((el) => clean(el.textContent).includes('件重尺'));
    if (!marker) {
      log('未找到件重尺区域', 'warn');
      return;
    }
    let root = marker.parentElement;
    for (let i = 0; root && i < 8; i += 1, root = root.parentElement) {
      const t = clean(root.textContent);
      if (t.includes('长(cm)') && t.includes('宽(cm)') && t.includes('重量(g)')) break;
    }
    if (!root) return;
    const row = all('tr', root).filter(visible).find((tr) => all('input:not([type=hidden])', tr).filter(visible).length >= 4);
    const inputs = all('input:not([type=hidden])', row || root).filter(visible);
    if (inputs.length < 4) {
      log(`件重尺输入框数量不足（找到 ${inputs.length} 个）`, 'warn');
      return;
    }
    const values = [settings.lengthCm, settings.widthCm, settings.heightCm];
    values.forEach((value, index) => dispatchValue(inputs[index], value));
    // 通常第4项是自动计算的体积，最后一项是重量。
    dispatchValue(inputs[inputs.length - 1], settings.weightG);
    log(`件重尺：${settings.lengthCm} × ${settings.widthCm} × ${settings.heightCm} cm，${settings.weightG} g`);
  }

  function isProductEditUrl(url) {
    try {
      const parsed = new URL(url, location.href);
      const isLegacyEditor = parsed.hostname === 'offer.1688.com' && parsed.pathname === '/offer/post/fill_product_info.vm';
      const isNewEditor = parsed.hostname === 'offer-new.1688.com' && /\/popular\/publish\.htm$/.test(parsed.pathname);
      return (isLegacyEditor || isNewEditor) && parsed.searchParams.get('operator') === 'edit';
    } catch (_) {
      return false;
    }
  }

  function collectSelectedEditUrls() {
    const checked = all('input[type=checkbox]:checked').filter(visible);
    const urls = [];
    for (const checkbox of checked) {
      let row = checkbox.closest('tr,[role=row],li,.offer-item,.item,.card');
      if (!row) row = checkbox.parentElement?.parentElement;
      const links = all('a[href]', row || document).filter(visible);
      const detailLink = links.find((a) => compact(a.textContent).includes('修改详情'));
      const explicitEditLink = links.find((a) => {
        const href = a.href || '';
        return /\/offer\/post\/fill_product_info\.vm/i.test(href) && /[?&]operator=edit(?:&|$)/i.test(href);
      });
      const chosen = detailLink || explicitEditLink;
      if (chosen?.href) urls.push(chosen.href);
    }
    return [...new Set(urls)];
  }

  function findCommonCategoryShortcut(leafName) {
    const markers = candidatesByText('常用类目')
      .filter((el) => !el.closest('#v1688-panel'))
      .filter((el) => compact(el.textContent).startsWith('常用类目'));
    for (const marker of markers) {
      const markerRect = marker.getBoundingClientRect();
      let root = marker.parentElement;
      for (let depth = 0; root && depth < 4; depth += 1, root = root.parentElement) {
        const shortcut = all('a,button,[role=button],span,div', root)
          .filter(visible)
          .filter((el) => !el.closest('#v1688-panel'))
          .filter((el) => compact(el.textContent) === compact(leafName))
          .filter((el) => Math.abs(el.getBoundingClientRect().top - markerRect.top) < 80)
          .sort((a, b) => compact(a.textContent).length - compact(b.textContent).length)[0];
        if (shortcut) return shortcut.closest('a,button,[role=button]') || shortcut;
      }
    }
    return null;
  }

  async function handleCategoryPage(settings) {
    log('识别到重新选择类目页面');
    // 类目组件比页面骨架晚加载，等待常用类目和三级列表稳定。
    await sleep(2500);
    const shortcut = findCommonCategoryShortcut(settings.categoryLeaf);
    let selectedByShortcut = false;
    if (shortcut) {
      selectedByShortcut = await activateUntilSelected(shortcut, settings);
      if (selectedByShortcut) log(`已点击常用类目并校验通过：${settings.categoryLeaf}`);
      else log('常用类目点击后三级类目栏未显示目标路径，改用搜索', 'warn');
    }
    if (!selectedByShortcut) {
      if (!shortcut) log('常用类目中未找到目标，改用搜索', 'warn');
      const search = all('input').filter(visible).find((el) =>
        clean(el.placeholder) === '类目搜索，可输入关键词搜索类目'
      ) || all('input').filter(visible).find((el) =>
        /类目|搜索/.test(`${el.placeholder || ''} ${el.getAttribute('aria-label') || ''}`)
      );
      if (!search) throw new Error('找不到类目搜索输入框');
      dispatchValue(search, settings.categoryKeyword);
      const searched = clickText('搜索', { exact: true }) || clickText('搜索', { exact: false });
      if (!searched) {
        search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
        search.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
      }

      const expectedPath = compact(settings.categoryPath);
      const resultRow = await waitUntil(() => all('a,li,div,span')
        .filter(visible)
        .filter((el) => !el.closest('#v1688-panel'))
        .filter((el) => compact(el.textContent).includes(expectedPath))
        .sort((a, b) => compact(a.textContent).length - compact(b.textContent).length)[0], 10000);
      const leaf = resultRow && (all('a,button,[role=button],span', resultRow)
        .filter(visible)
        .find((el) => compact(el.textContent) === compact(settings.categoryLeaf)) || resultRow);
      if (!leaf) throw new Error(`搜索后没有找到精确类目“${settings.categoryLeaf}”`);
      const selectedBySearch = await activateUntilSelected(leaf, settings);
      if (!selectedBySearch) throw new Error(`已找到搜索结果，但点击后三级类目栏未显示：${settings.categoryPath}`);
      log(`已点击搜索结果并校验通过：${settings.categoryPath}`);
    }

    const categorySelected = await waitUntil(() => categorySelectionVerified(settings), 6000);
    if (!categorySelected) {
      throw new Error(`点击类目后校验未通过，三级类目栏未显示目标路径：${settings.categoryPath}`);
    }
    const verifySource = categoryCascadeShowsPath(settings) ? '三级类目栏' : '已选类目摘要';
    log(`类目选择页校验通过（${verifySource}）：${settings.categoryPath}`);
    // 1688 可能在不改变 /select.htm 地址的情况下切换回编辑表单，先保存阶段再点击。
    save({ phase: 'fill-form' });
    const continueElement = all('button,[role=button],a,span,div')
      .filter(visible)
      .filter((el) => !el.closest('#v1688-panel'))
      .filter((el) => compact(el.textContent) === '确认类目继续完善')
      .sort((a, b) => compact(a.textContent).length - compact(b.textContent).length)[0];
    if (!continueElement) {
      save({ phase: 'choose-category' });
      throw new Error('找不到“确认类目 继续完善”按钮');
    }
    const continueTarget = continueElement.closest('button,[role=button],a') || continueElement;
    const continued = await activateWithAncestorsUntil(
      continueTarget,
      () => !isCategorySelectorPage() || (text().includes('产品属性') && text().includes('基础信息')),
      2000
    );
    if (!continued) {
      save({ phase: 'choose-category' });
      throw new Error(`已找到“确认类目 继续完善”，但点击后页面没有进入商品编辑表单。已尝试节点：${lastActivationTrace || '无'}`);
    }
    log('已进入商品编辑表单');
  }

  function findProductTitleField() {
    return findField('商品标题') || all('input[maxlength="60"],input[maxLength="60"]')
      .filter(visible)
      .find((el) => clean(el.value));
  }

  const EFFECT_WORDS = [
    '治疗', '治愈', '预防疾病', '药用', '药效', '特效', '根治', '消炎', '止痛', '抗癌',
    '降血糖', '降血脂', '降血压', '减肥', '瘦身', '壮阳', '祛斑', '美白', '排毒',
    '提高免疫力', '增强免疫力', '改善睡眠', '治疗失眠', '改善视力', '治疗关节', '修复软骨'
  ];
  const DOSE_PATTERN = /(?:每(?:粒|片|袋|瓶|份|次|日|天)|每日|每天|一日|一天|建议食用|食用方法|用法用量)|\d+(?:\.\d+)?\s*(?:mg|kg|μg|ug|mcg|毫克|微克|国际单位|iu|ml|毫升|%)/i;

  function cleanAiTitle(raw) {
    return String(raw || '')
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/```[\s\S]*?```/g, (block) => block.replace(/```(?:text)?|```/gi, ''))
      .replace(/^\s*(?:标题|新标题|合规标题)\s*[：:]\s*/i, '')
      .split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0]
      ?.replace(/^["'“‘]+|["'”’。]+$/g, '').trim() || '';
  }

  function validateAiTitle(title, original) {
    if (!title) return '模型返回了空标题';
    if (title.length > 60) return `标题长度为${title.length}字，超过60字`;
    if (title.length < 24) return `标题只有${title.length}字，缺少完整的柔和卖点和日常使用场景`;
    if (title === original) return '标题没有发生变化';
    const effect = EFFECT_WORDS.find((word) => title.includes(word));
    if (effect) return `仍含疑似功效词“${effect}”`;
    if (DOSE_PATTERN.test(title)) return '仍含剂量、含量或食用次数说明';
    return '';
  }

  function requestSenseNovaOnce(settings, messages) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') {
        reject(new Error('当前油猴未授予GM_xmlhttpRequest权限，请重新保存脚本')); return;
      }
      GM_xmlhttpRequest({
        method: 'POST',
        url: settings.aiBaseUrl,
        timeout: 45000,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${settings.aiApiKey}`
        },
        data: JSON.stringify({
          model: settings.aiModel,
          messages,
          temperature: 0.2,
          max_tokens: 2048,
          chat_template_kwargs: { enable_thinking: false },
          stream: false
        }),
        onload: (response) => {
          let data;
          try { data = JSON.parse(response.responseText || '{}'); }
          catch (_) { reject(new Error(`AI接口返回的不是JSON（HTTP ${response.status}）`)); return; }
          if (response.status < 200 || response.status >= 300) {
            const detail = data?.error?.message || data?.message || response.statusText || '未知错误';
            const error = new Error(`AI接口失败（HTTP ${response.status}）：${detail}`);
            error.httpStatus = response.status;
            const retryAfter = String(response.responseHeaders || '').match(/^retry-after:\s*(\d+(?:\.\d+)?)/im);
            error.retryAfterMs = retryAfter ? Number(retryAfter[1]) * 1000 : 0;
            reject(error); return;
          }
          const choice = data?.choices?.[0];
          const message = choice?.message || {};
          const content = message.content;
          let answer = '';
          if (typeof content === 'string') answer = content;
          else if (Array.isArray(content)) {
            answer = content.map((part) => typeof part === 'string' ? part : (part?.text || part?.content || '')).join('');
          } else if (content && typeof content === 'object') {
            answer = content.text || content.content || '';
          }
          answer ||= message.final_content || message.output_text || data.output_text || '';
          if (!String(answer).trim()) {
            const reasonLength = String(message.reasoning_content || '').length;
            const finish = choice?.finish_reason || 'unknown';
            reject(new Error(`AI返回正文为空（finish_reason=${finish}，reasoning_content=${reasonLength}字）`)); return;
          }
          resolve(String(answer));
        },
        ontimeout: () => reject(new Error('AI接口请求超时（45秒）')),
        onerror: () => reject(new Error('AI接口网络请求失败'))
      });
    });
  }

  async function requestSenseNova(settings, messages) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const state = load();
      const interval = Math.max(3000, Number(settings.aiRequestIntervalMs) || 12000);
      const waitForSlot = Math.max(0, Number(state.aiLastRequestAt || 0) + interval - Date.now());
      if (waitForSlot > 0) {
        log(`AI请求限速保护：等待${Math.ceil(waitForSlot / 1000)}秒`);
        await sleep(waitForSlot);
      }
      save({ aiLastRequestAt: Date.now() });
      try {
        return await requestSenseNovaOnce(settings, messages);
      } catch (error) {
        if (error.httpStatus !== 429 || attempt >= 3) throw error;
        const fallback = attempt === 1 ? 20000 : 40000;
        const waitMs = Math.min(55000, Math.max(5000, Number(error.retryAfterMs) || fallback));
        log(`日日新达到TPM/RPM限制，等待${Math.ceil(waitMs / 1000)}秒后自动重试（${attempt}/2）`, 'warn');
        await sleep(waitMs);
      }
    }
    throw new Error('AI请求重试次数已用完');
  }

  async function generateCompliantTitle(original, settings) {
    if (!settings.aiApiKey) throw new Error('尚未填写日日新API密钥');
    if (!settings.aiModel) throw new Error('尚未填写AI模型名称');
    const systemPrompt = [
      '你是1688食品商品营销标题改写器。只输出一行最终标题，不要解释、引号、序号或Markdown。',
      '保留原题中可核实的品牌、核心原料或产品名称、剂型、适用人群、包装数量和原有卖点方向；不得编造原题没有的原料、规格或数字。',
      '标题必须有完整营销信息，不能只输出品牌加产品名。把原来的直接功效说法改写为柔和的日常养护、护理、营养、活力、舒适或使用场景表达。',
      '删除所有剂量、含量、浓度、每日/每次食用数量和用法说明，包括mg、g、μg、IU、ml、百分比、每粒/每日等。',
      '包装总数量如“60粒装”可以保留，但不得把它改写成食用剂量。',
      '允许并鼓励使用这些柔和表达：温和呵护、日常护理、身体养护、维持良好状态、提升能量活力、营养补充、调理呵护、日常膳食营养、身体衡养、关节护理、促进钙质吸收、顺畅运动、身体舒适、夜间睡眠放松状态。',
      '禁止出现治疗、治愈、药用、特效、根治、消炎、止痛、抗癌、降血糖、降血脂、降血压、减肥、壮阳等强医疗或直接疾病功效词。',
      '以下标题是用户认可的目标风格，请学习其长度、结构和柔和卖点表达，不要把它们缩成单独产品名：',
      settings.aiStyleReference,
      '标题必须自然、有销售表达，建议28至58个字符，最多60个字符。'
    ].join('\n');
    let correction = '';
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const raw = await requestSenseNova(settings, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `原商品标题：${original}${correction}` }
      ]);
      const title = cleanAiTitle(raw);
      const issue = validateAiTitle(title, original);
      if (!issue) return title;
      log(`AI标题第${attempt}次校验未通过：${issue}`, 'warn');
      correction = `\n上一次结果不合格，原因：${issue}。请重新生成并严格只输出最终标题。`;
    }
    throw new Error('AI连续3次生成的标题均未通过本地合规校验');
  }

  const sameTitle = (actual, expected) => clean(actual) === clean(expected);

  function currentWrittenTitle(expected, fallbackField) {
    const freshField = findProductTitleField();
    const visibleMatch = all('input:not([type=hidden]),textarea')
      .filter(visible)
      .filter((el) => !el.closest('#v1688-panel'))
      .find((el) => sameTitle(el.value, expected));
    if (visibleMatch) return String(visibleMatch.value || '');
    if (freshField && 'value' in freshField) return String(freshField.value || '');
    return String(fallbackField?.value || '');
  }

  async function writeProductTitle(field, title) {
    field.scrollIntoView({ block: 'center', inline: 'nearest' });
    dispatchValue(field, title);
    await sleep(500);
    if (sameTitle(currentWrittenTitle(title, field), title)) return true;

    // 1688的受控输入框偶尔会在blur后回滚；保持焦点再次提交React事件。
    field.focus();
    const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    const previous = field.value;
    if (setter) setter.call(field, title);
    else field.value = title;
    if (field._valueTracker?.setValue) field._valueTracker.setValue(previous);
    field.dispatchEvent(new Event('beforeinput', { bubbles: true, composed: true }));
    field.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    field.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    await sleep(700);
    if (sameTitle(currentWrittenTitle(title, field), title)) {
      field.blur();
      return true;
    }

    // 最后使用浏览器的编辑命令，行为更接近用户全选后粘贴。
    field.focus();
    if (typeof field.select === 'function') field.select();
    try { document.execCommand('insertText', false, title); } catch (_) { /* ignore */ }
    field.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    field.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    await sleep(700);
    const ok = sameTitle(currentWrittenTitle(title, field), title);
    if (ok) field.blur();
    return ok;
  }

  async function replaceProductTitle(settings) {
    if (!settings.aiTitleEnabled && (!settings.titleReplaceEnabled || !settings.titleFind)) {
      log('商品标题替换：未启用');
      return false;
    }
    const field = findProductTitleField();
    if (!field || !('value' in field)) {
      throw new Error('未找到“商品标题”输入框');
    }
    const before = String(field.value || '');
    if (settings.aiTitleEnabled) {
      log(`正在调用AI生成合规标题（模型：${settings.aiModel}）`);
      const after = await generateCompliantTitle(before, settings);
      log(`AI已生成标题：${after}`);
      if (!await writeProductTitle(field, after)) {
        throw new Error(`AI标题写入后校验失败；目标：“${after}”；当前页面标题：“${currentWrittenTitle(after, field)}”`);
      }
      log(`AI标题已写入：${after}`);
      return true;
    }
    if (!before.includes(settings.titleFind)) {
      log(`商品标题不包含“${settings.titleFind}”，保持不变`);
      return false;
    }
    const after = before.split(settings.titleFind).join(settings.titleReplace);
    const maxLength = Number(field.maxLength) > 0 ? Number(field.maxLength) : 60;
    if (after.length > maxLength) {
      throw new Error(`标题替换后为 ${after.length} 字，超过上限 ${maxLength} 字`);
    }
    if (!await writeProductTitle(field, after)) {
      throw new Error(`商品标题替换后校验失败；目标：“${after}”；当前页面标题：“${currentWrittenTitle(after, field)}”`);
    }
    log(`商品标题已替换：“${settings.titleFind}” → “${settings.titleReplace}”`);
    return true;
  }

  async function fillCurrentForm(settings) {
    log(settings.titleOnlyMode ? '开始仅替换当前商品标题' : '开始填写当前商品表单');
    const titleChanged = await replaceProductTitle(settings);
    if (settings.titleOnlyMode) {
      if (!titleChanged) {
        log('仅标题模式：标题无需修改，跳过提交并进入下一件');
        finishOne();
        return;
      }
      log('仅标题模式：已跳过类目、属性、发货时间和件重尺');
    } else {
      if (settings.customMode) {
        const customChecked = await ensureCheckboxChecked('定制');
        if (!customChecked) throw new Error('未能勾选供货方式“定制”');
        log('供货方式：已勾选定制');
        await sleep(800);
      }
      await fillRequiredAttributes(settings);
      await fillSpecialCosmetic();
      if (!await fillColorCategory(settings)) throw new Error('颜色分类修改失败，已暂停提交');
      if (settings.customMode) {
        if (!await fillCustomDeliveryTiers()) throw new Error('定制发货分档设置失败，已暂停提交');
      } else {
        await fillDeliveryTime();
      }
      if (!await fillMeasurementUnit(settings)) throw new Error('计量单位修改失败，已暂停提交');
      fillPackage(settings);
    }
    save({ phase: 'ready-submit' });
    if (settings.batchAutoSubmit && !settings.testMode) await submitCurrent();
    else log('已在提交前暂停。请检查页面，然后点击面板“提交当前商品并继续”。', 'warn');
  }

  async function submitCurrent() {
    const buttons = ['同意协议条款，我要发布', '保存并提交', '提交审核', '确认发布', '发布商品', '保存'];
    const chosen = buttons.find((name) => candidatesByText(name).some((el) => compact(el.textContent) === compact(name)));
    if (!chosen) {
      log('未找到最终提交按钮；请人工提交，成功后点击“标记成功并下一个”', 'error');
      return;
    }
    // 必须先保存阶段；点击发布后会整页跳转，点击后的 JS 上下文可能立即销毁。
    save({ phase: 'submitting' });
    log(`准备点击“${chosen}”，队列进度已保存`);
    if (!clickText(chosen, { exact: true })) {
      save({ phase: 'ready-submit' });
      log(`未能点击“${chosen}”；请人工提交，成功后点击“标记成功 / 下一个”`, 'error');
      return;
    }
    const success = await waitUntil(() => /修改成功[\s\S]{0,40}商品已提交审核|商品已提交审核|发布成功|提交成功/.test(text()), 15000, 500);
    if (success) {
      log('商品提交成功，直接进入队列下一个商品');
      finishOne();
    } else if (text().includes('产品属性') || text().includes('发货服务')) {
      save({ phase: 'ready-submit' });
      log('未能自动确认提交结果。确认成功后点击“标记成功并下一个”；若有红字错误请先处理。', 'warn');
    }
  }

  function finishOne() {
    const state = load();
    const nextIndex = state.current + 1;
    if (nextIndex >= state.queue.length) {
      save({ current: nextIndex, running: false, phase: 'done' });
      log(`批次完成：${state.queue.length} 个商品`);
      return;
    }
    save({ current: nextIndex, phase: 'open-edit' });
    log(`进入第 ${nextIndex + 1}/${state.queue.length} 个商品`);
    navigate(state.queue[nextIndex]);
  }

  async function autoRun() {
    const settings = load();
    if (!settings.running) return;
    await sleep(900);
    // 批量跳转后新编辑页会渐进加载；已经打开很久的手工测试页不需要额外等待。
    if (settings.phase === 'open-edit') await waitForPageAge(9000);
    const body = text();
    try {
      // 兼容人工点击发布或旧版本留下的阶段状态：成功文案优先于 phase 判断。
      if (/修改成功[\s\S]{0,40}商品已提交审核|商品已提交审核|发布成功|提交成功/.test(body)) {
        log('识别到提交成功页，直接进入队列下一个商品');
        finishOne();
        return;
      }
      // 发布成功页不会自动返回编辑页；识别成功文案后直接打开队列中的下一条链接。
      if (settings.phase === 'submitting') {
        const success = await waitUntil(() => /修改成功[\s\S]{0,40}商品已提交审核|商品已提交审核|发布成功|提交成功/.test(text()), 15000, 500);
        if (success) {
          log('识别到提交成功页，直接进入队列下一个商品');
          finishOne();
        } else {
          save({ running: false, phase: 'ready-submit' });
          log('等待提交结果超时，任务已暂停。请检查页面；若实际成功可点“标记成功 / 下一个”。', 'warn');
        }
        return;
      }
      if (settings.titleOnlyMode && (settings.phase === 'open-edit' || settings.phase === 'fill-form')) {
        const titleReady = await waitUntil(() => !!findProductTitleField(), 12000, 400);
        if (!titleReady) throw new Error('仅标题模式：等待“商品标题”输入框超时');
        save({ phase: 'fill-form' });
        log('仅标题模式：编辑页已就绪，跳过修改类目');
        await fillCurrentForm({ ...settings, phase: 'fill-form' });
        return;
      }
      if (isCategorySelectorPage()) {
        await handleCategoryPage(settings);
        return;
      }
      if (settings.phase === 'open-edit' && pageHasExpectedCategory(settings) &&
          body.includes('产品属性') && (body.includes('件重尺') || body.includes('发货服务'))) {
        save({ phase: 'fill-form' });
        log('编辑页已显示目标类目，从填写属性阶段继续');
        await fillCurrentForm({ ...settings, phase: 'fill-form' });
        return;
      }
      if (settings.phase === 'open-edit' || settings.phase === 'choose-category') {
        if (body.includes('重选类目可能导致部分信息丢失')) {
          if (!clickCategoryWarningConfirm()) throw new Error(`找到重选类目提示，但未找到弹窗中的蓝色主按钮。页面可见按钮：${visibleButtonSummary() || '无'}`);
          log('已确认重选类目，等待进入类目页');
          return;
        }
        const clicked = clickText('修改类目', { exact: false });
        if (!clicked) throw new Error('当前阶段应修改类目，但未找到“修改类目”入口');
        save({ phase: 'choose-category' });
        log('已点击“修改类目”');
        const warningVisible = await waitUntil(() => text().includes('重选类目可能导致部分信息丢失'), 4000);
        if (warningVisible && !clickCategoryWarningConfirm()) throw new Error(`找到重选类目提示，但未找到弹窗中的蓝色主按钮。页面可见按钮：${visibleButtonSummary() || '无'}`);
        return;
      }
      if (settings.phase === 'fill-form' && body.includes('产品属性') && (body.includes('件重尺') || body.includes('发货服务'))) {
        const editPageCategoryReady = await waitUntil(() => pageHasExpectedCategory(settings), 10000);
        if (!editPageCategoryReady) {
          throw new Error(`回到编辑页后类目校验失败，未显示目标路径：${settings.categoryPath}`);
        }
        log(`编辑页类目校验通过：${settings.categoryPath}`);
        await fillCurrentForm(settings);
        return;
      }
      log('无法识别当前页面步骤，已暂停，请查看日志', 'error');
      save({ running: false });
    } catch (error) {
      log(error.message || String(error), 'error');
      save({ running: false });
    }
  }

  function renderPanel() {
    if (document.querySelector('#v1688-panel')) return;
    const s = load();
    const panel = document.createElement('aside');
    panel.id = 'v1688-panel';
    panel.className = s.panelCollapsed ? 'v-collapsed' : '';
    const phaseLabel = s.running ? `运行中 ${Math.min(s.current + 1, s.queue.length)}/${s.queue.length}` : (s.phase === 'done' ? '已完成' : '待命');
    panel.innerHTML = `
      <style>
        #v1688-panel{--v-blue:#2563eb;--v-ink:#0f172a;--v-muted:#64748b;--v-line:#e2e8f0;position:fixed;right:18px;top:18px;width:390px;max-height:calc(100vh - 36px);overflow:auto;z-index:2147483647;background:#f8fafc;border:1px solid #dbe4f0;border-radius:16px;box-shadow:0 18px 55px rgba(15,23,42,.18);font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;color:var(--v-ink)}
        #v1688-panel *{box-sizing:border-box}#v1688-panel.v-collapsed{width:248px;overflow:hidden}#v1688-panel.v-collapsed .v-body{display:none}
        #v1688-panel .v-head{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:10px;padding:12px 14px;background:rgba(255,255,255,.96);border-bottom:1px solid var(--v-line);backdrop-filter:blur(10px)}
        #v1688-panel .v-logo{display:grid;place-items:center;width:30px;height:30px;border-radius:9px;background:linear-gradient(135deg,#2563eb,#60a5fa);color:white;font-weight:800}#v1688-panel .v-heading{min-width:0;flex:1}#v1688-panel .v-title{font-size:14px;font-weight:750;white-space:nowrap}#v1688-panel .v-sub{font-size:11px;color:var(--v-muted)}
        #v1688-panel .v-status{padding:3px 7px;border-radius:999px;background:#eff6ff;color:#1d4ed8;font-size:10px;font-weight:700;white-space:nowrap}#v1688-panel #v-collapse{width:28px;height:28px;padding:0;border:1px solid var(--v-line);border-radius:8px;background:#fff;color:#475569;font-size:16px}
        #v1688-panel .v-body{padding:10px}#v1688-panel .v-card{margin-bottom:9px;padding:10px;background:#fff;border:1px solid var(--v-line);border-radius:12px}#v1688-panel .v-section{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;font-size:12px;font-weight:750;color:#334155}#v1688-panel .v-hint{font-size:10px;font-weight:500;color:#94a3b8}
        #v1688-panel label.v-field{display:block;margin:7px 0 3px;font-size:11px;font-weight:650;color:#475569}#v1688-panel input[type=text],#v1688-panel input[type=password],#v1688-panel textarea{width:100%;border:1px solid #cbd5e1;border-radius:8px;background:#fff;padding:7px 9px;color:#0f172a;outline:none;transition:.15s}#v1688-panel input[type=text]:focus,#v1688-panel input[type=password]:focus,#v1688-panel textarea:focus{border-color:#60a5fa;box-shadow:0 0 0 3px #dbeafe}
        #v1688-panel .v-grid2{display:grid;grid-template-columns:1fr 1fr;gap:7px}#v1688-panel .v-grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:7px}#v1688-panel .v-checks{display:flex;flex-wrap:wrap;gap:10px;margin-top:8px}#v1688-panel .v-checks label{display:flex;align-items:center;gap:5px;font-size:11px;color:#475569}
        #v1688-panel .v-actions{display:grid;grid-template-columns:1fr 1fr;gap:7px}#v1688-panel button{border:0;border-radius:8px;padding:8px 10px;background:var(--v-blue);color:#fff;font:600 12px/1.2 inherit;cursor:pointer;transition:transform .12s,filter .12s}#v1688-panel button:hover{filter:brightness(.96)}#v1688-panel button:active{transform:translateY(1px)}#v1688-panel button.v-secondary{background:#e2e8f0;color:#334155}#v1688-panel button.v-ghost{background:#fff;color:#2563eb;border:1px solid #bfdbfe}#v1688-panel button.v-danger{background:#fee2e2;color:#b91c1c}#v1688-panel button.v-wide{grid-column:1/-1}
        #v1688-log{white-space:pre-wrap;background:#0f172a;color:#cbd5e1;min-height:82px;max-height:150px;overflow:auto;padding:9px;border-radius:9px;margin-top:8px;font:10.5px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
      </style>
          <div class="v-head"><div class="v-logo">88</div><div class="v-heading"><div class="v-title">1688 批量编辑</div><div class="v-sub">Category & Offer Ops · v0.6.1</div></div><span class="v-status">${escapeHtml(phaseLabel)}</span><button id="v-collapse" title="缩小/展开">${s.panelCollapsed ? '+' : '−'}</button></div>
      <div class="v-body">
        <section class="v-card"><div class="v-section"><span>标题批量替换</span><span class="v-hint">逐个商品生效</span></div>
          <div class="v-grid2"><div><label class="v-field">查找文字</label><input id="v-title-find" type="text" value="${escapeHtml(s.titleFind)}"></div><div><label class="v-field">替换为</label><input id="v-title-replace" type="text" value="${escapeHtml(s.titleReplace)}"></div></div>
          <div class="v-checks"><label><input id="v-title-enable" type="checkbox" ${s.titleReplaceEnabled ? 'checked' : ''}> 启用文字替换</label><label><input id="v-ai-title" type="checkbox" ${s.aiTitleEnabled ? 'checked' : ''}> AI合规改写（优先）</label><label><input id="v-title-only" type="checkbox" ${s.titleOnlyMode ? 'checked' : ''}> 仅替换标题，其他不更改</label></div>
          <div class="v-grid2"><div><label class="v-field">日日新API密钥</label><input id="v-ai-key" type="password" autocomplete="off" placeholder="${s.aiApiKey ? '密钥已保存在油猴本地' : '粘贴新密钥'}"></div><div><label class="v-field">AI模型</label><input id="v-ai-model" type="text" value="${escapeHtml(s.aiModel)}"></div></div>
          <label class="v-field">AI请求间隔（秒，429时还会自动等待）</label><input id="v-ai-interval" type="text" value="${Math.max(3, Math.round((Number(s.aiRequestIntervalMs) || 12000) / 1000))}">
          <label class="v-field">AI标题风格参考（每行一个）</label><textarea id="v-ai-style" rows="4">${escapeHtml(s.aiStyleReference)}</textarea>
        </section>
        <section class="v-card"><div class="v-section"><span>类目规则</span><span class="v-hint">双重校验</span></div>
          <div class="v-grid2"><div><label class="v-field">搜索词</label><input id="v-cat-key" type="text" value="${escapeHtml(s.categoryKeyword)}"></div><div><label class="v-field">末级类目</label><input id="v-cat-leaf" type="text" value="${escapeHtml(s.categoryLeaf)}"></div></div>
          <label class="v-field">预期完整路径</label><input id="v-cat-path" type="text" value="${escapeHtml(s.categoryPath)}">
        </section>
        <section class="v-card"><div class="v-section"><span>商品参数</span><span class="v-hint">定制：1～2个48h / 3个以上72h</span></div>
          <div class="v-grid2"><div><label class="v-field">必填项内容</label><input id="v-required" type="text" value="${escapeHtml(s.requiredText)}"></div><div><label class="v-field">重量 (g)</label><input id="v-weight" type="text" value="${escapeHtml(s.weightG)}"></div></div>
          <label class="v-field">件重尺 (cm)</label><div class="v-grid3"><input id="v-length" type="text" placeholder="长" value="${escapeHtml(s.lengthCm)}"><input id="v-width" type="text" placeholder="宽" value="${escapeHtml(s.widthCm)}"><input id="v-height" type="text" placeholder="高" value="${escapeHtml(s.heightCm)}"></div>
          <div class="v-grid2"><div><label class="v-field">颜色分类目标值</label><input id="v-color-category" type="text" placeholder="例如：100ml" value="${escapeHtml(s.colorCategoryValue)}"></div><div><label class="v-field">计量单位</label><input id="v-unit" type="text" value="${escapeHtml(s.measurementUnit)}"></div></div>
          <div class="v-checks"><label><input id="v-custom" type="checkbox" ${s.customMode ? 'checked' : ''}> 勾选定制并设置两档发货</label><label><input id="v-overwrite" type="checkbox" ${s.overwriteAttributes ? 'checked' : ''}> 覆盖已有属性</label><label><input id="v-auto" type="checkbox" ${s.batchAutoSubmit ? 'checked' : ''}> 批量自动发布</label></div>
        </section>
        <section class="v-card"><div class="v-section"><span>任务队列</span><span class="v-hint">${s.queue.length} 个商品</span></div>
          <textarea id="v-urls" rows="4" placeholder="每行一个修改详情链接">${escapeHtml(s.queue.join('\n'))}</textarea>
          <div class="v-actions" style="margin-top:8px"><button id="v-collect" class="v-ghost">读取本页选中</button><button id="v-test" class="v-secondary">测试当前商品</button><button id="v-start" class="v-wide">开始 / 重新开始批量</button></div>
        </section>
        <section class="v-card"><div class="v-section"><span>当前任务</span><span class="v-hint">${escapeHtml(s.phase)}</span></div>
          <div class="v-actions"><button id="v-submit" class="v-wide">提交当前商品并继续</button><button id="v-next" class="v-secondary">标记成功 / 下一个</button><button id="v-stop" class="v-danger">停止任务</button></div>
          <div id="v1688-log">${escapeHtml(s.log.join('\n'))}</div>
        </section>
      </div>`;
    document.body.appendChild(panel);

    const value = (id) => document.querySelector(id).value.trim();
    const persistForm = () => {
      const enteredKey = value('#v-ai-key');
      const patch = {
        titleReplaceEnabled: document.querySelector('#v-title-enable').checked,
        titleOnlyMode: document.querySelector('#v-title-only').checked,
        aiTitleEnabled: document.querySelector('#v-ai-title').checked,
        aiModel: value('#v-ai-model'),
        aiRequestIntervalMs: Math.max(3000, (Number(value('#v-ai-interval')) || 12) * 1000),
        aiStyleReference: value('#v-ai-style'),
        titleFind: value('#v-title-find'), titleReplace: value('#v-title-replace'),
        categoryKeyword: value('#v-cat-key'), categoryLeaf: value('#v-cat-leaf'), categoryPath: value('#v-cat-path'),
        requiredText: value('#v-required') || '/', lengthCm: value('#v-length'), widthCm: value('#v-width'),
        heightCm: value('#v-height'), weightG: value('#v-weight'),
        customMode: document.querySelector('#v-custom').checked,
        colorCategoryValue: value('#v-color-category'),
        measurementUnit: value('#v-unit') || '个',
        batchAutoSubmit: document.querySelector('#v-auto').checked,
        overwriteAttributes: document.querySelector('#v-overwrite').checked,
        queue: value('#v-urls').split(/\n+/).map((x) => x.trim()).filter(Boolean)
      };
      if (enteredKey) patch.aiApiKey = enteredKey;
      const state = save(patch);
      if (enteredKey) {
        document.querySelector('#v-ai-key').value = '';
        document.querySelector('#v-ai-key').placeholder = '密钥已保存在油猴本地';
      }
      return state;
    };
    panel.addEventListener('change', persistForm);
    document.querySelector('#v-collapse').onclick = () => {
      const collapsed = !panel.classList.contains('v-collapsed');
      panel.classList.toggle('v-collapsed', collapsed);
      document.querySelector('#v-collapse').textContent = collapsed ? '+' : '−';
      save({ panelCollapsed: collapsed });
    };
    document.querySelector('#v-collect').onclick = () => {
      const urls = collectSelectedEditUrls();
      document.querySelector('#v-urls').value = urls.join('\n');
      persistForm(); log(`读取到 ${urls.length} 个选中商品修改链接${urls.length ? '' : '；若页面按钮没有真实链接，请手工粘贴链接'}`, urls.length ? 'info' : 'warn');
    };
    document.querySelector('#v-test').onclick = async () => {
      const state = persistForm();
      if (state.aiTitleEnabled && !state.aiApiKey) return log('AI改写前必须填写日日新API密钥', 'error');
      if (state.aiTitleEnabled && !state.aiModel) return log('AI改写前必须填写模型名称', 'error');
      if (state.titleOnlyMode && !state.aiTitleEnabled && (!state.titleReplaceEnabled || !state.titleFind)) return log('仅标题模式必须启用AI改写，或启用文字替换并填写查找文字', 'error');
      if (!state.titleOnlyMode && (!state.weightG || !state.lengthCm || !state.widthCm || !state.heightCm)) return log('测试前必须填写长、宽、高、重量', 'error');
      if (!state.titleOnlyMode && state.customMode && !state.colorCategoryValue) return log('定制模式必须填写颜色分类目标值', 'error');
      save({
        testMode: true,
        queue: [location.href],
        current: 0,
        running: true,
        phase: 'open-edit'
      });
      log(state.titleOnlyMode ? '开始当前商品仅标题流程' : '开始当前商品完整流程：先修改类目，再填写属性');
      await autoRun();
    };
    document.querySelector('#v-start').onclick = () => {
      const state = persistForm();
      if (state.aiTitleEnabled && !state.aiApiKey) return log('AI改写前必须填写日日新API密钥', 'error');
      if (state.aiTitleEnabled && !state.aiModel) return log('AI改写前必须填写模型名称', 'error');
      if (state.titleOnlyMode && !state.aiTitleEnabled && (!state.titleReplaceEnabled || !state.titleFind)) return log('仅标题模式必须启用AI改写，或启用文字替换并填写查找文字', 'error');
      if (!state.titleOnlyMode && (!state.weightG || !state.lengthCm || !state.widthCm || !state.heightCm)) return log('开始前必须填写长、宽、高、重量', 'error');
      if (!state.titleOnlyMode && state.customMode && !state.colorCategoryValue) return log('定制模式必须填写颜色分类目标值', 'error');
      if (!state.queue.length) return log('没有商品修改链接', 'error');
      const invalidCount = state.queue.filter((url) => !isProductEditUrl(url)).length;
      if (invalidCount) return log(`发现 ${invalidCount} 条非“修改详情”链接，已阻止开始。请重新点击“读取本页选中”`, 'error');
      save({ running: true, testMode: false, current: 0, phase: 'open-edit' });
      navigate(load().queue[0]);
    };
    document.querySelector('#v-submit').onclick = async () => { persistForm(); await submitCurrent(); };
    document.querySelector('#v-next').onclick = finishOne;
    document.querySelector('#v-stop').onclick = () => { save({ running: false, phase: 'stopped' }); log('批量任务已停止', 'warn'); };
  }

  const isRelevantDocument = () => {
    const isEditor = /(^|\.)offer(?:-new)?\.1688\.com$/.test(location.hostname);
    const hasProductRows = !!document.querySelector('a[href*="fill_product_info"][href*="operator=edit"]');
    return isEditor || hasProductRows;
  };
  const start = () => {
    if (isRelevantDocument()) {
      renderPanel();
      autoRun();
      return;
    }
    // 商品表格由工作台 iframe 延迟加载；只在真正含商品行的文档中显示面板。
    let checks = 0;
    const timer = setInterval(() => {
      checks += 1;
      if (isRelevantDocument()) {
        clearInterval(timer);
        renderPanel();
        autoRun();
      } else if (checks >= 60) clearInterval(timer);
    }, 500);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
