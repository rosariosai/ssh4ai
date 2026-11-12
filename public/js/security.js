// Security section of the Settings dialog (web only): optional login password and optional allowed addresses.
// Self-contained: adds its own section to #settings-modal-overlay, and does nothing when the server has no /api/security.
// These settings are saved in the database. If the same setting exists in the compose file (environment variable)
// the compose file overrides it, and the item is shown as read-only here.
(function () {
  'use strict';
  let st = null;
  let root, msg;

  function el(tag, props, kids) {
    const e = document.createElement(tag);
    Object.assign(e, props || {});
    (kids || []).forEach((k) => e.append(k));
    return e;
  }
  async function api(method, url, body) {
    const r = await fetch(url, {
      method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
    });
    let j = {};
    try { j = await r.json(); } catch (e) { /* not JSON */ }
    if (!r.ok) throw new Error(j.error || ('Request failed (' + r.status + ')'));
    return j;
  }

  function say(text, bad) {
    msg.textContent = text || '';
    msg.style.color = bad ? 'var(--error, #f87171)' : 'var(--primary, #60a5fa)';
  }
  const field = (label, input) => el('div', { className: 'form-field' }, [el('label', { textContent: label }), input]);
  const pwInput = (ph) => el('input', { type: 'password', className: 'form-input', placeholder: ph || '', autocomplete: 'new-password', maxLength: 1024 });
  const btn = (text, cls, fn) => { const b = el('button', { className: 'btn ' + cls, textContent: text, type: 'button' }); b.addEventListener('click', fn); return b; };
  const note = (t, color) => el('div', { textContent: t, style: 'font-size:11px;color:' + (color || 'var(--text-muted)') + ';line-height:1.5;' });
  const badge = (on) => el('span', {
    textContent: on ? 'ON' : 'OFF',
    style: 'font-size:10px;font-family:var(--font-mono);padding:1px 6px;border-radius:3px;border:1px solid ' + (on ? 'var(--primary)' : 'var(--border-line)') + ';color:' + (on ? 'var(--primary)' : 'var(--text-dim)') + ';',
  });
  const subhead = (t, on) => el('div', { className: 'settings-row', style: 'margin-top:6px;' }, [
    el('strong', { textContent: t, style: 'font-size:12px;color:var(--text-bright);font-family:var(--font-mono);' }), badge(on),
  ]);
  const fromCompose = (what) => note('Set in the compose file (' + what + '). The compose file overrides this setting; edit it there to change or remove it.', 'var(--text-bright)');

  async function act(fn, okText) {
    say('Saving...');
    try { st = await fn(); render(); say(okText); } catch (e) { say(e.message, true); }
  }

  function loginBlock() {
    const box = el('div', { style: 'display:flex;flex-direction:column;gap:8px;' });
    box.append(subhead('Login password', st.login.on));
    if (st.login.source === 'env') { box.append(fromCompose('APP_PASSWORD_HASH')); return box; }
    if (!st.login.on) {
      const p1 = pwInput('New password (12+ characters)'), p2 = pwInput('Repeat password');
      box.append(field('New password', p1), field('Repeat', p2),
        el('div', { style: 'display:flex;gap:8px;' }, [
          btn('Turn on login', 'btn-primary', () => {
            if (p1.value !== p2.value) return say('The two passwords do not match', true);
            act(() => api('PUT', '/api/security/login', { enabled: true, newPassword: p1.value }), 'Login is on. You stay signed in on this browser.');
          })]),
        note('One shared password for everyone. Sessions end after ' + st.idleMinutes + ' minutes idle or ' + st.maxHours + ' hours.'));
    } else {
      const cur = pwInput('Current password'), p1 = pwInput('New password (12+ characters)'), p2 = pwInput('Repeat new password');
      box.append(field('Current password (needed for any change)', cur), field('New password (only to change it)', p1), field('Repeat new password', p2),
        el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;' }, [
          btn('Change password', 'btn-primary', () => {
            if (!p1.value) return say('Enter the new password', true);
            if (p1.value !== p2.value) return say('The two new passwords do not match', true);
            act(() => api('PUT', '/api/security/login', { enabled: true, currentPassword: cur.value, newPassword: p1.value }), 'Password changed. Other sessions were signed out.');
          }),
          btn('Turn off login', 'btn-secondary', () =>
            act(() => api('PUT', '/api/security/login', { enabled: false, currentPassword: cur.value }), 'Login is off.')),
          el('a', { href: '/logout', className: 'btn btn-secondary', textContent: 'Sign out', style: 'text-decoration:none;' }),
        ]),
        note('Sessions end after ' + st.idleMinutes + ' minutes idle or ' + st.maxHours + ' hours. Changing the password signs out every other session.'));
    }
    return box;
  }

  function allowBlock() {
    const box = el('div', { style: 'display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--border-line);padding-top:10px;margin-top:4px;' });
    box.append(subhead('Allowed addresses', st.allow.on));
    if (st.allow.source === 'env') {
      box.append(fromCompose('ALLOWED_CIDRS'), note('Currently allowed: ' + st.allow.cidrs.join(', ')));
      return box;
    }
    const ta = el('textarea', { className: 'form-textarea', rows: 3, placeholder: 'One per line or separated by commas, e.g.\n192.0.2.0/24\n192.0.2.50', value: st.allow.cidrs.join('\n') });
    box.append(field('Only these IP addresses or ranges can open this app', ta),
      note('Your address now: ' + st.yourIp + '. A list that does not contain it is refused, so you cannot lock yourself out by mistake.'),
      el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;' }, [
        btn('Add my address', 'btn-secondary', () => {
          if (!ta.value.split(/[\s,]+/).includes(st.yourIp)) ta.value = (ta.value.trim() ? ta.value.trim() + '\n' : '') + st.yourIp;
        }),
        btn(st.allow.on ? 'Save list' : 'Turn on allowlist', 'btn-primary', () =>
          act(() => api('PUT', '/api/security/allowlist', { enabled: true, cidrs: ta.value }), 'Allowlist saved.')),
        st.allow.on ? btn('Turn off', 'btn-secondary', () => act(() => api('PUT', '/api/security/allowlist', { enabled: false }), 'Allowlist is off.')) : '',
      ]));
    if (!st.proxyTrusted) {
      box.append(note('Behind a reverse proxy (for example Nginx Proxy Manager)? Set TRUSTED_PROXIES in the compose file, otherwise every visitor looks like the proxy.'));
    }
    return box;
  }

  function render() {
    root.replaceChildren(
      el('div', { className: 'settings-section-title', textContent: 'Security (optional)' }),
      note('Saved in the database and applied immediately; the Save Settings button below does not affect them. ' +
           'If the same setting is also defined in the compose file (APP_PASSWORD_HASH or ALLOWED_CIDRS), the compose file overrides it and that item is read-only here.'),
    );
    if (!st.canEdit) { root.append(note('Settings storage is not available on this server.')); return; }
    msg = el('div', { style: 'min-height:16px;font-size:12px;' });
    root.append(loginBlock(), allowBlock(), msg);
  }

  async function refresh() {
    try { st = await api('GET', '/api/security'); render(); } catch (e) { /* keep what is shown */ }
  }

  (async function init() {
    const body = document.querySelector('#settings-modal-overlay .modal-body');
    if (!body) return;
    try {
      const r = await fetch('/api/security');
      if (!r.ok) return;
      st = await r.json();
      if (!st || st.ok !== true) return;
    } catch (e) { return; }
    root = el('div', { className: 'settings-section', id: 'security-settings' });
    body.append(root);
    msg = el('div');
    render();
    const open = document.getElementById('btn-settings');
    if (open) open.addEventListener('click', refresh);      // always show the current state when Settings is opened
  })();
})();
