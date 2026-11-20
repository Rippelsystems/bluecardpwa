// ═══════════════════════════════════════════════════════════════════════════
// v1.42 (20/11/2026) — XRGL40 SIGHT FROM THE APPROVED LIST
// MD / Gerhard 20/11/2026:
//   • The GRN40 sights have their own route (build card + Final Acceptance
//     Checklist RES-QC-16). Once a sight is FINALLY APPROVED (Final Acceptance
//     saved ACCEPT = YES) it becomes available to the XRGL40 build card, the
//     same way a Rear Assy becomes available to the HRC box.
//   • On the XRGL40 card the Sight Serial No is PICKED from that list (search
//     box + list + confirm box) — only sights of the gun's own contract, not
//     yet on another XRGL40.
//   • Typing a sight number by hand needs the Admin PIN.
//   • The gun only goes to FAT once its sight is on the card (and all 19
//     checks are done) — the database view bc_fat_ready does that.
//   • The database checks every sight put on an XRGL40 card (trigger
//     trg_weapon_builds_sight_gate, "SIGHT_GATE: …"), so no tablet or old
//     version can put a sight on that is not approved / of another contract /
//     already on another gun. See xrgl_sight_gate_20Nov.sql.
// Cards that already carry a sight are shown as they are (linked).
// Nothing in the identity save path changes: the card still saves
// sight_serial from the Sight Serial box as before.
// ═══════════════════════════════════════════════════════════════════════════

state.sightPick = state.sightPick || null;   // {mode:'off'|'pick'|'linked', list, filter, loading, buildId, row}

function sightPickEnabled() { return state.cardType === 'XRGL40'; }
function _spEsc(t) { return String(t == null ? '' : t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function _spNorm(v) { return String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, ''); }
function _spContract() {
  const c = document.getElementById('inp-contract');
  return String((c && c.value) || state.formData.contract_name || '').trim();
}
function _spSigned() { return String(state.formData.status || '').toUpperCase() === 'COMPLETE'; }
function _spWhen(ts) {
  if (!ts) return '';
  try { return new Date(ts).toLocaleDateString('en-ZA', { day: '2-digit', month: 'short' }); } catch (e) { return ''; }
}

// the Sight Serial box: read-only while it comes from the list
function _spLock(locked) {
  const inp = document.getElementById('inp-sight-serial');
  if (inp) { inp.readOnly = !!locked; inp.classList.toggle('ra-locked', !!locked); }
  const cam = document.getElementById('cam-inp-sight-serial');
  if (cam) cam.style.display = locked ? 'none' : '';
}

function _spMatches(s) {
  const q = _spNorm(s.filter), list = s.list || [];
  return q ? list.filter(r => _spNorm(r.serial_number).includes(q)) : list;
}
function _spOptions(s) {
  const all = s.list || [], hits = _spMatches(s);
  const head = s.loading ? 'Loading approved sights…'
    : s.noContract ? '🔭 Choose the Contract first'
    : !all.length ? '🔭 No approved sights waiting for this contract'
    : _spNorm(s.filter) ? (hits.length ? `🔭 ${hits.length} of ${all.length} match — pick one…` : `🔭 No match for "${s.filter}" — check the number`)
    : `🔭 Pick a Sight (${all.length} waiting)…`;
  return `<option value="">${_spEsc(head)}</option>`
    + hits.map(r => `<option value="${_spEsc(r.serial_number)}">${_spEsc(r.serial_number)}${r.accepted_by ? `  ·  accepted OP ${_spEsc(r.accepted_by)}` : ''}${r.accepted_at ? ' ' + _spEsc(_spWhen(r.accepted_at)) : ''}</option>`).join('')
    + '<option value="__manual">✎ Type the sight number by hand (Admin PIN)</option>';
}

function _spRender() {
  const pick = document.getElementById('sp-pick'), info = document.getElementById('sp-info');
  if (!pick || !info) return;
  const s = state.sightPick || { mode: 'off' };
  pick.style.display = 'none'; pick.innerHTML = ''; info.style.display = 'none'; info.innerHTML = '';
  if (s.mode === 'off') { _spLock(false); return; }
  if (s.mode === 'linked') {
    _spLock(true);
    info.style.display = 'block';
    info.innerHTML = `🔭 Sight <b>${_spEsc(s.serial || '')}</b>${s.byHand ? ' · typed by hand (Admin)' : ''}`
      + (_spSigned() ? '' : ` <button type="button" class="ra-link" onclick="changeCardSight()">↺ Change</button>`);
    return;
  }
  // pick
  _spLock(true);
  pick.style.display = 'block';
  pick.innerHTML = `<input type="text" id="sp-search" class="ra-search" placeholder="🔎 Search sight no (e.g. 6123)"
        autocomplete="off" autocapitalize="characters" spellcheck="false"
        value="${_spEsc(s.filter || '')}" oninput="_spFilter(this.value)">
    <select id="sel-sight" onchange="pickCardSight(this.value)">${_spOptions(s)}</select>`;
}

function _spFilter(v) {
  const s = state.sightPick;
  if (!s || s.mode !== 'pick') return;
  s.filter = v;
  const sel = document.getElementById('sel-sight');
  if (sel) sel.innerHTML = _spOptions(s);
}

async function _spLoadPick() {
  const keep = (state.sightPick && state.sightPick.mode === 'pick') ? (state.sightPick.filter || '') : '';
  const contract = _spContract();
  state.sightPick = { mode: 'pick', list: [], loading: !!contract, noContract: !contract,
                      buildId: state.buildId || null, filter: keep, contract };
  _spRender();
  if (!contract) return;
  try {
    const { data, error } = await supabaseClient.from('bc_sights_available')
      .select('serial_number,project,accepted_by,accepted_at')
      .eq('project', contract).order('serial_number').limit(2000);
    if (error) throw error;
    if (state.sightPick && state.sightPick.mode === 'pick') { state.sightPick.list = data || []; state.sightPick.loading = false; }
  } catch (e) {
    console.warn('[Sight] list', e);
    if (state.sightPick && state.sightPick.mode === 'pick') { state.sightPick.list = []; state.sightPick.loading = false; }
    showToast('⚠ Could not load the approved sights — try again in a moment', 'warn');
  }
  _spRender();
}

// called after the Identity boxes are filled (app.js refreshIdentity / buildIdentityGrid)
async function refreshCardSight() {
  if (!sightPickEnabled() || !document.getElementById('sp-pick')) { state.sightPick = { mode: 'off' }; _spRender(); return; }
  const inp = document.getElementById('inp-sight-serial');
  const have = String((inp && inp.value) || state.formData.sight_serial || '').trim();
  const s = state.sightPick;
  if (have) {
    const same = s && s.mode === 'linked' && s.buildId === (state.buildId || null) && _spNorm(s.serial) === _spNorm(have);
    state.sightPick = same ? s : { mode: 'linked', serial: have, buildId: state.buildId || null };
    _spRender(); return;
  }
  await _spLoadPick();          // no sight yet: the list is read again every time Identity is shown
}

async function pickCardSight(val) {
  const s = state.sightPick || {};
  if (!val) return;
  const sel = document.getElementById('sel-sight'); if (sel) sel.value = '';
  if (val === '__manual') { await _spTypeByHand(); return; }
  const r = (s.list || []).find(x => x.serial_number === val); if (!r) return;
  if (!(await _spConfirm(r))) { showToast('Cancelled — no sight put on', 'warn'); return; }
  // still free? (another tablet may have taken it while the box was open)
  try {
    const { data, error } = await supabaseClient.from('bc_sights_available')
      .select('serial_number').eq('serial_number', r.serial_number).limit(1);
    if (!error && (!data || !data.length)) {
      showToast(`🚫 Sight ${r.serial_number} was just taken by another gun — pick another`, 'error');
      await _spLoadPick();
      return;
    }
  } catch (e) { console.warn('[Sight] re-check', e); }   // the database gate still applies
  if (state.sightPick !== s) return;                       // card changed while the box was open
  _spPutOn(r.serial_number, false);
  showToast(`🔭 Sight ${r.serial_number} on this gun`, 'ok');
}

function _spPutOn(serial, byHand) {
  const inp = document.getElementById('inp-sight-serial');
  if (inp) inp.value = serial;
  state.formData.sight_serial = serial;
  state.sightPick = { mode: 'linked', serial, byHand: !!byHand, buildId: state.buildId || null, picked: true };
  _spRender();
  if (typeof scheduleAutoSave === 'function') scheduleAutoSave(800);
}

async function _spTypeByHand() {
  if (!state.buildId) {
    showToast('Save the card first (launcher serial confirmed), then add the sight by hand', 'warn'); return;
  }
  const num = (prompt('TYPE THE SIGHT NUMBER BY HAND\n\nSight serial no (e.g. GRN-6123):') || '').trim().toUpperCase();
  if (!num) return;
  const pin = prompt(`ADMIN PIN\n\nPut sight ${num} on this gun without picking it from the approved list?\n\nEnter the Admin PIN:`);
  if (!pin) return;
  try {
    const { data, error } = await supabaseClient.rpc('sight_override_approve', {
      p_build_id: state.buildId, p_sight: num, p_operator: state.operator,
      p_admin_pin: pin.trim(), p_reason: 'Sight typed by hand on the tablet' });
    if (error) throw error;
    if (!data || !data.ok) { showToast('🚫 ' + ((data && data.msg) || 'Not approved'), 'error'); return; }
  } catch (e) {
    showToast('⚠ Could not check the Admin PIN — ' + ((e && e.message) || e), 'error'); return;
  }
  _spPutOn(num, true);
  showToast(`🔓 Sight ${num} typed by hand (Admin) — saving…`, 'ok');
}

async function changeCardSight() {
  if (_spSigned()) { showToast('This card is signed off — the sight can no longer be changed here', 'warn'); return; }
  const s = state.sightPick || {};
  if (!confirm(`Take Sight ${s.serial || ''} off this gun and pick another?\n\n`
             + `It goes back on the approved list when the card is saved, and the gun\n`
             + `leaves FAT / PDI until a sight is on again.`)) return;
  const inp = document.getElementById('inp-sight-serial');
  if (inp) inp.value = '';
  state.formData.sight_serial = null;
  if (typeof scheduleAutoSave === 'function') scheduleAutoSave(800);
  await _spLoadPick();
}

// the database refused the sight ("SIGHT_GATE: …") — readable text, or null
function _sightGateError(err) {
  const m = String((err && (err.message || err.details)) || '');
  const i = m.indexOf('SIGHT_GATE:');
  return i >= 0 ? m.slice(i + 11).trim() : null;
}
// put the box back to what the card holds in the database, then show the list
function _sightRevert() {
  const saved = (state._idBase && state._idBase.sight_serial) || null;
  const inp = document.getElementById('inp-sight-serial');
  if (inp) inp.value = saved || '';
  state.formData.sight_serial = saved;
  state.sightPick = null;
  refreshCardSight();
}

// v1.42: CONFIRM THE PICK — the sight number big and clear, to check against
// the sight in the operator's hand. true = Confirm, false = Cancel.
function _spConfirm(r) {
  return new Promise(resolve => {
    const old = document.getElementById('sp-confirm'); if (old) old.remove();
    const ov = document.createElement('div');
    ov.id = 'sp-confirm';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(10,22,40,0.62);z-index:200;display:flex;'
      + 'align-items:center;justify-content:center;padding:18px;';
    const gun = state.formData.launcher_serial || '';
    ov.innerHTML = `<div style="background:#fff;border-radius:14px;max-width:440px;width:100%;padding:18px 18px 14px;box-shadow:0 10px 30px rgba(0,0,0,0.35);border-top:6px solid #1b5e20;">
        <div style="font-size:12px;font-weight:800;letter-spacing:0.08em;color:#1b5e20;">🔭 CONFIRM SIGHT FOR THIS GUN</div>
        <div style="font-size:12.5px;color:#6b7e99;margin:4px 0 12px;">Check the number against the sight in your hand${gun ? ` — gun <b style="color:#1a2236;">${_spEsc(gun)}</b>` : ''}.</div>
        <div style="background:#eef6ee;border:1px solid #b9d7ba;border-radius:10px;padding:10px 12px;margin-bottom:10px;">
          <div style="font-size:10px;font-weight:800;letter-spacing:0.08em;color:#2e7d32;">SIGHT SERIAL NO</div>
          <div id="sp-confirm-no-txt" style="font-family:var(--font-mono,monospace);font-size:24px;font-weight:800;color:#1b3a1c;">${_spEsc(r.serial_number)}</div>
        </div>
        <div style="font-size:12.5px;color:#1b3a1c;margin-bottom:14px;">Final Acceptance ACCEPTED${r.accepted_by ? ` by <b>OP ${_spEsc(r.accepted_by)}</b>` : ''}${r.accepted_at ? ' · ' + _spEsc(_spWhen(r.accepted_at)) : ''} · ${_spEsc(r.project || '')}</div>
        <div style="display:flex;gap:10px;">
          <button type="button" id="sp-confirm-no" style="flex:1;padding:13px 6px;border-radius:9px;border:2px solid #d93025;background:#fff;color:#d93025;font-size:14px;font-weight:800;cursor:pointer;">✕ Cancel</button>
          <button type="button" id="sp-confirm-yes" style="flex:1.4;padding:13px 6px;border-radius:9px;border:none;background:linear-gradient(180deg,#20c070 0%,#15a055 100%);color:#fff;font-size:14px;font-weight:800;cursor:pointer;">✓ Confirm — put on this gun</button>
        </div>
      </div>`;
    const done = ok => { ov.remove(); resolve(ok); };
    ov.addEventListener('click', e => { if (e.target === ov) done(false); });
    document.body.appendChild(ov);
    ov.querySelector('#sp-confirm-no').onclick = () => done(false);
    ov.querySelector('#sp-confirm-yes').onclick = () => done(true);
  });
}

// the contract was changed on the card: the list is for the new contract
function onSightContractChanged() {
  if (!sightPickEnabled()) return;
  const s = state.sightPick;
  if (!s || s.mode === 'pick' || s.mode === 'off') _spLoadPick();
}
