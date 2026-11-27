// ─── STATE ────────────────────────────────────────────────────────────────────
const state = {
  operator: null,
  cardType: 'RLL',
  checks: {},
  formData: {},
  serialVerified: false,
  buildId: null,
  _dirtyChecks: {},   // v1.35: checks changed on THIS tablet and not yet merged into the card
  _idBase: null       // v1.35: identity values as last read from / saved to the card
};

// ─── BOOT ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initSupabase();
  _bcDropServiceWorker();     // v1.50: see the note below — there is no sw.js now
  show('screen-login');
  _bcWatchStart();            // v1.50: messages from Matrix, and new releases
});

// ═══ NO SERVICE WORKER (v1.50, 24/11/2026) ═══════════════════════════════════
// sw.js came in with the very first commit on 05/08/2026 as part of the
// standard "make it installable" recipe (manifest.json + icons + sw.js + this
// register call). What it did was:
//     caches.match(e.request).then(r => r || fetch(e.request))
// cache-first, for ever, with no version and no clean-up. A tablet that ran it
// would have been frozen on whatever index.html and app.js it cached the first
// time, and NO amount of uploading would ever have changed them.
//
// It never ran. It registered '/sw.js' and cached '/index.html', '/js/app.js' —
// paths for a site at the top of a domain, while the Blue Card lives under
// /bluecardpwa/. So the file was never found, registration failed, and the
// error went into a .catch(). manifest.json was corrected for the subfolder on
// 25/10/2026 (start_url, scope); sw.js was missed in that same fix and has sat
// there as a landmine ever since — correcting its path would have frozen every
// tablet on the floor.
//
// sw.js is deleted from the repo. This clears up after it on any tablet that
// somehow did register one: it unregisters only workers scoped to this app and
// deletes only this app's own caches, so nothing else on
// rippelsystems.github.io is touched.
function _bcDropServiceWorker() {
  try {
    if ('serviceWorker' in navigator && navigator.serviceWorker.getRegistrations) {
      navigator.serviceWorker.getRegistrations().then(rs => {
        (rs || []).forEach(r => {
          const scope = String((r && r.scope) || '');
          if (scope.indexOf('/bluecardpwa/') >= 0) { try { r.unregister(); } catch (e) {} }
        });
      }).catch(() => {});
    }
    if (window.caches && caches.keys) {
      caches.keys().then(names => {
        (names || []).forEach(n => {
          if (/^bluecard/i.test(String(n))) { try { caches.delete(n); } catch (e) {} }
        });
      }).catch(() => {});
    }
  } catch (e) { /* an old browser without any of this — nothing to clear */ }
}

// ═══ MESSAGES FROM MATRIX, AND NOTICING A NEW RELEASE (v1.50, 24/11/2026) ════
// Gerhard 24/11/2026: "is there a way to send a message from Matrix to the
// tablet staff ... like a popup on all the tablets at the same time".
//
// Two things on one timer:
//   1. a message typed on the laptop (BLUE CARD -> BC Tablet Message) comes up
//      FULL SCREEN here until the operator taps OK, and the tap is recorded so
//      the laptop can show who has seen it;
//   2. the tablet compares its own version with the one the database says it
//      should be running, and offers to load a new release itself. Nobody has
//      to be told to log out and in again.
//
// A plain check every BC_WATCH_SECS is used rather than a live socket: tablets
// roam between access points on the floor and a dropped socket silently misses
// messages, while a check that fails simply succeeds on the next round.
// 25/11/2026 — v1.52. THIS MUST MATCH THE FOOTER IN index.html. It is what
// the tablet reports as "what I am running", and _bcCheckRelease compares it
// against tablet_release every minute. Left behind, a tablet that HAS been
// updated goes on showing "New version 1.52 is out — you are on 1.50" for
// ever, because the two never agree.
const BC_APP_VERSION = '1.56';          // keep in step with the index.html footer
const BC_WATCH_SECS  = 25;
let _bcWatchTimer = null;
let _bcMsgShowing  = null;              // the message on screen right now
let _bcWatchMissing = false;            // the message SQL is not on this database
let _bcUpdateShown  = false;            // the update bar is already up
// v1.56 (27/11/2026): "Later" used to silence the bar until the page was
// reloaded. It now hides it for 10 minutes for THAT version only; a newer
// version shows at once.
let _bcLaterUntil = 0, _bcLaterVersion = '';
const BC_LATER_MINS = 10;

function _bcDeviceName() {              // a steady name for this tablet
  try {
    let d = localStorage.getItem('bcDeviceName');
    if (!d) {
      d = 'TAB-' + Math.random().toString(36).slice(2, 6).toUpperCase();
      localStorage.setItem('bcDeviceName', d);
    }
    return d;
  } catch (e) { return 'TAB-?'; }
}

function _bcWatchStart() {
  if (_bcWatchTimer) return;
  _bcWatchTick();
  _bcWatchTimer = setInterval(_bcWatchTick, BC_WATCH_SECS * 1000);
}

async function _bcWatchTick() {
  if (_bcWatchMissing || typeof supabaseClient === 'undefined' || !supabaseClient) return;
  await _bcCheckRelease();
  await _bcCheckMessages();
}

// ── a new release ───────────────────────────────────────────────────────────
async function _bcCheckRelease() {
  if (_bcUpdateShown) return;
  try {
    const { data, error } = await supabaseClient.rpc('bc_release_version',
      { p_page: 'index.html' });
    if (error) { if (_isMissingFn(error)) _bcWatchMissing = true; return; }
    if (!data || !data.ok || !data.version) return;
    if (String(data.version) === String(BC_APP_VERSION)) return;
    if (String(data.version) === _bcLaterVersion && Date.now() < _bcLaterUntil) return;
    _bcUpdateShown = true;
    _bcShowUpdateBar(String(data.version), data.note || '');
  } catch (e) { /* next round */ }
}

function _bcShowUpdateBar(version, note) {
  if (document.getElementById('bc-update-bar')) return;
  const bar = document.createElement('div');
  bar.id = 'bc-update-bar';
  bar.setAttribute('style',
    'position:fixed;left:0;right:0;bottom:0;z-index:9998;background:#0D47A1;color:#fff;' +
    'padding:14px 18px;display:flex;align-items:center;gap:14px;font-size:17px;' +
    'font-weight:700;box-shadow:0 -3px 14px rgba(0,0,0,.3)');
  const words = document.createElement('div');
  words.setAttribute('style', 'flex:1;min-width:0');
  words.textContent = '⬆ New version ' + version + ' is out'
                      + (note ? ' — ' + note : '') + '. You are on ' + BC_APP_VERSION + '.';
  const go = document.createElement('button');
  go.textContent = 'Load it now';
  go.setAttribute('style',
    'flex:0 0 auto;border:none;border-radius:10px;padding:14px 20px;font-size:17px;' +
    'font-weight:800;background:#FFFFFF;color:#0D47A1');
  go.onclick = () => { try { location.reload(true); } catch (e) { location.reload(); } };
  const later = document.createElement('button');
  later.textContent = 'Later';
  later.setAttribute('style',
    'flex:0 0 auto;border:none;border-radius:10px;padding:14px 16px;font-size:15px;' +
    'font-weight:700;background:rgba(255,255,255,.18);color:#fff');
  later.onclick = () => {
    bar.remove();
    _bcLaterVersion = String(version);
    _bcLaterUntil = Date.now() + BC_LATER_MINS * 60000;
    _bcUpdateShown = false;               // let the check run again
  };
  bar.appendChild(words); bar.appendChild(go); bar.appendChild(later);
  document.body.appendChild(bar);
}

// ── a message from the laptop ───────────────────────────────────────────────
async function _bcCheckMessages() {
  if (_bcMsgShowing || !state.operator) return;     // nobody logged in = nobody to record
  try {
    const { data, error } = await supabaseClient.rpc('bc_messages_for',
      { p_card_type: state.cardType || null, p_operator: state.operator });
    if (error) { if (_isMissingFn(error)) _bcWatchMissing = true; return; }
    const list = Array.isArray(data) ? data : [];
    if (!list.length) return;
    _bcShowMessage(list[0]);                        // one at a time, oldest first
  } catch (e) { /* next round */ }
}

function _bcShowMessage(msg) {
  if (_bcMsgShowing) return;
  _bcMsgShowing = msg;
  const info = String(msg.level || 'IMPORTANT').toUpperCase() === 'INFO';
  const wrap = document.createElement('div');
  wrap.id = 'bc-msg-overlay';
  wrap.setAttribute('style',
    'position:fixed;inset:0;z-index:9999;background:rgba(10,22,40,.92);display:flex;' +
    'align-items:center;justify-content:center;padding:24px');
  const card = document.createElement('div');
  card.setAttribute('style',
    'background:#FFFFFF;border-radius:18px;max-width:640px;width:100%;max-height:90vh;' +
    'overflow:auto;box-shadow:0 10px 40px rgba(0,0,0,.45)');
  const head = document.createElement('div');
  head.setAttribute('style',
    'background:' + (info ? '#1565C0' : '#B71C1C') + ';color:#fff;padding:18px 22px;' +
    'border-radius:18px 18px 0 0;font-size:22px;font-weight:800');
  head.textContent = (info ? 'ℹ ' : '⚠ ') + (msg.title || 'Message');
  const body = document.createElement('div');
  body.setAttribute('style',
    'padding:22px;font-size:19px;line-height:1.5;color:#1A2333;white-space:pre-wrap');
  body.textContent = msg.body || '';
  const from = document.createElement('div');
  from.setAttribute('style', 'padding:0 22px 6px;font-size:14px;color:#6B7688');
  from.textContent = 'From ' + (msg.sent_by || 'the office')
                     + (msg.sent_at ? ' · ' + new Date(msg.sent_at).toLocaleString('en-ZA',
                         { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
  const foot = document.createElement('div');
  foot.setAttribute('style', 'padding:14px 22px 22px');
  const ok = document.createElement('button');
  ok.id = 'bc-msg-ok';
  ok.textContent = 'OK — I have read this';
  ok.setAttribute('style',
    'width:100%;border:none;border-radius:12px;padding:18px;font-size:19px;' +
    'font-weight:800;background:#1B5E20;color:#fff');
  ok.onclick = () => _bcAckMessage(msg.id);
  foot.appendChild(ok);
  card.appendChild(head); card.appendChild(body); card.appendChild(from); card.appendChild(foot);
  wrap.appendChild(card);
  document.body.appendChild(wrap);
}

async function _bcAckMessage(id) {
  const btn = document.getElementById('bc-msg-ok');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    await supabaseClient.rpc('bc_message_ack',
      { p_id: id, p_operator: state.operator, p_device: _bcDeviceName() });
  } catch (e) {
    // the floor is never held up by a failed acknowledgement — it will be
    // offered again on the next round and recorded then
    console.warn('[Message] ack failed', e);
  }
  const ov = document.getElementById('bc-msg-overlay');
  if (ov) ov.remove();
  _bcMsgShowing = null;
}

// ─── ROUTING ──────────────────────────────────────────────────────────────────
function show(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(screenId);
  if (el) { el.classList.add('active'); window.scrollTo(0,0); }
  document.querySelectorAll('.nav-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.screen === screenId &&
      (!t.dataset.stage || (typeof fatpdi !== 'undefined' && t.dataset.stage === fatpdi.stage))));
  const nav = document.getElementById('bottom-nav');
  // v1.22: FAT / PDI live on the bar now, so the bar stays while they are open
  const hideNav = ['screen-login','screen-complete'].includes(screenId);
  if (nav) nav.classList.toggle('hidden', hideNav);
  const swBtn = document.getElementById('switch-op-btn');
  if (swBtn) swBtn.style.display = hideNav ? 'none' : 'block';
  // v1.25 (31/10/2026): for GRN40 the FAT stage is the RES-QC-16 Final
  // Acceptance Checklist, so the bar tab says so (it is not the build card).
  const fatLbl = document.getElementById('nav-fat-label');
  if (fatLbl) fatLbl.textContent = (state.cardType === 'GRN40') ? 'Acceptance' : 'FAT';
  // v1.32 (12/11/2026): Rear Assy tab — RLL and XRGL40 only
  if (typeof refreshRearAssyTab === 'function') refreshRearAssyTab();
}

function showSection(id) {
  // v1.31 (11/11/2026): sign-off is done on the PDI page (final check) only
  if (id === 'signoff') {
    showToast('🖊 Sign-off is now done on the PDI page, once identity, checks, FAT and PDI are complete', 'warn');
    return;
  }
  // v1.29: Identity opened from the bar with no card open = a new card —
  // seed it exactly as Start New Card does (operator, card type, start time)
  if (id==='identity' && !state.buildId && !state.formData.operator_number) {
    state.formData = { ...state.formData, operator_number: state.operator, card_type: state.cardType,
                       status: 'IN PROGRESS', session_start: state.formData.session_start || new Date().toISOString() };
  }
  if (id==='identity') refreshIdentity();
  if (id==='checks')   { refreshChecks(); _pullChecks(); }   // v1.35: show everybody's ticks
  if (id==='signoff')  refreshSignoff();
  const map = { identity:'screen-identity', checks:'screen-checks', signoff:'screen-signoff' };
  if (!map[id]) return;
  // Auto-save checks whenever leaving checks tab
  if (document.getElementById('screen-checks') && document.getElementById('screen-checks').classList.contains('active')) {
    // v1.35: only what this tablet changed is sent — never the whole card
    if (state.buildId) _flushChecks();
  }
  // Block move to signoff if required check values are missing
  if (id === 'signoff') {
    const cfg = getCardConfig();
    const items = cfg.checks || cfg.stages || [];
    const missing = [];
    items.forEach(chk => {
      const saved = state.checks[chk.id] || {};
      // Must have a result
      if (!saved.result) { missing.push(chk.label); return; }
      // Measurement checks must also have a value
      if ((chk.type === 'measurement') && saved.result && !saved.value) {
        missing.push(chk.label + ' (value required)');
      }
      // Note: GRN40 stages used to require a separately-typed tech_no here.
      // That field is gone — the operator (assy_no) now auto-stamps on every
      // Pass/Fail/N-A tap, same as RLL/XRGL40 checks, so "must have a result"
      // above already covers it.
    });
    // Block if no contract selected — contract is the serial-linking key
    if (!state.formData.contract_name) {
      showToast('⚠ Select a Contract before proceeding to sign-off', 'error');
      const sel = document.getElementById('inp-contract');
      if (sel) sel.style.border = '2px solid var(--fail)';
      show('screen-identity');
      return;
    }
    // Block if no country selected — required for customs/export documentation
    if (!state.formData.client_country) {
      showToast('⚠ Select a Country before proceeding to sign-off', 'error');
      const sel = document.getElementById('inp-country');
      if (sel) sel.style.border = '2px solid var(--fail)';
      show('screen-identity');
      return;
    }
    // Block while any check is FAIL / NO-GO — the unit must be reworked and
    // each failed check re-marked PASS (with its rework note) first.
    const fails = openFails();
    if (fails.length > 0) {
      showToast(`🚫 ${fails.length} FAILED check(s) must be fixed and passed before sign-off: `
                + fails.slice(0,3).map(c=>c.label).join(', ') + (fails.length>3?' + more':''), 'error');
      fails.forEach(c => { const row = document.getElementById('chk-row-' + c.id);
        if (row) { row.style.border='2px solid var(--fail)'; row.style.borderRadius='6px'; } });
      show('screen-checks');
      return;
    }
    if (missing.length > 0) {
      showToast('⚠ Complete all checks before sign-off: ' + missing.slice(0,3).join(', ') + (missing.length>3?' + more':''), 'error');
      // Highlight incomplete rows
      items.forEach(chk => {
        const row = document.getElementById('chk-row-' + chk.id);
        const saved = state.checks[chk.id] || {};
        if (!saved.result || (chk.type==='measurement' && !saved.value)) {
          if (row) { row.style.border='2px solid var(--fail)'; row.style.borderRadius='6px'; }
        } else {
          if (row) { row.style.border=''; }
        }
      });
      return;
    }
  }
  show(map[id]);
}

// ─── CARD TYPE HELPERS ────────────────────────────────────────────────────────
function getCardConfig() { return CARD_TYPES[state.cardType] || CARD_TYPES.RLL; }

function updateCardBadges() {
  const cfg = getCardConfig();
  ['resume-card-badge','id-card-badge','checks-card-badge','signoff-card-badge'].forEach(id => {
    const el = document.getElementById(id); if (el) el.textContent = state.cardType;
  });
  const title = document.getElementById('card-main-title');
  if (title) title.textContent = `${cfg.label} BUILD HISTORY CARD`;
  const idTitle = document.getElementById('id-title');
  if (idTitle) idTitle.textContent = 'Build History Card';
  // Doc ref
  ['doc-no','so-doc-no'].forEach(id=>{const el=document.getElementById(id);if(el)el.textContent=cfg.docNo;});
  ['doc-rev','so-doc-rev'].forEach(id=>{const el=document.getElementById(id);if(el)el.textContent=cfg.rev;});
  ['doc-date','so-doc-date'].forEach(id=>{const el=document.getElementById(id);if(el)el.textContent=cfg.revDate;});
  // Checks heading
  const ch = document.getElementById('checks-heading');
  if (ch) ch.textContent = state.cardType==='GRN40' ? 'Sub-Assembly Stages' : 'Inspection Points';
}

// ─── SWITCH OPERATOR ──────────────────────────────────────────────────────────
function showSwitchOperator() {
  const newOp = prompt(`Current: OP ${state.operator}\n\nEnter new operator number:`);
  if (!newOp||!newOp.trim()) return;
  const prev = state.operator;
  state.operator = newOp.trim();
  ['id-op','resume-op'].forEach(id=>{const el=document.getElementById(id);if(el)el.textContent=state.operator;});
  const sl=document.getElementById('switch-op-label');if(sl)sl.textContent=`OP ${state.operator}`;
  showToast(`Switched to Operator ${state.operator}`,'ok');
  logActivity('OPERATOR_SWITCH',{from:prev,to:state.operator},null);
}

// ─── LOGIN ─────────────────────────────────────────────────────────────────────
async function handleLogin() {
  const op  = document.getElementById('inp-operator').value.trim();
  const pin = document.getElementById('inp-operator-pin')?.value.trim();
  const ct  = document.getElementById('inp-card-type').value;
  const btn = document.getElementById('btn-login');
  const errEl = document.getElementById('login-error');

  if (errEl) errEl.style.display = 'none';

  if (!op)  { showToast('Enter your operator number','error'); return; }
  if (!pin) { showToast('Enter your PIN','error'); return; }

  if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }

  // ── Verify via a server-side function — the tablet never sees any PIN,
  // only a true/false answer back. This means the PIN values themselves
  // are never exposed through the browser, even to someone inspecting
  // network traffic or using dev tools.
  let verified = false;
  try {
    const {data, error} = await supabaseClient.rpc('verify_operator_pin', {
      p_operator_number: op,
      p_pin: pin
    });
    if (error) throw error;
    verified = data === true;
  } catch(e) {
    console.error('[Login] PIN verification failed:', e);
    if (btn) { btn.disabled = false; btn.textContent = 'Start Session'; }
    showToast('Could not verify PIN — check connection and try again', 'error');
    return;
  }

  if (btn) { btn.disabled = false; btn.textContent = 'Start Session'; }

  if (!verified) {
    // Deliberately vague — don't reveal whether the operator number or
    // the PIN was wrong, same principle as any login screen.
    if (errEl) { errEl.style.display = 'block'; errEl.textContent = '❌ Incorrect operator number or PIN'; }
    showToast('❌ Incorrect operator number or PIN', 'error');
    const pinInput = document.getElementById('inp-operator-pin');
    if (pinInput) { pinInput.value = ''; pinInput.focus(); }
    return;
  }

  // ── PIN verified — proceed exactly as before ──────────────────────────
  state.operator = op;
  state.cardType = ct;
  const resumeOp=document.getElementById('resume-op'); if(resumeOp) resumeOp.textContent=op;
  const sl=document.getElementById('switch-op-label'); if(sl) sl.textContent=`OP ${op}`;
  const rb=document.getElementById('resume-card-badge'); if(rb) rb.textContent=ct;
  show('screen-resume');
  loadResumeScreen();
}

// ─── RESUME ───────────────────────────────────────────────────────────────────
async function loadResumeScreen() {
  _resumeForCardType();   // v1.43
  const tSel=document.getElementById('inp-find-trolley');
  const pSel=document.getElementById('inp-find-pos');
  if (tSel) { tSel.innerHTML='<option value="">Trolley…</option>'; for(let i=1;i<=20;i++) tSel.innerHTML+=`<option value="${i}">Trolley ${i}</option>`; }
  if (pSel) { pSel.innerHTML='<option value="">Pos…</option>'; for(let i=1;i<=56;i++) pSel.innerHTML+=`<option value="${i}">Pos ${i}</option>`; }
  const listEl=document.getElementById('my-cards-list');
  listEl.innerHTML='<div class="loading-msg">Loading…</div>';
  try {
    // Show ALL incomplete cards, not just the current operator's own —
    // a shared factory-floor tool must not hide other operators' in-progress
    // work, or someone can end up starting a duplicate for the same
    // trolley/position without ever knowing a card already exists.
    // v1.26 (31/10/2026): ... but only cards of the card type the operator is
    // logged in with. A duplicate can only ever be of the same type, and the
    // newest-20 limit was letting a busy RLL run push GRN40 cards off the list.
    let q=supabaseClient.from('weapon_builds')
      .select('id,launcher_serial,sight_serial,trolley_number,trolley_position,client_country,contract_name,created_at,status,card_type,checks,operator_number')
      .neq('status','COMPLETE');
    if (state.cardType) q=q.eq('card_type',state.cardType);
    // v1.55 (26/11/2026, Gerhard): SHOW THEM ALL. The list stopped at the
    // newest 20, so on a trolley of 56 the floor had to find every card after
    // that one by one with Find by Trolley / Position. Now every incomplete
    // card of this type is listed, in trolley and position order, so the next
    // position is simply the next card. Picking a trolley in the Trolley box
    // below narrows the list to that trolley.
    const {data}=await q.order('created_at',{ascending:false}).limit(1000);
    _resumeRows=(data||[]).slice().sort(_resumeOrder);
    // the trolley he was working on stays picked when he comes back from a card
    if (tSel) {
      if (_resumeTrolley && _resumeRows.some(r=>String(r.trolley_number)===_resumeTrolley)) tSel.value=_resumeTrolley;
      else _resumeTrolley='';
      tSel.onchange=()=>{ _resumeTrolley=String(tSel.value||''); _resumeDraw(); };
    }
    _resumeDraw(true);
  } catch(e) { listEl.innerHTML='<div class="loading-msg">Could not load cards</div>'; }
}
let _resumeRows=[], _resumeTrolley='', _resumeLast='';   // _resumeLast = the card opened last, shown outlined
function _resumeOrder(a,b){
  const ta=parseInt(a.trolley_number,10), tb=parseInt(b.trolley_number,10);
  const pa=parseInt(a.trolley_position,10), pb=parseInt(b.trolley_position,10);
  const na=isNaN(ta), nb=isNaN(tb);
  if (na!==nb) return na?1:-1;                       // cards with no trolley yet go last
  if (!na && ta!==tb) return ta-tb;
  const npa=isNaN(pa), npb=isNaN(pb);
  if (npa!==npb) return npa?1:-1;
  if (!npa && pa!==pb) return pa-pb;
  return String(b.created_at||'').localeCompare(String(a.created_at||''));   // newest first
}
function _resumeOpen(id){ _resumeLast=String(id); loadBuild(id); }
function _resumeDraw(scrollToLast){
  const listEl=document.getElementById('my-cards-list'); if (!listEl) return;
  const tSel=document.getElementById('inp-find-trolley');
  const t=tSel?String(tSel.value||''):'';
  const data=t?_resumeRows.filter(r=>String(r.trolley_number)===t):_resumeRows;
  {
    if (!data||data.length===0) {
      listEl.innerHTML=t
        ? `<div class="loading-msg">No incomplete ${state.cardType||''} cards on Trolley ${t}</div>`
        : `<div class="loading-msg">No incomplete ${state.cardType||''} cards — start a new one with the button above</div>`;
    } else {
      listEl.innerHTML=`<div style="font-size:12px;font-weight:700;color:var(--text-dim);margin:0 0 8px 2px;">${data.length} incomplete card${data.length===1?'':'s'}${t?' on Trolley '+t:' — all trolleys, in trolley and position order'}</div>`+data.map(r=>{
        const st=(r.status||'IN PROGRESS').toUpperCase();
        const stColour=st==='COMPLETE'?'#1a9e5c':'#e08f1a';
        const stLabel=st==='COMPLETE'?'✓ COMPLETE':'⏳ IN PROGRESS';
        // Count checks completed
        const checks=r.checks||{};
        const done=Object.values(checks).filter(v=>v&&v.result).length;
        const fails=Object.values(checks).filter(v=>v&&(v.result==='FAIL'||v.result==='NO-GO')).length;
        const checksLabel=done>0?`${done} checks done${fails>0?' · '+fails+' FAIL':''}`:' No checks yet';
        return `
        <div class="resume-card" ${String(r.id)===_resumeLast?'id="resume-last" style="outline:3px solid var(--accent);outline-offset:1px;"':''} onclick="_resumeOpen('${r.id}')">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
            <span style="background:var(--accent);color:#fff;font-size:10px;font-weight:700;padding:2px 7px;border-radius:4px;">${r.card_type||'RLL'}</span>
            <span style="font-family:var(--font-mono);font-size:14px;font-weight:700;color:var(--accent);">${_rowIdentifierSerial(r)||'No serial yet'}</span>
            <span style="margin-left:auto;font-size:10px;font-weight:700;color:${stColour};background:${stColour}18;padding:2px 8px;border-radius:4px;border:1px solid ${stColour}44;">${stLabel}</span>
          </div>
          <div style="font-size:11px;color:var(--text-dim);margin-bottom:2px;">
            Trolley ${r.trolley_number||'—'} · Pos ${r.trolley_position||'—'} · ${r.contract_name||r.client_country||'—'} · ${formatDate(new Date(r.created_at))}
            ${r.operator_number && r.operator_number !== state.operator ? ` · <span style="color:var(--accent);font-weight:600;">Started by OP ${r.operator_number}</span>` : ''}
          </div>
          <div style="font-size:11px;color:${fails>0?'#e05050':'var(--text-dim)'};">${checksLabel}</div>
        </div>`;}).join('');
      if (scrollToLast===true) {
        const last=document.getElementById('resume-last');
        if (last && last.scrollIntoView) { try { last.scrollIntoView({block:'center'}); } catch(e) {} }
      }
    }
  }
}

async function findBySerial() {
  let serial=document.getElementById('inp-find-serial').value.trim().toUpperCase();
  // v1.43: "6403" finds GRN-6403.  v1.45: "2499" / "X26-2499" finds X26 2499
  if (state.cardType==='GRN40' || state.cardType==='XRGL40')
    serial = normaliseSerial(serial, state.cardType);
  if (!serial || serial==='GRN-' || serial==='X26'){showToast('Enter a serial number','error');return;}
  let {data}=await supabaseClient.from('weapon_builds').select('id,card_type').eq('launcher_serial',serial).neq('status','COMPLETE').limit(1);
  // GRN40 cards are identified by sight_serial (no launcher_serial at all)
  if (!data||data.length===0) {
    ({data}=await supabaseClient.from('weapon_builds').select('id,card_type')
      .eq('sight_serial',serial).eq('card_type','GRN40').neq('status','COMPLETE').limit(1));
  }
  if (data&&data.length>0) loadBuild(data[0].id);
  else showToast('No incomplete card found','warn');
}

async function findByTrolley() {
  const t=document.getElementById('inp-find-trolley').value;
  const p=document.getElementById('inp-find-pos').value;
  if (!t||!p){showToast('Select trolley and position','error');return;}
  // Cast to integer for Supabase integer column
  const {data}=await supabaseClient.from('weapon_builds')
    .select('id,card_type')
    .eq('trolley_number', parseInt(t))
    .eq('trolley_position', parseInt(p))
    .neq('status','COMPLETE')
    .limit(1);
  if (data&&data.length>0) loadBuild(data[0].id);
  else showToast(`No incomplete card at Trolley ${t} / Pos ${p}`, 'warn');
}

async function loadBuild(id) {
  showToast('Loading…','ok');
  const {data}=await supabaseClient.from('weapon_builds').select('*').eq('id',id).limit(1);
  if (!data||data.length===0){showToast('Could not load','error');return;}
  const row=data[0];
  state.buildId=row.id;
  if (typeof resetCardRearAssy === 'function') resetCardRearAssy();   // v1.32
  state.sightPick = null;                                              // v1.42
  // formData must NEVER carry a copy of checks: identity auto-save spreads
  // formData into the update, so a stale checks snapshot taken here would
  // overwrite every tick made since (the "ticks wiped" bug).
  state.formData={...row}; delete state.formData.checks;
  // v1.45: a card with no card_type recorded used to throw the operator back
  // to RLL in the middle of an XRGL40 run — keep the type being worked in.
  state.cardType=row.card_type||state.cardType||'RLL';
  _rememberStoredComponents(row);   // v1.28: a number this card ALREADY holds never blocks its saves
  // A saved row's identifying serial was already validated when it was
  // first confirmed — GRN40 = sight_serial, RLL/XRGL40 = launcher_serial.
  state.checks=row.checks||{}; state.serialVerified=!!_rowIdentifierSerial(row);
  state._dirtyChecks={}; state._idBase={...state.formData};   // v1.35
  _trolleyApprovedFor = null;   // v1.37: an Admin approval to move a gun is for that card only
  updateCardBadges();
  buildIdentityGrid();
  _injectAutoSaveIndicator();
  refreshIdentity();
  show('screen-identity');
  populateTrolley(); populateYear(); loadCountries(); loadContracts();
  loadActivityLog(_rowIdentifierSerial(row)); initOCR();
}

function startNewCard() {
  state.buildId=null; state._storedComponents={}; state._dupComponents={};
  if (typeof resetCardRearAssy === 'function') resetCardRearAssy();   // v1.32
  state.sightPick = null;                                              // v1.42
  state.formData={operator_number:state.operator,card_type:state.cardType,status:'IN PROGRESS',session_start:new Date().toISOString()};
  state.checks={}; state.serialVerified=false;
  state._dirtyChecks={}; state._idBase=null;   // v1.35
  updateCardBadges();
  buildIdentityGrid();
  _injectAutoSaveIndicator();
  show('screen-identity');
  populateTrolley(); populateYear(); loadCountries(); loadContracts(); initOCR();
}

function goToResume() {
  state.buildId=null; state.formData={}; state.checks={}; state.serialVerified=false; state._storedComponents={}; state._dupComponents={};
  state._dirtyChecks={}; state._idBase=null;   // v1.35
  if (typeof resetCardRearAssy === 'function') resetCardRearAssy();   // v1.32
  state.sightPick = null;                                              // v1.42
  show('screen-resume'); loadResumeScreen();
}

// Lets an operator back out of a card they don't want to continue —
// whether or not anything was saved yet. If it was only ever local state
// (no serial confirmed, nothing autosaved), this is a plain reset. If it
// was already autosaved to weapon_builds (a serial was confirmed), this
// also deletes that row and frees the serial back to UNBUILT, logging the
// cancellation first so it's traceable in the audit trail.
async function cancelBuildCard() {
  // 21/10/2026 (v1.20): a reason is compulsory and goes into the audit trail.
  // Nothing is deleted until a reason has been given.
  const serialNow = _unitIdentifierSerial();
  const done = Object.values(state.checks || {}).filter(v => v && v.result).length;
  const reasonRaw = prompt(
    `CANCEL / DISCARD THIS CARD\n\n` +
    `Serial: ${serialNow || '(no serial yet)'}\n` +
    `Checks marked: ${done}\n` +
    `Operator: OP ${state.operator}\n\n` +
    `Why is this card being cancelled? (required)\n` +
    `e.g. wrong serial, started twice, wrong card type`);
  if (reasonRaw === null) return;                 // operator backed out
  const reason = reasonRaw.trim();
  if (!reason) {
    showToast('A reason is required to cancel a card', 'error');
    return;
  }
  if (!confirm(`Cancel card ${serialNow || ''}?\n\nReason: ${reason}\n\n` +
               `Any saved data for this card will be permanently deleted. This cannot be undone.`)) {
    return;
  }

  if (!state.buildId) {
    // Nothing was ever saved to Supabase — pure local reset (still logged if
    // a serial had been confirmed, so the attempt is on the trail).
    if (serialNow) {
      await logActivity('BUILD_CANCELLED', {
        cancelled_by: state.operator, reason, checks_marked: done, saved_card: false
      }, null);
    }
    showToast('Card discarded', 'ok');
    goToResume();
    return;
  }

  try {
    const unitSerial = serialNow;
    if (unitSerial) {
      await logActivity('BUILD_CANCELLED', {
        cancelled_by: state.operator, reason, checks_marked: done,
        trolley: state.formData.trolley_number || null,
        position: state.formData.trolley_position || null
      }, null);
    }
    await supabaseClient.from('weapon_builds').delete().eq('id', state.buildId);
    if (unitSerial) {
      await supabaseClient.from('weapon_serials')
        .update({ status: 'UNBUILT', checks_done: 0, pct_complete: 0 })
        .eq('serial_number', unitSerial);
    }
    showToast('✅ Card cancelled and deleted', 'ok');
  } catch (e) {
    console.error('[CancelBuild]', e);
    showToast('⚠ Could not fully clean up — tell your admin to check this serial', 'warn');
  }
  goToResume();
}

function endSession() {
  _releasePlace();                   // v1.49: never leave a place held
  state.operator=null; state.buildId=null; state.formData={}; state.checks={}; state._dirtyChecks={}; state._idBase=null;
  show('screen-login');
}

function changeCardType() {
  _releasePlace();                   // v1.49: never leave a place held
  // Go back to login screen to pick a different card type or operator
  state.operator=null; state.buildId=null; state.formData={}; state.checks={}; state._dirtyChecks={}; state._idBase=null;
  state.serialVerified=false;
  show('screen-login');
}

// v1.43 (20/11/2026): switch card type from the Home screen — same operator,
// no End Session / log in again. Only from Home, where no card is open.
function switchCardType(ct) {
  if (!state.operator) { show('screen-login'); return; }
  if (!ct || ct === state.cardType || !CARD_TYPES[ct]) return;
  // a FAT / PDI gun still open from before is let go (others see it is free)
  if (typeof fatpdi !== 'undefined' && fatpdi.focus && fatpdi._focusStage && typeof _fpRelease === 'function') {
    _fpRelease(fatpdi.focus, fatpdi._focusStage, fatpdi._focusType);
    fatpdi.focus = null; fatpdi.focusSnap = null; fatpdi._focusStage = null; fatpdi._focusType = null;
  }
  state.cardType = ct;
  const sel = document.getElementById('inp-card-type'); if (sel) sel.value = ct;   // next login starts on it
  const fs = document.getElementById('inp-find-serial'); if (fs) fs.value = '';
  updateCardBadges();
  goToResume();   // clears any card state and reloads Home for the new type
  showToast(`Card type: ${ct}`, 'ok');
}

// v1.43: Home screen labels / sections for the card type logged in with
function _resumeForCardType() {
  const ct = state.cardType || 'RLL';
  const grn = ct === 'GRN40';
  const rb = document.getElementById('resume-card-badge'); if (rb) rb.textContent = ct;
  const h = document.getElementById('resume-find-serial-head');
  if (h) h.textContent = grn ? 'Find by Sight Serial' : 'Find by Launcher Serial';
  const fs = document.getElementById('inp-find-serial');
  if (fs) fs.placeholder = grn ? 'e.g. GRN-6403 or 6403'
                              : (ct === 'XRGL40' ? 'e.g. X26 2499 or 2499' : 'e.g. RLL 26004');
  // a sight is not on a trolley — no Find by Trolley on GRN40
  const tr = document.getElementById('resume-find-trolley');
  if (tr) tr.style.display = grn ? 'none' : '';
  document.querySelectorAll('#resume-switch-type button[data-ct]').forEach(b => {
    const on = b.dataset.ct === ct;
    b.disabled = on;
    b.classList.toggle('on', on);
  });
}

// ─── IDENTITY GRID (dynamic per card type) ────────────────────────────────────
function buildIdentityGrid() {
  const grid = document.getElementById('identity-fields-grid');
  if (!grid) return;
  const cfg = getCardConfig();

  if (state.cardType === 'GRN40') {
    grid.innerHTML = `
      <div class="card-cell span2">
        <label class="yellow">Sight Serial No ★</label>
        <div class="serial-row">
          <input type="text" id="inp-sight-serial" placeholder="GRN-…  tap 📷 or type the number" autocapitalize="characters" spellcheck="false"
                 onfocus="_grnPrefixFocus(this)" onblur="_grnPrefixBlur(this)" onchange="resetSightConfirm()">
          <img class="serial-thumb" id="thumb-inp-sight-serial">
          <button class="cam-btn" onclick="captureSerial('inp-sight-serial','photo_sight', true)">📷</button>
          <button class="cam-btn" id="btn-sight-confirm" style="background:var(--accent);color:#fff;" onclick="confirmSightSerial()">✓</button>
        </div>
        <div id="sight-verified" style="display:none;font-size:12px;font-weight:700;margin-top:6px;"></div>
      </div>
      <div class="card-cell">
        <label>Country</label>
        <select id="inp-country" style="font-family:var(--font-ui);font-size:13px;" onchange="scheduleAutoSave()"></select>
      </div>
      <div class="card-cell">
        <label>Contract</label>
        <select id="inp-contract" style="font-family:var(--font-ui);font-size:13px;" onchange="loadSerialsForProject(this.value);scheduleAutoSave();if(typeof onSightContractChanged==='function')onSightContractChanged()"></select>
      </div>
      <div class="card-cell">
        <label>Year of Manufacturing</label>
        <select id="inp-year" onchange="scheduleAutoSave()"></select>
      </div>`;
    // v1.43 (20/11/2026): no Trolley No on the GRN40 card — a sight is not on a
    // trolley; it goes onto the trolley with its gun (picked on the XRGL40 card)
    return;
  }

  // RLL and XRGL40 share the same base layout
  // v1.42 (20/11/2026): the XRGL40 sight is picked from the approved GRN40
  // sights (sightpick.js); typing by hand needs the Admin PIN
  const sightRow = (state.cardType==='XRGL40') ? `
    <div class="card-cell">
      <label class="yellow">Sight Serial No ★</label>
      <div id="sp-pick" class="ra-pick" style="display:none;"></div>
      <div class="serial-row">
        <input type="text" id="inp-sight-serial" placeholder="Pick from the list" autocapitalize="characters" spellcheck="false" readonly>
        <img class="serial-thumb" id="thumb-inp-sight-serial">
        <button class="cam-btn" id="cam-inp-sight-serial" onclick="captureSerial('inp-sight-serial','photo_sight', true)">📷</button>
      </div>
      <div id="sp-info" class="ra-info" style="display:none;"></div>
    </div>` : '<div class="card-cell"></div>';

  // v1.47 (23/11/2026, Gerhard): most XRGL40 barrels come off the same few
  // batches, so the Barrel Production No is picked from a list instead of
  // typed 60 times. The box stays typeable for a barrel from a new batch.
  // The batches live in app_settings (key xrgl40_barrel_batches) so a new one
  // is added in Matrix / Supabase, not in a release.
  const bpBatch = (state.cardType === 'XRGL40')
    ? '<select id="inp-barrel-prod-batch" class="batch-pick" onchange="pickBarrelBatch(this)"></select>' : '';

  // v1.45 (23/11/2026): XRGL40 launcher serials all start X26 — the box
  // starts with it so only the number is typed (RLL is left exactly as it was)
  const lPrefix = (state.cardType === 'XRGL40')
    ? ' onfocus="_x26PrefixFocus(this)" onblur="_x26PrefixBlur(this)"' : '';
  const lPlace  = (state.cardType === 'XRGL40')
    ? 'X26 …  tap 📷 or type the number' : 'Tap 📷 or type';

  // v1.47 (23/11/2026, Gerhard): the XRGL40 HFM Production No and HRC Production
  // No boxes are taken off the card. The two columns (hfm_prod_no, hrc_prod_no)
  // stay in weapon_builds with whatever is already in them — nothing is deleted
  // — they are simply no longer asked for, saved or required for FAT / sign-off.

  grid.innerHTML = `
    <div class="card-cell">
      <label>Trolley No</label>
      <select id="inp-trolley-no" onchange="handleTrolleyChange()"></select>
    </div>
    <div class="card-cell">
      <label>Trolley Position</label>
      <select id="inp-trolley-pos" onchange="checkTrolleyPositionCollision()"></select>
    </div>
    <div class="card-cell">
      <label>Year of Manufacturing</label>
      <select id="inp-year" onchange="scheduleAutoSave()"></select>
    </div>
    ${sightRow}
    <div class="card-cell">
      <label>Country</label>
      <select id="inp-country" style="font-family:var(--font-ui);font-size:13px;" onchange="scheduleAutoSave()"></select>
    </div>
    <div class="card-cell">
      <label>Contract</label>
      <select id="inp-contract" style="font-family:var(--font-ui);font-size:13px;" onchange="loadSerialsForProject(this.value);scheduleAutoSave();if(typeof onSightContractChanged==='function')onSightContractChanged()"></select>
    </div>
    <!-- Launcher Serial — full width with confirm -->
    <div class="card-cell span2">
      <label class="yellow">Launcher Serial No ★</label>
      <div class="serial-row">
        <input type="text" id="inp-launcher-serial" placeholder="${lPlace}"
               autocapitalize="characters" spellcheck="false"${lPrefix} onchange="resetSerialConfirm()">
        <img class="serial-thumb" id="thumb-inp-launcher-serial">
        <button class="cam-btn" onclick="captureSerial('inp-launcher-serial','photo_launcher', false)">📷</button>
      </div>
      <div id="launcher-confirm-wrap" style="margin-top:6px;display:none;">
        <label style="color:var(--warn);font-size:10px;font-weight:700;letter-spacing:0.07em;display:block;margin-bottom:3px;">CONFIRM LAUNCHER SERIAL</label>
        <div style="display:flex;gap:8px;align-items:center;">
          <input type="text" id="inp-launcher-confirm" placeholder="Re-type to confirm"
                 autocapitalize="characters" spellcheck="false" style="flex:1;">
          <button class="cam-btn" style="background:#fff3e0;border-color:var(--warn);color:var(--warn);"
                  onclick="confirmLauncherSerial()">✓</button>
        </div>
      </div>
      <div id="launcher-verified" style="display:none;font-size:11px;color:var(--pass);font-weight:700;margin-top:4px;">✓ Serial verified</div>
    </div>
    <!-- Barrel No | Barrel Production No -->
    <div class="card-cell">
      <label class="yellow">Barrel No</label>
      <div class="serial-row">
        <input type="text" id="inp-barrel-no" placeholder="Tap 📷" autocapitalize="characters" spellcheck="false" onchange="checkComponentDuplicate(this)">
        <img class="serial-thumb" id="thumb-inp-barrel-no">
        <button class="cam-btn" onclick="captureSerial('inp-barrel-no','photo_barrel', false)">📷</button>
      </div>
    </div>
    <div class="card-cell">
      <label class="yellow">Barrel Production No</label>
      ${bpBatch}
      <div class="serial-row">
        <!-- v1.51 (25/11/2026): TYPING IN HERE NOW SAVES, THE SAME AS PICKING
             FROM THE BATCH LIST ABOVE IT.
             On 25/11 twenty XRGL40 cards were still carrying 2604113433 even
             though the men said they had typed the corrected number in by
             hand. They had. It was never saved. pickBarrelBatch() calls
             scheduleAutoSave(), so CHOOSING a batch saves itself two seconds
             later — but typing in this box fired nothing at all, and picking
             "Other — type it below" empties the box and schedules no save.
             So the man picks Other, types the right number, moves on, and the
             card keeps the old one. He has no reason to think this time is
             different, because every other time he touched this field it
             saved itself.
             onchange fires when he leaves the box, which is the same moment
             the batch list would have saved. -->
        <input type="text" id="inp-barrel-prod-no" placeholder="Tap 📷" autocapitalize="characters" spellcheck="false" onchange="scheduleAutoSave()">
        <img class="serial-thumb" id="thumb-inp-barrel-prod-no">
        <button class="cam-btn" onclick="captureSerial('inp-barrel-prod-no','photo_barrel_prod', false)">📷</button>
      </div>
    </div>
    <!-- Cylinder No | HRC Serial No -->
    <div class="card-cell">
      <label class="yellow">Cylinder No</label>
      <div class="serial-row">
        <input type="text" id="inp-cylinder-no" placeholder="Tap 📷" autocapitalize="characters" spellcheck="false" onchange="checkComponentDuplicate(this)">
        <img class="serial-thumb" id="thumb-inp-cylinder-no">
        <button class="cam-btn" onclick="captureSerial('inp-cylinder-no','photo_cylinder', false)">📷</button>
      </div>
    </div>
    <div class="card-cell">
      <label class="yellow">HRC Serial No</label>
      <div id="ra-pick" class="ra-pick" style="display:none;"></div>
      <div class="serial-row">
        <span class="num-prefix" id="prefix-inp-hrc-serial" style="display:none;font-family:var(--font-mono,monospace);font-weight:800;font-size:14px;color:var(--accent);padding:0 2px;white-space:nowrap;"></span><input type="text" id="inp-hrc-serial" placeholder="Tap 📷" autocapitalize="characters" spellcheck="false" onchange="applyComponentPrefix(this);checkComponentDuplicate(this)">
        <img class="serial-thumb" id="thumb-inp-hrc-serial">
        <button class="cam-btn" id="cam-inp-hrc-serial" onclick="captureSerial('inp-hrc-serial','photo_hrc', false)">📷</button>
        <span class="ra-tag" id="ra-tag-inp-hrc-serial" style="display:none;"></span>
      </div>
      <div id="ra-info" class="ra-info" style="display:none;"></div>
    </div>
    <!-- Cylinder Production No | Firing Mech No -->
    <div class="card-cell">
      <label class="yellow">Cylinder Production No</label>
      <div class="serial-row">
        <input type="text" id="inp-cylinder-prod-no" placeholder="Tap 📷" autocapitalize="characters" spellcheck="false">
        <img class="serial-thumb" id="thumb-inp-cylinder-prod-no">
        <button class="cam-btn" onclick="captureSerial('inp-cylinder-prod-no','photo_cylinder_prod', false)">📷</button>
      </div>
    </div>
    <div class="card-cell">
      <label class="yellow">Firing Mech No</label>
      <div class="serial-row">
        <span class="num-prefix" id="prefix-inp-firing-mech" style="display:none;font-family:var(--font-mono,monospace);font-weight:800;font-size:14px;color:var(--accent);padding:0 2px;white-space:nowrap;"></span><input type="text" id="inp-firing-mech" placeholder="Tap 📷" autocapitalize="characters" spellcheck="false" onchange="applyComponentPrefix(this);checkComponentDuplicate(this)">
        <img class="serial-thumb" id="thumb-inp-firing-mech">
        <button class="cam-btn" id="cam-inp-firing-mech" onclick="captureSerial('inp-firing-mech','photo_firing_mech', false)">📷</button>
        <span class="ra-tag" id="ra-tag-inp-firing-mech" style="display:none;"></span>
      </div>
    </div>
    <!-- HFM Serial No | empty -->
    <div class="card-cell">
      <label class="yellow">HFM Serial No</label>
      <div class="serial-row">
        <span class="num-prefix" id="prefix-inp-hfm-serial" style="display:none;font-family:var(--font-mono,monospace);font-weight:800;font-size:14px;color:var(--accent);padding:0 2px;white-space:nowrap;"></span><input type="text" id="inp-hfm-serial" placeholder="Tap 📷" autocapitalize="characters" spellcheck="false" onchange="applyComponentPrefix(this);checkComponentDuplicate(this)">
        <img class="serial-thumb" id="thumb-inp-hfm-serial">
        <button class="cam-btn" onclick="captureSerial('inp-hfm-serial','photo_hfm', false)">📷</button>
      </div>
    </div>
    <div class="card-cell"></div>`;
  // v1.32: HRC Serial No from the Rear Assy list (rearassy.js)
  if (typeof refreshCardRearAssy === 'function') setTimeout(refreshCardRearAssy, 150);
  // v1.42: XRGL40 Sight Serial No from the approved sights (sightpick.js)
  if (typeof refreshCardSight === 'function') setTimeout(refreshCardSight, 150);
  // v1.47: the Barrel Production No batch list — here too, because a brand
  // new card goes straight to the Identity screen without refreshIdentity()
  if (typeof refreshBarrelBatches === 'function') setTimeout(refreshBarrelBatches, 150);
}

// ─── IDENTITY SAVE/RESTORE ────────────────────────────────────────────────────
function getIdentityMap() {
  const base = {
    'inp-trolley-no':'trolley_number','inp-trolley-pos':'trolley_position',
    'inp-year':'year_of_manufacture','inp-country':'client_country','inp-contract':'contract_name',
    'inp-launcher-serial':'launcher_serial','inp-barrel-no':'barrel_no',
    'inp-barrel-prod-no':'barrel_production_no','inp-cylinder-no':'cylinder_no',
    'inp-hrc-serial':'hrc_serial_no','inp-cylinder-prod-no':'cylinder_production_no',
    'inp-hfm-serial':'hfm_serial_no','inp-firing-mech':'firing_mech_no',
  };
  if (state.cardType==='XRGL40'||state.cardType==='GRN40') base['inp-sight-serial']='sight_serial';
  // v1.47: hfm_prod_no / hrc_prod_no are no longer on the XRGL40 card, so they
  // are no longer read from it or written back. What is already stored stays.
  return base;
}

function refreshIdentity() {
  const opEl=document.getElementById('id-op'); if(opEl) opEl.textContent=state.operator||'—';
  refreshComponentPrefixes();   // v1.27: HFM- / LRC- / LFM- badges on the RLL card
  const map=getIdentityMap();
  // Use setTimeout to ensure dropdowns are populated before setting values
  setTimeout(() => {
    Object.entries(map).forEach(([elId,key])=>{
      const el=document.getElementById(elId);
      if(el && state.formData[key] !== undefined && state.formData[key] !== null) {
        el.value=_stripPrefix(elId, state.formData[key]);
      }
    });
  }, 100);
  if (state.serialVerified&&state.formData.launcher_serial) {
    const lv=document.getElementById('launcher-verified');
    const lw=document.getElementById('launcher-confirm-wrap');
    if(lv) lv.style.display='block'; if(lw) lw.style.display='none';
  }
  if (state.cardType==='GRN40' && state.serialVerified && state.formData.sight_serial) {
    const sv=document.getElementById('sight-verified');
    if(sv){ sv.style.display='block'; sv.style.color='var(--pass)';
            sv.textContent=`✓ Sight serial verified — ${state.formData.sight_serial}`; }
  }
  const logWrap=document.getElementById('activity-log-wrap');
  if(logWrap) logWrap.style.display=state.buildId?'block':'none';
  updateCardBadges();
  // v1.32: Rear Assy on the HRC box — after the boxes are filled (100 ms above)
  if (typeof refreshCardRearAssy === 'function') setTimeout(refreshCardRearAssy, 150);
  // v1.42: XRGL40 sight from the approved list — after the boxes are filled
  if (typeof refreshCardSight === 'function') setTimeout(refreshCardSight, 150);
  // v1.47: the Barrel Production No batch list
  if (typeof refreshBarrelBatches === 'function') setTimeout(refreshBarrelBatches, 150);
}

function resetSerialConfirm() {
  state.serialVerified=false;
  const lv=document.getElementById('launcher-verified');
  const lw=document.getElementById('launcher-confirm-wrap');
  const inp=document.getElementById('inp-launcher-serial');
  // Normalise on every change — fixes spaces, prefix, case automatically
  if (inp && inp.value) {
    const norm = normaliseSerial(inp.value, state.cardType);
    if (norm !== inp.value) inp.value = norm;
  }
  const val=inp?.value.trim();
  if(lv) lv.style.display='none';
  if(lw) lw.style.display=val&&val.length>2?'block':'none';
}

async function confirmLauncherSerial() {
  const inp1 = document.getElementById('inp-launcher-serial');
  const inp2 = document.getElementById('inp-launcher-confirm');
  const btn  = document.querySelector('#launcher-confirm-wrap button');
  const lv   = document.getElementById('launcher-verified');
  const lw   = document.getElementById('launcher-confirm-wrap');

  // ── STEP 1: Normalise both fields before comparing ──────────────────────
  // This catches extra spaces, missing prefix, wrong case automatically.
  const s1 = normaliseSerial(inp1?.value || '', state.cardType);
  const s2 = normaliseSerial(inp2?.value || '', state.cardType);

  // Write normalised value back so operator sees what was accepted
  if (inp1) inp1.value = s1;
  if (inp2) inp2.value = s2;

  // ── STEP 2: Both fields must be filled ──────────────────────────────────
  if (!s1 || !s2) {
    showToast('Enter serial in both fields', 'error');
    return;
  }

  // ── STEP 3: Both normalised entries must match exactly ──────────────────
  if (s1 !== s2) {
    showToast('❌ Serials do not match — correct and re-enter', 'error');
    if (inp2) {
      inp2.value = '';
      inp2.style.borderBottomColor = 'var(--fail)';
      inp2.style.backgroundColor   = '#fff0f0';
      inp2.focus();
    }
    if (lv) {
      lv.style.display = 'block';
      lv.textContent   = `❌  "${s1}"  ≠  "${s2}"  — they do not match`;
      lv.style.color   = 'var(--fail)';
    }
    return;
  }

  // ── STEP 4: Minimum length sanity check ─────────────────────────────────
  if (s1.length < 4) {
    showToast('Serial too short — check and re-enter', 'error');
    return;
  }

  // ── STEP 5: Check register — HARD BLOCK if not found ────────────────────
  if (btn) { btn.textContent = 'Checking…'; btn.disabled = true; }

  const validation = await validateSerialExists(s1);

  if (!validation.exists) {
    // HARD BLOCK — cannot proceed with an unregistered serial
    showToast(`🚫 BLOCKED — "${s1}" not in serial register`, 'error');
    if (lv) {
      lv.style.display = 'block';
      lv.innerHTML = `
        <div style="color:var(--fail);font-weight:700;margin-bottom:6px;">
          🚫 "${s1}" not found in this contract.
        </div>
        <div style="font-size:12px;color:#ffaaaa;margin-bottom:10px;">
          ${validation.reason || 'Check the serial number carefully — a single wrong digit or extra space will fail.'}<br>
          Also check you have selected the correct contract above.<br>
          If you are sure this serial is correct, ask your supervisor to approve.
        </div>
        <button id="btn-override-request"
          style="background:#c0392b;color:#fff;border:none;padding:8px 18px;
                 border-radius:6px;font-size:13px;font-weight:700;cursor:pointer;">
          🔐 Supervisor Override
        </button>
        <span id="override-status" style="display:none;margin-left:10px;font-size:12px;"></span>`;
      lv.style.color = 'var(--fail)';
      // Wire up the override button
      document.getElementById('btn-override-request')
        .addEventListener('click', () => requestSupervisorOverride(s1));
    }
    if (inp1) { inp1.style.borderBottomColor = 'var(--fail)'; }
    if (inp2) { inp2.value = ''; inp2.style.borderBottomColor = 'var(--fail)'; }
    if (btn)  { btn.textContent = '✓'; btn.disabled = false; }
    state.serialVerified = false;
    // Log the failed attempt for audit trail
    logActivity('SERIAL_NOT_IN_REGISTER', {serial_attempted: s1, operator: state.operator}, null);
    return;
  }

  // ── STEP 6: Duplicate check — hard block if already COMPLETE ────────────
  if (!state.buildId) {
    const dupeCheck = await checkDuplicateSerial(s1);
    if (dupeCheck.isDupe) {
      const st  = (dupeCheck.status || 'EXISTS').toUpperCase();
      const rec = dupeCheck.record || {};
      let msg, detail;
      if (st === 'COMPLETE') {
        msg    = `🚫 DUPLICATE — ${s1} already has a COMPLETED build card`;
        detail = 'This weapon has already been built and signed off. Contact QA.';
      } else {
        msg    = `⚠ ${s1} is already IN PROGRESS`;
        detail = `Trolley ${rec.trolley_number||'?'} · Pos ${rec.trolley_position||'?'} · OP ${rec.operator_number||'?'}`;
      }
      showToast(msg, 'error');
      if (lv) {
        lv.style.display = 'block';
        lv.innerHTML     = `${msg}<br><small style="color:#ffaaaa">${detail}</small>`;
        lv.style.color   = 'var(--fail)';
      }
      if (btn) { btn.textContent = '✓'; btn.disabled = false; }
      state.serialVerified = false;
      return;
    }
  }

  if (btn) { btn.textContent = '✓'; btn.disabled = false; }

  // ── STEP 7: All checks passed — claim the serial, THEN show confirmed ───
  state.formData.launcher_serial = s1;
  state.serialVerified = true;
  if (lv) { lv.style.display = 'block'; lv.style.color = 'var(--text-dim)';
            lv.textContent = `⏳ Registering ${s1}…`; }
  if (btn) { btn.textContent = '…'; btn.disabled = true; }
  const claimed = await _claimSerialNow();       // creates the card row now
  if (btn) { btn.textContent = '✓'; btn.disabled = false; }
  if (!state.serialVerified) return;             // taken by another tablet — _refuseTaken showed why
  if (inp1) { inp1.style.borderBottomColor = 'var(--pass)'; inp1.style.backgroundColor = ''; }
  if (inp2) { inp2.style.borderBottomColor = 'var(--pass)'; inp2.style.backgroundColor = ''; }
  if (lv) {
    lv.style.display = 'block';
    lv.textContent   = claimed ? `✓ Serial confirmed and registered — ${s1}`
                               : `✓ Serial confirmed — ${s1} (not saved yet — check Wi-Fi, it will retry)`;
    lv.style.color   = claimed ? 'var(--pass)' : 'var(--warn)';
  }
  if (lw) lw.style.display = 'none';
  showToast(`✓ Serial confirmed — ${s1}`, 'ok');
  updateUnitStrip();
}

// ─── GRN40 SIGHT SERIAL CONFIRM ───────────────────────────────────────────────
// GRN40's Blue Card IS the sight unit, so sight_serial is its identity —
// the equivalent of launcher_serial on RLL/XRGL40. Same gates as
// confirmLauncherSerial(): normalise → register check (project-scoped via
// validateSerialExists) → duplicate block → confirm + auto-save.
// Differences, by design:
//   - Single entry + ✓ (the GRN40 row has no second "re-type" box).
//   - Duplicate check is self-contained (_findDuplicateSight) rather than
//     supabase.js's checkDuplicateSerial(), which is launcher-based, and it
//     runs on resume too (excluding this card's own row), not only on new cards.

// Any edit to a confirmed sight serial drops verification — otherwise
// autoSaveIdentity() would read the edited, unvalidated value straight
// from the input box and save it over the confirmed one.
function resetSightConfirm() {
  if (state.cardType !== 'GRN40') return;
  state.serialVerified = false;
  const inp = document.getElementById('inp-sight-serial');
  if (inp && inp.value) {
    const norm = normaliseSerial(inp.value, 'GRN40');
    if (norm !== inp.value) inp.value = norm;
  }
  if (inp) { inp.style.borderBottomColor = ''; inp.style.backgroundColor = ''; }
  const sv = document.getElementById('sight-verified');
  if (sv) {
    sv.style.display = inp && inp.value ? 'block' : 'none';
    sv.style.color   = 'var(--warn)';
    sv.textContent   = 'Tap ✓ to confirm the sight serial';
  }
}

// Returns the first OTHER GRN40 build already using this sight serial
// (IN PROGRESS or COMPLETE), or null. Throws on query failure so the
// caller can block rather than let a possible duplicate through.
async function _findDuplicateSight(serial) {
  let q = supabaseClient.from('weapon_builds')
    .select('id,status,trolley_number,trolley_position,operator_number')
    .eq('card_type', 'GRN40')
    .eq('sight_serial', serial)
    .in('status', ['IN PROGRESS', 'COMPLETE']);
  if (state.buildId) q = q.neq('id', state.buildId);
  const { data, error } = await q.limit(1);
  if (error) throw error;
  return (data && data.length > 0) ? data[0] : null;
}

// Shows a duplicate-block message in the #sight-verified div. Shared by
// confirmSightSerial() and the supervisor-override path.
function _showSightDuplicate(serial, dupe) {
  const st = (dupe.status || 'EXISTS').toUpperCase();
  const msg = st === 'COMPLETE'
    ? `🚫 DUPLICATE — ${serial} already has a COMPLETED GRN40 build card`
    : `⚠ ${serial} is already IN PROGRESS on another GRN40 card`;
  const detail = st === 'COMPLETE'
    ? 'This sight has already been built and signed off. Contact QA.'
    : `Trolley ${dupe.trolley_number||'?'} · Pos ${dupe.trolley_position||'?'} · OP ${dupe.operator_number||'?'}`;
  showToast(msg, 'error');
  const sv = document.getElementById('sight-verified');
  if (sv) {
    sv.style.display = 'block';
    sv.style.color   = 'var(--fail)';
    sv.innerHTML     = `${msg}<br><small style="color:#ffaaaa">${detail}</small>`;
  }
  const inp = document.getElementById('inp-sight-serial');
  if (inp) inp.style.borderBottomColor = 'var(--fail)';
}

async function confirmSightSerial() {
  const inp = document.getElementById('inp-sight-serial');
  const btn = document.getElementById('btn-sight-confirm');
  const sv  = document.getElementById('sight-verified');

  // ── STEP 1: Normalise (uppercase, trim, collapse spaces, keep hyphen) ──
  const s = normaliseSerial(inp?.value || '', 'GRN40');
  if (inp) inp.value = s;

  // ── STEP 2: Must be filled, minimum length ─────────────────────────────
  if (!s) { showToast('Enter the sight serial first', 'error'); return; }
  if (s.length < 4) { showToast('Serial too short — check and re-enter', 'error'); return; }

  const _resetBtn = () => { if (btn) { btn.textContent = '✓'; btn.disabled = false; } };
  if (btn) { btn.textContent = '…'; btn.disabled = true; }
  state.serialVerified = false;

  // ── STEP 3: Register check — HARD BLOCK if not found ──────────────────
  const validation = await validateSerialExists(s);
  if (!validation.exists) {
    showToast(`🚫 BLOCKED — "${s}" not in serial register`, 'error');
    if (sv) {
      sv.style.display = 'block';
      sv.style.color   = 'var(--fail)';
      sv.innerHTML = `
        <div style="color:var(--fail);font-weight:700;margin-bottom:6px;">
          🚫 "${s}" not found in this contract.
        </div>
        <div style="font-size:12px;color:#ffaaaa;margin-bottom:10px;font-weight:400;">
          ${validation.reason || 'Check the serial number carefully — a single wrong digit or extra space will fail.'}<br>
          Also check you have selected the correct contract.<br>
          If you are sure this serial is correct, ask your supervisor to approve.
        </div>
        <button id="btn-override-request"
          style="background:#c0392b;color:#fff;border:none;padding:8px 18px;
                 border-radius:6px;font-size:13px;font-weight:700;cursor:pointer;">
          🔐 Supervisor Override
        </button>
        <span id="override-status" style="display:none;margin-left:10px;font-size:12px;"></span>`;
      document.getElementById('btn-override-request')
        .addEventListener('click', () => requestSupervisorOverride(s));
    }
    if (inp) inp.style.borderBottomColor = 'var(--fail)';
    _resetBtn();
    logActivity('SERIAL_NOT_IN_REGISTER', {serial_attempted: s, operator: state.operator}, null);
    return;
  }

  // ── STEP 4: Duplicate check — block if any OTHER GRN40 card uses it ────
  let dupe;
  try {
    dupe = await _findDuplicateSight(s);
  } catch (e) {
    console.error('[SightConfirm] duplicate check failed', e);
    showToast('⚠ Could not check for duplicates — check connection and tap ✓ again', 'error');
    _resetBtn();
    return;
  }
  if (dupe) { _showSightDuplicate(s, dupe); _resetBtn(); return; }

  // ── STEP 5: All checks passed — claim the serial, THEN show confirmed ─
  state.formData.sight_serial = s;
  state.serialVerified = true;
  if (sv) { sv.style.display = 'block'; sv.style.color = 'var(--text-dim)';
            sv.textContent = `⏳ Registering ${s}…`; }
  const claimed = await _claimSerialNow();       // creates the card row now
  _resetBtn();
  if (!state.serialVerified) return;             // taken by another tablet — _refuseTaken showed why
  if (inp) { inp.style.borderBottomColor = 'var(--pass)'; inp.style.backgroundColor = ''; }
  if (sv) {
    sv.style.display = 'block';
    sv.style.color   = claimed ? 'var(--pass)' : 'var(--warn)';
    sv.textContent   = claimed ? `✓ Sight serial confirmed and registered — ${s}`
                               : `✓ Sight serial confirmed — ${s} (not saved yet — check Wi-Fi, it will retry)`;
  }
  showToast(`✓ Sight serial confirmed — ${s}`, 'ok');
  updateUnitStrip();
}

// ─── v1.27 (10/11/2026) COMPONENT-NUMBER GATE ────────────────────────────────
// Every manually typed component number — Barrel no, Cylinder no, HRC serial,
// HFM serial, Firing Mech no — can be on ONE card per card type. (Production
// numbers are not gated until confirmed per-unit; add a line here AND in
// bluecard_component_columns() in the database to gate one.) The tablet asks the database (bluecard_component_in_use) the moment a
// number is entered and again before every identity save; the database
// trigger trg_weapon_builds_component_unique is the hard backstop. Numbers
// are compared upper-case with spaces removed. Blank is never a duplicate.
const COMPONENT_UNIQUE_FIELDS = {
  'inp-barrel-no':   { col: 'barrel_no',      label: 'Barrel no' },
  'inp-cylinder-no': { col: 'cylinder_no',    label: 'Cylinder no' },
  'inp-hfm-serial':  { col: 'hfm_serial_no',  label: 'HFM serial' },
  'inp-hrc-serial':  { col: 'hrc_serial_no',  label: 'HRC serial' },
  'inp-firing-mech': { col: 'firing_mech_no', label: 'Firing mech no' },
};
state._dupComponents = state._dupComponents || {};   // col -> message while a duplicate is sitting in the field

// ─── v1.27 RLL fixed prefixes (Gerhard, 10/11/2026) ──────────────────────────
// On the RLL card the operator types just the number; the tablet shows the
// prefix in front of the box and stores prefix + number: HFM-26122,
// LRC-26192(25), LFM-26075(25). Typing the prefix anyway (with or without the
// hyphen, any case) is not doubled. Other card types are untouched.
const COMPONENT_PREFIX = { RLL: { 'inp-hfm-serial': 'HFM-', 'inp-hrc-serial': 'LRC-', 'inp-firing-mech': 'LFM-' } };
// v1.28 (10/11/2026): letters the operators type in front of the number that
// are NOT part of it — dropped the same way as the prefix (HFM box: "LHF26277")
const COMPONENT_PREFIX_ALIASES = { 'inp-hfm-serial': ['LHF'] };
function _componentPrefix(elId) { return (COMPONENT_PREFIX[state.cardType] || {})[elId] || ''; }
// stored value -> what the operator sees in the box (number only)
function _stripPrefix(elId, val) {
  const p = _componentPrefix(elId); if (!p || !val) return val;
  const words = [p.slice(0, -1)].concat(COMPONENT_PREFIX_ALIASES[elId] || []);
  let v = String(val), m;
  // strip repeatedly: "HFM-LHF-26216" -> "LHF-26216" -> "26216"
  while ((m = new RegExp('^\\s*(' + words.join('|') + ')\\s*-?\\s*', 'i').exec(v))) v = v.slice(m[0].length);
  return v;
}
// what is in the box -> stored value (prefix + number)
function _withPrefix(elId, raw) {
  const p = _componentPrefix(elId); const v = String(raw || '').trim();
  if (!p || !v) return v || null;
  return p + _stripPrefix(elId, v).trim();
}
function applyComponentPrefix(inp) {           // onchange: normalise what was typed
  if (!_componentPrefix(inp.id)) return;
  inp.value = _stripPrefix(inp.id, inp.value).trim();
}
function refreshComponentPrefixes() {          // show/hide the badges for the current card type
  ['inp-hfm-serial', 'inp-hrc-serial', 'inp-firing-mech'].forEach(id => {
    const b = document.getElementById('prefix-' + id), p = _componentPrefix(id);
    if (b) { b.textContent = p; b.style.display = p ? 'inline' : 'none'; }
  });
}
// value of an identity field as it must be stored (prefix applied where set)
function _identityValue(elId, el) { return _componentPrefix(elId) ? _withPrefix(elId, el.value) : (el.value || null); }

async function _componentInUse(col, value) {
  const v = String(value || '').trim();
  if (!v) return null;
  const { data, error } = await supabaseClient.rpc('bluecard_component_in_use', {
    p_card_type: state.cardType, p_column: col, p_value: v, p_exclude_id: state.buildId || null
  });
  if (error) throw error;
  return data || null;          // text = "HFM serial 26122 is already on card RLL 260071 (Trolley 11 / Pos 56 · IN PROGRESS)"
}

function _markComponentField(elId, msg) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.style.borderBottomColor = msg ? 'var(--fail, #e03c3c)' : '';
  el.style.backgroundColor   = msg ? 'rgba(224,60,60,0.12)' : '';
  el.title = msg || '';
}

// onchange of the three inputs — tell the operator at once
async function checkComponentDuplicate(inp) {
  const cfg = COMPONENT_UNIQUE_FIELDS[inp.id];
  if (!cfg) return;
  try {
    const value = _identityValue(inp.id, inp);
    const msg = await _componentInUse(cfg.col, value);
    if (msg && _isStoredComponent(cfg.col, value)) {
      // this card already holds it (one of the known pairs) — warn, don't block
      delete state._dupComponents[cfg.col];
      _markComponentWarn(inp.id, msg);
      showToast('⚠ ' + msg + ' — this card already carries it; correct it when the real number is known', 'warn');
    } else if (msg) {
      state._dupComponents[cfg.col] = msg;
      _markComponentField(inp.id, msg);
      showToast('🚫 ' + msg + ' — check the number on the gun', 'error');
    } else {
      delete state._dupComponents[cfg.col];
      _markComponentField(inp.id, null);
    }
  } catch (e) {
    console.warn('[ComponentGate] check failed', e);   // the save-time check and the DB trigger still apply
  }
}

// v1.28 (11/11/2026): the gate only bites when a number is NEW on this card —
// the same rule as the database trigger. A card that already holds one of the
// known duplicate numbers (the 6 pairs found 10 Nov) must still save its
// trolley, position, other numbers and progress; the duplicate field is shown
// amber until it is corrected. v1.27 refused every save on those cards.
state._storedComponents = state._storedComponents || {};   // col -> value as last loaded/saved
function _normComponent(v) {            // same as bluecard_component_norm() in the database
  return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^[A-Z]+/, '');
}
function _rememberStoredComponents(row) {
  state._storedComponents = {};
  Object.values(COMPONENT_UNIQUE_FIELDS).forEach(cfg => { state._storedComponents[cfg.col] = (row && row[cfg.col]) || null; });
}
function _isStoredComponent(col, value) {
  const stored = state._storedComponents[col];
  return !!stored && _normComponent(stored) === _normComponent(value);
}
function _markComponentWarn(elId, msg) {      // amber: already on this card, not blocking
  const el = document.getElementById(elId);
  if (!el) return;
  el.style.borderBottomColor = 'var(--warn, #e08f1a)';
  el.style.backgroundColor   = 'rgba(224,143,26,0.12)';
  el.title = msg;
}

// Before an identity save: true = blocked (a NEW duplicate is in one of the fields)
async function _blockIfDuplicateComponents() {
  for (const [elId, cfg] of Object.entries(COMPONENT_UNIQUE_FIELDS)) {
    const el = document.getElementById(elId);
    if (!el || !el.value.trim()) { delete state._dupComponents[cfg.col]; _markComponentField(elId, null); continue; }
    const value = _identityValue(elId, el);
    if (_isStoredComponent(cfg.col, value)) {   // unchanged on this card — never blocks
      delete state._dupComponents[cfg.col];
      if (el.title && /already on card/.test(el.title)) _markComponentWarn(elId, el.title); else _markComponentField(elId, null);
      continue;
    }
    let msg = null;
    try { msg = await _componentInUse(cfg.col, value); }
    catch (e) { console.warn('[ComponentGate] check failed', e); continue; }   // DB trigger is the backstop
    if (msg) {
      state._dupComponents[cfg.col] = msg;
      _markComponentField(elId, msg);
      showToast('🚫 Not saved — ' + msg, 'error');
      return true;
    }
    delete state._dupComponents[cfg.col];
    _markComponentField(elId, null);
  }
  return false;
}

// The database refused the row (trigger message "DUPLICATE|<col>|<text>")
function _duplicateComponentError(error) {
  const m = /DUPLICATE\|(\w+)\|(.+)$/.exec((error && error.message) || '');
  if (!m) return null;
  const elId = Object.keys(COMPONENT_UNIQUE_FIELDS).find(k => COMPONENT_UNIQUE_FIELDS[k].col === m[1]);
  if (elId) { state._dupComponents[m[1]] = m[2]; _markComponentField(elId, m[2]); }
  return m[2];
}

async function saveIdentity() {
  // Collect ALL fields from form — including selects
  const map = getIdentityMap();
  Object.entries(map).forEach(([elId, key]) => {
    const el = document.getElementById(elId);
    if (el) state.formData[key] = _identityValue(elId, el);
  });

  // Block save if launcher serial entered but not confirmed
  const launcherInput = document.getElementById('inp-launcher-serial')?.value.trim();
  if (launcherInput && !state.serialVerified) {
    showToast('❌ Please confirm the launcher serial first — tap ✓ button', 'error');
    const lw = document.getElementById('launcher-confirm-wrap');
    if (lw) lw.style.display = 'block';
    return;
  }

  // GRN40 equivalent — sight serial is the unit's identity
  const sightInput = document.getElementById('inp-sight-serial')?.value.trim();
  if (state.cardType === 'GRN40' && sightInput && !state.serialVerified) {
    showToast('❌ Please confirm the sight serial first — tap ✓ button', 'error');
    return;
  }

  // Block creating a BRAND NEW record with no identifying serial at all —
  // this is what produced "ghost" IN PROGRESS cards with no serial that
  // just sit in the incomplete list forever. Updating an EXISTING card
  // (state.buildId already set) is unaffected — this only blocks a fresh
  // insert with nothing to identify it.
  if (!state.buildId) {
    const idField = state.cardType === 'GRN40' ? 'inp-sight-serial' : 'inp-launcher-serial';
    const idLabel = state.cardType === 'GRN40' ? 'Sight Serial' : 'Launcher Serial';
    const hasSerial = state.cardType === 'GRN40'
      ? (state.serialVerified && !!sightInput)
      : (state.serialVerified && !!launcherInput);
    if (!hasSerial) {
      showToast(`❌ Enter and confirm the ${idLabel} before saving a new card`, 'error');
      return;
    }
  }

  // Warn if launcher photo not taken — it is required for customs/export docs.
  // RLL/XRGL40 only: GRN40 has no launcher, so this would otherwise block
  // every GRN40 save once its sight serial is verified.
  if (state.cardType !== 'GRN40' && state.serialVerified && !state.formData.photo_launcher) {
    showToast('📷 Please take a photo of the Launcher Serial before saving', 'warn');
    const statusEl = document.getElementById('ocr-status');
    if (statusEl) {
      statusEl.textContent = '⚠ Launcher serial photo REQUIRED — tap 📷 next to Launcher Serial No';
      statusEl.style.color = 'var(--warn)';
    }
    return;
  }

  // v1.27: a component number already on another card stops the save
  if (await _blockIfDuplicateComponents()) return;

  // Always set status and card type
  state.formData.status = state.formData.status || 'IN PROGRESS';
  state.formData.card_type = state.cardType;

  // Identity saves carry identity fields only — checks are saved by the
  // Checks screen itself (setCheck / saveChecks), never from here.
  delete state.formData.checks;
  let result, error;
  if (state.buildId) {
    // v1.35: only the fields changed on this tablet — never another person's
    // newer values, and never status / sign-off
    const changes = _identityChanges();
    if (Object.keys(changes).length) {
      ({data: result, error} = await supabaseClient.from('weapon_builds')
        .update({...changes, updated_at: new Date().toISOString()})
        .eq('id', state.buildId).select());
      if (!error) _identitySaved(changes);
    }
  } else {
    const sent = {...state.formData};
    ({data: result, error} = await _createBuildRow(sent));
    if (!error && state.buildId) _identitySaved(sent);
  }

  if (error) {
    console.error(error);
    const dup = _duplicateComponentError(error);
    const gate = _trolleyGateError(error);   // v1.37
    if (gate) { showToast('🚫 Not saved — ' + gate, 'error'); _trolleyRevert(); return; }
    const sgate = (typeof _sightGateError === 'function') ? _sightGateError(error) : null;   // v1.42
    if (sgate) { showToast('🚫 Not saved — ' + sgate, 'error'); _sightRevert(); return; }
    showToast(dup ? '🚫 Not saved — ' + dup : 'Save failed — ' + (error.message||'check connection'), 'error');
    return;
  }

  // Update serial register — mark as IN PROGRESS with trolley info
  const regSerial = _unitIdentifierSerial();
  if (regSerial) {
    const serialUpdate = { status: 'IN PROGRESS' };
    if (state.formData.trolley_number)   serialUpdate.trolley_number   = state.formData.trolley_number;
    if (state.formData.trolley_position) serialUpdate.trolley_position = state.formData.trolley_position;
    const { error: serErr } = await supabaseClient.from('weapon_serials')
      .update(serialUpdate)
      .eq('serial_number', regSerial)
      .or('status.is.null,status.neq.COMPLETE');   // v1.35: never undo a sign-off
    if (serErr) console.warn('Serial status update failed:', serErr);
  }

  _rememberStoredComponents(state.formData);
  await logActivity('IDENTITY_SAVE', state.formData, null);
  showToast('Identity saved ✓', 'ok');
  loadActivityLog(_unitIdentifierSerial());
}

// ─── ONE CARD PER SERIAL — the only way a weapon_builds row is ever created ──
// 20/10/2026 (v1.19). Four places used to insert a build row on their own
// (identity auto-save, Save Identity Fields, Save Progress, Submit). After
// tapping ✓ the auto-save insert runs in the background; tapping Save
// Identity Fields in that 1–2 s window inserted the SAME card again — a
// second row with the serial and no checks (the "0/18 duplicate").
//
// Now every create goes through here, which guarantees one row per serial:
//   1. one create at a time — a second caller waits for the first;
//   2. if a card for this serial already exists (created a moment ago, or
//      on another tablet) it is ADOPTED and updated, never duplicated;
//   3. if the database's unique index still rejects the insert (two tablets
//      at the exact same instant), the existing card is adopted instead;
//   4. the new row is bound to this screen only if the operator is still on
//      the same serial — not if they already moved to another card.
let _createInFlight = null;

function _serialColumn() {
  return state.cardType === 'GRN40' ? 'sight_serial' : 'launcher_serial';
}

async function _findExistingBuild(serial) {
  let q = supabaseClient.from('weapon_builds')
    .select('id,status,checks,card_type,operator_number,trolley_number,trolley_position')
    .eq(_serialColumn(), serial);
  if (state.cardType === 'GRN40') q = q.eq('card_type', 'GRN40');
  const { data } = await q.order('created_at', { ascending: true }).limit(1);
  return (data && data.length) ? data[0] : null;
}

async function _createBuildRow(payload) {
  if (state.buildId) return { data: [{ id: state.buildId }], error: null };
  if (_createInFlight) {
    try { await _createInFlight; } catch (e) { /* reported by the first caller */ }
    // The first caller created (or adopted) the row — apply THIS caller's
    // data to it instead of creating a second one.
    if (state.buildId) return _applyToExisting(payload);
  }
  const serial = _unitIdentifierSerial();
  if (!serial) {
    // Never create a card with no identifying serial (a "ghost" card)
    return { data: null, error: { message: 'No serial on this card yet — confirm the serial first' } };
  }
  // v1.29 (11/11/2026): a card is ALWAYS stamped with the operator who started
  // it. Opening Identity from the bottom bar (instead of Start New Card) used
  // to create the card from an empty form — no operator_number, no
  // session_start — and the KPIs are built on that stamp.
  if (!payload.operator_number) payload.operator_number = state.operator || null;
  if (!payload.card_type)       payload.card_type       = state.cardType;
  if (!payload.status)          payload.status          = 'IN PROGRESS';
  if (!payload.session_start)   payload.session_start   = new Date().toISOString();
  const run = (async () => {
    // 1. A card already exists for this serial.
    //    23/10/2026 (v1.22): adopt it ONLY if it is this operator's own card
    //    (the v1.19 double-insert on one tablet). If ANOTHER operator created
    //    it — two tablets confirming the same serial seconds apart — refuse:
    //    v1.19 adopted it silently and both men ended up on one card.
    if (serial) {
      const existing = await _findExistingBuild(serial);
      if (existing) {
        return _isOwnCard(existing) ? _adoptBuild(existing, payload, serial)
                                    : _refuseTaken(serial, existing);
      }
    }
    // 2. Create it
    const { data, error } = await supabaseClient.from('weapon_builds')
      .insert(payload).select();
    if (error && (error.code === '23505' || /duplicate key|unique/i.test(error.message || ''))) {
      // The database refused a second row — someone else created it first
      // (the unique index is the real lock: whichever tablet lands first owns it)
      const existing = serial ? await _findExistingBuild(serial) : null;
      if (existing) {
        return _isOwnCard(existing) ? _adoptBuild(existing, payload, serial)
                                    : _refuseTaken(serial, existing);
      }
    }
    if (!error && data && data.length) {
      if (_unitIdentifierSerial() === serial) {
        state.buildId = data[0].id;
        // Ticks made while the row was still being created have nowhere to
        // go until now — write them to the new row.
        if (!('checks' in payload) && Object.keys(state.checks || {}).length) {
          const { error: ce } = await supabaseClient.from('weapon_builds')
            .update({ checks: state.checks }).eq('id', state.buildId);
          if (!ce) state._dirtyChecks = {};   // v1.35: all on the new card
        }
      }
    }
    return { data, error };
  })();
  _createInFlight = run;
  try { return await run; } finally { if (_createInFlight === run) _createInFlight = null; }
}

function _isOwnCard(existing) {
  const op = existing && existing.operator_number;
  return !!op && String(op).trim() === String(state.operator || '').trim();
}

// 23/10/2026 (v1.22): another tablet took this serial first. Drop the
// confirmation on this tablet, clear the serial boxes and tell the operator
// whose card it is — he must pick another serial. Logged so the Audit Trail
// shows the clash.
async function _refuseTaken(serial, existing) {
  const who = existing.operator_number ? `OP ${existing.operator_number}` : 'another operator';
  const where = `Trolley ${existing.trolley_number || '?'} · Pos ${existing.trolley_position || '?'}`;
  const msg = `🚫 ${serial} was just taken by ${who} — pick another serial`;
  try {
    await supabaseClient.from('weapon_build_sessions').insert({
      launcher_serial: serial, operator_number: state.operator,
      action: 'SERIAL_TAKEN_BY_OTHER',
      fields_updated: JSON.stringify({ serial, taken_by: existing.operator_number || null,
                                       build_id: existing.id, trolley: existing.trolley_number || null,
                                       position: existing.trolley_position || null })
    });
  } catch (e) { /* best effort */ }
  state.serialVerified = false;
  state.buildId = null;
  if (state.cardType === 'GRN40') {
    state.formData.sight_serial = null;
    const inp = document.getElementById('inp-sight-serial');
    if (inp) { inp.value = ''; inp.style.borderBottomColor = 'var(--fail)'; }
    const sv = document.getElementById('sight-verified');
    if (sv) { sv.style.display = 'block'; sv.style.color = 'var(--fail)';
              sv.innerHTML = `${msg}<br><small style="color:#ffaaaa">${where}</small>`; }
  } else {
    state.formData.launcher_serial = null;
    const i1 = document.getElementById('inp-launcher-serial');
    const i2 = document.getElementById('inp-launcher-confirm');
    if (i1) { i1.value = ''; i1.style.borderBottomColor = 'var(--fail)'; }
    if (i2) { i2.value = ''; i2.style.borderBottomColor = 'var(--fail)'; }
    const lv = document.getElementById('launcher-verified');
    if (lv) { lv.style.display = 'block'; lv.style.color = 'var(--fail)';
              lv.innerHTML = `${msg}<br><small style="color:#ffaaaa">${where}</small>`; }
    const lw = document.getElementById('launcher-confirm-wrap');
    if (lw) lw.style.display = '';
  }
  showToast(msg, 'error');
  return { data: null, error: { code: 'SERIAL_TAKEN', message: msg } };
}

// 23/10/2026 (v1.22): the serial is CLAIMED the moment ✓ is tapped — the
// card row is created right here and the operator waits for it, so a second
// tablet confirming the same serial a moment later meets the row (or the
// unique index) and is refused. v1.19–1.21 fired the create in the
// background and showed "confirmed" before the row existed.
async function _claimSerialNow() {
  const t0 = Date.now();
  while (_autoSaving && Date.now() - t0 < 4000) {
    await new Promise(r => setTimeout(r, 100));
  }
  await autoSaveIdentity();
  return state.serialVerified && !!state.buildId;
}

async function _applyToExisting(payload) {
  const upd = { ...payload, updated_at: new Date().toISOString() };
  delete upd.id; delete upd.created_at;
  if (!('checks' in upd)) delete upd.checks;
  const { data, error } = await supabaseClient.from('weapon_builds')
    .update(upd).eq('id', state.buildId).select();
  return { data: data && data.length ? data : [{ id: state.buildId }], error };
}

async function _adoptBuild(existing, payload, serial) {
  if (_unitIdentifierSerial() !== serial) return { data: [existing], error: null };
  state.buildId = existing.id;
  const upd = { ...payload, updated_at: new Date().toISOString() };
  delete upd.id; delete upd.created_at;
  if (!('checks' in upd)) {
    // Identity save: keep the checks already on the card, and show them
    delete upd.checks;
    if (existing.checks && Object.keys(state.checks || {}).length === 0) {
      state.checks = existing.checks;
      updateNavBadges();
    }
  }
  if (!upd.status || upd.status === 'IN PROGRESS') {
    upd.status = existing.status === 'COMPLETE' ? 'COMPLETE' : 'IN PROGRESS';
    state.formData.status = upd.status;
  }
  const { data, error } = await supabaseClient.from('weapon_builds')
    .update(upd).eq('id', existing.id).select();
  showToast(`ℹ ${serial} already has a card — continuing that one`, 'warn');
  logActivity('EXISTING_CARD_ADOPTED', { serial, build_id: existing.id }, null);
  return { data: data && data.length ? data : [existing], error };
}

// ─── ACTIVITY LOG ─────────────────────────────────────────────────────────────
// GRN40 builds have no launcher_serial — sight_serial IS their identity.
// Activity logging must fall back to it, or GRN40 work never gets logged
// at all (which is exactly why Operator Activity showed 0 events for
// operators who only worked on GRN40 cards). Reuses the existing
// weapon_build_sessions.launcher_serial column to hold whichever serial
// applies, rather than adding a new column — same column Audit Trail and
// Operator Activity already search by.
//
// Card-type aware: GRN40 = sight_serial; RLL/XRGL40 = launcher_serial only.
// (An XRGL40 also carries a sight_serial — the GRN40 sight paired to it —
// but that is NOT the gun's identity, so it must never be used as the
// XRGL40's audit/register key, even before its launcher serial is set.)
function _unitIdentifierSerial() {
  if (state.cardType === 'GRN40') return state.formData.sight_serial || null;
  return state.formData.launcher_serial || null;
}

// Same rule applied to a raw weapon_builds row (Resume list, loadBuild).
function _rowIdentifierSerial(row) {
  if (!row) return null;
  return (row.card_type === 'GRN40') ? (row.sight_serial || null) : (row.launcher_serial || null);
}

// 20/10/2026 (v1.18): the log must never carry the photos. IDENTITY_SAVE /
// IDENTITY_AUTOSAVE used to write the whole formData — including every
// base64 serial photo (100–300 KB each) — into fields_updated on EVERY
// auto-save. Rows of 1–2 MB each made Operator Activity / Audit Trail in
// Rippel Matrix time out on the first day of real use. The photos live on
// weapon_builds; the log only needs to say a photo was taken.
function _logSafeFields(fields) {
  if (!fields || typeof fields !== 'object') return fields;
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'checks') continue;                       // checks have their own column
    if (k.startsWith('photo_')) { if (v) out[k] = '[photo]'; continue; }
    if (typeof v === 'string' && v.startsWith('data:')) { out[k] = '[photo]'; continue; }
    out[k] = v;
  }
  return out;
}

async function logActivity(action,fields,checks) {
  const unitSerial = _unitIdentifierSerial();
  if(!unitSerial) return;
  try {
    await supabaseClient.from('weapon_build_sessions').insert({
      launcher_serial:unitSerial,
      operator_number:state.operator,action,
      fields_updated:fields?JSON.stringify(_logSafeFields(fields)):null,
      checks_updated:checks?JSON.stringify(checks):null,
    });
  } catch(e){console.warn('Log failed',e);}
}

async function loadActivityLog(serial) {
  if(!serial) return;
  const logEl=document.getElementById('activity-log'); if(!logEl) return;
  try {
    const {data}=await supabaseClient.from('weapon_build_sessions')
      .select('operator_number,action,created_at').eq('launcher_serial',serial)
      .order('created_at',{ascending:true});
    if(!data||data.length===0){logEl.innerHTML='<div style="color:var(--text-dim);font-style:italic;font-size:12px;">No activity yet</div>';return;}
    logEl.innerHTML=data.map(r=>`
      <div style="display:flex;gap:8px;padding:5px 0;border-bottom:1px solid var(--border);font-size:12px;">
        <span style="font-family:var(--font-mono);color:var(--accent);font-weight:700;flex-shrink:0;">OP ${r.operator_number}</span>
        <span style="flex:1;">${r.action.replace(/_/g,' ')}</span>
        <span style="color:var(--text-dim);flex-shrink:0;">${formatDate(new Date(r.created_at))}</span>
      </div>`).join('');
  } catch(e){}
}

// ─── TROLLEY / YEAR / CUSTOMERS ───────────────────────────────────────────────
function populateTrolley() {
  const tSel=document.getElementById('inp-trolley-no'); if(!tSel||tSel.options.length>1) return;
  tSel.innerHTML='<option value="">— Select —</option>';
  for(let i=1;i<=20;i++) tSel.innerHTML+=`<option value="${i}">Trolley ${i}</option>`;
  const pSel=document.getElementById('inp-trolley-pos');
  if(pSel){pSel.innerHTML='<option value="">— Select —</option>';for(let i=1;i<=56;i++) pSel.innerHTML+=`<option value="${i}">Pos ${i}</option>`;}
  if(!state.buildId) autoSuggestTrolley(); else _markTrolleysInUse();
}

// v1.48: the place comes from the database — bc_next_free_trolley() carries on
// with the trolley being filled FOR THIS CARD TYPE, skips any trolley somebody
// else is holding, and moves up when one is full. The old version took the last
// created card of ANY type and added 1, which is how three tablets were handed
// the same place and how an XRGL40 card inherited an RLL position.
async function autoSuggestTrolley() {
  const tn = document.getElementById('inp-trolley-no');
  const tp = document.getElementById('inp-trolley-pos');
  try {
    const { data, error } = await supabaseClient.rpc('bc_next_free_trolley',
      { p_card_type: state.cardType, p_operator: state.operator || null });
    if (error) {
      if (_isMissingFn(error)) { _claimFnMissing = true; return _autoSuggestTrolleyOld(); }
      throw error;
    }
    if (!data || !data.ok) {
      showToast('⚠ ' + ((data && data.error) || 'No free trolley position'), 'warn');
      return;
    }
    if (tn) tn.value = String(data.trolley);
    if (tp) tp.value = String(data.position);
    state.formData.trolley_number = String(data.trolley);
    state.formData.trolley_position = String(data.position);
    await _claimPlace(data.trolley, data.position);   // v1.49: the PLACE, not the trolley
    _markTrolleysInUse();
  } catch (e) {
    console.warn('[Trolley] next place failed — falling back', e);
    return _autoSuggestTrolleyOld();
  }
}

// the v1.47 guess, kept only for a tablet whose database has not had
// trolley_claim_23Nov.sql / trolley_next_place_v2_23Nov.sql run on it yet
async function _autoSuggestTrolleyOld() {
  try {
    const {data}=await supabaseClient.from('weapon_builds')
      .select('trolley_number,trolley_position')
      .eq('card_type', state.cardType)                 // v1.48: at least scope it
      .not('trolley_number','is',null)
      .order('created_at',{ascending:false}).limit(1);
    let t=1,p=1;
    if(data&&data.length>0&&data[0].trolley_number){t=data[0].trolley_number;p=(data[0].trolley_position||0)+1;if(p>56){t++;p=1;}if(t>20)t=20;}
    const tn=document.getElementById('inp-trolley-no'); if(tn) tn.value=t;
    const tp=document.getElementById('inp-trolley-pos'); if(tp) tp.value=p;
    state.formData.trolley_number=String(t); state.formData.trolley_position=String(p);
  } catch(e){}
}

async function handleTrolleyChange() {
  // v1.37 (14/11/2026): a gun that already has a place may only be moved with
  // the Admin PIN — asked here, before anything else happens
  if (_hasSavedPlace()) { checkTrolleyPositionCollision(true); return; }
  // v1.49: picking a trolley by hand claims NOTHING — a trolley is shared by
  // several men. Whatever place this tablet was holding on the old trolley is
  // let go, and the new place is claimed when the position is picked below
  // (checkTrolleyPositionCollision).
  await _releasePlace();
  _markTrolleysInUse();
  // a new card: no position until one is picked (it used to jump to Pos 1,
  // which is usually already taken)
  const tp=document.getElementById('inp-trolley-pos'); if(tp) tp.value='';
  state.formData.trolley_position = null;
  scheduleAutoSave();
}

// ─── TROLLEY CLAIM (v1.48, 23/11/2026) ────────────────────────────────────────
// Floor 23/11/2026 (Gerhard): "if 3 pads are working they save over each
// other's work — it does open a trolley number when somebody else has it open
// as well. As soon as a trolley has been opened by an operator it needs to say
// it is in use by whom, and the next number must become available."
//
// WHY v1.37 DID NOT COVER IT
//   _createBuildRow() refuses to create a card with no serial, so UNTIL THE
//   SERIAL IS SAVED THE CARD DOES NOT EXIST IN THE DATABASE. Its trolley and
//   position live only on that tablet. checkTrolleyPositionCollision() looks in
//   weapon_builds, finds nothing — the other tablets have written no row either
//   — and lets it through. Three men can all be on Trolley 12 / Pos 14 and none
//   can see the other two. LIVE showed 25 pairs of cards started on the same
//   trolley by different operators inside two minutes.
//   And autoSuggestTrolley() took "the last created card + 1" WITHOUT FILTERING
//   BY CARD TYPE, so an XRGL40 card could inherit a position from an RLL one.
//
// THE CLAIM EXISTS BEFORE THE CARD DOES — trolley_claims, written the moment a
// place is taken on screen (trolley_claim_23Nov.sql + trolley_next_place_v2).
// If the SQL is not loaded the tablet behaves exactly as v1.47 did.
// ── v1.49, 23/11/2026 night: A PLACE IS CLAIMED, NOT A TROLLEY ──────────────
// v1.48 locked the whole trolley to one operator. A trolley holds 56 guns and
// several men fill the same trolley at once, so the first man to open a card
// took all 56 places and everybody else was told "Trolley 4 is in use by
// OP 019" and pushed onto an empty trolley. That stopped the XRGL40 floor on
// 23/11. What was always meant was the thing Gerhard actually said — "THE SAME
// SAVE ON THE SAME TROLLY POS OPENED" — one PLACE, not one trolley.
let _trolleyClaim = null;        // { card_type, trolley, position, until }
let _claimFnMissing = false;     // the claim SQL is not on this database

// hand back the place this tablet is holding
async function _releasePlace() {
  const c = _trolleyClaim;
  _trolleyClaim = null;
  if (!c || _claimFnMissing || !state.operator) return;
  try {
    await supabaseClient.rpc('bc_place_release', {
      p_card_type: c.card_type, p_trolley: c.trolley,
      p_position: c.position, p_operator: state.operator });
  } catch (e) { console.warn('[PlaceClaim] release failed', e); }
}

// claim ONE place for this operator. true = it is ours to build on.
// false = somebody is already on it; the boxes have been moved to the next one.
async function _claimPlace(trolley, position, _hop) {
  if (_claimFnMissing || !state.operator || !trolley || !position) return true;
  // a hop limit, so a busy moment can never turn into an endless walk
  const hop = (_hop || 0) + 1;
  if (hop > 25) { showToast('⚠ Could not find a free place — pick one by hand', 'error'); return false; }
  try {
    const { data, error } = await supabaseClient.rpc('bc_place_claim', {
      p_card_type: state.cardType, p_trolley: parseInt(trolley, 10),
      p_position: parseInt(position, 10),
      p_operator: state.operator, p_minutes: 90,
      p_build_id: state.buildId || null });
    if (error) {
      if (_isMissingFn(error)) { _claimFnMissing = true; return true; }   // SQL not loaded
      console.warn('[PlaceClaim]', error);
      return true;                      // never block the floor on a claim error
    }
    if (data && data.ok) {
      _trolleyClaim = { card_type: state.cardType, trolley: parseInt(trolley, 10),
                        position: parseInt(position, 10), until: data.until };
      return true;
    }
    // somebody is on that place — say who, and move to the next free one
    const who = (data && data.in_use_by) || null;
    const next = (data && data.next) || null;
    // The whole PLACE must differ, trolley and position both. Comparing the
    // position alone was wrong: Trolley 4 / Pos 1 taken, next free Trolley 5 /
    // Pos 1 — same number, different place — and the man was told "taken" and
    // left standing instead of being moved. Pos 1 of one trolley after another
    // is exactly what a back-capture does.
    const samePlace = next && String(next.trolley) === String(trolley)
                           && String(next.position) === String(position);
    if (next && next.ok && !samePlace) {
      const tn = document.getElementById('inp-trolley-no');
      const tp = document.getElementById('inp-trolley-pos');
      if (tn) tn.value = String(next.trolley);
      if (tp) tp.value = String(next.position);
      state.formData.trolley_number = String(next.trolley);
      state.formData.trolley_position = String(next.position);
      showToast((who ? `🔒 Trolley ${trolley} / Pos ${position} is being built by OP ${who}`
                     : `🔒 Trolley ${trolley} / Pos ${position} already has a gun on it`)
                + ` — moved you to Trolley ${next.trolley} / Pos ${next.position}`, 'warn');
      return await _claimPlace(next.trolley, next.position, hop);
    }
    showToast('🔒 ' + ((data && data.error) || `Trolley ${trolley} / Pos ${position} is taken`), 'error');
    return false;
  } catch (e) {
    console.warn('[PlaceClaim] claim failed', e);
    return true;                        // never block the floor
  }
}

// how full each trolley is, and how many men are on it, for the Trolley No
// dropdown. v1.49: a trolley is NEVER shown as locked to one man — several men
// share a trolley. It shows what is left and who is on it.
async function _markTrolleysInUse() {
  if (_claimFnMissing || !state.cardType) return;
  const tSel = document.getElementById('inp-trolley-no');
  if (!tSel) return;
  try {
    const { data, error } = await supabaseClient.rpc('bc_trolley_state',
      { p_card_type: state.cardType });
    if (error) { if (_isMissingFn(error)) _claimFnMissing = true; return; }
    (data || []).forEach(row => {
      const opt = [...tSel.options].find(o => o.value === String(row.trolley));
      if (!opt) return;
      const places = row.on_places || {};
      const mine = Object.keys(places).filter(k => places[k] === state.operator);
      const men  = row.builders || 0;
      opt.textContent = `Trolley ${row.trolley}`
        + (row.next_free === null ? '  (full)'
           : `  — next free Pos ${row.next_free}`)
        + (men ? `  · ${men} building` : '')
        + (mine.length ? `  · you on Pos ${mine.join(', ')}` : '');
    });
  } catch (e) { /* the dropdown just stays plain */ }
}

// ─── TROLLEY / POSITION GATE (v1.37, 14/11/2026) ──────────────────────────────
// Floor 14/11/2026: guns were nearly mixed up when trolley positions were
// changed. Gerhard's rules (also enforced in the database — trolley_gate_14Nov.sql):
//   • a position is TAKEN as soon as a build card sits there (any status);
//   • another serial cannot go on a taken position without the Admin PIN —
//     "wrong serial on the wrong place";
//   • a gun that already has a place cannot be moved (or taken off its place)
//     without the Admin PIN, even to an empty position.
// Before v1.37 this was only a warning on a NEW card, and Cancel carried on.
function _hasSavedPlace() {
  const b = state._idBase || {};
  return !!state.buildId && b.trolley_number != null && String(b.trolley_number) !== ''
                         && b.trolley_position != null && String(b.trolley_position) !== '';
}
function _gunSerial() { return _unitIdentifierSerial() || 'this gun'; }
// put the trolley / position boxes back where the gun is
function _trolleyRevert() {
  const b = state._idBase || {};
  const tn = document.getElementById('inp-trolley-no'), tp = document.getElementById('inp-trolley-pos');
  if (_hasSavedPlace()) {
    if (tn) tn.value = String(b.trolley_number);
    if (tp) tp.value = String(b.trolley_position);
    state.formData.trolley_number = b.trolley_number;
    state.formData.trolley_position = b.trolley_position;
  } else {
    if (tp) tp.value = '';
    state.formData.trolley_position = null;
  }
}
// Admin PIN → approval in the database (15 minutes). true = allowed.
let _trolleyApprovedFor = null;     // { buildId, until } — one PIN covers trolley + position
async function _trolleyAdminApprove(msg, buildId, t, p) {
  const pin = prompt(`${msg}\n\nEnter the ADMIN PIN to allow it — or Cancel to leave it as it was:`);
  if (pin === null || !String(pin).trim()) { showToast('Cancelled — the gun stays where it was', 'warn'); return false; }
  try {
    const { data, error } = await supabaseClient.rpc('trolley_override_approve', {
      p_build_id: buildId || null, p_card_type: state.cardType,
      p_trolley: buildId ? null : parseInt(t, 10), p_pos: buildId ? null : parseInt(p, 10),
      p_operator: state.operator, p_admin_pin: String(pin).trim(), p_reason: 'tablet: ' + msg.split('\n')[0]
    });
    if (error) {
      if (typeof _isMissingFn === 'function' && _isMissingFn(error)) return true;   // gate SQL not loaded yet
      throw error;
    }
    if (!data || !data.ok) { showToast('🚫 ' + ((data && data.msg) || 'Not allowed'), 'error'); return false; }
    if (buildId) _trolleyApprovedFor = { buildId, until: Date.now() + 14 * 60000 };
    showToast('🔓 Admin approved — trolley / position change allowed', 'ok');
    return true;
  } catch (e) {
    showToast('⚠ Could not check the Admin PIN — ' + ((e && e.message) || e), 'error');
    return false;
  }
}
// readable text for a database refusal ("TROLLEY_GATE: …")
function _trolleyGateError(err) {
  const m = String((err && (err.message || err.details)) || '');
  const i = m.indexOf('TROLLEY_GATE:');
  return i >= 0 ? m.slice(i + 13).trim() : null;
}

// Fires when trolley or position is changed. moving = trolley box changed on
// a gun that already has a place.
async function checkTrolleyPositionCollision(moving) {
  if (typeof _autoSaveTimer !== 'undefined' && _autoSaveTimer) clearTimeout(_autoSaveTimer);   // nothing saved until decided
  const t = document.getElementById('inp-trolley-no')?.value;
  const p = document.getElementById('inp-trolley-pos')?.value;

  // ── A gun that already has a place: moving it needs the Admin PIN ──
  if (_hasSavedPlace()) {
    const b = state._idBase;
    if (!moving && String(b.trolley_number) === String(t) && String(b.trolley_position) === String(p)) return;
    const ok = (_trolleyApprovedFor && _trolleyApprovedFor.buildId === state.buildId && Date.now() < _trolleyApprovedFor.until)
      || await _trolleyAdminApprove(
           `🚫 ${_gunSerial()} is on Trolley ${b.trolley_number} / Pos ${b.trolley_position}.\n` +
           `Moving a gun to another trolley or position needs the Admin PIN.`, state.buildId, t, p);
    if (!ok) { _trolleyRevert(); return; }
    if (moving) {                                   // trolley changed → pick the new position
      const tp = document.getElementById('inp-trolley-pos'); if (tp) tp.value = '';
      state.formData.trolley_position = null;
      return;
    }
    // fall through: also tell them if the new place already holds another gun
  }
  if (!t || !p) return;

  try {
    // any card on this place, any status — another serial = wrong place
    const { data } = await supabaseClient.from('weapon_builds')
      .select('id,launcher_serial,sight_serial,operator_number,status')
      .eq('trolley_number', parseInt(t)).eq('trolley_position', parseInt(p))
      .eq('card_type', state.cardType).limit(5);
    const mine = String(_unitIdentifierSerial() || '').toUpperCase();
    const other = (data || []).find(r => r.id !== state.buildId &&
      String((state.cardType === 'GRN40' ? r.sight_serial : r.launcher_serial) || '').toUpperCase() !== mine);
    if (!other) {
      // v1.49: no gun on this place — claim it for this man so the next tablet
      // is sent past it instead of onto it. A gun that already has its place
      // keeps it; only a card still being placed claims.
      if (!_hasSavedPlace()) {
        const got = await _claimPlace(t, p);
        if (!got) return;                  // the toast said who is on it
      }
      if (_hasSavedPlace() || state.buildId) scheduleAutoSave(400);
      return;
    }
    const oSerial = (state.cardType === 'GRN40' ? other.sight_serial : other.launcher_serial) || '(serial not entered)';
    const oStatus = String(other.status || 'IN PROGRESS').toUpperCase();
    // a NEW card on an unfinished card's place: offer that card first (as before)
    if (!state.buildId && oStatus !== 'COMPLETE' &&
        confirm(`⚠ Trolley ${t} / Pos ${p} already has a card:\n\n  Serial: ${oSerial}\n  Started by: OP ${other.operator_number}\n` +
                `  Status: ${oStatus}\n\nTap OK to open THAT card.\nCancel = this is a different gun (needs the Admin PIN).`)) {
      loadBuild(other.id); return;
    }
    // already approved for this gun (moving) → that covers it
    if (state.buildId && _trolleyApprovedFor && _trolleyApprovedFor.buildId === state.buildId && Date.now() < _trolleyApprovedFor.until) {
      scheduleAutoSave(400); return;
    }
    const ok = await _trolleyAdminApprove(
      `🚫 WRONG PLACE — Trolley ${t} / Pos ${p} already has ${oSerial} (${oStatus}).\n` +
      `${_gunSerial()} is the wrong serial for this place.`, null, t, p);
    if (!ok) { _trolleyRevert(); return; }
    if (state.buildId) scheduleAutoSave(400);
  } catch(e) {
    console.warn('[TrolleyGate] Check failed:', e);
  }
}

function populateYear() {
  const sel=document.getElementById('inp-year'); if(!sel||sel.options.length>1) return;
  sel.innerHTML='<option value="">— Select —</option>';
  const y=new Date().getFullYear();
  for(let i=y;i<=y+2;i++) sel.innerHTML+=`<option value="${i}">${i}</option>`;
  if(!state.formData.year_of_manufacture) sel.value=y;
}

// ─── COUNTRY DROPDOWN — self-service list, purely descriptive ────────────────
// Sourced from a small "countries" table the admin maintains directly in
// Supabase (no code change needed to add a new country). Country has NO
// effect on serial validation — it is printed on the card only.
async function loadCountries() {
  try {
    const {data} = await supabaseClient
      .from('countries')
      .select('name')
      .order('name');
    const sel = document.getElementById('inp-country'); if (!sel) return;
    sel.innerHTML = '<option value="">— Select Country —</option>';
    (data || []).forEach(c => sel.innerHTML += `<option value="${c.name}">${c.name}</option>`);
    if (state.formData.client_country) sel.value = state.formData.client_country;
  } catch(e) {
    console.warn('[loadCountries] Failed:', e);
  }
}

// ─── CONTRACT DROPDOWN — self-service list, but LIVE-LINKED to serials ───────
// Sourced from "bluecard_contracts" (admin-maintained in Supabase).
// IMPORTANT: the contract name selected here is the exact key checked against
// weapon_serials.project for the serial hard-block.
//
// CARD-TYPE AWARE: one customer contract can hold more than one product under
// the SAME name — e.g. "XRGL40 Colombia 2026" has XRGL40 launchers (guns) AND
// GRN40 sights. weapon_serials.card_type is what separates them. So:
//   - the dropdown only lists contracts that have serials for the card type
//     this operator logged in with, labelled "— Launchers" / "— Sights";
//   - the option VALUE stays the plain contract name (what gets saved);
//   - serial checks only ever look at serials of this card type.
// Serials loaded before card_type was filled in (card_type null) still count,
// so older contracts keep working.
const PRODUCT_LABEL = { RLL: 'Launchers', XRGL40: 'Launchers', GRN40: 'Sights' };

function _contractLabel(name) {
  const p = PRODUCT_LABEL[state.cardType];
  return p ? `${name} — ${p}` : name;
}

async function loadContracts() {
  try {
    const {data} = await supabaseClient
      .from('bluecard_contracts')
      .select('name')
      .order('name');
    const all = (data || []).map(c => c.name).filter(Boolean);

    // Which contracts have serials for THIS card type? One small count query
    // per contract (head:true = count only, no rows) — avoids Supabase's
    // 1000-row page limit on a big serial register.
    // Listed if it has serials of this card type — or, for an older contract
    // whose serials were loaded with NO card_type at all, listed as before
    // (a contract with typed serials of another product is NOT listed here).
    const countWhere = async (name, typeFilter) => {
      const {count} = await typeFilter(supabaseClient.from('weapon_serials')
        .select('serial_number', {count: 'exact', head: true})
        .eq('project', name));
      return count || 0;
    };
    const checks = await Promise.all(all.map(async name => {
      try {
        if (await countWhere(name, q => q.eq('card_type', state.cardType)) > 0) return name;
        const typed   = await countWhere(name, q => q.not('card_type', 'is', null));
        const untyped = await countWhere(name, q => q.is('card_type', null));
        return (typed === 0 && untyped > 0) ? name : null;
      } catch (e) { return name; }   // can't tell — don't hide it
    }));
    let names = checks.filter(Boolean);
    // Safety net: if nothing matched (e.g. serials not loaded yet for any
    // contract), fall back to the full list, as before this change.
    if (names.length === 0) names = all;
    // A resumed card keeps its saved contract visible even if it no longer matches
    if (state.formData.contract_name && !names.includes(state.formData.contract_name)) {
      names = [state.formData.contract_name, ...names];
    }

    const sel = document.getElementById('inp-contract'); if (!sel) return;
    sel.innerHTML = '<option value="">— Select Contract —</option>';
    names.forEach(n => sel.innerHTML += `<option value="${n}">${_contractLabel(n)}</option>`);
    if (state.formData.contract_name) {
      sel.value = state.formData.contract_name;
      // Load serials for the restored contract
      await loadSerialsForProject(state.formData.contract_name);
    }
  } catch(e) {
    console.warn('[loadContracts] Failed:', e);
  }
}

// ─── SERIAL-PROJECT LINKING ────────────────────────────────────────────────────
// When operator selects a contract, load the serial numbers for that project
// AND this card type. validateSerialExists() then checks only within these,
// so a launcher serial can never be accepted on a sight card or vice versa,
// even though both products share one contract name.
state._projectSerials = null; // null = no project selected yet (check all)

async function loadSerialsForProject(project) {
  if (!project) { state._projectSerials = null; return; }
  try {
    // Paged — Supabase returns max 1000 rows per request, and a contract
    // can have more serials than that.
    const PAGE = 1000;
    let rows = [], from = 0;
    while (true) {
      const {data, error} = await supabaseClient
        .from('weapon_serials')
        .select('serial_number,status,card_type')
        .eq('project', project)
        .or(`card_type.eq.${state.cardType},card_type.is.null`)
        .order('serial_number')
        .range(from, from + PAGE - 1);
      if (error) throw error;
      rows = rows.concat(data || []);
      if (!data || data.length < PAGE) break;
      from += PAGE;
    }
    state._projectSerials = rows;
    const count = rows.length;
    const statusEl = document.getElementById('ocr-status');
    if (statusEl) {
      statusEl.textContent =
        `📋 ${_contractLabel(project)} — ${count} serial(s) available for this contract`;
    }
    console.log(`[SerialProject] Loaded ${count} ${state.cardType} serials for "${project}"`);
  } catch(e) {
    console.warn('[SerialProject] Failed to load serials:', e);
    state._projectSerials = null;
  }
}

// ─── CHECKS ───────────────────────────────────────────────────────────────────
// 23/10/2026 (v1.22): the unit you are working on, carried onto the Checks
// and Sign-off pages — serial large, trolley/position and contract under it,
// and the serial in the sticky top bar so it stays visible while scrolling.
// Identity page only; FAT and PDI are a separate process and are untouched.
function updateUnitStrip() {
  const serial = _unitIdentifierSerial();
  const cfg = getCardConfig();
  const kind = state.cardType === 'GRN40' ? 'Sight' : 'Launcher';
  const tp = `Trolley ${state.formData.trolley_number || '—'} · Pos ${state.formData.trolley_position || '—'}`;
  const contract = state.formData.contract_name
    ? `${state.formData.contract_name}${state.formData.client_country ? ' · ' + state.formData.client_country : ''}`
    : 'No contract selected';
  ['unit-strip-checks', 'unit-strip-signoff'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    if (!serial) {
      el.className = 'unit-strip unit-strip-none';
      el.innerHTML = `<div class="unit-strip-serial">NO SERIAL CONFIRMED</div>
                      <div class="unit-strip-sub">Go to Identity and confirm the ${kind.toLowerCase()} serial with ✓ first</div>`;
      return;
    }
    el.className = 'unit-strip';
    el.innerHTML = `<div class="unit-strip-kind">${kind} serial</div>
                    <div class="unit-strip-serial">${serial}</div>
                    <div class="unit-strip-sub">${tp} &nbsp;·&nbsp; ${contract} &nbsp;·&nbsp; ${cfg.label || state.cardType}</div>`;
  });
  const ct = document.getElementById('checks-title');
  if (ct) ct.textContent = serial ? `${serial}` : 'Inspection Checks';
}

function refreshChecks() {
  const cfg=getCardConfig();
  const container=document.getElementById('checks-list');
  const total = cfg.stages ? cfg.stages.length : cfg.checks.length;
  updateUnitStrip();

  // Always rebuild from state.checks. The old shortcut re-used the rows
  // already on screen and only re-applied ticks that the new card HAD —
  // ticks the previous card had and this one does not were left showing,
  // so one gun's ticks appeared to carry over to the next.
  container.innerHTML='';

  if(state.cardType==='GRN40') {
    buildGRN40Stages(container, cfg.stages);
  } else {
    buildCheckRows(container, cfg.checks);
  }
  updateChecksProgress();
}

function buildCheckRows(container, checks) {
  checks.forEach(chk=>{
    const saved=state.checks[chk.id]||{};
    const row=document.createElement('div');
    row.className='check-row'; row.id=`chk-row-${chk.id}`;
    const measField=chk.type==='measurement'?`
      <input type="text" id="chk-val-${chk.id}" placeholder="Value (${chk.unit})"
             value="${saved.value||''}" onchange="setCheckValue('${chk.id}',this.value)"
             style="width:100%;border:none;border-bottom:1px solid var(--border);
                    background:transparent;font-size:12px;padding:3px 2px;margin-top:6px;outline:none;color:var(--text);">`:'' ;
    // v1.38 (14/11/2026, QMS): PASS / FAIL belong to FAT and PDI — on the
    // build Checks the buttons READ "COMPLETED" / "NOT COMPLETED". Only the
    // words change: the card still stores PASS / FAIL (val1 / val2), so every
    // card, report, rule and the FAT / PDI pages work exactly as before.
    const btnLabel1=chk.type==='go_nogo'?'GO':'COMPLETED';
    const btnLabel2=chk.type==='go_nogo'?'NO-GO':'NOT COMPLETED';
    const val1=chk.type==='go_nogo'?'GO':'PASS';
    const val2=chk.type==='go_nogo'?'NO-GO':'FAIL';
    row.innerHTML=`
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:8px;">
        <span class="check-label" style="margin:0;">${chk.label}</span>
        <div class="assy-stamp" id="assy-${chk.id}" onclick="editAssyNo('${chk.id}')"
             style="font-size:10px;font-family:var(--font-mono);color:var(--text-dim);
                    background:var(--bg);border:1px solid var(--border);border-radius:4px;
                    padding:2px 6px;cursor:pointer;flex-shrink:0;white-space:nowrap;">
          OP ${saved.assy_no||state.operator||'—'}
        </div>
      </div>
      ${measField}
      ${saved.rework_note?`<div style="font-size:11px;color:#1a9e5c;margin-top:6px;">🔧 Reworked by OP ${saved.rework_by||'?'}: ${String(saved.rework_note).replace(/</g,'&lt;')}</div>`:''}
      <div class="check-btns" style="margin-top:8px;">
        <button class="chk-btn pass" onclick="setCheck('${chk.id}','${val1}')">${btnLabel1}</button>
        <button class="chk-btn fail" onclick="setCheck('${chk.id}','${val2}')">${btnLabel2}</button>
        <!-- v1.38 (14/11/2026): N/A button removed — never used on any card (LIVE 14 Nov: 0 of 6,088 checks) -->
      </div>`;
    container.appendChild(row);
    if(saved.result) applyCheckVisual(chk.id);
  });
}

function buildGRN40Stages(container, stages) {
  // GRN40: grid of stage cards with Tech No input
  const grid=document.createElement('div');
  grid.style.cssText='display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;';
  stages.forEach(s=>{
    const saved=state.checks[s.id]||{};
    const card=document.createElement('div');
    card.id=`chk-row-${s.id}`;
    card.style.cssText='background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:8px;';
    card.innerHTML=`
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:6px;">
        <div style="font-size:10px;font-weight:800;color:var(--text);line-height:1.3;margin-bottom:2px;">${s.label}</div>
        <div class="assy-stamp" id="assy-${s.id}" onclick="editAssyNo('${s.id}')"
             style="font-size:9px;font-family:var(--font-mono);color:var(--text-dim);
                    background:var(--bg);border:1px solid var(--border);border-radius:4px;
                    padding:2px 5px;cursor:pointer;flex-shrink:0;white-space:nowrap;">
          OP ${saved.assy_no||state.operator||'—'}
        </div>
      </div>
      ${s.process?`<div style="font-size:9px;color:var(--text-dim);margin-bottom:4px;">${s.process}</div>`:''}
      <div style="font-size:9px;color:var(--text-dim);margin-bottom:6px;font-family:var(--font-mono);">${s.partNo}</div>
      ${saved.rework_note?`<div style="font-size:9px;color:#1a9e5c;margin-bottom:4px;">🔧 OP ${saved.rework_by||'?'}: ${String(saved.rework_note).replace(/</g,'&lt;')}</div>`:''}
      <div class="check-btns" style="margin-top:6px;gap:4px;">
        <button class="chk-btn pass" onclick="setCheck('${s.id}','PASS')" style="font-size:9px;padding:5px 2px;">✓</button>
        <button class="chk-btn fail" onclick="setCheck('${s.id}','FAIL')" style="font-size:9px;padding:5px 2px;">✗</button>
        <button class="chk-btn na"   onclick="setCheck('${s.id}','N/A')"  style="font-size:9px;padding:5px 2px;">—</button>
      </div>`;
    if(saved.result) applyCheckVisual(s.id);
    grid.appendChild(card);
  });
  container.appendChild(grid);
}

// ─── FAIL RULES (21/10/2026, v1.21) ──────────────────────────────────────────
// A FAIL / NO-GO is a defect on the unit. It is cleared ONLY by re-marking
// the check PASS / GO after rework, with a compulsory note of what was found
// and what was done (logged CHECK_REWORKED, kept on the check). N/A is never
// a way out of a FAIL, and never replaces a PASS — N/A is only for a check
// that has not been marked. A FAIL cannot be un-ticked. While any check is
// FAIL the card cannot be signed off, so it can never reach FAT or PDI.
const _FAIL_RESULTS = ['FAIL', 'NO-GO'];
const _PASS_RESULTS = ['PASS', 'GO'];
function _isFail(r) { return _FAIL_RESULTS.includes(r); }
// v1.38: what the operator sees for a stored result on the Checks page
function _chkWord(r) { return r === 'PASS' ? 'COMPLETED' : r === 'FAIL' ? 'NOT COMPLETED' : r; }
function _isPass(r) { return _PASS_RESULTS.includes(r); }
function openFails() {
  const cfg = getCardConfig();
  const defs = cfg.checks || cfg.stages || [];
  return defs.filter(c => _isFail((state.checks[c.id] || {}).result));
}

function setCheck(id,result) {
  if(!state.checks[id]) state.checks[id]={};
  const prevResult = state.checks[id].result;
  const prevOp = state.checks[id].assy_no;
  const cfgDef = (getCardConfig().checks || getCardConfig().stages || []).find(c => c.id === id);
  const labelNow = cfgDef ? cfgDef.label : id;

  // ── Strict FAIL rules ──
  if (_isFail(prevResult)) {
    if (result === prevResult) { showToast(`${_chkWord(prevResult)} cannot be cleared — fix it, then tap ${prevResult === 'NO-GO' ? 'GO' : 'COMPLETED'} and record what was done`, 'error'); return; }
    if (result === 'N/A')      { showToast('N/A is not allowed on a failed check — it must be fixed and re-marked PASS', 'error'); return; }
    if (_isPass(result)) {
      const noteRaw = prompt(
        `REWORK — ${labelNow}\n\nThis check was marked ${_chkWord(prevResult)}.\n` +
        `Describe what was found and what was done to fix it (required):`);
      if (noteRaw === null) return;
      const note = noteRaw.trim();
      if (!note) { showToast(`A rework description is required before it can be marked ${_chkWord(result)}`, 'error'); return; }
      state.checks[id].rework_note = note;
      state.checks[id].rework_by   = state.operator;
      state.checks[id].rework_at   = new Date().toISOString();
      state.checks[id].failed_by   = prevOp || null;
    }
  } else if (result === 'N/A' && _isPass(prevResult)) {
    showToast('N/A cannot replace a PASS — tap PASS again to clear it first', 'error'); return;
  }
  const reworked = _isFail(prevResult) && _isPass(result);

  // Tapping the button that is already selected UNTICKS the check — the
  // result is cleared, the count drops, and the card can be signed off only
  // once it has been marked again. (Measurement values are kept.)
  const clearing = (prevResult === result);
  if (clearing) {
    delete state.checks[id].result;
    delete state.checks[id].assy_no;
    delete state.checks[id].timestamp;
    if (Object.keys(state.checks[id]).length === 0) delete state.checks[id];
  } else {
    state.checks[id].result=result;
    // Always stamp the CURRENT operator — whoever last changed a result gets
    // credited for it.
    state.checks[id].assy_no=state.operator;
    state.checks[id].timestamp=new Date().toISOString();
  }
  applyCheckVisual(id); updateChecksProgress(); updateNavBadges();
  const stamp=document.getElementById(`assy-${id}`);
  if(stamp) stamp.textContent=`OP ${(state.checks[id]&&state.checks[id].assy_no)||state.operator}`;
  if (clearing) showToast('Check cleared — tap it again to mark it', 'warn');
  // Auto-persist to DB on every check tap — so half-filled cards survive.
  // v1.35: only this check (and any other this tablet changed) is sent; the
  // database merges it into the card, so ticks made on another tablet stay.
  _markCheckDirty(id);
  if (state.buildId) {
    _flushChecks().then(r => {
      if (r && r.error && !r.error.locked) showToast('Auto-save failed','warn');
    });
    // Keep weapon_serials in sync so serial register shows correct progress
    const regSerial = _unitIdentifierSerial();
    if (regSerial) {
      const cfg=getCardConfig();
      const total=cfg.stages?cfg.stages.length:cfg.checks.length;
      const done=Object.values(state.checks).filter(v=>v&&v.result).length;
      const pct=total>0?Math.round(done/total*100):0;
      // Only update to COMPLETE via handleSubmit — here just ensure IN PROGRESS.
      // open_fails = checks currently FAIL/NO-GO (shown on the Project Dashboard)
      supabaseClient.from('weapon_serials')
        .update({status:'IN PROGRESS', checks_done:done, checks_total:total, pct_complete:pct,
                 open_fails: openFails().length})
        .eq('serial_number', regSerial)
        .or('status.is.null,status.neq.COMPLETE')   // v1.35: never undo a sign-off
        .then(()=>{});
    }
  }
  // Log individual check action with full detail
  const cfg=getCardConfig();
  const checkDef = (cfg.checks||cfg.stages||[]).find(c=>c.id===id);
  const label = checkDef ? checkDef.label : id;
  logActivity(clearing ? 'CHECK_CLEARED' : (reworked ? 'CHECK_REWORKED' : 'CHECK_MARKED'), null, {
    check_id: id,
    check_label: label,
    result: clearing ? 'UNMARKED' : result,
    prev_result: prevResult || 'UNMARKED',
    assy_no: clearing ? state.operator : state.checks[id].assy_no,
    prev_assy_no: prevOp || 'none',
    rework_note: reworked ? state.checks[id].rework_note : undefined,
    timestamp: clearing ? new Date().toISOString() : state.checks[id].timestamp
  });
}

function setCheckValue(id,value) { if(!state.checks[id]) state.checks[id]={}; state.checks[id].value=value; _markCheckDirty(id); }

// ─── v1.45 (21/11/2026, Gerhard) — the Assy No must be a REAL operator ───────
// This box took whatever was typed and stored it. "007" was entered as "07" on
// 20 checks, so Matrix counted one man as two people. An Assy No says WHO did
// the work, so an unchecked one is worthless as evidence.
// Now: the number is read as a number and written three-wide (7, 07 and 007 are
// one man; 70 is somebody else), and it must exist in the operator list
// (assemblers). Anything else is refused and NOTHING on the card is changed.
let _opList = null;          // [{operator_number, name}] — read once per session

function _opNo(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  return /^[0-9]+$/.test(s) ? String(parseInt(s, 10)).padStart(3, '0') : s;
}

async function _operators(force) {
  if (_opList && !force) return _opList;
  try {
    const list = (typeof getAssemblers === 'function')
      ? await getAssemblers()
      : ((await supabaseClient.from('assemblers').select('operator_number,name')).data || []);
    _opList = (list || []).map(a => ({ no: _opNo(a.operator_number),
                                       name: (a.name || '').trim() }))
                          .filter(a => a.no);
  } catch (e) {
    console.warn('[AssyNo] operator list', e);
    _opList = null;          // not read — try again next time, never guess
  }
  return _opList;
}

async function editAssyNo(id) {
  const current=state.checks[id]?.assy_no||state.operator;
  const raw=prompt(`Assy No for this check:\nCurrently: OP ${current}\n\nEnter operator number:`);
  if(!raw||!raw.trim()) return;
  const newNo=_opNo(raw);

  // the operator list decides — no list, no change
  let ops = await _operators();
  if (!ops) {
    showToast('⚠ Could not check the operator list — nothing changed. Check Wi-Fi and try again.', 'error');
    return;
  }
  let who = ops.find(a => a.no === newNo);
  if (!who) {
    // not in the list we hold — it may have been added since, so read it again
    ops = await _operators(true);
    if (!ops) {
      showToast('⚠ Could not check the operator list — nothing changed. Check Wi-Fi and try again.', 'error');
      return;
    }
    who = ops.find(a => a.no === newNo);
  }
  if (!who) {
    showToast(`🚫 ${raw.trim()} is not an operator number — nothing changed`, 'error');
    return;
  }

  const prev = state.checks[id]?.assy_no || state.operator;
  if (_opNo(prev) === newNo) { showToast(`Already OP ${newNo}`, 'warn'); return; }
  if(!state.checks[id]) state.checks[id]={};
  state.checks[id].assy_no=newNo;
  _markCheckDirty(id); if (state.buildId) _flushChecks();   // v1.35
  const stamp=document.getElementById(`assy-${id}`); if(stamp) stamp.textContent=`OP ${newNo}`;
  showToast(`Assy No → OP ${newNo}${who.name ? ' · ' + who.name : ''}`,'ok');
  // Log the operator reassignment
  const cfg=getCardConfig();
  const checkDef = (cfg.checks||cfg.stages||[]).find(c=>c.id===id);
  const label = checkDef ? checkDef.label : id;
  logActivity('ASSY_NO_CHANGED', null, {
    check_id: id,
    check_label: label,
    changed_from: prev,
    changed_to: newNo,
    by_operator: state.operator,
    timestamp: new Date().toISOString()
  });
}

function applyCheckVisual(id) {
  const row=document.getElementById(`chk-row-${id}`); if(!row) return;
  const chkData=state.checks[id];
  if(!chkData||!chkData.result){
    // No result on THIS card — make sure nothing is shown as selected
    row.removeAttribute('data-result');
    row.querySelectorAll('.chk-btn').forEach(b=>b.classList.remove('selected'));
    return;
  }
  const result=chkData.result;
  const isPass=result==='PASS'||result==='GO';
  const isFail=result==='FAIL'||result==='NO-GO';
  row.setAttribute('data-result',isPass?'PASS':isFail?'FAIL':'N/A');
  row.querySelectorAll('.chk-btn').forEach(b=>b.classList.remove('selected'));
  // v1.38: by the button's kind (pass / fail / na), not its text — the text now
  // reads COMPLETED / NOT COMPLETED while the stored result stays PASS / FAIL
  const want = isPass ? 'pass' : isFail ? 'fail' : 'na';
  row.querySelectorAll('.chk-btn').forEach(b=>{ if (b.classList.contains(want)) b.classList.add('selected'); });
}

function updateChecksProgress() {
  const cfg=getCardConfig();
  const total=cfg.stages?cfg.stages.length:cfg.checks.length;
  const done=Object.values(state.checks).filter(v=>v&&v.result).length;
  const fails=Object.values(state.checks).filter(v=>v&&(v.result==='FAIL'||v.result==='NO-GO')).length;
  const el=document.getElementById('checks-progress');
  if(el) el.textContent=`${done}/${total}${fails>0?` · ${fails} ✗`:''}`;   // v1.38: short — the top bar is narrow
}

async function saveChecks() {
  const cfg=getCardConfig();
  const total=cfg.stages?cfg.stages.length:cfg.checks.length;
  const done=Object.values(state.checks).filter(v=>v&&v.result).length;

  // Highlight any measurement checks that have result but no value
  const items = cfg.checks || cfg.stages || [];
  let missingValues = 0;
  let firstMissingInput = null;
  items.forEach(chk => {
    const saved = state.checks[chk.id] || {};
    const row = document.getElementById('chk-row-' + chk.id);
    const inp = document.getElementById('chk-val-' + chk.id);
    if (chk.type === 'measurement' && saved.result && !saved.value) {
      if (row) { row.style.border = '2px solid #E65100'; row.style.borderRadius = '6px'; row.style.backgroundColor = '#FFF3E0'; }
      if (inp) { inp.style.border = '2px solid #E65100'; inp.style.backgroundColor = '#FFF3E0'; inp.placeholder = '⚠ Value required!'; }
      if (!firstMissingInput && inp) firstMissingInput = inp;
      missingValues++;
    } else if (chk.type === 'measurement') {
      if (row) { row.style.border = ''; row.style.backgroundColor = ''; }
      if (inp) { inp.style.border = ''; inp.style.backgroundColor = ''; }
    }
  });
  if (missingValues > 0) {
    showToast(`⚠ ${missingValues} measurement check(s) missing a value — highlighted in orange`, 'error');
    if (firstMissingInput) firstMissingInput.scrollIntoView({behavior:'smooth', block:'center'});
    return;  // Block save until values are filled
  }

  if (state.buildId) {
    // Existing build — v1.35: send what this tablet changed, read back the card
    const {error} = await _flushChecks(true);
    if (error && error.locked) return;
    if (error) { showToast('Save failed — ' + (error.message||'check connection'), 'error'); return; }
    await logActivity('CHECKS_SAVE',null,state.checks);
    showToast(`Saved — ${done}/${total} marked`,'ok');
  } else if (state.formData && _unitIdentifierSerial() &&
             (state.cardType !== 'GRN40' || state.serialVerified)) {
    // (GRN40 must be confirmed first — RLL/XRGL40 behaviour unchanged)
    // No buildId yet but we have identity data — create a draft build record
    const draft = {
      ...state.formData,
      card_type: state.cardType,
      operator_number: state.operator,
      checks: state.checks,
      status: 'IN PROGRESS',
      session_start: new Date().toISOString(),
    };
    delete draft.id; delete draft.created_at;
    const {error} = await _createBuildRow(draft);
    if (error) { showToast('Save failed — ' + (error.message||'check connection'), 'error'); return; }
    if (state.buildId) showToast(`Draft saved — ${done}/${total} marked`, 'ok');
  } else {
    // No identity at all — warn operator
    showToast('⚠ Save identity (Step 1) before saving checks', 'warn');
  }
}

// ════════════════════════════════════════════════════════════════════════
// v1.35 (12/11/2026) — SEVERAL PEOPLE ON ONE CARD, NOBODY OVERWRITES ANYBODY
// Floor feedback: more than one person works on a gun. Before, every tap
// saved this tablet's WHOLE copy of the checks, so a second tablet with the
// same card open wiped every tick made since it opened the card (and leaving
// the Checks tab re-saved the old copy). Now:
//   • only the checks changed on this tablet are sent; the database merges
//     them into the card in one step (bluecard_merge_checks) and answers with
//     the card's full current checks — everybody's ticks — which the screen
//     then shows;
//   • a card signed off on another tablet is never changed from here;
//   • if the database function is not there yet, the old save is used.
// ════════════════════════════════════════════════════════════════════════
let _chkChain = Promise.resolve();
let _mergeFnMissing = false;

function _markCheckDirty(id) {
  if (!state._dirtyChecks) state._dirtyChecks = {};
  state._dirtyChecks[id] = true;
}
function _isMissingFn(error) {
  const m = String((error && (error.message || error.details)) || '');
  return !!error && (error.code === 'PGRST202' || error.code === '42883' ||
                     /could not find the function|function .* does not exist/i.test(m));
}
// one save at a time, in the order they were made
function _flushChecks(pull) {
  const run = _chkChain.then(() => _flushChecksNow(!!pull));
  _chkChain = run.catch(() => {});
  return run;
}
function _pullChecks() { return state.buildId ? _flushChecks(true) : Promise.resolve({ error: null }); }

async function _flushChecksNow(pull) {
  const buildId = state.buildId;
  if (!buildId) return { error: null };
  const ids = Object.keys(state._dirtyChecks || {});
  if (!ids.length && !pull) return { error: null };
  const patch = {};
  ids.forEach(id => { patch[id] = state.checks[id] ? JSON.parse(JSON.stringify(state.checks[id])) : null; });

  if (_mergeFnMissing) return _flushChecksOld(buildId, ids, patch);
  let res;
  try {
    res = await supabaseClient.rpc('bluecard_merge_checks', { p_build_id: buildId, p_patch: patch });
  } catch (e) { return { error: e }; }
  const { data, error } = res || {};
  if (error) {
    if (_isMissingFn(error)) { _mergeFnMissing = true; return _flushChecksOld(buildId, ids, patch); }
    return { error };
  }
  if (state.buildId !== buildId) return { error: null };          // already on another card
  _clearSent(ids, patch);
  if (data && data.ok === false && data.status === 'COMPLETE') {
    state._dirtyChecks = {};
    _applyServerChecks(data.checks || {});
    showToast('🔒 This card was already signed off on another tablet — nothing changed', 'error');
    return { error: { message: 'card already signed off', locked: true } };
  }
  if (data && data.ok === false) return { error: { message: data.msg || 'not saved' } };
  if (data && data.checks) _applyServerChecks(data.checks);
  return { error: null, data };
}
// what was sent is saved — unless it was changed again while saving
function _clearSent(ids, patch) {
  ids.forEach(id => {
    if (JSON.stringify(state.checks[id] || null) === JSON.stringify(patch[id])) delete state._dirtyChecks[id];
  });
}
// database function not loaded yet → the old whole-card save (as before v1.35)
async function _flushChecksOld(buildId, ids, patch) {
  if (!ids.length) return { error: null };
  const r = await supabaseClient.from('weapon_builds').update({ checks: state.checks }).eq('id', buildId);
  if (!r.error && state.buildId === buildId) _clearSent(ids, patch);
  return r;
}
// the card's checks from the database + what this tablet has not saved yet
function _applyServerChecks(server) {
  const merged = { ...(server || {}) };
  Object.keys(state._dirtyChecks || {}).forEach(id => {
    if (state.checks[id]) merged[id] = state.checks[id]; else delete merged[id];
  });
  const before = JSON.stringify(state.checks);
  state.checks = merged;
  if (JSON.stringify(merged) !== before) _redrawChecksInPlace();
}
// update the rows on screen without rebuilding them (a value being typed stays)
function _redrawChecksInPlace() {
  const cfg = getCardConfig();
  (cfg.checks || cfg.stages || []).forEach(c => {
    if (!document.getElementById(`chk-row-${c.id}`)) return;
    applyCheckVisual(c.id);
    const d = state.checks[c.id] || {};
    const stamp = document.getElementById(`assy-${c.id}`);
    if (stamp) stamp.textContent = `OP ${d.assy_no || state.operator || '—'}`;
    const inp = document.getElementById(`chk-val-${c.id}`);
    if (inp && document.activeElement !== inp && !(state._dirtyChecks || {})[c.id]) inp.value = d.value || '';
  });
  updateChecksProgress(); updateNavBadges();
}

// ── identity: only the fields changed on this tablet ───────────────────────
// Before v1.35 every identity save wrote the whole card as this tablet last
// read it — including status — so a tablet left open on a card could put
// back old values, or even undo a sign-off done on the PDI page. Now only
// fields that differ from what this tablet last read / saved are sent, and
// status / sign-off / who-started fields are never sent from Identity.
const _ID_NOT_FROM_SCREEN = ['id', 'created_at', 'updated_at', 'checks', 'status', 'qa_operator',
  'completed_at', 'checks_complete', 'operator_number', 'session_start', 'card_type'];
function _idVal(v) {
  if (v === undefined || v === null) return '';
  return typeof v === 'object' ? JSON.stringify(v) : String(v).trim();
}
function _identityChanges() {
  const base = state._idBase || {}, out = {};
  Object.keys(state.formData || {}).forEach(k => {
    if (_ID_NOT_FROM_SCREEN.includes(k)) return;
    if (_idVal(state.formData[k]) !== _idVal(base[k])) out[k] = state.formData[k];
  });
  return out;
}
function _identitySaved(sent) { state._idBase = { ...(state._idBase || {}), ...sent }; }

function updateNavBadges() {
  const cfg=getCardConfig();
  const total=cfg.stages?cfg.stages.length:cfg.checks.length;
  const done=Object.values(state.checks).filter(v=>v&&v.result).length;
  const el=document.getElementById('nav-badge-checks');
  if(el){el.textContent=done>0?`${done}/${total}`:'';el.style.display=done>0?'inline':'none';}
}

// ─── SIGNOFF ──────────────────────────────────────────────────────────────────
function refreshSignoff() {
  const cfg=getCardConfig();
  const total=cfg.stages?cfg.stages.length:cfg.checks.length;
  document.getElementById('so-cardtype').textContent=cfg.label;
  const soSerial=document.getElementById('so-serial');
  soSerial.textContent=_unitIdentifierSerial()||'—';
  // Row label lives in index.html as "Launcher Serial" — relabel for GRN40
  if (soSerial.previousElementSibling)
    soSerial.previousElementSibling.textContent = state.cardType==='GRN40' ? 'Sight Serial' : 'Launcher Serial';
  document.getElementById('so-trolley').textContent=`${state.formData.trolley_number||'—'} / Pos ${state.formData.trolley_position||'—'}`;
  document.getElementById('so-client').textContent=`${state.formData.contract_name||'—'} — ${state.formData.client_country||'—'}`;
  const done=Object.values(state.checks).filter(v=>v&&v.result).length;
  const fails=Object.values(state.checks).filter(v=>v&&(v.result==='FAIL'||v.result==='NO-GO')).length;
  document.getElementById('so-checks').textContent=`${done} / ${total}`;
  const fb=document.getElementById('so-fails'); fb.textContent=fails; fb.className=`badge ${fails>0?'fail':'pass'}`;
  // v1.22: no QA / FAT boxes any more — the logged-in operator is the sign-off
  const soOp=document.getElementById('so-signoff-op'); if(soOp) soOp.textContent=state.operator||'—';
  updateCardBadges();
  updateUnitStrip();
}

async function handleSubmit() {
  if (openFails().length > 0) {
    showToast('🚫 This card has FAILED checks — it cannot be signed off until they are fixed and passed', 'error');
    showSection('checks');
    return;
  }
  // v1.22 (23/10/2026): the FAT-name / QA-operator / notes boxes are gone —
  // the operator logged in on the tablet IS the sign-off (qa_operator), and
  // every check already carries its own operator stamp. fat_name / fat_date
  // are left empty (FAT is its own process on the FAT tab).
  const qa=String(state.operator||'').trim();
  if(!qa){showToast('Log in first — the sign-off is recorded against your operator number','error');return;}
  if(!confirm(`Sign off ${_unitIdentifierSerial()||'this card'} as OP ${qa} and mark it COMPLETE?`)) return;
  const btn=document.getElementById('btn-submit');
  btn.textContent='Saving…'; btn.disabled=true;
  const cfg=getCardConfig();
  const total=cfg.stages?cfg.stages.length:cfg.checks.length;
  const updates={
    qa_operator:qa,
    completed_at:new Date().toISOString(),checks:state.checks,
    checks_complete:Object.values(state.checks).filter(v=>v&&v.result).length===total,
    status:'COMPLETE'
  };
  let error;
  if(state.buildId){({error}=await supabaseClient.from('weapon_builds').update(updates).eq('id',state.buildId));}
  else{({error}=await _createBuildRow({...state.formData,...updates}));}
  const regSerial=_unitIdentifierSerial();
  if(!error&&regSerial){
    await supabaseClient.from('weapon_serials').update({status:'COMPLETE'}).eq('serial_number',regSerial);
  }
  await logActivity('QA_SIGNOFF',{qa_operator:qa,signed_off_by:qa},state.checks);
  btn.textContent='Submit & Save Build Card'; btn.disabled=false;
  if(error){console.error(error);showToast('Save failed','error');return;}
  showToast('Build card saved ✓','ok');
  document.getElementById('done-serial').textContent=_unitIdentifierSerial()||'—';
  setTimeout(()=>show('screen-complete'),800);
}

// ─── CAMERA + OCR ─────────────────────────────────────────────────────────────
let tesseractWorker=null;
async function initOCR() {
  try {
    tesseractWorker=await Tesseract.createWorker('eng');
    await tesseractWorker.setParameters({tessedit_char_whitelist:'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789- '});
    const el=document.getElementById('ocr-status'); if(el) el.textContent='📷 Tap 📷 next to Launcher Serial to take a required photo — other photos optional';
  } catch(e){ const el=document.getElementById('ocr-status'); if(el) el.textContent='⚠ OCR not available — type manually'; }
}

async function captureSerial(fieldId, photoKey, useOCR) {
  // useOCR: true  = compress + store + run OCR (laser-engraved serials only)
  //         false = compress + store photo only, operator types serial manually
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'image/*'; input.capture = 'environment';
  input.style.display = 'none'; document.body.appendChild(input);

  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) { document.body.removeChild(input); return; }

    const statusEl = document.getElementById('ocr-status');
    const thumb    = document.getElementById(`thumb-${fieldId}`);
    const inp      = document.getElementById(fieldId);

    if (statusEl) statusEl.textContent = '📷 Compressing photo…';

    // Always compress before storing
    const compressed = await compressImage(file, 1200, 0.70);
    const base64 = compressed || await new Promise(res => {
      const r = new FileReader();
      r.onload = ev => res(ev.target.result);
      r.readAsDataURL(file);
    });

    // Store photo
    state.formData[photoKey] = base64;

    // Show thumbnail
    if (thumb) { thumb.src = base64; thumb.style.display = 'block'; }

    // Persist the photo to Supabase immediately — do not wait for the
    // operator to change another field or press Save. Previously a photo
    // taken after the launcher serial was confirmed had no reliable trigger
    // to ever reach the database, so it stayed on the tablet only.
    if (statusEl) statusEl.textContent = '💾 Uploading photo…';
    if (state.serialVerified && _unitIdentifierSerial()) {
      await autoSaveIdentity();
    }

    if (!useOCR) {
      // ── PHOTO ONLY — no OCR ─────────────────────────────────────────────
      if (statusEl) statusEl.textContent = '✅ Photo stored — type serial number above';
      showToast('Photo saved ✓', 'ok');
      if (inp) {
        inp.disabled    = false;
        inp.placeholder = 'Type serial number';
        inp.focus();
      }
      return;
    }

    // ── OCR PATH — laser-engraved serials only ───────────────────────────
    if (inp) { inp.placeholder = 'Reading…'; inp.disabled = true; }
    if (statusEl) statusEl.textContent = '🔍 Reading laser serial…';
    showToast('Reading serial…', 'ok');

    try {
      if (!tesseractWorker) await initOCR();
      const {data} = await tesseractWorker.recognize(base64);
      let text = data.text.trim().toUpperCase()
                  .replace(/\n/g,' ').replace(/\s+/g,' ').trim();
      if (inp) {
        inp.value       = normaliseSerial(text, state.cardType);
        inp.disabled    = false;
        inp.placeholder = 'Confirm or correct';
      }
      if (statusEl) statusEl.textContent = '✓ Read — confirm or correct above';
      if (fieldId === 'inp-launcher-serial') resetSerialConfirm();
      if (fieldId === 'inp-sight-serial' && state.cardType === 'GRN40') resetSightConfirm();
      showToast('Done — confirm serial ✓', 'ok');
    } catch(err) {
      if (inp) { inp.disabled = false; inp.placeholder = 'Type manually'; }
      if (statusEl) statusEl.textContent = '⚠ Could not read — type manually';
      showToast('OCR failed — type manually', 'warn');
    }
  };

  document.body.removeChild(input);
  input.click();
}




// ─── IDENTITY AUTO-SAVE ───────────────────────────────────────────────────────
// Auto-saves identity fields to Supabase without operator intervention.
// Two triggers:
//   A) Immediately after launcher serial is confirmed (most critical)
//   B) 2 seconds after any other identity field changes (debounced)
// Shows a small non-intrusive status indicator — not a full toast.

let _autoSaveTimer = null;
let _autoSaving    = false;

function scheduleAutoSave(delayMs) {
  // debounce — reset timer on every call
  if (_autoSaveTimer) clearTimeout(_autoSaveTimer);
  _autoSaveTimer = setTimeout(() => autoSaveIdentity(), delayMs || 2000);
}

function _injectAutoSaveIndicator() {
  // Adds the auto-save status pill below the OCR status line on the identity screen.
  // Safe to call multiple times — removes existing one first.
  const existing = document.getElementById('autosave-indicator');
  if (existing) existing.remove();
  // Find the ocr-status div and insert after it
  const ocrEl = document.getElementById('ocr-status');
  if (!ocrEl || !ocrEl.parentNode) return;
  const ind = document.createElement('div');
  ind.id = 'autosave-indicator';
  ind.style.cssText = 'font-size:11px;font-weight:700;padding:3px 10px;'
    + 'text-align:right;color:var(--text-dim);min-height:18px;';
  ocrEl.parentNode.insertBefore(ind, ocrEl.nextSibling);
}

async function autoSaveIdentity() {
  // Don't auto-save if no serial confirmed yet — nothing worth saving.
  // Identity serial is card-type aware: GRN40 = sight_serial, else launcher_serial.
  if (!state.serialVerified || !_unitIdentifierSerial()) return;
  // Don't stack saves
  if (_autoSaving) { scheduleAutoSave(1500); return; }
  _autoSaving = true;

  // Show subtle saving indicator
  const indEl = document.getElementById('autosave-indicator');
  if (indEl) { indEl.textContent = '💾 Saving…'; indEl.style.color = 'var(--text-dim)'; }

  // Collect current field values
  const map = getIdentityMap();
  Object.entries(map).forEach(([elId, key]) => {
    const el = document.getElementById(elId);
    if (el) state.formData[key] = _identityValue(elId, el);
  });
  state.formData.status    = state.formData.status    || 'IN PROGRESS';
  state.formData.card_type = state.cardType;
  delete state.formData.checks;   // see loadBuild — never write a checks snapshot from identity

  try {
    // v1.27: never auto-save a duplicate component number
    if (await _blockIfDuplicateComponents()) {
      if (indEl) { indEl.textContent = '🚫 Not saved — duplicate component number'; indEl.style.color = 'var(--fail, #e03c3c)'; }
      return;
    }
    let result, error;
    if (state.buildId) {
      // v1.35: only the fields changed on this tablet (see _identityChanges)
      const changes = _identityChanges();
      if (Object.keys(changes).length) {
        ({data: result, error} = await supabaseClient
          .from('weapon_builds')
          .update({...changes, updated_at: new Date().toISOString()})
          .eq('id', state.buildId).select());
        if (!error) _identitySaved(changes);
      }
    } else {
      const sent = {...state.formData};
      ({data: result, error} = await _createBuildRow(sent));
      if (!error && state.buildId) _identitySaved(sent);
    }

    if (error) throw error;

    // Update serial register status
    const regSerial = _unitIdentifierSerial();
    if (regSerial) {
      const serialUpdate = { status: 'IN PROGRESS' };
      if (state.formData.trolley_number)   serialUpdate.trolley_number   = state.formData.trolley_number;
      if (state.formData.trolley_position) serialUpdate.trolley_position = state.formData.trolley_position;
      await supabaseClient.from('weapon_serials')
        .update(serialUpdate)
        .eq('serial_number', regSerial)
        .or('status.is.null,status.neq.COMPLETE');   // v1.35: never undo a sign-off
    }

    if (indEl) {
      indEl.textContent = '✓ Saved';
      indEl.style.color = 'var(--pass)';
      setTimeout(() => { if(indEl) indEl.textContent = ''; }, 3000);
    }
    _rememberStoredComponents(state.formData);
    await logActivity('IDENTITY_AUTOSAVE', state.formData, null);

    // Keep the XRGL40 <-> GRN40 sight pairing in sync while the build is
    // still in progress. Once a Blue Card is COMPLETE, changing the sight
    // must go through the PMS "Replace Sight" admin function instead
    // (see weapon_sight_pairings / admin_replace_sight), so this only
    // auto-syncs pre-completion normal capture/correction.
    if (state.cardType === 'XRGL40' && state.formData.launcher_serial &&
        state.formData.sight_serial && state.formData.status !== 'COMPLETE') {
      _syncSightPairing(state.formData.launcher_serial, state.formData.sight_serial);
    }

  } catch(e) {
    console.error('[AutoSave]', e);
    const sgate = (typeof _sightGateError === 'function') ? _sightGateError(e) : null;   // v1.42
    if (sgate) {
      showToast('🚫 Not saved — ' + sgate, 'error');
      _sightRevert();
      if (indEl) { indEl.textContent = '🚫 Not saved — sight must come from the approved list'; indEl.style.color = 'var(--fail, #e03c3c)'; }
      return;
    }
    const gate = _trolleyGateError(e);   // v1.37: wrong trolley place refused by the database
    if (gate) {
      showToast('🚫 Not saved — ' + gate, 'error');
      _trolleyRevert();
      if (indEl) { indEl.textContent = '🚫 Not saved — trolley / position needs the Admin PIN'; indEl.style.color = 'var(--fail, #e03c3c)'; }
      return;
    }
    const dup = _duplicateComponentError(e);
    if (dup) showToast('🚫 Not saved — ' + dup, 'error');
    if (indEl) {
      indEl.textContent = dup ? '🚫 Not saved — duplicate component number' : '⚠ Auto-save failed';
      indEl.style.color = dup ? 'var(--fail, #e03c3c)' : 'var(--warn)';
    }
  } finally {
    _autoSaving = false;
  }
}

// Keep weapon_sight_pairings.is_current in step with the XRGL40 identity
// screen's Sight Serial field. Never called after a build is COMPLETE —
// that path is the admin-only Replace Sight function instead.
async function _syncSightPairing(launcherSerial, sightSerial) {
  try {
    const { data: existing } = await supabaseClient.from('weapon_sight_pairings')
      .select('id,sight_serial').eq('launcher_serial', launcherSerial)
      .eq('is_current', true).limit(1);

    if (existing && existing.length > 0) {
      if (existing[0].sight_serial === sightSerial) return; // unchanged
      await supabaseClient.from('weapon_sight_pairings')
        .update({ is_current: false, replaced_at: new Date().toISOString(),
                   replaced_by: state.operator, replace_reason: 'Corrected during build' })
        .eq('id', existing[0].id);
    }

    await supabaseClient.from('weapon_sight_pairings').insert({
      launcher_serial: launcherSerial,
      sight_serial: sightSerial,
      is_current: true,
      paired_by: state.operator
    });
  } catch (e) {
    console.error('[SightPairing] sync error', e);
  }
}


// ─── SERIAL VALIDATION OVERRIDE ───────────────────────────────────────────────
// Overrides validateSerialExists from supabase.js.
// If a project has been selected (state._projectSerials is loaded),
// validates the serial ONLY within that project's serials.
// This prevents using an RLL serial on an XRGL contract and vice versa.
async function validateSerialExists(serial) {
  if (!supabaseClient) return { exists: true, status: 'UNKNOWN' };

  // ── Project-scoped check ──────────────────────────────────────────────────
  if (state._projectSerials !== null) {
    // We have a specific project selected — check only within those serials
    const match = state._projectSerials.find(
      r => (r.serial_number || '').toUpperCase() === serial.toUpperCase()
    );
    if (!match) {
      const project = state.formData.contract_name || 'selected contract';
      return {
        exists: false,
        status: null,
        reason: `Serial "${serial}" is not in project "${project}". ` +
                `Check you have selected the correct contract.`
      };
    }
    return { exists: true, status: match.status };
  }

  // ── No project selected — check whole register (fallback) ────────────────
  // Still card-type aware: a launcher serial must not validate on a sight
  // card (or vice versa). Serials with no card_type recorded still count.
  const { data } = await supabaseClient
    .from('weapon_serials')
    .select('serial_number,status')
    .eq('serial_number', serial)
    .or(`card_type.eq.${state.cardType},card_type.is.null`)
    .limit(1);
  if (!data || data.length === 0) return { exists: false, status: null };
  return { exists: true, status: data[0].status };
}

// ─── SERIAL NORMALISATION ─────────────────────────────────────────────────────
// Cleans any serial number typed or OCR'd by the operator:
//   - Strips leading/trailing whitespace
//   - Collapses multiple internal spaces to one
//   - Forces uppercase
//   - For RLL cards: ensures prefix is exactly "RLL " (not RLL26004 or RL 26004)
//   - For XRGL40 cards: normalises to "X## #### RSA" pattern where applicable
// Returns the cleaned string.
function normaliseSerial(raw, cardType) {
  if (!raw) return '';
  // Step 1: uppercase, collapse whitespace
  let s = raw.toUpperCase().replace(/\s+/g, ' ').trim();

  if (cardType === 'RLL') {
    // Must start with RLL followed by a space then digits
    // Handle: RLL26004 → RLL 26004, RL 26004 → RLL 26004
    s = s.replace(/^RL{1,2}\s*/i, 'RLL ');
    // Remove any non-alphanumeric except spaces
    s = s.replace(/[^A-Z0-9 ]/g, '');
    // Collapse again after cleaning
    s = s.replace(/\s+/g, ' ').trim();
  } else if (cardType === 'XRGL40') {
    // v1.45 (23/11/2026, Gerhard): XRGL40 launcher serials are "X26 nnnn" in
    // the Serial Register — a SPACE between X26 and the number, not a dash.
    // Typed as "2499", "X262499", "X26-2499" or "x26 2499" they all become
    // "X26 2499", so the register is found however it was entered. A dash is
    // read as the separator rather than thrown away, which is what made
    // "X26-2499" come back as not in the register.
    s = s.replace(/[^A-Z0-9 \-_]/g, '').replace(/[\-_]+/g, ' ')
         .replace(/\s+/g, ' ').trim();
    if (/^[0-9]+$/.test(s)) s = 'X26 ' + s;
    else if (/^X26[0-9]+$/.test(s)) s = 'X26 ' + s.slice(3);
  } else {
    s = s.replace(/[^A-Z0-9 \-]/g, '').replace(/\s+/g, ' ').trim();
    // v1.43 (20/11/2026): GRN40 sight serials are GRN-nnnn — just the number
    // ("6403") or GRN with no dash ("GRN6403") becomes GRN-6403. Anything
    // else typed is left exactly as it was.
    if (cardType === 'GRN40') {
      if (/^[0-9]+$/.test(s)) s = 'GRN-' + s;
      else if (/^GRN[0-9]+$/.test(s)) s = 'GRN-' + s.slice(3);
    }
  }
  return s;
}

// v1.43: the GRN40 sight box starts with GRN- — the operator types the number
// ─── v1.47 — Barrel Production No batches (XRGL40) ──────────────────────────
async function _loadBarrelBatches() {
  // read fresh each time a card is opened — it is one small row, and a batch
  // added in the database must show up without waiting for a release
  try {
    const { data } = await supabaseClient.from('app_settings')
      .select('value').eq('key', 'xrgl40_barrel_batches').limit(1);
    const raw = (data && data.length) ? String(data[0].value || '') : '';
    return raw.split(/[,;\n]/).map(x => x.trim()).filter(Boolean);
  } catch (e) {
    console.warn('[Barrel batch] could not read the list', e);
    return null;                  // not read — the box is simply typed in
  }
}

async function refreshBarrelBatches() {
  const sel = document.getElementById('inp-barrel-prod-batch');
  if (!sel) return;
  const list = await _loadBarrelBatches();
  const cur = document.getElementById('inp-barrel-prod-no');
  if (!list || !list.length) { sel.style.display = 'none'; return; }
  sel.style.display = '';
  sel.innerHTML = '<option value="">— Pick the batch —</option>'
    + list.map(b => `<option value="${b}">${b}</option>`).join('')
    + '<option value="__other">Other — type it below</option>';
  // a card already carrying one of the batches opens with it shown
  if (cur && cur.value && list.indexOf(cur.value.trim()) >= 0) sel.value = cur.value.trim();
}

function pickBarrelBatch(sel) {
  const inp = document.getElementById('inp-barrel-prod-no');
  if (!inp || !sel) return;
  if (sel.value === '__other') { inp.value = ''; inp.focus(); return; }
  if (!sel.value) return;
  inp.value = sel.value;
  if (typeof scheduleAutoSave === 'function') scheduleAutoSave();
}

// v1.45: the launcher box on an XRGL40 starts with "X26 " — the operator
// types only the number. Blank again on leaving if nothing was typed.
function _x26PrefixFocus(inp) {
  if (inp && !inp.value && !inp.readOnly) {
    inp.value = 'X26 ';
    try { inp.setSelectionRange(4, 4); } catch (e) { /* some keyboards */ }
  }
}
function _x26PrefixBlur(inp) {
  if (inp && inp.value.trim().toUpperCase() === 'X26') inp.value = '';
}

function _grnPrefixFocus(inp) {
  if (inp && !inp.value && !inp.readOnly) {
    inp.value = 'GRN-';
    try { inp.setSelectionRange(4, 4); } catch (e) { /* some keyboards */ }
  }
}
function _grnPrefixBlur(inp) {
  if (inp && inp.value.trim().toUpperCase() === 'GRN-') inp.value = '';
}


// ─── SUPERVISOR SERIAL OVERRIDE ───────────────────────────────────────────────
// Called when operator taps "Supervisor Override" on a blocked serial.
// Supervisor enters their PIN. If correct:
//   - Adds the serial to weapon_serials table with status UNBUILT
//   - Logs the override action with operator + supervisor identity
//   - Allows the build to proceed
// PIN is fetched from app_settings table (key='pwa_supervisor_pin').
// Falls back to '9999' if table not reachable.
async function requestSupervisorOverride(serial) {
  const statusEl = document.getElementById('override-status');
  const overrideBtn = document.getElementById('btn-override-request');

  // Step 1: Get supervisor PIN from Supabase app_settings
  let supervisorPin = '9999'; // fallback
  try {
    const {data: pinData} = await supabaseClient
      .from('app_settings')
      .select('value')
      .eq('key', 'pwa_supervisor_pin')
      .limit(1);
    if (pinData && pinData.length > 0) supervisorPin = pinData[0].value;
  } catch(e) {
    console.warn('[Override] Could not fetch supervisor PIN, using fallback');
  }

  // Step 2: Prompt for supervisor PIN
  const enteredPin = prompt(
    `SUPERVISOR OVERRIDE\n\n` +
    `Serial: ${serial}\n` +
    `Operator: OP ${state.operator}\n\n` +
    `Enter supervisor PIN to add this serial and proceed:`
  );

  if (!enteredPin) {
    if (statusEl) { statusEl.style.display='inline'; statusEl.textContent='Cancelled.'; statusEl.style.color='#aaa'; }
    return;
  }

  // Step 3: Log the attempt regardless of outcome
  logActivity('SUPERVISOR_OVERRIDE_ATTEMPT', {
    serial_attempted: serial,
    operator: state.operator,
    pin_correct: enteredPin.trim() === supervisorPin
  }, null);

  // Step 4: Check PIN
  if (enteredPin.trim() !== supervisorPin) {
    if (statusEl) {
      statusEl.style.display = 'inline';
      statusEl.textContent   = '❌ Wrong PIN — override denied. Contact supervisor.';
      statusEl.style.color   = 'var(--fail)';
    }
    showToast('❌ Wrong supervisor PIN — override denied', 'error');
    return;
  }

  // Step 5: PIN correct — add serial to register
  if (overrideBtn) { overrideBtn.disabled = true; overrideBtn.textContent = 'Adding…'; }
  if (statusEl)    { statusEl.style.display='inline'; statusEl.textContent='Adding to register…'; statusEl.style.color='#aaa'; }

  try {
    const cardType = state.cardType || 'RLL';
    const {error: insertErr} = await supabaseClient.from('weapon_serials').insert({
      serial_number: serial,
      card_type:     cardType,
      status:        'UNBUILT',
      added_by_override: true,
      override_operator: state.operator,
      override_note: `Added via supervisor override during build session`,
    });

    if (insertErr) {
      // May already exist or column doesn't exist — try simpler insert
      const {error: insertErr2} = await supabaseClient.from('weapon_serials').insert({
        serial_number: serial,
        card_type:     cardType,
        status:        'UNBUILT',
      });
      if (insertErr2) throw insertErr2;
    }

    // Step 6: Log the approved override
    logActivity('SUPERVISOR_OVERRIDE_APPROVED', {
      serial_added: serial,
      operator: state.operator,
      card_type: cardType
    }, null);

    // Step 7 (GRN40): override only covers the register check — the sight
    // must still not already be on another GRN40 card.
    if (cardType === 'GRN40') {
      const dupe = await _findDuplicateSight(serial);
      if (dupe) { _showSightDuplicate(serial, dupe); return; }
      state.formData.sight_serial = serial;
      state.serialVerified = true;
      autoSaveIdentity();
      const inp = document.getElementById('inp-sight-serial');
      const sv  = document.getElementById('sight-verified');
      if (inp) { inp.value = serial; inp.style.borderBottomColor = 'var(--pass)'; }
      if (sv) {
        sv.style.display = 'block';
        sv.style.color   = 'var(--pass)';
        sv.textContent   = `✓ SUPERVISOR OVERRIDE APPROVED — ${serial} added to register by OP ${state.operator}`;
      }
      showToast(`✓ Override approved — ${serial} added to register`, 'ok');
      return;
    }

    // Step 7: Now proceed as if serial was always in register
    showToast(`✓ Override approved — ${serial} added to register`, 'ok');
    state.formData.launcher_serial = serial;
    state.serialVerified = true;
    // Auto-save immediately after override approval
    autoSaveIdentity();

    const inp1 = document.getElementById('inp-launcher-serial');
    const inp2 = document.getElementById('inp-launcher-confirm');
    const lv   = document.getElementById('launcher-verified');
    const lw   = document.getElementById('launcher-confirm-wrap');

    if (inp1) { inp1.value = serial; inp1.style.borderBottomColor = 'var(--pass)'; }
    if (inp2) { inp2.style.borderBottomColor = 'var(--pass)'; }
    if (lv) {
      lv.innerHTML   = `✓ SUPERVISOR OVERRIDE APPROVED — ${serial} added to register by OP ${state.operator}`;
      lv.style.color = 'var(--pass)';
    }
    if (lw) lw.style.display = 'none';

  } catch(e) {
    showToast('Override failed — could not add to register: ' + e.message, 'error');
    if (statusEl) {
      statusEl.style.display = 'inline';
      statusEl.textContent   = '❌ Failed to add: ' + e.message;
      statusEl.style.color   = 'var(--fail)';
    }
    if (overrideBtn) { overrideBtn.disabled = false; overrideBtn.textContent = '🔐 Supervisor Override'; }
  }
}

// ─── PHOTO COMPRESSION ────────────────────────────────────────────────────────
// Resize image to maxWidth px and compress as JPEG at given quality (0-1).
// Called before uploading serial photos to keep Supabase storage lean.
function compressImage(file, maxWidth, quality) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        // Calculate target dimensions — preserve aspect ratio
        let w = img.width;
        let h = img.height;
        if (w > maxWidth) {
          h = Math.round(h * maxWidth / w);
          w = maxWidth;
        }
        const canvas = document.createElement('canvas');
        canvas.width  = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        // Export as JPEG — much smaller than PNG or raw base64
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => resolve(null); // fall back to uncompressed
      img.src = ev.target.result;
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

// ─── UTILS ────────────────────────────────────────────────────────────────────
function formatDate(d){return new Date(d).toLocaleDateString('en-ZA',{day:'2-digit',month:'short',year:'numeric'});}
let toastTimer;
function showToast(msg,type='ok'){
  const t=document.getElementById('toast'); t.textContent=msg; t.className=`toast ${type} visible`;
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>t.classList.remove('visible'),3200);
}
