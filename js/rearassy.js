// ═══════════════════════════════════════════════════════════════════════════
// v1.32 (12/11/2026) — REAR ASSY
// Gerhard 12/11/2026: the rear assembly (HRC serial + firing mech no) is its
// own build and assembly step, often by someone other than the gun's
// operator.
//   • "Rear Assy" on the bottom bar (RLL and XRGL40) opens its own page:
//     two numbers, saved against the logged-in operator and the time.
//   • On the build card, HRC Serial No is picked from the rear assemblies not
//     yet on a gun: that fills HRC + Firing Mech and shows, where the photo
//     buttons were, who assembled the rear assembly. "Type by hand" stays.
//   • Cards that already carry an HRC number are left exactly as they are
//     ("what is done is done").
//   • The pick can be changed until the card is signed off (a faulty unit
//     found at FAT / PDI); the one taken off goes back on the list.
//   • v1.34: picking one opens a confirm box (HRC, firing mech, assembler) —
//     nothing is taken until Confirm; Cancel leaves the card unchanged.
//   • A rear assembly can be corrected by its assembler while it is not on a
//     gun; Admin (PIN) can correct or delete it any time — if it is already on
//     a gun, that gun's card gets the corrected numbers too.
// The database does the checking (rear_assy_save / rear_assy_delete) and
// keeps the "on which gun" link right whenever a card's HRC is saved
// (trigger trg_weapon_builds_rear_assy) — see rear_assy_12Nov.sql.
// Nothing in the existing identity save path is changed: the card still
// saves hrc_serial_no / firing_mech_no from the two boxes as before.
// ═══════════════════════════════════════════════════════════════════════════

const REAR_ASSY_TYPES = ['RLL', 'XRGL40'];
const ra = {
  edit: null,        // rear assembly being corrected on the Rear Assy page (row) or null = new
  adminPin: null,    // PIN typed for the Admin correction in progress (sent to the database, never stored)
  free: [],          // rear assemblies not on a gun (this card type)
  onGun: [],         // last ones put on a gun
};
state.rearAssy = state.rearAssy || null;   // build card: {row, mode:'linked'|'pick'|'manual'|'off'}

function _raEsc(t) { return String(t == null ? '' : t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function _raWhen(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('en-ZA', { day: '2-digit', month: 'short' }) + ' '
       + d.toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit', hour12: false });
}
function _raWho(r) { return `OP ${r.assembler_number}${r.assembler_name ? ' · ' + r.assembler_name : ''}`; }
function rearAssyEnabled(ct) { return REAR_ASSY_TYPES.includes(ct || state.cardType); }
// what is in a box -> stored value (RLL prefixes LRC- / LFM- as on the card)
function _raStore(cardElId, raw) { return _withPrefix(cardElId, raw); }
function _raShow(cardElId, val) { return _stripPrefix(cardElId, val) || ''; }

// ── the bottom-bar tab ──────────────────────────────────────────────────────
function refreshRearAssyTab() {
  const tab = document.getElementById('nav-rearassy');
  if (tab) tab.style.display = rearAssyEnabled() ? '' : 'none';
}

function openRearAssy() {
  if (!state.operator) { showToast('Log in first', 'error'); return; }
  if (!rearAssyEnabled()) { showToast('Rear Assy is for RLL and XRGL40', 'warn'); return; }
  // leaving Checks: keep the ticks, same as the other tabs do
  const chk = document.getElementById('screen-checks');
  if (chk && chk.classList.contains('active') && state.buildId) {
    supabaseClient.from('weapon_builds').update({ checks: state.checks }).eq('id', state.buildId).then(() => {});
  }
  const b = document.getElementById('ra-card-badge'); if (b) b.textContent = state.cardType;
  const o = document.getElementById('ra-op'); if (o) o.textContent = state.operator;
  _raStartNew();
  show('screen-rearassy');
  loadRearAssyLists();
}

function _raPrefixBadges() {
  [['ra-hrc', 'inp-hrc-serial'], ['ra-fm', 'inp-firing-mech']].forEach(([id, cardId]) => {
    const b = document.getElementById('prefix-' + id), p = _componentPrefix(cardId);
    if (b) { b.textContent = p; b.style.display = p ? 'inline' : 'none'; }
  });
}

function _raStartNew() {
  ra.edit = null; ra.adminPin = null;
  const h = document.getElementById('ra-hrc'), f = document.getElementById('ra-fm');
  if (h) h.value = ''; if (f) f.value = '';
  _raPrefixBadges();
  _raRenderForm();
}

function _raRenderForm() {
  const t = document.getElementById('ra-form-title'), who = document.getElementById('ra-form-who');
  const save = document.getElementById('btn-ra-save'), cancel = document.getElementById('btn-ra-cancel');
  const del = document.getElementById('btn-ra-delete'), box = document.getElementById('ra-form-box');
  const msg = document.getElementById('ra-msg'); if (msg) { msg.textContent = ''; msg.style.display = 'none'; }
  if (!ra.edit) {
    if (t) t.textContent = 'NEW REAR ASSEMBLY';
    if (who) who.innerHTML = `Assembled by <b>OP ${_raEsc(state.operator)}</b> (you) — saved with today's date and time`;
    if (save) save.textContent = '💾 Save Rear Assy';
    if (cancel) cancel.style.display = 'none';
    if (del) del.style.display = 'none';
    if (box) box.classList.remove('ra-admin', 'ra-editing');
    return;
  }
  const r = ra.edit;
  if (t) t.textContent = ra.adminPin ? '🔐 ADMIN CHANGE — REAR ASSEMBLY' : 'CORRECT REAR ASSEMBLY';
  if (who) who.innerHTML = `Assembled by <b>${_raEsc(_raWho(r))}</b> · ${_raEsc(_raWhen(r.assembled_at))}`
    + (r.build_id ? ` · <b>on gun ${_raEsc(r._gun || '?')}</b> — the gun's card is corrected too` : '');
  if (save) save.textContent = ra.adminPin ? '🔐 Save Admin Change' : '💾 Save Correction';
  if (cancel) cancel.style.display = '';
  if (del) del.style.display = r.build_id ? 'none' : '';
  if (box) { box.classList.add('ra-editing'); box.classList.toggle('ra-admin', !!ra.adminPin); }
}

function _raMsg(text, bad) {
  const m = document.getElementById('ra-msg');
  if (!m) return;
  m.style.display = text ? 'block' : 'none';
  m.textContent = text || '';
  m.style.color = bad ? 'var(--fail)' : 'var(--pass)';
}

async function saveRearAssy() {
  const h = document.getElementById('ra-hrc'), f = document.getElementById('ra-fm');
  const hrc = _raStore('inp-hrc-serial', h ? h.value : ''), fm = _raStore('inp-firing-mech', f ? f.value : '');
  if (!hrc || !fm) { _raMsg('Fill in both the HRC Serial No and the Firing Mech No', true); return; }
  if (ra.edit && ra.edit.build_id &&
      !confirm(`This rear assembly is on gun ${ra.edit._gun || '?'}.\n\nChange it to\n  HRC ${hrc}\n  Firing mech ${fm}\n\nand correct that gun's card too?`)) return;
  const btn = document.getElementById('btn-ra-save'), txt = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    const { data, error } = await supabaseClient.rpc('rear_assy_save', {
      p_id: ra.edit ? ra.edit.id : null, p_card_type: state.cardType,
      p_hrc: hrc, p_fm: fm, p_operator: state.operator, p_admin_pin: ra.adminPin || null
    });
    if (error) throw error;
    if (!data || !data.ok) { _raMsg('🚫 ' + ((data && data.msg) || 'Not saved'), true); return; }
    showToast('✅ ' + (data.msg || 'Rear assembly saved') + ` — HRC ${hrc}`, 'ok');
    _raStartNew();
    _raMsg(`✓ Saved — HRC ${hrc} · Firing mech ${fm}`, false);
    loadRearAssyLists();
  } catch (e) {
    console.error('[RearAssy] save', e);
    _raMsg('⚠ Could not save — ' + ((e && e.message) || e), true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = btn.textContent === 'Saving…' ? txt : btn.textContent; }
  }
}

async function deleteRearAssy() {
  const r = ra.edit; if (!r || r.build_id) return;
  if (!confirm(`Delete this rear assembly?\n\nHRC ${r.hrc_serial_no}\nFiring mech ${r.firing_mech_no}\n${_raWho(r)}`)) return;
  try {
    const { data, error } = await supabaseClient.rpc('rear_assy_delete', {
      p_id: r.id, p_operator: state.operator, p_admin_pin: ra.adminPin || null });
    if (error) throw error;
    if (!data || !data.ok) { _raMsg('🚫 ' + ((data && data.msg) || 'Not deleted'), true); return; }
    showToast('🗑 ' + data.msg, 'ok');
    _raStartNew();
    loadRearAssyLists();
  } catch (e) { _raMsg('⚠ Could not delete — ' + ((e && e.message) || e), true); }
}

function _raFind(id) { return ra.free.concat(ra.onGun).find(r => r.id === id) || null; }

function correctRearAssy(id) {
  const r = _raFind(id); if (!r) return;
  if (r.build_id) { showToast(`It is on gun ${r._gun || '?'} — use 🔐 Admin to change it`, 'warn'); return; }
  if (String(r.assembler_number) !== String(state.operator)) {
    showToast(`Only the assembler (OP ${r.assembler_number}) can correct it — or use 🔐 Admin`, 'warn'); return;
  }
  _raLoadIntoForm(r, null);
}

function adminRearAssy(id) {
  const r = _raFind(id); if (!r) return;
  const pin = prompt(`🔐 ADMIN CHANGE — REAR ASSEMBLY\n\nHRC ${r.hrc_serial_no}\nFiring mech ${r.firing_mech_no}\n${_raWho(r)}`
    + (r.build_id ? `\nOn gun ${r._gun || '?'}` : '') + `\n\nEnter the Admin PIN:`);
  if (!pin || !pin.trim()) return;
  _raLoadIntoForm(r, pin.trim());        // the PIN is checked by the database on save
}

function _raLoadIntoForm(r, pin) {
  ra.edit = r; ra.adminPin = pin;
  const h = document.getElementById('ra-hrc'), f = document.getElementById('ra-fm');
  if (h) h.value = _raShow('inp-hrc-serial', r.hrc_serial_no);
  if (f) f.value = _raShow('inp-firing-mech', r.firing_mech_no);
  _raRenderForm();
  const box = document.getElementById('ra-form-box'); if (box && box.scrollIntoView) box.scrollIntoView({ block: 'start' });
}

async function loadRearAssyLists() {
  const freeEl = document.getElementById('ra-free-list'), gunEl = document.getElementById('ra-gun-list');
  if (freeEl) freeEl.innerHTML = '<div class="loading-msg">Loading…</div>';
  try {
    const [fr, gr] = await Promise.all([
      supabaseClient.from('rear_assemblies').select('*').eq('card_type', state.cardType)
        .is('build_id', null).order('assembled_at', { ascending: false }).limit(300),
      supabaseClient.from('rear_assemblies').select('*').eq('card_type', state.cardType)
        .not('build_id', 'is', null).order('linked_at', { ascending: false }).limit(30)
    ]);
    if (fr.error) throw fr.error;
    if (gr.error) throw gr.error;
    ra.free = fr.data || []; ra.onGun = gr.data || [];
    const ids = ra.onGun.map(r => r.build_id);
    if (ids.length) {
      const { data: guns } = await supabaseClient.from('weapon_builds').select('id,launcher_serial,status').in('id', ids);
      (guns || []).forEach(g => ra.onGun.filter(r => r.build_id === g.id).forEach(r => { r._gun = g.launcher_serial; r._gunStatus = g.status; }));
    }
    const row = (r, onGun) => {
      const mine = String(r.assembler_number) === String(state.operator);
      return `<div class="ra-row${onGun ? ' on-gun' : ''}">
        <div class="ra-nums"><span>HRC <b>${_raEsc(r.hrc_serial_no)}</b></span><span>FM <b>${_raEsc(r.firing_mech_no)}</b></span></div>
        <div class="ra-meta">${_raEsc(_raWho(r))} · ${_raEsc(_raWhen(r.assembled_at))}${onGun ? ` · on gun <b>${_raEsc(r._gun || '?')}</b>` : ''}${r.updated_at ? ' · corrected' : ''}</div>
        <div class="ra-acts">
          ${!onGun && mine ? `<button type="button" class="ra-btn" onclick="correctRearAssy('${r.id}')">✎ Correct</button>` : ''}
          <button type="button" class="ra-btn admin" onclick="adminRearAssy('${r.id}')">🔐 Admin change</button>
        </div></div>`;
    };
    const fc = document.getElementById('ra-free-count'); if (fc) fc.textContent = ra.free.length;
    if (freeEl) freeEl.innerHTML = ra.free.length ? ra.free.map(r => row(r, false)).join('')
      : '<div class="loading-msg">None waiting — every rear assembly is on a gun</div>';
    if (gunEl) gunEl.innerHTML = ra.onGun.length ? ra.onGun.map(r => row(r, true)).join('')
      : '<div class="loading-msg">None on a gun yet</div>';
  } catch (e) {
    console.error('[RearAssy] list', e);
    if (freeEl) freeEl.innerHTML = `<div class="loading-msg">⚠ Could not load — ${_raEsc((e && e.message) || e)}</div>`;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// BUILD CARD (identity page) — HRC Serial No from the Rear Assy list
// ═══════════════════════════════════════════════════════════════════════════
const _RA_CARD_FIELDS = ['inp-hrc-serial', 'inp-firing-mech'];

function _raCardLock(locked, r) {
  _RA_CARD_FIELDS.forEach(id => {
    const inp = document.getElementById(id);
    if (inp) { inp.readOnly = !!locked; inp.classList.toggle('ra-locked', !!locked); }
    const thumb = document.getElementById('thumb-' + id), cam = document.getElementById('cam-' + id);
    const tag = document.getElementById('ra-tag-' + id);
    if (thumb) thumb.style.visibility = locked ? 'hidden' : '';
    if (cam) cam.style.display = locked ? 'none' : '';
    if (tag) {
      tag.style.display = locked && r ? 'inline-flex' : 'none';
      tag.innerHTML = locked && r ? `🔩 OP ${_raEsc(r.assembler_number)}` : '';
      tag.title = locked && r ? `Rear assembly by ${_raWho(r)} · ${_raWhen(r.assembled_at)}` : '';
    }
  });
}

function _raCardRender() {
  const pick = document.getElementById('ra-pick'), info = document.getElementById('ra-info');
  if (!pick || !info) return;
  const s = state.rearAssy || { mode: 'off' };
  const signed = String(state.formData.status || '').toUpperCase() === 'COMPLETE';
  pick.style.display = 'none'; pick.innerHTML = ''; info.style.display = 'none'; info.innerHTML = '';
  if (s.mode === 'off') { _raCardLock(false); return; }
  if (s.mode === 'linked' && s.row) {
    _raCardLock(true, s.row);
    info.style.display = 'block';
    info.innerHTML = `🔩 Rear Assy by <b>${_raEsc(_raWho(s.row))}</b> · ${_raEsc(_raWhen(s.row.assembled_at))}`
      + (signed ? '' : ` <button type="button" class="ra-link" onclick="changeCardRearAssy()">↺ Change</button>`);
    return;
  }
  if (s.mode === 'pick') {
    _raCardLock(true, null);
    pick.style.display = 'block';
    const opts = (s.list || []).map(r => `<option value="${r.id}">${_raEsc(r.hrc_serial_no)}  ·  FM ${_raEsc(r.firing_mech_no)}  ·  OP ${_raEsc(r.assembler_number)}</option>`).join('');
    pick.innerHTML = `<select id="sel-rear-assy" onchange="pickCardRearAssy(this.value)">
        <option value="">${s.loading ? 'Loading rear assemblies…' : (s.list || []).length ? `🔩 Pick a Rear Assy (${s.list.length} waiting)…` : '🔩 No rear assemblies waiting'}</option>
        ${opts}
        <option value="__manual">✎ Type the numbers by hand</option>
      </select>`;
    return;
  }
  // manual: the boxes work exactly as before
  _raCardLock(false);
  if (!signed) {
    info.style.display = 'block';
    info.innerHTML = `<button type="button" class="ra-link" onclick="changeCardRearAssy()">🔩 Pick from the Rear Assy list instead</button>`;
  }
}

// called by refreshIdentity (app.js) after the boxes are filled
async function refreshCardRearAssy() {
  if (!rearAssyEnabled() || !document.getElementById('ra-pick')) { state.rearAssy = { mode: 'off' }; _raCardRender(); return; }
  const s = state.rearAssy;
  if (s && s.buildId === (state.buildId || null) && ['linked', 'pick', 'manual'].includes(s.mode)) {
    _raCardRender(); return;                         // keep what the operator chose on this card
  }
  const hasHrc = !!String(state.formData.hrc_serial_no || '').trim();
  if (state.buildId && hasHrc) {
    // linked to a rear assembly? (cards made before v1.32 are not — they stay as they are)
    try {
      const { data } = await supabaseClient.from('rear_assemblies').select('*')
        .eq('build_id', state.buildId).limit(1);
      if (data && data.length) { state.rearAssy = { mode: 'linked', row: data[0], buildId: state.buildId }; _raCardRender(); return; }
    } catch (e) { console.warn('[RearAssy] card link', e); }
    state.rearAssy = { mode: 'manual', buildId: state.buildId };
    _raCardRender(); return;
  }
  if (hasHrc) { state.rearAssy = { mode: 'manual', buildId: state.buildId || null }; _raCardRender(); return; }
  await _raCardLoadPick();
}

async function _raCardLoadPick() {
  state.rearAssy = { mode: 'pick', list: [], loading: true, buildId: state.buildId || null };
  _raCardRender();
  try {
    const { data, error } = await supabaseClient.from('rear_assemblies').select('*')
      .eq('card_type', state.cardType).is('build_id', null)
      .order('assembled_at', { ascending: false }).limit(300);
    if (error) throw error;
    if (state.rearAssy && state.rearAssy.mode === 'pick') { state.rearAssy.list = data || []; state.rearAssy.loading = false; }
  } catch (e) {
    console.warn('[RearAssy] list for card', e);
    if (state.rearAssy && state.rearAssy.mode === 'pick') { state.rearAssy.list = []; state.rearAssy.loading = false; }
    showToast('⚠ Could not load the Rear Assy list — you can type the numbers by hand', 'warn');
  }
  _raCardRender();
}

async function pickCardRearAssy(val) {
  const s = state.rearAssy || {};
  if (!val) return;
  if (val === '__manual') {
    state.rearAssy = { mode: 'manual', buildId: state.buildId || null };
    _raCardRender();
    const inp = document.getElementById('inp-hrc-serial'); if (inp) inp.focus();
    return;
  }
  const r = (s.list || []).find(x => x.id === val); if (!r) return;
  // v1.34 (12/11/2026): nothing is taken until the operator has seen the
  // selection and confirmed it. The list goes back to "Pick…" straight away,
  // so Cancel leaves the card exactly as it was.
  const sel = document.getElementById('sel-rear-assy'); if (sel) sel.value = '';
  if (!(await _raConfirmPick(r))) {
    showToast('Cancelled — no rear assembly taken', 'warn');
    return;
  }
  // still free? (another tablet may have taken it while the box was open)
  try {
    const { data, error } = await supabaseClient.from('rear_assemblies')
      .select('id,build_id').eq('id', r.id).limit(1);
    if (!error && (!data || !data.length || data[0].build_id)) {
      showToast(`🚫 Rear Assy ${r.hrc_serial_no} was just taken by another gun — pick another`, 'error');
      await _raCardLoadPick();
      return;
    }
  } catch (e) { console.warn('[RearAssy] re-check', e); }   // the database link + duplicate gate still apply
  if (state.rearAssy !== s) return;                          // card changed while the box was open
  const h = document.getElementById('inp-hrc-serial'), f = document.getElementById('inp-firing-mech');
  if (h) h.value = _raShow('inp-hrc-serial', r.hrc_serial_no);
  if (f) f.value = _raShow('inp-firing-mech', r.firing_mech_no);
  state.formData.hrc_serial_no = r.hrc_serial_no;
  state.formData.firing_mech_no = r.firing_mech_no;
  state.rearAssy = { mode: 'linked', row: r, buildId: state.buildId || null, picked: true };
  _raCardRender();
  // same checks as typing the numbers (another tablet may have taken it a moment ago)
  if (typeof checkComponentDuplicate === 'function') { if (h) checkComponentDuplicate(h); if (f) checkComponentDuplicate(f); }
  showToast(`🔩 Rear Assy ${r.hrc_serial_no} — by ${_raWho(r)}`, 'ok');
  if (typeof scheduleAutoSave === 'function') scheduleAutoSave(800);
}

// v1.34 (12/11/2026): CONFIRM THE PICK — shows the selected rear assembly
// big and clear; the operator checks it against the parts in his hand.
// Resolves true = Confirm, false = Cancel (or tapping outside the box).
function _raConfirmPick(r) {
  return new Promise(resolve => {
    const old = document.getElementById('ra-confirm'); if (old) old.remove();
    const ov = document.createElement('div');
    ov.id = 'ra-confirm';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(10,22,40,0.62);z-index:200;display:flex;'
      + 'align-items:center;justify-content:center;padding:18px;';
    const serial = state.formData.launcher_serial || '';
    ov.innerHTML = `<div style="background:#fff;border-radius:14px;max-width:440px;width:100%;padding:18px 18px 14px;box-shadow:0 10px 30px rgba(0,0,0,0.35);border-top:6px solid #5d4037;">
        <div style="font-size:12px;font-weight:800;letter-spacing:0.08em;color:#5d4037;">🔩 CONFIRM REAR ASSY FOR THIS GUN</div>
        <div style="font-size:12.5px;color:#6b7e99;margin:4px 0 12px;">Check the numbers against the parts in your hand${serial ? ` — gun <b style="color:#1a2236;">${_raEsc(serial)}</b>` : ''}.</div>
        <div style="background:#f6efec;border:1px solid #d7c7bf;border-radius:10px;padding:10px 12px;margin-bottom:8px;">
          <div style="font-size:10px;font-weight:800;letter-spacing:0.08em;color:#8d6e63;">HRC SERIAL NO</div>
          <div id="ra-confirm-hrc" style="font-family:var(--font-mono,monospace);font-size:22px;font-weight:800;color:#3e2723;">${_raEsc(r.hrc_serial_no)}</div>
        </div>
        <div style="background:#f6efec;border:1px solid #d7c7bf;border-radius:10px;padding:10px 12px;margin-bottom:10px;">
          <div style="font-size:10px;font-weight:800;letter-spacing:0.08em;color:#8d6e63;">FIRING MECH NO</div>
          <div id="ra-confirm-fm" style="font-family:var(--font-mono,monospace);font-size:22px;font-weight:800;color:#3e2723;">${_raEsc(r.firing_mech_no)}</div>
        </div>
        <div style="font-size:12.5px;color:#3e2723;margin-bottom:14px;">Rear Assy by <b>${_raEsc(_raWho(r))}</b> · ${_raEsc(_raWhen(r.assembled_at))}</div>
        <div style="display:flex;gap:10px;">
          <button type="button" id="ra-confirm-no" style="flex:1;padding:13px 6px;border-radius:9px;border:2px solid #d93025;background:#fff;color:#d93025;font-size:14px;font-weight:800;cursor:pointer;">✕ Cancel</button>
          <button type="button" id="ra-confirm-yes" style="flex:1.4;padding:13px 6px;border-radius:9px;border:none;background:linear-gradient(180deg,#20c070 0%,#15a055 100%);color:#fff;font-size:14px;font-weight:800;cursor:pointer;">✓ Confirm — put on this gun</button>
        </div>
      </div>`;
    const done = ok => { ov.remove(); resolve(ok); };
    ov.addEventListener('click', e => { if (e.target === ov) done(false); });
    document.body.appendChild(ov);
    ov.querySelector('#ra-confirm-no').onclick = () => done(false);
    ov.querySelector('#ra-confirm-yes').onclick = () => done(true);
  });
}

async function changeCardRearAssy() {
  if (String(state.formData.status || '').toUpperCase() === 'COMPLETE') {
    showToast('This card is signed off — the rear assembly can no longer be changed here', 'warn'); return;
  }
  const s = state.rearAssy || {};
  if (s.mode === 'linked' && s.row &&
      !confirm(`Take Rear Assy ${s.row.hrc_serial_no} off this card and pick another?\n\n`
             + `It goes back on the Rear Assy list when the card is saved.`)) return;
  const h = document.getElementById('inp-hrc-serial'), f = document.getElementById('inp-firing-mech');
  if (s.mode === 'linked') {
    if (h) h.value = ''; if (f) f.value = '';
    state.formData.hrc_serial_no = null; state.formData.firing_mech_no = null;
    if (typeof _markComponentField === 'function') _RA_CARD_FIELDS.forEach(id => _markComponentField(id, null));
  }
  await _raCardLoadPick();
}

function resetCardRearAssy() { state.rearAssy = null; }
