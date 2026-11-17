/* 세무회계 일주 — 페이지 렌더러 (디자인 시안 형식 .dc.html 을 일반 브라우저에서 그려 줍니다) */
(function () {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var HOLE = /\{\{([^}]+)\}\}/g;
  var BOOL_ATTRS = { checked: 1, disabled: 1, selected: 1, hidden: 1, readonly: 1, required: 1, autoplay: 1, muted: 1, loop: 1, playsinline: 1 };

  function DCLogic(props) {
    this.props = props || {};
    this.state = {};
  }
  DCLogic.prototype.setState = function (patch) {
    var next = typeof patch === 'function' ? patch(this.state, this.props) : patch;
    this.state = Object.assign({}, this.state, next);
    var self = this;
    if (!self.__rerender || self.__pending) return;
    self.__pending = true;
    Promise.resolve().then(function () { self.__pending = false; self.__rerender(); });
  };
  window.DCLogic = DCLogic;

  function lookup(expr, scope) {
    expr = String(expr).trim();
    if (expr === 'true') return true;
    if (expr === 'false') return false;
    if (/^-?\d+(\.\d+)?$/.test(expr)) return Number(expr);
    var parts = expr.split('.');
    var v = scope[parts[0]];
    for (var i = 1; i < parts.length; i++) {
      if (v == null) return undefined;
      v = v[parts[i]];
    }
    return v;
  }
  function single(str) {
    var m = /^\s*\{\{([^}]+)\}\}\s*$/.exec(str || '');
    return m ? m[1] : null;
  }
  function interp(str, scope) {
    return String(str).replace(HOLE, function (_, e) {
      var v = lookup(e, scope);
      return v == null ? '' : String(v);
    });
  }
  function camel(name) {
    return name.replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); });
  }

  /* ---------- 컴포넌트 정의 읽기 ---------- */
  var defCache = {};
  function defFromDoc(doc) {
    var xdc = doc.querySelector('x-dc');
    var script = doc.querySelector('script[data-dc-script]');
    var Cls = DCLogic;
    var meta = {};
    if (script) {
      try { Cls = new Function('DCLogic', script.textContent + '\n;return Component;')(DCLogic); }
      catch (e) { console.error('[ilju] component script', e); }
      try { meta = JSON.parse(script.getAttribute('data-props') || '{}'); } catch (e) { meta = {}; }
    }
    var helmets = [];
    Array.prototype.slice.call(xdc.querySelectorAll('helmet')).forEach(function (h) { helmets.push(h); h.parentNode.removeChild(h); });
    return { Cls: Cls, meta: meta, template: xdc, helmets: helmets };
  }
  function loadDef(name) {
    if (!defCache[name]) {
      defCache[name] = fetch(name + '.dc.html')
        .then(function (r) { if (!r.ok) throw new Error(name); return r.text(); })
        .then(function (t) { return defFromDoc(new DOMParser().parseFromString(t, 'text/html')); });
    }
    return defCache[name];
  }
  function importsIn(node) {
    return Array.prototype.slice.call(node.querySelectorAll('dc-import')).map(function (n) { return n.getAttribute('name'); });
  }
  function loadAll(def, defs) {
    var names = importsIn(def.template).filter(function (n) { return !(n in defs); });
    names.forEach(function (n) { defs[n] = null; });
    return Promise.all(names.map(function (n) {
      return loadDef(n).then(function (d) { defs[n] = d; return loadAll(d, defs); });
    }));
  }

  /* ---------- head(글꼴·스타일) 적용 ---------- */
  var headSeen = {};
  function applyHelmets(def) {
    def.helmets.forEach(function (h) {
      Array.prototype.slice.call(h.children).forEach(function (c) {
        var key = c.outerHTML;
        if (headSeen[key]) return;
        headSeen[key] = 1;
        var el = document.createElement(c.tagName.toLowerCase());
        Array.prototype.slice.call(c.attributes).forEach(function (a) { el.setAttribute(a.name, a.value); });
        el.textContent = c.textContent;
        document.head.appendChild(el);
      });
    });
  }

  /* ---------- 그리기 ---------- */
  function renderChildren(tpl, scope, ctx) {
    var out = [];
    Array.prototype.forEach.call(tpl.childNodes, function (c) { out.push.apply(out, renderNode(c, scope, ctx)); });
    return out;
  }

  function renderNode(n, scope, ctx) {
    if (n.nodeType === 3) return [document.createTextNode(interp(n.nodeValue, scope))];
    if (n.nodeType !== 1) return [];
    var tag = n.localName;
    if (tag === 'helmet' || tag === 'script') return [];

    if (tag === 'sc-for') {
      var list = lookup(single(n.getAttribute('list')) || '', scope) || [];
      var as = n.getAttribute('as') || 'item';
      var out = [];
      list.forEach(function (item, i) {
        var s = Object.create(scope);
        s[as] = item;
        s[as + 'Index'] = i;
        out.push.apply(out, renderChildren(n, s, ctx));
      });
      return out;
    }
    if (tag === 'sc-if') {
      return lookup(single(n.getAttribute('value')) || '', scope) ? renderChildren(n, scope, ctx) : [];
    }
    if (tag === 'dc-import') {
      var name = n.getAttribute('name');
      var def = ctx.defs[name];
      var props = {};
      Array.prototype.forEach.call(n.attributes, function (a) {
        if (a.name === 'name' || a.name.indexOf('hint-') === 0) return;
        var e = single(a.value);
        props[camel(a.name)] = e ? lookup(e, scope) : interp(a.value, scope);
      });
      var host = document.createElement('div');
      host.setAttribute('data-dc', name);
      host.style.display = 'contents';
      if (def) mount(def, props, host, ctx);
      return [host];
    }

    var el = n.namespaceURI === SVG_NS ? document.createElementNS(SVG_NS, n.localName) : document.createElement(tag);
    el.__h = {};
    el.__p = {};
    Array.prototype.forEach.call(n.attributes, function (a) {
      var nm = a.name === 'dc-src' ? 'src' : a.name;
      var e = single(a.value);
      if (nm.indexOf('on') === 0 && nm.length > 2) {
        var fn = e ? lookup(e, scope) : null;
        if (typeof fn === 'function') {
          var evt = nm.slice(2).toLowerCase();
          if (evt === 'doubleclick') evt = 'dblclick';
          el.__h[evt] = fn;
        }
        return;
      }
      if (e) {
        var v = lookup(e, scope);
        if (typeof v === 'boolean' || (BOOL_ATTRS[nm] && (v === '' || v == null))) {
          if (nm === 'checked' || nm === 'selected' || nm === 'disabled') el.__p[nm] = !!v;
          if (v) el.setAttribute(nm, '');
          return;
        }
        if (nm === 'value') el.__p.value = v == null ? '' : String(v);
        el.setAttribute(nm, v == null ? '' : String(v));
        return;
      }
      var val = interp(a.value, scope);
      if (nm === 'value') el.__p.value = val;
      if (nm === 'checked') el.__p.checked = true;
      el.setAttribute(nm, val);
    });
    Object.keys(el.__h).forEach(function (evt) { bind(el, evt); });
    renderChildren(n, scope, ctx).forEach(function (c) { el.appendChild(c); });
    applyProps(el, el, true);
    return [el];
  }

  function bind(el, evt) {
    el.addEventListener(evt, function (ev) {
      var f = el.__h && el.__h[evt];
      if (typeof f === 'function') f(ev);
    });
  }
  function applyProps(target, src, initial) {
    var p = src.__p || {};
    if ('value' in p && (initial || document.activeElement !== target) && target.value !== p.value) target.value = p.value;
    if ('checked' in p) target.checked = p.checked;
    if ('selected' in p) target.selected = p.selected;
    if ('disabled' in p) target.disabled = p.disabled;
  }

  /* ---------- 다시 그릴 때 바뀐 부분만 고치기 ---------- */
  function morphChildren(parent, fresh) {
    var old = Array.prototype.slice.call(parent.childNodes);
    var len = Math.max(old.length, fresh.length);
    for (var i = 0; i < len; i++) {
      var o = old[i], n = fresh[i];
      if (!n) { parent.removeChild(o); continue; }
      if (!o) { parent.appendChild(n); continue; }
      if (o.nodeType !== n.nodeType || o.nodeName !== n.nodeName || (o.getAttribute && o.getAttribute('data-dc') !== n.getAttribute('data-dc'))) {
        parent.replaceChild(n, o);
        continue;
      }
      if (o.nodeType === 3) { if (o.nodeValue !== n.nodeValue) o.nodeValue = n.nodeValue; continue; }
      if (o.nodeType === 1) morphEl(o, n);
    }
  }
  function morphEl(o, n) {
    if (o.getAttribute('data-dc')) {
      /* 불러온 부품(왼쪽 메뉴 등)은 그대로 두고 내용만 맞춥니다 */
      morphChildren(o, Array.prototype.slice.call(n.childNodes));
      return;
    }
    Array.prototype.slice.call(o.attributes).forEach(function (a) { if (!n.hasAttribute(a.name)) o.removeAttribute(a.name); });
    Array.prototype.forEach.call(n.attributes, function (a) { if (o.getAttribute(a.name) !== a.value) o.setAttribute(a.name, a.value); });
    var oh = o.__h || (o.__h = {});
    var nh = n.__h || {};
    Object.keys(nh).forEach(function (k) { if (!(k in oh)) bind(o, k); oh[k] = nh[k]; });
    Object.keys(oh).forEach(function (k) { if (!(k in nh)) oh[k] = null; });
    o.__p = n.__p;
    applyProps(o, n, false);
    morphChildren(o, Array.prototype.slice.call(n.childNodes));
  }

  /* ---------- 붙이기 ---------- */
  function defaultsFrom(meta, props) {
    Object.keys(meta || {}).forEach(function (k) {
      if (k.charAt(0) === '$') return;
      var m = meta[k];
      if (props[k] === undefined && m && 'default' in m) props[k] = m.default;
      if (m && m.editor === 'int' && typeof props[k] === 'string' && props[k] !== '') props[k] = Number(props[k]);
    });
    return props;
  }
  function mount(def, props, host, ctx) {
    applyHelmets(def);
    var inst;
    try { inst = new def.Cls(defaultsFrom(def.meta, props)); }
    catch (e) { console.error('[ilju] component', e); inst = new DCLogic(props); }
    var render = function () {
      var vals = {};
      try { vals = typeof inst.renderVals === 'function' ? (inst.renderVals() || {}) : {}; }
      catch (e) { console.error('[ilju] renderVals', e); }
      var scope = Object.assign({}, vals, { props: inst.props });
      var nodes = renderChildren(def.template, scope, ctx);
      if (!host.__mounted) {
        nodes.forEach(function (c) { host.appendChild(c); });
        host.__mounted = true;
      } else {
        morphChildren(host, nodes);
      }
    };
    inst.__rerender = render;
    render();
    return inst;
  }

  function boot() {
    var xdc = document.querySelector('x-dc');
    if (!xdc) return;
    var def = defFromDoc(document);
    var host = document.createElement('div');
    host.id = 'dc-root';
    xdc.parentNode.insertBefore(host, xdc);
    xdc.parentNode.removeChild(xdc);
    var defs = {};
    loadAll(def, defs).then(function () {
      mount(def, {}, host, { defs: defs });
      if (location.hash) {
        var t = document.getElementById(decodeURIComponent(location.hash.slice(1)));
        if (t) t.scrollIntoView();
      }
    }).catch(function (e) { console.error('[ilju] load', e); });
  }

  var css = document.createElement('style');
  css.textContent = 'x-dc{display:none}html{scroll-behavior:smooth}';
  (document.head || document.documentElement).appendChild(css);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
