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
  const hideNav = ['screen-login','screen-complete'].includes(screenId);
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
      // GRN40 stages must have a tech_no
      if (chk.tech_no !== undefined || (cfg.stages && cfg.stages.find(s=>s.id===chk.id))) {
        if (!saved.tech_no) missing.push(chk.label + ' (tech no required)');
      }
    });
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
function handleLogin() {
  const op = document.getElementById('inp-operator').value.trim();
  const ct = document.getElementById('inp-card-type').value;
  if (!op) { showToast('Enter your operator number','error'); return; }
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
    const {data}=await supabaseClient.from('weapon_builds')
      .select('id,launcher_serial,trolley_number,trolley_position,client_country,created_at,status,card_type')
      .eq('operator_number',state.operator).neq('status','COMPLETE')
      .order('created_at',{ascending:false}).limit(10);
    if (!data||data.length===0) {
      listEl.innerHTML='<div class="loading-msg">No incomplete cards — start a new one below</div>';
    } else {
      listEl.innerHTML=data.map(r=>`
        <div class="resume-card" onclick="loadBuild('${r.id}')">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
            <span style="background:var(--accent);color:#fff;font-size:10px;font-weight:700;padding:2px 7px;border-radius:4px;">${r.card_type||'RLL'}</span>
            <span style="font-family:var(--font-mono);font-size:14px;font-weight:700;color:var(--accent);">${r.launcher_serial||'No serial yet'}</span>
          </div>
          <div style="font-size:11px;color:var(--text-dim);">
            Trolley ${r.trolley_number||'—'} · Pos ${r.trolley_position||'—'} · ${r.client_country||'—'} · ${formatDate(new Date(r.created_at))}
          </div>
        </div>`).join('');
    }
  } catch(e) { listEl.innerHTML='<div class="loading-msg">Could not load cards</div>'; }
}

async function findBySerial() {
  const serial=document.getElementById('inp-find-serial').value.trim().toUpperCase();
  if (!serial){showToast('Enter a serial number','error');return;}
  const {data}=await supabaseClient.from('weapon_builds').select('id,card_type').eq('launcher_serial',serial).neq('status','COMPLETE').limit(1);
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
  state.checks=row.checks||{}; state.serialVerified=!!row.launcher_serial;
  state.cardType=row.card_type||'RLL';
  updateCardBadges();
  buildIdentityGrid();
  refreshIdentity();
  show('screen-identity');
  populateTrolley(); populateYear(); loadCustomers();
  loadActivityLog(row.launcher_serial); initOCR();
}

function startNewCard() {
  state.buildId=null;
  state.formData={operator_number:state.operator,card_type:state.cardType,status:'IN PROGRESS',started_at:new Date().toISOString()};
  state.checks={}; state.serialVerified=false;
  updateCardBadges();
  buildIdentityGrid();
  show('screen-identity');
  populateTrolley(); populateYear(); loadCustomers(); initOCR();
}

function goToResume() {
  state.buildId=null; state.formData={}; state.checks={}; state.serialVerified=false;
  show('screen-resume'); loadResumeScreen();
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
        <label class="yellow">Sight Serial No</label>
        <div class="serial-row">
          <input type="text" id="inp-sight-serial" placeholder="Tap 📷" autocapitalize="characters" spellcheck="false">
          <img class="serial-thumb" id="thumb-inp-sight-serial">
          <button class="cam-btn" onclick="captureSerial('inp-sight-serial','photo_sight')">📷</button>
        </div>
      </div>
      <div class="card-cell span2">
        <label>Client / Contract</label>
        <select id="inp-customer" style="font-family:var(--font-ui);font-size:13px;"></select>
      </div>
      <div class="card-cell">
        <label>Year of Manufacturing</label>
        <select id="inp-year"></select>
      </div>
      <div class="card-cell">
        <label>Trolley No</label>
        <select id="inp-trolley-no" onchange="handleTrolleyChange()"></select>
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
        <button class="cam-btn" onclick="captureSerial('inp-sight-serial','photo_sight')">📷</button>
      </div>
    </div>` : '<div class="card-cell"></div>';

  const hfmProdRow = (state.cardType==='XRGL40') ? `
    <div class="card-cell">
      <label class="yellow">HFM Production No</label>
      <div class="serial-row">
        <input type="text" id="inp-hfm-prod-no" placeholder="Tap 📷" autocapitalize="characters" spellcheck="false">
        <img class="serial-thumb" id="thumb-inp-hfm-prod-no">
        <button class="cam-btn" onclick="captureSerial('inp-hfm-prod-no','photo_hfm_prod')">📷</button>
      </div>
    </div>
    <div class="card-cell">
      <label class="yellow">HRC Production No</label>
      <div class="serial-row">
        <input type="text" id="inp-hrc-prod-no" placeholder="Tap 📷" autocapitalize="characters" spellcheck="false">
        <img class="serial-thumb" id="thumb-inp-hrc-prod-no">
        <button class="cam-btn" onclick="captureSerial('inp-hrc-prod-no','photo_hrc_prod')">📷</button>
      </div>
    </div>` : '';

  grid.innerHTML = `
    <div class="card-cell">
      <label>Trolley No</label>
      <select id="inp-trolley-no" onchange="handleTrolleyChange()"></select>
    </div>
    <div class="card-cell">
      <label>Trolley Position</label>
      <select id="inp-trolley-pos"></select>
    </div>
    <div class="card-cell">
      <label>Year of Manufacturing</label>
      <select id="inp-year"></select>
    </div>
    ${sightRow}
    <div class="card-cell span2">
      <label>Client / Contract</label>
      <select id="inp-customer" style="font-family:var(--font-ui);font-size:13px;"></select>
    </div>
    <!-- Launcher Serial — full width with confirm -->
    <div class="card-cell span2">
      <label class="yellow">Launcher Serial No ★</label>
      <div class="serial-row">
        <input type="text" id="inp-launcher-serial" placeholder="Tap 📷 or type"
               autocapitalize="characters" spellcheck="false" onchange="resetSerialConfirm()">
        <img class="serial-thumb" id="thumb-inp-launcher-serial">
        <button class="cam-btn" onclick="captureSerial('inp-launcher-serial','photo_launcher')">📷</button>
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
        <button class="cam-btn" onclick="captureSerial('inp-barrel-no','photo_barrel')">📷</button>
      </div>
    </div>
    <div class="card-cell">
      <label class="yellow">Barrel Production No</label>
      <div class="serial-row">
        <input type="text" id="inp-barrel-prod-no" placeholder="Tap 📷" autocapitalize="characters" spellcheck="false">
        <img class="serial-thumb" id="thumb-inp-barrel-prod-no">
        <button class="cam-btn" onclick="captureSerial('inp-barrel-prod-no','photo_barrel_prod')">📷</button>
      </div>
    </div>
    <!-- Cylinder No | HRC Serial No -->
    <div class="card-cell">
      <label class="yellow">Cylinder No</label>
      <div class="serial-row">
        <input type="text" id="inp-cylinder-no" placeholder="Tap 📷" autocapitalize="characters" spellcheck="false">
        <img class="serial-thumb" id="thumb-inp-cylinder-no">
        <button class="cam-btn" onclick="captureSerial('inp-cylinder-no','photo_cylinder')">📷</button>
      </div>
    </div>
    <div class="card-cell">
      <label class="yellow">HRC Serial No</label>
      <div class="serial-row">
        <input type="text" id="inp-hrc-serial" placeholder="Tap 📷" autocapitalize="characters" spellcheck="false">
        <img class="serial-thumb" id="thumb-inp-hrc-serial">
        <button class="cam-btn" onclick="captureSerial('inp-hrc-serial','photo_hrc')">📷</button>
      </div>
    </div>
    <!-- Cylinder Production No | Firing Mech No -->
    <div class="card-cell">
      <label class="yellow">Cylinder Production No</label>
      <div class="serial-row">
        <input type="text" id="inp-cylinder-prod-no" placeholder="Tap 📷" autocapitalize="characters" spellcheck="false">
        <img class="serial-thumb" id="thumb-inp-cylinder-prod-no">
        <button class="cam-btn" onclick="captureSerial('inp-cylinder-prod-no','photo_cylinder_prod')">📷</button>
      </div>
    </div>
    <div class="card-cell">
      <label class="yellow">Firing Mech No</label>
      <div class="serial-row">
        <input type="text" id="inp-firing-mech" placeholder="Tap 📷" autocapitalize="characters" spellcheck="false">
        <img class="serial-thumb" id="thumb-inp-firing-mech">
        <button class="cam-btn" onclick="captureSerial('inp-firing-mech','photo_firing_mech')">📷</button>
      </div>
    </div>
    <!-- HFM Serial No | empty -->
    <div class="card-cell">
      <label class="yellow">HFM Serial No</label>
      <div class="serial-row">
        <input type="text" id="inp-hfm-serial" placeholder="Tap 📷" autocapitalize="characters" spellcheck="false">
        <img class="serial-thumb" id="thumb-inp-hfm-serial">
        <button class="cam-btn" onclick="captureSerial('inp-hfm-serial','photo_hfm')">📷</button>
      </div>
    </div>
    <div class="card-cell"></div>
    ${hfmProdRow}`;
}

// ─── IDENTITY SAVE/RESTORE ────────────────────────────────────────────────────
function getIdentityMap() {
  const base = {
    'inp-trolley-no':'trolley_number','inp-trolley-pos':'trolley_position',
    'inp-year':'year_of_manufacture','inp-customer':'client_country',
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
  const logWrap=document.getElementById('activity-log-wrap');
  if(logWrap) logWrap.style.display=state.buildId?'block':'none';
  updateCardBadges();
}

function resetSerialConfirm() {
  state.serialVerified=false;
  const lv=document.getElementById('launcher-verified');
  const lw=document.getElementById('launcher-confirm-wrap');
  const val=document.getElementById('inp-launcher-serial')?.value.trim();
  if(lv) lv.style.display='none';
  if(lw) lw.style.display=val&&val.length>2?'block':'none';
}

async function confirmLauncherSerial() {
  const s1 = document.getElementById('inp-launcher-serial')?.value.trim().toUpperCase();
  const s2 = document.getElementById('inp-launcher-confirm')?.value.trim().toUpperCase();

  // Step 1: Both fields must be filled
  if (!s1 || !s2) { showToast('Enter serial in both fields', 'error'); return; }

  // Step 2: Both entries must match exactly
  if (s1 !== s2) {
    showToast('❌ Serials do not match — check and re-enter', 'error');
    // Clear confirm field and highlight it red
    const conf = document.getElementById('inp-launcher-confirm');
    if (conf) { conf.value = ''; conf.style.borderBottomColor = 'var(--fail)'; conf.focus(); }
    return;
  }

  // Step 3: Check if serial exists in the register
  const btn = document.querySelector('#launcher-confirm-wrap button');
  if (btn) { btn.textContent = 'Checking…'; btn.disabled = true; }

  const validation = await validateSerialExists(s1);

  if (!validation.exists) {
    showToast(`⚠ Serial ${s1} not found in register — check serial number`, 'warn');
    // Still allow — serial might be for a different product line
    // But warn the operator clearly
  }

  // Step 4: Check for duplicates
  if (!state.buildId) {
    const dupeCheck = await checkDuplicateSerial(s1);
    if (dupeCheck.isDupe) {
      const st = dupeCheck.status || 'EXISTS';
      const rec = dupeCheck.record || {};
      let msg = `🚫 DUPLICATE — ${s1} already exists`;
      if (st === 'COMPLETE') msg += ` (COMPLETED build card)`;
      else if (st === 'IN PROGRESS') msg += ` — IN PROGRESS on Trolley ${rec.trolley_number||'?'} Pos ${rec.trolley_position||'?'} by OP ${rec.operator_number||'?'}`;
      showToast(msg, 'error');
      // Also show in the verified field
      const lv = document.getElementById('launcher-verified');
      if (lv) { lv.style.display='block'; lv.textContent=msg; lv.style.color='var(--fail)'; }
      if (btn) { btn.textContent = '✓'; btn.disabled = false; }
      return;
    }
  }

  if (btn) { btn.textContent = '✓'; btn.disabled = false; }

  // Step 5: Confirmed!
  state.formData.launcher_serial = s1;
  state.serialVerified = true;
  const lv = document.getElementById('launcher-verified');
  const lw = document.getElementById('launcher-confirm-wrap');
  if (lv) {
    lv.style.display = 'block';
    lv.textContent = validation.exists
      ? `✓ Serial verified — ${s1}`
      : `⚠ Serial verified (not in register) — ${s1}`;
    lv.style.color = validation.exists ? 'var(--pass)' : 'var(--warn)';
  }
  if (lw) lw.style.display = 'none';
  showToast(validation.exists ? `✓ Serial confirmed — ${s1}` : `⚠ Serial confirmed but not in register — ${s1}`,
            validation.exists ? 'ok' : 'warn');
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
  if (state.formData.launcher_serial) {
    const serialUpdate = { status: 'IN PROGRESS' };
    if (state.formData.trolley_number)   serialUpdate.trolley_number   = state.formData.trolley_number;
    if (state.formData.trolley_position) serialUpdate.trolley_position = state.formData.trolley_position;
    const { error: serErr } = await supabaseClient.from('weapon_serials')
      .update(serialUpdate)
      .eq('serial_number', state.formData.launcher_serial);
    if (serErr) console.warn('Serial status update failed:', serErr);
  }

  await logActivity('IDENTITY_SAVE', state.formData, null);
  showToast('Identity saved ✓', 'ok');
  loadActivityLog(state.formData.launcher_serial);
}

// ─── ACTIVITY LOG ─────────────────────────────────────────────────────────────
async function logActivity(action,fields,checks) {
  if(!state.formData.launcher_serial) return;
  try {
    await supabaseClient.from('weapon_build_sessions').insert({
      launcher_serial:state.formData.launcher_serial,
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

function handleTrolleyChange() { const tp=document.getElementById('inp-trolley-pos'); if(tp) tp.value=1; }

function populateYear() {
  const sel=document.getElementById('inp-year'); if(!sel||sel.options.length>1) return;
  sel.innerHTML='<option value="">— Select —</option>';
  const y=new Date().getFullYear();
  for(let i=y;i<=y+2;i++) sel.innerHTML+=`<option value="${i}">${i}</option>`;
  if(!state.formData.year_of_manufacture) sel.value=y;
}

async function loadCustomers() {
  try {
    const {data}=await supabaseClient.from('supplier_po').select('project').order('project');
    const unique=[...new Set((data||[]).map(r=>r.project).filter(Boolean))];
    const sel=document.getElementById('inp-customer'); if(!sel) return;
    sel.innerHTML='<option value="">— Select Contract / Country —</option>';
    unique.forEach(c=>sel.innerHTML+=`<option value="${c}">${c}</option>`);
    if(state.formData.client_country) sel.value=state.formData.client_country;
  } catch(e){}
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
      <div style="font-size:10px;font-weight:800;color:var(--text);line-height:1.3;margin-bottom:2px;">${s.label}</div>
      ${s.process?`<div style="font-size:9px;color:var(--text-dim);margin-bottom:4px;">${s.process}</div>`:''}
      <div style="font-size:9px;color:var(--text-dim);margin-bottom:6px;font-family:var(--font-mono);">${s.partNo}</div>
      <div style="font-size:9px;color:var(--label);margin-bottom:2px;font-weight:700;">TECH NO</div>
      <input type="text" placeholder="Op No" value="${saved.tech_no||''}"
             onchange="setStageValue('${s.id}',this.value)"
             style="width:100%;border:none;border-bottom:1px solid var(--border);background:transparent;
                    font-size:11px;padding:2px;outline:none;color:var(--text);font-family:var(--font-mono);">
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
  state.checks[id].assy_no=state.checks[id].assy_no||state.operator;
  state.checks[id].timestamp=new Date().toISOString();
  applyCheckVisual(id); updateChecksProgress(); updateNavBadges();
  const stamp=document.getElementById(`assy-${id}`);
  if(stamp) stamp.textContent=`OP ${state.checks[id].assy_no}`;
  // Auto-persist to DB on every check tap — so half-filled cards survive
  if (state.buildId) {
    supabaseClient.from('weapon_builds').update({checks:state.checks}).eq('id',state.buildId).then(({error})=>{
      if(error) showToast('Auto-save failed','warn');
    });
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
function setStageValue(id,value) { if(!state.checks[id]) state.checks[id]={}; state.checks[id].tech_no=value; }

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
  } else if (state.formData && state.formData.launcher_serial) {
    // No buildId yet but we have identity data — create a draft build record
    const draft = {
      ...state.formData,
      card_type: state.cardType,
      operator_number: state.operator,
      checks: state.checks,
      status: 'IN PROGRESS',
      started_at: new Date().toISOString(),
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
  document.getElementById('so-serial').textContent=state.formData.launcher_serial||'—';
  document.getElementById('so-trolley').textContent=`${state.formData.trolley_number||'—'} / Pos ${state.formData.trolley_position||'—'}`;
  document.getElementById('so-client').textContent=state.formData.client_country||'—';
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
  if(!error&&state.formData.launcher_serial){
    await supabaseClient.from('weapon_serials').update({status:'COMPLETE'}).eq('serial_number',state.formData.launcher_serial);
  }
  await logActivity('QA_SIGNOFF',{qa_operator:qa,fat_name:fat},state.checks);
  btn.textContent='Submit & Save Build Card'; btn.disabled=false;
  if(error){console.error(error);showToast('Save failed','error');return;}
  showToast('Build card saved ✓','ok');
  document.getElementById('done-serial').textContent=state.formData.launcher_serial||'—';
  setTimeout(()=>show('screen-complete'),800);
}

// ─── CAMERA + OCR ─────────────────────────────────────────────────────────────
let tesseractWorker=null;
async function initOCR() {
  try {
    tesseractWorker=await Tesseract.createWorker('eng');
    await tesseractWorker.setParameters({tessedit_char_whitelist:'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789- '});
    const el=document.getElementById('ocr-status'); if(el) el.textContent='📷 Camera ready — tap icon next to any yellow serial field';
  } catch(e){ const el=document.getElementById('ocr-status'); if(el) el.textContent='⚠ OCR not available — type manually'; }
}

async function captureSerial(fieldId,photoKey) {
  const input=document.createElement('input');
  input.type='file'; input.accept='image/*'; input.capture='environment';
  input.style.display='none'; document.body.appendChild(input);
  input.onchange=async(e)=>{
    const file=e.target.files[0]; if(!file){document.body.removeChild(input);return;}
    const reader=new FileReader();
    reader.onload=async(ev)=>{
      const base64=ev.target.result; state.formData[photoKey]=base64;
      const thumb=document.getElementById(`thumb-${fieldId}`); if(thumb){thumb.src=base64;thumb.style.display='block';}
      const inp=document.getElementById(fieldId); if(inp){inp.placeholder='Reading…';inp.disabled=true;}
      const statusEl=document.getElementById('ocr-status'); if(statusEl) statusEl.textContent='🔍 Reading serial…';
      showToast('Reading serial…','ok');
      try {
        if(!tesseractWorker) await initOCR();
        const {data}=await tesseractWorker.recognize(base64);
        let text=data.text.trim().toUpperCase().replace(/\n/g,' ').replace(/\s+/g,' ').trim();
        if(inp){inp.value=text;inp.disabled=false;inp.placeholder='Confirm or correct';}
        if(statusEl) statusEl.textContent='✓ Read — confirm or correct above';
        if(fieldId==='inp-launcher-serial') resetSerialConfirm();
        showToast('Done — confirm serial ✓','ok');
      } catch(err){
        if(inp){inp.disabled=false;inp.placeholder='Type manually';}
        if(statusEl) statusEl.textContent='⚠ Could not read — type manually';
        showToast('OCR failed — type manually','warn');
      }
    };
    reader.readAsDataURL(file); document.body.removeChild(input);
  };
  input.click();
}

// ─── UTILS ────────────────────────────────────────────────────────────────────
function formatDate(d){return new Date(d).toLocaleDateString('en-ZA',{day:'2-digit',month:'short',year:'numeric'});}
let toastTimer;
function showToast(msg,type='ok'){
  const t=document.getElementById('toast'); t.textContent=msg; t.className=`toast ${type} visible`;
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>t.classList.remove('visible'),3200);
}
