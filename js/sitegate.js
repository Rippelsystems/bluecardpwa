// ─── SITE ACCESS GATE — "Rippel Matrix BCDS" ─────────────────────────────────
// A first layer in front of every Blue Card page (index, dashboard, identity):
// nothing on the page is shown until the site password has been accepted on
// this tablet/browser.
//
//  - The password is checked by the database (RPC verify_site_password), which
//    only answers true/false. The password is never stored in this file or
//    anywhere on GitHub — only a one-way hash inside the database function.
//  - Once accepted, this device is remembered for SITE_GATE_DAYS days, so
//    operators aren't asked on every app launch. Operator number + PIN are
//    still required as before — this gate is IN ADDITION to them.
//  - To force every device to re-enter the password (e.g. after changing it),
//    change SITE_GATE_KEY below AND in the small <script> in each page's <head>.
//
// Loads after js/supabase.js (needs SUPABASE_URL / SUPABASE_ANON_KEY).

const SITE_GATE_KEY  = 'bcds_site_access_v1';
const SITE_GATE_DAYS = 30;

(function () {
  function isUnlocked() {
    try {
      const v = JSON.parse(localStorage.getItem(SITE_GATE_KEY) || 'null');
      return !!(v && v.until > Date.now());
    } catch (e) { return false; }
  }

  function unlock() {
    try {
      localStorage.setItem(SITE_GATE_KEY, JSON.stringify({
        until: Date.now() + SITE_GATE_DAYS * 24 * 60 * 60 * 1000
      }));
    } catch (e) { /* private mode — still unlock for this visit */ }
    document.documentElement.classList.remove('bcds-locked');
    const g = document.getElementById('bcds-gate');
    if (g) g.remove();
  }

  if (isUnlocked()) {
    document.documentElement.classList.remove('bcds-locked');
    return;
  }
  document.documentElement.classList.add('bcds-locked');

  let gateClient = null;
  function client() {
    if (!gateClient) {
      gateClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false, storageKey: 'bcds-site-gate' }
      });
    }
    return gateClient;
  }

  function build() {
    if (document.getElementById('bcds-gate')) return;
    const gate = document.createElement('div');
    gate.id = 'bcds-gate';
    gate.innerHTML = `
      <div class="bcds-card">
        <div class="bcds-brand">RIPPEL EFFECT SYSTEMS</div>
        <div class="bcds-title">Rippel Matrix</div>
        <div class="bcds-sub">Blue Card Digital System · Restricted access</div>
        <label for="bcds-pw">SITE PASSWORD</label>
        <input id="bcds-pw" type="password" autocomplete="current-password"
               autocapitalize="off" autocorrect="off" spellcheck="false"
               placeholder="Enter site password">
        <div id="bcds-err"></div>
        <button id="bcds-btn" type="button">Enter</button>
        <div class="bcds-note">This tablet will be remembered for ${SITE_GATE_DAYS} days.</div>
      </div>`;
    document.body.appendChild(gate);

    const inp = gate.querySelector('#bcds-pw');
    const btn = gate.querySelector('#bcds-btn');
    const err = gate.querySelector('#bcds-err');

    async function submit() {
      const pw = (inp.value || '').trim();
      err.textContent = '';
      if (!pw) { err.textContent = 'Enter the site password'; inp.focus(); return; }
      btn.disabled = true; btn.textContent = 'Checking…';
      try {
        const { data, error } = await client().rpc('verify_site_password', { p_password: pw });
        if (error) throw error;
        if (data === true) { unlock(); return; }
        err.textContent = '❌ Incorrect site password';
        inp.value = ''; inp.focus();
      } catch (e) {
        console.error('[SiteGate]', e);
        err.textContent = '⚠ Could not check password — check the connection and try again';
      } finally {
        btn.disabled = false; btn.textContent = 'Enter';
      }
    }
    btn.addEventListener('click', submit);
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    setTimeout(() => inp.focus(), 50);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();
