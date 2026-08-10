// ─── STATE ────────────────────────────────────────────────────────────────────
const state = {
  operator: null,
  checks: {},
  formData: {},
  serialVerified: false
};

const RLL_CHECKS = [
  { id:'c01', label:'Frame inspection — no cracks or deformation' },
  { id:'c02', label:'Barrel installation correct and torqued' },
  { id:'c03', label:'Bolt carrier group fitted and cycles freely' },
  { id:'c04', label:'Trigger group installed — pull weight within spec' },
  { id:'c05', label:'Pistol grip fitted and fastened' },
  { id:'c06', label:'Stock / buffer assembly installed' },
  { id:'c07', label:'Magazine catch operates correctly' },
  { id:'c08', label:'Safety selector — all positions confirmed' },
  { id:'c09', label:'Dust cover fitted and spring-loaded correctly' },
  { id:'c10', label:'Handguard secured — no movement' },
  { id:'c11', label:'Gas system installed and aligned' },
  { id:'c12', label:'Muzzle device fitted and torqued' },
  { id:'c13', label:'All external surfaces — finish inspection' },
  { id:'c14', label:'Serial number engraving — legible and correct' },
  { id:'c15', label:'Function test — dry cycle confirmed' },
  { id:'c16', label:'Lubrication applied per spec' },
  { id:'c17', label:'Final visual — no loose components or tooling left' }
];

const SECTIONS = [
  { id:'identity', screen:'screen-identity' },
  { id:'serial',   screen:'screen-serial'   },
  { id:'checks',   screen:'screen-checks'   },
  { id:'signoff',  screen:'screen-signoff'  },
];

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
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.toggle('active', t.dataset.screen === screenId));
  const nav = document.getElementById('bottom-nav');
  if (nav) nav.classList.toggle('hidden', ['screen-login','screen-complete'].includes(screenId));
}

function showSection(id) {
  const sec = SECTIONS.find(s => s.id === id);
  if (!sec) return;
  if (id === 'identity') refreshIdentity();
  if (id === 'checks')   refreshChecks();
  if (id === 'signoff')  refreshSignoff();
  show(sec.screen);
}

// ─── LOGIN ─────────────────────────────────────────────────────────────────────
function handleLogin() {
  const op = document.getElementById('inp-operator').value.trim();
  if (!op) { showToast('Enter your operator number', 'error'); return; }
  state.operator = op;
  state.formData = { operator_number: op, card_type: 'RLL', session_start: new Date().toISOString() };
  showToast(`Session started — Operator ${op}`, 'ok');
  setTimeout(() => {
    refreshIdentity();
    show('screen-identity');
    document.getElementById('bottom-nav').classList.remove('hidden');
    populateTrolley();
    populateYear();
    loadCustomers();
    initOCR();
  }, 400);
}

// ─── IDENTITY ─────────────────────────────────────────────────────────────────
function refreshIdentity() {
  const opEl = document.getElementById('id-op');
  if (opEl) opEl.textContent = state.operator || '—';
  // Restore saved values
  const map = getIdentityMap();
  Object.entries(map).forEach(([elId, key]) => {
    const el = document.getElementById(elId);
    if (el && state.formData[key]) el.value = state.formData[key];
  });
}

function getIdentityMap() {
  return {
    'inp-trolley-no':       'trolley_number',
    'inp-trolley-pos':      'trolley_position',
    'inp-year':             'year_of_manufacture',
    'inp-customer':         'client_country',
    'inp-launcher-serial':  'launcher_serial',
    'inp-barrel-no':        'barrel_no',
    'inp-cylinder-no':      'cylinder_no',
    'inp-barrel-prod-no':   'barrel_production_no',
    'inp-cylinder-prod-no': 'cylinder_production_no',
    'inp-hrc-serial':       'hrc_serial_no',
    'inp-hfm-serial':       'hfm_serial_no',
    'inp-firing-mech':      'firing_mech_no',
  };
}

function saveIdentity() {
  const map = getIdentityMap();
  Object.entries(map).forEach(([elId, key]) => {
    const el = document.getElementById(elId);
    if (el) state.formData[key] = el.value;
  });
  showToast('Identity fields saved ✓', 'ok');
}

// ─── TROLLEY ──────────────────────────────────────────────────────────────────
function populateTrolley() {
  const tSel = document.getElementById('inp-trolley-no');
  if (!tSel || tSel.options.length > 1) return;
  tSel.innerHTML = '<option value="">— Select —</option>';
  for (let i=1; i<=20; i++) tSel.innerHTML += `<option value="${i}">Trolley ${i}</option>`;
  const pSel = document.getElementById('inp-trolley-pos');
  pSel.innerHTML = '<option value="">— Select —</option>';
  for (let i=1; i<=56; i++) pSel.innerHTML += `<option value="${i}">Pos ${i}</option>`;
  autoSuggestTrolley();
}

async function autoSuggestTrolley() {
  try {
    const { data } = await supabaseClient.from('weapon_builds')
      .select('trolley_number,trolley_position')
      .not('trolley_number','is',null)
      .order('created_at',{ascending:false}).limit(1);
    let t=1, p=1;
    if (data && data.length > 0 && data[0].trolley_number) {
      t = data[0].trolley_number;
      p = (data[0].trolley_position||0) + 1;
      if (p > 56) { t++; p=1; }
      if (t > 20) t=20;
    }
    document.getElementById('inp-trolley-no').value = t;
    document.getElementById('inp-trolley-pos').value = p;
    state.formData.trolley_number   = String(t);
    state.formData.trolley_position = String(p);
  } catch(e) {}
}

function handleTrolleyChange() {
  document.getElementById('inp-trolley-pos').value = 1;
}

function populateYear() {
  const sel = document.getElementById('inp-year');
  if (!sel || sel.options.length > 1) return;
  sel.innerHTML = '<option value="">— Select —</option>';
  const y = new Date().getFullYear();
  for (let i=y; i<=y+2; i++) sel.innerHTML += `<option value="${i}">${i}</option>`;
  sel.value = y;
}

async function loadCustomers() {
  try {
    const { data } = await supabaseClient.from('weapon_serials').select('customer').order('customer');
    const unique = [...new Set((data||[]).map(r=>r.customer).filter(Boolean))];
    const sel = document.getElementById('inp-customer');
    sel.innerHTML = '<option value="">— Select —</option>';
    unique.forEach(c => sel.innerHTML += `<option value="${c}">${c}</option>`);
    if (state.formData.client_country) sel.value = state.formData.client_country;
  } catch(e) {}
}

// ─── SERIAL VERIFY ────────────────────────────────────────────────────────────
async function handleSerialConfirm() {
  const e1 = document.getElementById('inp-serial-1').value.trim().toUpperCase();
  const e2 = document.getElementById('inp-serial-2').value.trim().toUpperCase();
  if (!e1||!e2) { showToast('Enter serial in both fields','error'); return; }
  if (e1!==e2)  { showToast('Entries do not match','error'); return; }
  const btn = document.getElementById('btn-serial-confirm');
  btn.textContent='Checking…'; btn.disabled=true;
  const isDupe = await checkDuplicateSerial(e1);
  btn.textContent='Confirm Serial'; btn.disabled=false;
  if (isDupe) { showToast(`DUPLICATE — ${e1} already exists`,'error'); return; }
  state.formData.launcher_serial = e1;
  state.serialVerified = true;
  const statusEl = document.getElementById('serial-status');
  statusEl.textContent = `✓ Verified: ${e1}`;
  statusEl.className = 'serial-verified ok';
  showToast('Serial verified ✓','ok');
}

// ─── CHECKS ───────────────────────────────────────────────────────────────────
function refreshChecks() {
  const container = document.getElementById('checks-list');
  if (container.children.length === RLL_CHECKS.length) {
    RLL_CHECKS.forEach(c => applyCheckVisual(c.id));
    updateChecksProgress(); return;
  }
  container.innerHTML = '';
  RLL_CHECKS.forEach(chk => {
    const row = document.createElement('div');
    row.className='check-row'; row.id=`chk-row-${chk.id}`;
    row.innerHTML=`<span class="check-label">${chk.label}</span>
      <div class="check-btns">
        <button class="chk-btn pass" onclick="setCheck('${chk.id}','PASS')">PASS</button>
        <button class="chk-btn fail" onclick="setCheck('${chk.id}','FAIL')">FAIL</button>
        <button class="chk-btn na"   onclick="setCheck('${chk.id}','N/A')">N/A</button>
      </div>`;
    container.appendChild(row);
    if (state.checks[chk.id]) applyCheckVisual(chk.id);
  });
  updateChecksProgress();
}

function setCheck(id, result) {
  state.checks[id] = result;
  applyCheckVisual(id);
  updateChecksProgress();
  updateNavBadges();
}

function applyCheckVisual(id) {
  const result = state.checks[id];
  if (!result) return;
  const row = document.getElementById(`chk-row-${id}`);
  if (!row) return;
  row.setAttribute('data-result', result);
  row.querySelectorAll('.chk-btn').forEach(b => b.classList.remove('selected'));
  const cls = result==='PASS'?'pass':result==='FAIL'?'fail':'na';
  const btn = row.querySelector(`.chk-btn.${cls}`);
  if (btn) btn.classList.add('selected');
}

function updateChecksProgress() {
  const done=Object.keys(state.checks).length, total=RLL_CHECKS.length;
  const fails=Object.values(state.checks).filter(v=>v==='FAIL').length;
  const el=document.getElementById('checks-progress');
  if (el) el.textContent=`${done}/${total}${fails>0?` · ${fails} FAIL`:''}`;
}

function saveChecks() {
  const done=Object.keys(state.checks).length, total=RLL_CHECKS.length;
  showToast(`Progress saved — ${done}/${total} marked`,'ok');
}

function updateNavBadges() {
  const done=Object.keys(state.checks).length;
  const el=document.getElementById('nav-badge-checks');
  if (el) { el.textContent=done>0?`${done}/${RLL_CHECKS.length}`:''; el.style.display=done>0?'inline':'none'; }
}

// ─── SIGNOFF ──────────────────────────────────────────────────────────────────
function refreshSignoff() {
  document.getElementById('so-serial').textContent   = state.formData.launcher_serial || '—';
  document.getElementById('so-operator').textContent = state.operator || '—';
  document.getElementById('so-date').textContent     = formatDate(new Date());
  const done=Object.keys(state.checks).length, total=RLL_CHECKS.length;
  const fails=Object.values(state.checks).filter(v=>v==='FAIL').length;
  document.getElementById('so-checks').textContent = `${done} / ${total}`;
  const fb=document.getElementById('so-fails');
  fb.textContent=fails; fb.className=`badge ${fails>0?'fail':'pass'}`;
  if (state.formData.qa_operator) document.getElementById('inp-qa-operator').value=state.formData.qa_operator;
  if (state.formData.qa_note)     document.getElementById('inp-qa-note').value=state.formData.qa_note;
}

async function handleSubmit() {
  const qa = document.getElementById('inp-qa-operator').value.trim();
  if (!qa) { showToast('QA operator number required','error'); return; }
  const btn=document.getElementById('btn-submit');
  btn.textContent='Saving…'; btn.disabled=true;
  state.formData.qa_operator   = qa;
  state.formData.qa_note       = document.getElementById('inp-qa-note').value.trim()||null;
  state.formData.completed_at  = new Date().toISOString();
  state.formData.checks        = state.checks;
  state.formData.checks_complete = Object.keys(state.checks).length===RLL_CHECKS.length;
  const {result,error} = await saveRecord('weapon_builds', state.formData);
  btn.textContent='Submit & Save Build Card'; btn.disabled=false;
  if (error) { console.error(error); showToast('Save failed — check connection','error'); return; }
  showToast('Build card saved ✓','ok');
  document.getElementById('done-serial').textContent = state.formData.launcher_serial||'—';
  setTimeout(()=>show('screen-complete'),800);
}

// ─── NEW CARD / END SESSION ───────────────────────────────────────────────────
function startNewCard() {
  state.formData={operator_number:state.operator,card_type:'RLL',session_start:new Date().toISOString()};
  state.checks={}; state.serialVerified=false;
  document.querySelectorAll('input[type="text"],textarea').forEach(el=>el.value='');
  document.getElementById('serial-status').textContent='Not yet verified';
  document.getElementById('serial-status').className='serial-verified';
  document.getElementById('checks-list').innerHTML='';
  updateNavBadges();
  refreshIdentity();
  show('screen-identity');
}

function endSession() {
  state.operator=null; startNewCard(); show('screen-login');
}

// ─── CAMERA + OCR ─────────────────────────────────────────────────────────────
let tesseractWorker=null;

async function initOCR() {
  try {
    tesseractWorker = await Tesseract.createWorker('eng');
    await tesseractWorker.setParameters({ tessedit_char_whitelist:'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789- ' });
    const el=document.getElementById('ocr-status');
    if (el) el.textContent='📷 Camera ready — tap icon next to any yellow serial field';
  } catch(e) {
    const el=document.getElementById('ocr-status');
    if (el) el.textContent='⚠ OCR not available — type serials manually';
  }
}

async function captureSerial(fieldId, photoKey) {
  const input=document.createElement('input');
  input.type='file'; input.accept='image/*'; input.capture='environment';
  input.style.display='none'; document.body.appendChild(input);
  input.onchange=async(e)=>{
    const file=e.target.files[0];
    if (!file) { document.body.removeChild(input); return; }
    const reader=new FileReader();
    reader.onload=async(ev)=>{
      const base64=ev.target.result;
      state.formData[photoKey]=base64;
      const thumb=document.getElementById(`thumb-${fieldId}`);
      if (thumb) { thumb.src=base64; thumb.style.display='block'; }
      const inp=document.getElementById(fieldId);
      if (inp) { inp.placeholder='Reading…'; inp.disabled=true; }
      const statusEl=document.getElementById('ocr-status');
      if (statusEl) statusEl.textContent='🔍 Reading serial number…';
      showToast('Reading serial…','ok');
      try {
        if (!tesseractWorker) await initOCR();
        const {data}=await tesseractWorker.recognize(base64);
        let text=data.text.trim().toUpperCase().replace(/\n/g,' ').replace(/\s+/g,' ').trim();
        if (inp) { inp.value=text; inp.disabled=false; inp.style.borderBottomColor='var(--warn)'; inp.placeholder='Confirm or correct'; }
        state.formData[fieldId.replace('inp-','').replace(/-/g,'_')]=text;
        if (statusEl) statusEl.textContent='✓ Read complete — please confirm or correct the value';
        showToast('Done — confirm serial ✓','ok');
      } catch(err) {
        if (inp) { inp.disabled=false; inp.placeholder='Type manually'; }
        if (statusEl) statusEl.textContent='⚠ Could not read — type manually';
        showToast('OCR failed — type manually','warn');
      }
    };
    reader.readAsDataURL(file);
    document.body.removeChild(input);
  };
  input.click();
}

// ─── UTILS ────────────────────────────────────────────────────────────────────
function formatDate(d) { return d.toLocaleDateString('en-ZA',{day:'2-digit',month:'short',year:'numeric'}); }

let toastTimer;
function showToast(msg,type='ok') {
  const t=document.getElementById('toast');
  t.textContent=msg; t.className=`toast ${type} visible`;
  clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>t.classList.remove('visible'),3200);
}
