// ─── STATE ────────────────────────────────────────────────────────────────────
const state = {
  operator: null,
  cardType: 'RLL',
  checks: {},
  formData: {},
  serialVerified: false,
  buildId: null
};

// ─── BOOT ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initSupabase();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(()=>{});
  show('screen-login');
});

// ─── ROUTING ──────────────────────────────────────────────────────────────────
function show(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(screenId);
  if (el) { el.classList.add('active'); window.scrollTo(0,0); }
  document.querySelectorAll('.nav-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.screen === screenId));
  const nav = document.getElementById('bottom-nav');
  const hideNav = ['screen-login','screen-complete','screen-fatpdi'].includes(screenId);
  if (nav) nav.classList.toggle('hidden', hideNav);
  const swBtn = document.getElementById('switch-op-btn');
  if (swBtn) swBtn.style.display = hideNav ? 'none' : 'block';
}

function showSection(id) {
  if (id==='identity') refreshIdentity();
  if (id==='checks')   refreshChecks();
  if (id==='signoff')  refreshSignoff();
  const map = { identity:'screen-identity', checks:'screen-checks', signoff:'screen-signoff' };
  if (!map[id]) return;
  // Auto-save checks whenever leaving checks tab
  if (document.getElementById('screen-checks') && document.getElementById('screen-checks').classList.contains('active')) {
    if (state.buildId) {
      supabaseClient.from('weapon_builds').update({checks:state.checks}).eq('id',state.buildId).then(()=>{});
    }
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
    const {data}=await supabaseClient.from('weapon_builds')
      .select('id,launcher_serial,sight_serial,trolley_number,trolley_position,client_country,contract_name,created_at,status,card_type,checks,operator_number')
      .neq('status','COMPLETE')
      .order('created_at',{ascending:false}).limit(20);
    if (!data||data.length===0) {
      listEl.innerHTML='<div class="loading-msg">No incomplete cards — start a new one below</div>';
    } else {
      listEl.innerHTML=data.map(r=>{
        const st=(r.status||'IN PROGRESS').toUpperCase();
        const stColour=st==='COMPLETE'?'#1a9e5c':'#e08f1a';
        const stLabel=st==='COMPLETE'?'✓ COMPLETE':'⏳ IN PROGRESS';
        // Count checks completed
        const checks=r.checks||{};
        const done=Object.values(checks).filter(v=>v&&v.result).length;
        const fails=Object.values(checks).filter(v=>v&&(v.result==='FAIL'||v.result==='NO-GO')).length;
        const checksLabel=done>0?`${done} checks done${fails>0?' · '+fails+' FAIL':''}`:' No checks yet';
        return `
        <div class="resume-card" onclick="loadBuild('${r.id}')">
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
    }
  } catch(e) { listEl.innerHTML='<div class="loading-msg">Could not load cards</div>'; }
}

async function findBySerial() {
  const serial=document.getElementById('inp-find-serial').value.trim().toUpperCase();
  if (!serial){showToast('Enter a serial number','error');return;}
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
  state.buildId=row.id; state.formData={...row};
  state.cardType=row.card_type||'RLL';
  // A saved row's identifying serial was already validated when it was
  // first confirmed — GRN40 = sight_serial, RLL/XRGL40 = launcher_serial.
  state.checks=row.checks||{}; state.serialVerified=!!_rowIdentifierSerial(row);
  updateCardBadges();
  buildIdentityGrid();
  _injectAutoSaveIndicator();
  refreshIdentity();
  show('screen-identity');
  populateTrolley(); populateYear(); loadCountries(); loadContracts();
  loadActivityLog(_rowIdentifierSerial(row)); initOCR();
}

function startNewCard() {
  state.buildId=null;
  state.formData={operator_number:state.operator,card_type:state.cardType,status:'IN PROGRESS',session_start:new Date().toISOString()};
  state.checks={}; state.serialVerified=false;
  updateCardBadges();
  buildIdentityGrid();
  _injectAutoSaveIndicator();
  show('screen-identity');
  populateTrolley(); populateYear(); loadCountries(); loadContracts(); initOCR();
}

function goToResume() {
  state.buildId=null; state.formData={}; state.checks={}; state.serialVerified=false;
  show('screen-resume'); loadResumeScreen();
}

// Lets an operator back out of a card they don't want to continue —
// whether or not anything was saved yet. If it was only ever local state
// (no serial confirmed, nothing autosaved), this is a plain reset. If it
// was already autosaved to weapon_builds (a serial was confirmed), this
// also deletes that row and frees the serial back to UNBUILT, logging the
// cancellation first so it's traceable in the audit trail.
async function cancelBuildCard() {
  if (!confirm('Cancel this build card?\n\nAny saved data for this card will be permanently deleted. This cannot be undone.')) {
    return;
  }

  if (!state.buildId) {
    // Nothing was ever saved to Supabase — pure local reset.
    showToast('Card discarded', 'ok');
    goToResume();
    return;
  }

  try {
    const unitSerial = _unitIdentifierSerial();
    if (unitSerial) {
      await logActivity('BUILD_CANCELLED', { cancelled_by: state.operator }, null);
    }
    await supabaseClient.from('weapon_builds').delete().eq('id', state.buildId);
    if (unitSerial) {
      await supabaseClient.from('weapon_serials')
        .update({ status: 'UNBUILT' })
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
  state.operator=null; state.buildId=null; state.formData={}; state.checks={};
  show('screen-login');
}

function changeCardType() {
  // Go back to login screen to pick a different card type or operator
  state.operator=null; state.buildId=null; state.formData={}; state.checks={};
  state.serialVerified=false;
  show('screen-login');
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
          <input type="text" id="inp-sight-serial" placeholder="Tap 📷 or type" autocapitalize="characters" spellcheck="false" onchange="resetSightConfirm()">
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
        <select id="inp-contract" style="font-family:var(--font-ui);font-size:13px;" onchange="loadSerialsForProject(this.value);scheduleAutoSave()"></select>
      </div>
      <div class="card-cell">
        <label>Year of Manufacturing</label>
        <select id="inp-year" onchange="scheduleAutoSave()"></select>
      </div>
      <div class="card-cell">
        <label>Trolley No</label>
        <select id="inp-trolley-no" onchange="handleTrolleyChange();scheduleAutoSave()"></select>
      </div>`;
    return;
  }

  // RLL and XRGL40 share the same base layout
  const sightRow = (state.cardType==='XRGL40') ? `
    <div class="card-cell">
      <label class="yellow">Sight Serial No</label>
      <div class="serial-row">
        <input type="text" id="inp-sight-serial" placeholder="Tap 📷" autocapitalize="characters" spellcheck="false">
        <img class="serial-thumb" id="thumb-inp-sight-serial">
        <button class="cam-btn" onclick="captureSerial('inp-sight-serial','photo_sight', true)">📷</button>
      </div>
    </div>` : '<div class="card-cell"></div>';

  const hfmProdRow = (state.cardType==='XRGL40') ? `
    <div class="card-cell">
      <label class="yellow">HFM Production No</label>
      <div class="serial-row">
        <input type="text" id="inp-hfm-prod-no" placeholder="Tap 📷" autocapitalize="characters" spellcheck="false">
        <img class="serial-thumb" id="thumb-inp-hfm-prod-no">
        <button class="cam-btn" onclick="captureSerial('inp-hfm-prod-no','photo_hfm_prod', false)">📷</button>
      </div>
    </div>
    <div class="card-cell">
      <label class="yellow">HRC Production No</label>
      <div class="serial-row">
        <input type="text" id="inp-hrc-prod-no" placeholder="Tap 📷" autocapitalize="characters" spellcheck="false">
        <img class="serial-thumb" id="thumb-inp-hrc-prod-no">
        <button class="cam-btn" onclick="captureSerial('inp-hrc-prod-no','photo_hrc_prod', false)">📷</button>
      </div>
    </div>` : '';

  grid.innerHTML = `
    <div class="card-cell">
      <label>Trolley No</label>
      <select id="inp-trolley-no" onchange="handleTrolleyChange();scheduleAutoSave()"></select>
    </div>
    <div class="card-cell">
      <label>Trolley Position</label>
      <select id="inp-trolley-pos" onchange="checkTrolleyPositionCollision();scheduleAutoSave()"></select>
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
      <select id="inp-contract" style="font-family:var(--font-ui);font-size:13px;" onchange="loadSerialsForProject(this.value);scheduleAutoSave()"></select>
    </div>
    <!-- Launcher Serial — full width with confirm -->
    <div class="card-cell span2">
      <label class="yellow">Launcher Serial No ★</label>
      <div class="serial-row">
        <input type="text" id="inp-launcher-serial" placeholder="Tap 📷 or type"
               autocapitalize="characters" spellcheck="false" onchange="resetSerialConfirm()">
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
        <input type="text" id="inp-barrel-no" placeholder="Tap 📷" autocapitalize="characters" spellcheck="false">
        <img class="serial-thumb" id="thumb-inp-barrel-no">
        <button class="cam-btn" onclick="captureSerial('inp-barrel-no','photo_barrel', false)">📷</button>
      </div>
    </div>
    <div class="card-cell">
      <label class="yellow">Barrel Production No</label>
      <div class="serial-row">
        <input type="text" id="inp-barrel-prod-no" placeholder="Tap 📷" autocapitalize="characters" spellcheck="false">
        <img class="serial-thumb" id="thumb-inp-barrel-prod-no">
        <button class="cam-btn" onclick="captureSerial('inp-barrel-prod-no','photo_barrel_prod', false)">📷</button>
      </div>
    </div>
    <!-- Cylinder No | HRC Serial No -->
    <div class="card-cell">
      <label class="yellow">Cylinder No</label>
      <div class="serial-row">
        <input type="text" id="inp-cylinder-no" placeholder="Tap 📷" autocapitalize="characters" spellcheck="false">
        <img class="serial-thumb" id="thumb-inp-cylinder-no">
        <button class="cam-btn" onclick="captureSerial('inp-cylinder-no','photo_cylinder', false)">📷</button>
      </div>
    </div>
    <div class="card-cell">
      <label class="yellow">HRC Serial No</label>
      <div class="serial-row">
        <input type="text" id="inp-hrc-serial" placeholder="Tap 📷" autocapitalize="characters" spellcheck="false">
        <img class="serial-thumb" id="thumb-inp-hrc-serial">
        <button class="cam-btn" onclick="captureSerial('inp-hrc-serial','photo_hrc', false)">📷</button>
      </div>
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
        <input type="text" id="inp-firing-mech" placeholder="Tap 📷" autocapitalize="characters" spellcheck="false">
        <img class="serial-thumb" id="thumb-inp-firing-mech">
        <button class="cam-btn" onclick="captureSerial('inp-firing-mech','photo_firing_mech', false)">📷</button>
      </div>
    </div>
    <!-- HFM Serial No | empty -->
    <div class="card-cell">
      <label class="yellow">HFM Serial No</label>
      <div class="serial-row">
        <input type="text" id="inp-hfm-serial" placeholder="Tap 📷" autocapitalize="characters" spellcheck="false">
        <img class="serial-thumb" id="thumb-inp-hfm-serial">
        <button class="cam-btn" onclick="captureSerial('inp-hfm-serial','photo_hfm', false)">📷</button>
      </div>
    </div>
    <div class="card-cell"></div>
    ${hfmProdRow}`;
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
  if (state.cardType==='XRGL40') { base['inp-hfm-prod-no']='hfm_prod_no'; base['inp-hrc-prod-no']='hrc_prod_no'; }
  return base;
}

function refreshIdentity() {
  const opEl=document.getElementById('id-op'); if(opEl) opEl.textContent=state.operator||'—';
  const map=getIdentityMap();
  // Use setTimeout to ensure dropdowns are populated before setting values
  setTimeout(() => {
    Object.entries(map).forEach(([elId,key])=>{
      const el=document.getElementById(elId);
      if(el && state.formData[key] !== undefined && state.formData[key] !== null) {
        el.value=state.formData[key];
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

  // ── STEP 7: All checks passed — confirmed ───────────────────────────────
  state.formData.launcher_serial = s1;
  state.serialVerified = true;
  if (inp1) { inp1.style.borderBottomColor = 'var(--pass)'; inp1.style.backgroundColor = ''; }
  if (inp2) { inp2.style.borderBottomColor = 'var(--pass)'; inp2.style.backgroundColor = ''; }
  if (lv) {
    lv.style.display = 'block';
    lv.textContent   = `✓ Serial confirmed and registered — ${s1}`;
    lv.style.color   = 'var(--pass)';
  }
  if (lw) lw.style.display = 'none';
  showToast(`✓ Serial confirmed — ${s1}`, 'ok');
  // Auto-save immediately — serial confirmed is the most critical moment
  autoSaveIdentity();
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

  _resetBtn();

  // ── STEP 5: All checks passed — confirmed ─────────────────────────────
  state.formData.sight_serial = s;
  state.serialVerified = true;
  if (inp) { inp.style.borderBottomColor = 'var(--pass)'; inp.style.backgroundColor = ''; }
  if (sv) {
    sv.style.display = 'block';
    sv.style.color   = 'var(--pass)';
    sv.textContent   = `✓ Sight serial confirmed and registered — ${s}`;
  }
  showToast(`✓ Sight serial confirmed — ${s}`, 'ok');
  // Auto-save immediately, same as launcher confirm
  autoSaveIdentity();
}

async function saveIdentity() {
  // Collect ALL fields from form — including selects
  const map = getIdentityMap();
  Object.entries(map).forEach(([elId, key]) => {
    const el = document.getElementById(elId);
    if (el) state.formData[key] = el.value || null;
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

  // Always set status and card type
  state.formData.status = state.formData.status || 'IN PROGRESS';
  state.formData.card_type = state.cardType;

  let result, error;
  if (state.buildId) {
    ({data: result, error} = await supabaseClient.from('weapon_builds')
      .update({...state.formData, updated_at: new Date().toISOString()})
      .eq('id', state.buildId).select());
  } else {
    ({data: result, error} = await supabaseClient.from('weapon_builds')
      .insert({...state.formData}).select());
    if (!error && result && result.length > 0) state.buildId = result[0].id;
  }

  if (error) { console.error(error); showToast('Save failed — ' + (error.message||'check connection'), 'error'); return; }

  // Update serial register — mark as IN PROGRESS with trolley info
  const regSerial = _unitIdentifierSerial();
  if (regSerial) {
    const serialUpdate = { status: 'IN PROGRESS' };
    if (state.formData.trolley_number)   serialUpdate.trolley_number   = state.formData.trolley_number;
    if (state.formData.trolley_position) serialUpdate.trolley_position = state.formData.trolley_position;
    const { error: serErr } = await supabaseClient.from('weapon_serials')
      .update(serialUpdate)
      .eq('serial_number', regSerial);
    if (serErr) console.warn('Serial status update failed:', serErr);
  }

  await logActivity('IDENTITY_SAVE', state.formData, null);
  showToast('Identity saved ✓', 'ok');
  loadActivityLog(_unitIdentifierSerial());
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

async function logActivity(action,fields,checks) {
  const unitSerial = _unitIdentifierSerial();
  if(!unitSerial) return;
  try {
    await supabaseClient.from('weapon_build_sessions').insert({
      launcher_serial:unitSerial,
      operator_number:state.operator,action,
      fields_updated:fields?JSON.stringify(fields):null,
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
  if(!state.buildId) autoSuggestTrolley();
}

async function autoSuggestTrolley() {
  try {
    const {data}=await supabaseClient.from('weapon_builds')
      .select('trolley_number,trolley_position').not('trolley_number','is',null)
      .order('created_at',{ascending:false}).limit(1);
    let t=1,p=1;
    if(data&&data.length>0&&data[0].trolley_number){t=data[0].trolley_number;p=(data[0].trolley_position||0)+1;if(p>56){t++;p=1;}if(t>20)t=20;}
    const tn=document.getElementById('inp-trolley-no'); if(tn) tn.value=t;
    const tp=document.getElementById('inp-trolley-pos'); if(tp) tp.value=p;
    state.formData.trolley_number=String(t); state.formData.trolley_position=String(p);
  } catch(e){}
}

function handleTrolleyChange() {
  const tp=document.getElementById('inp-trolley-pos'); if(tp) tp.value=1;
  checkTrolleyPositionCollision();
}

// ─── TROLLEY/POSITION COLLISION GUARD ─────────────────────────────────────────
// Fires whenever trolley or position changes on a NEW (unsaved) card.
// If an incomplete card already exists at that exact trolley/position,
// warn immediately and offer to jump straight to it — this is the direct
// safeguard against the exact incident where a duplicate card got created
// because the existing one belonged to a different operator and was
// invisible on the Resume screen.
async function checkTrolleyPositionCollision() {
  // Only relevant when starting a brand-new card — resuming an existing
  // one already has state.buildId set, so there's nothing to collide with.
  if (state.buildId) return;

  const t = document.getElementById('inp-trolley-no')?.value;
  const p = document.getElementById('inp-trolley-pos')?.value;
  if (!t || !p) return;

  try {
    // Scope to this card type too — RLL/XRGL40/GRN40 trolleys are separate
    // lines and a trolley/position pair can legitimately repeat across them.
    const base = supabaseClient.from('weapon_builds')
      .select('id,launcher_serial,sight_serial,operator_number,status')
      .eq('trolley_number', parseInt(t))
      .eq('trolley_position', parseInt(p))
      .eq('card_type', state.cardType);

    // 1) An INCOMPLETE card here — same as before: offer to jump to it.
    const {data: inProgress} = await base.neq('status','COMPLETE').limit(1);
    if (inProgress && inProgress.length > 0) {
      const existing = inProgress[0];
      const serial = existing.launcher_serial || existing.sight_serial;
      const proceed = confirm(
        `⚠ A card already exists at Trolley ${t} / Pos ${p}:\n\n` +
        `  Serial: ${serial || '(not yet entered)'}\n` +
        `  Started by: OP ${existing.operator_number}\n` +
        `  Status: ${existing.status}\n\n` +
        `Tap OK to open that existing card instead, or Cancel to keep ` +
        `filling in a new one (only do this if you're sure this is a ` +
        `genuinely different build).`
      );
      if (proceed) { loadBuild(existing.id); }
      return;
    }

    // 2) A COMPLETED card already here — the gap that let a GRN40 sample
    // get signed off twice for the same trolley/position. It's finished,
    // so there's nothing to jump to — just a hard warning before letting
    // the operator create what would be a duplicate.
    const {data: completed} = await base.eq('status','COMPLETE').limit(1);
    if (completed && completed.length > 0) {
      const existing = completed[0];
      const serial = existing.launcher_serial || existing.sight_serial;
      const proceed = confirm(
        `🚫 Trolley ${t} / Pos ${p} already has a COMPLETED ${state.cardType} card:\n\n` +
        `  Serial: ${serial || '(none recorded)'}\n` +
        `  Signed off by: OP ${existing.operator_number}\n\n` +
        `Starting a new card here will create a DUPLICATE build for this ` +
        `position. Only continue if this trolley/position is genuinely ` +
        `being reused for a new, different unit.`
      );
      if (!proceed) {
        // Clear the position so they don't accidentally submit into it
        const posEl = document.getElementById('inp-trolley-pos');
        if (posEl) posEl.value = '';
      }
    }
  } catch(e) {
    console.warn('[TrolleyCollision] Check failed:', e);
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
function refreshChecks() {
  const cfg=getCardConfig();
  const container=document.getElementById('checks-list');
  const total = cfg.stages ? cfg.stages.length : cfg.checks.length;

  if(container.children.length===total){
    if(cfg.checks) cfg.checks.forEach(c=>applyCheckVisual(c.id));
    updateChecksProgress(); return;
  }
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
    const btnLabel1=chk.type==='go_nogo'?'GO':'PASS';
    const btnLabel2=chk.type==='go_nogo'?'NO-GO':'FAIL';
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
      <div class="check-btns" style="margin-top:8px;">
        <button class="chk-btn pass" onclick="setCheck('${chk.id}','${btnLabel1}')">${btnLabel1}</button>
        <button class="chk-btn fail" onclick="setCheck('${chk.id}','${btnLabel2}')">${btnLabel2}</button>
        <button class="chk-btn na"   onclick="setCheck('${chk.id}','N/A')">N/A</button>
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

function setCheck(id,result) {
  if(!state.checks[id]) state.checks[id]={};
  const prevResult = state.checks[id].result;
  const prevOp = state.checks[id].assy_no;
  state.checks[id].result=result;
  // Always stamp the CURRENT operator — whoever last changed a result gets
  // credited for it. Previously this used "existing || current", which meant
  // whoever touched a check FIRST stayed credited forever, even if a
  // different operator logged in later and corrected that same check.
  state.checks[id].assy_no=state.operator;
  state.checks[id].timestamp=new Date().toISOString();
  applyCheckVisual(id); updateChecksProgress(); updateNavBadges();
  const stamp=document.getElementById(`assy-${id}`);
  if(stamp) stamp.textContent=`OP ${state.checks[id].assy_no}`;
  // Auto-persist to DB on every check tap — so half-filled cards survive
  if (state.buildId) {
    supabaseClient.from('weapon_builds').update({checks:state.checks}).eq('id',state.buildId).then(({error})=>{
      if(error) showToast('Auto-save failed','warn');
    });
    // Keep weapon_serials in sync so serial register shows correct progress
    const regSerial = _unitIdentifierSerial();
    if (regSerial) {
      const cfg=getCardConfig();
      const total=cfg.stages?cfg.stages.length:cfg.checks.length;
      const done=Object.values(state.checks).filter(v=>v&&v.result).length;
      const pct=total>0?Math.round(done/total*100):0;
      // Only update to COMPLETE via handleSubmit — here just ensure IN PROGRESS
      supabaseClient.from('weapon_serials')
        .update({status:'IN PROGRESS', checks_done:done, checks_total:total, pct_complete:pct})
        .eq('serial_number', regSerial)
        .then(()=>{});
    }
  }
  // Log individual check action with full detail
  const cfg=getCardConfig();
  const checkDef = (cfg.checks||cfg.stages||[]).find(c=>c.id===id);
  const label = checkDef ? checkDef.label : id;
  logActivity('CHECK_MARKED', null, {
    check_id: id,
    check_label: label,
    result: result,
    prev_result: prevResult || 'UNMARKED',
    assy_no: state.checks[id].assy_no,
    prev_assy_no: prevOp || 'none',
    timestamp: state.checks[id].timestamp
  });
}

function setCheckValue(id,value) { if(!state.checks[id]) state.checks[id]={}; state.checks[id].value=value; }

function editAssyNo(id) {
  const current=state.checks[id]?.assy_no||state.operator;
  const newNo=prompt(`Assy No for this check:\nCurrently: OP ${current}\n\nEnter operator number:`);
  if(!newNo||!newNo.trim()) return;
  const prev = state.checks[id]?.assy_no || state.operator;
  if(!state.checks[id]) state.checks[id]={};
  state.checks[id].assy_no=newNo.trim();
  const stamp=document.getElementById(`assy-${id}`); if(stamp) stamp.textContent=`OP ${newNo.trim()}`;
  showToast(`Assy No → ${newNo.trim()}`,'ok');
  // Log the operator reassignment
  const cfg=getCardConfig();
  const checkDef = (cfg.checks||cfg.stages||[]).find(c=>c.id===id);
  const label = checkDef ? checkDef.label : id;
  logActivity('ASSY_NO_CHANGED', null, {
    check_id: id,
    check_label: label,
    changed_from: prev,
    changed_to: newNo.trim(),
    by_operator: state.operator,
    timestamp: new Date().toISOString()
  });
}

function applyCheckVisual(id) {
  const chkData=state.checks[id]; if(!chkData||!chkData.result) return;
  const result=chkData.result;
  const row=document.getElementById(`chk-row-${id}`); if(!row) return;
  const isPass=result==='PASS'||result==='GO';
  const isFail=result==='FAIL'||result==='NO-GO';
  row.setAttribute('data-result',isPass?'PASS':isFail?'FAIL':'N/A');
  row.querySelectorAll('.chk-btn').forEach(b=>b.classList.remove('selected'));
  row.querySelectorAll('.chk-btn').forEach(b=>{if(b.textContent.trim()===result||( result==='PASS'&&b.textContent.trim()==='✓')||(result==='FAIL'&&b.textContent.trim()==='✗')) b.classList.add('selected');});
}

function updateChecksProgress() {
  const cfg=getCardConfig();
  const total=cfg.stages?cfg.stages.length:cfg.checks.length;
  const done=Object.values(state.checks).filter(v=>v&&v.result).length;
  const fails=Object.values(state.checks).filter(v=>v&&(v.result==='FAIL'||v.result==='NO-GO')).length;
  const el=document.getElementById('checks-progress');
  if(el) el.textContent=`${done}/${total}${fails>0?` · ${fails} FAIL`:''}`;
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
    // Existing build — just update checks
    const {error} = await supabaseClient.from('weapon_builds').update({checks:state.checks}).eq('id',state.buildId);
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
    const {data, error} = await supabaseClient.from('weapon_builds').insert(draft).select().limit(1);
    if (error) { showToast('Save failed — ' + (error.message||'check connection'), 'error'); return; }
    if (data && data.length > 0) {
      state.buildId = data[0].id;
      showToast(`Draft saved — ${done}/${total} marked`, 'ok');
    }
  } else {
    // No identity at all — warn operator
    showToast('⚠ Save identity (Step 1) before saving checks', 'warn');
  }
}

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
  if(state.formData.qa_operator) document.getElementById('inp-qa-operator').value=state.formData.qa_operator;
  if(state.formData.qa_note) document.getElementById('inp-qa-note').value=state.formData.qa_note;
  updateCardBadges();
}

async function handleSubmit() {
  const qa=document.getElementById('inp-qa-operator').value.trim();
  const fat=document.getElementById('inp-fat-name').value.trim();
  if(!qa){showToast('QA operator number required','error');return;}
  if(!fat){showToast('FAT name required','error');return;}
  const btn=document.getElementById('btn-submit');
  btn.textContent='Saving…'; btn.disabled=true;
  const cfg=getCardConfig();
  const total=cfg.stages?cfg.stages.length:cfg.checks.length;
  const updates={
    qa_operator:qa,qa_note:document.getElementById('inp-qa-note').value.trim()||null,
    fat_name:fat,fat_date:document.getElementById('inp-fat-date').value||null,
    completed_at:new Date().toISOString(),checks:state.checks,
    checks_complete:Object.values(state.checks).filter(v=>v&&v.result).length===total,
    status:'COMPLETE'
  };
  let error;
  if(state.buildId){({error}=await supabaseClient.from('weapon_builds').update(updates).eq('id',state.buildId));}
  else{({error}=await supabaseClient.from('weapon_builds').insert({...state.formData,...updates}));}
  const regSerial=_unitIdentifierSerial();
  if(!error&&regSerial){
    await supabaseClient.from('weapon_serials').update({status:'COMPLETE'}).eq('serial_number',regSerial);
  }
  await logActivity('QA_SIGNOFF',{qa_operator:qa,fat_name:fat},state.checks);
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
    if (el) state.formData[key] = el.value || null;
  });
  state.formData.status    = state.formData.status    || 'IN PROGRESS';
  state.formData.card_type = state.cardType;

  try {
    let result, error;
    if (state.buildId) {
      ({data: result, error} = await supabaseClient
        .from('weapon_builds')
        .update({...state.formData, updated_at: new Date().toISOString()})
        .eq('id', state.buildId).select());
    } else {
      ({data: result, error} = await supabaseClient
        .from('weapon_builds')
        .insert({...state.formData}).select());
      if (!error && result && result.length > 0) {
        state.buildId = result[0].id;
      }
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
        .eq('serial_number', regSerial);
    }

    if (indEl) {
      indEl.textContent = '✓ Saved';
      indEl.style.color = 'var(--pass)';
      setTimeout(() => { if(indEl) indEl.textContent = ''; }, 3000);
    }
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
    if (indEl) {
      indEl.textContent = '⚠ Auto-save failed';
      indEl.style.color = 'var(--warn)';
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
    s = s.replace(/[^A-Z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  } else {
    s = s.replace(/[^A-Z0-9 \-]/g, '').replace(/\s+/g, ' ').trim();
  }
  return s;
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
