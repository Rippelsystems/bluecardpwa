// ─── SUPABASE CONFIG ──────────────────────────────────────────────────────────
// Replace these with your actual Supabase project URL and anon key
// TEST project: wtkbsvopuvtxiprjtqqx
// LIVE project: rifargmdjzsqgkttwgoy
// Get your anon key from: Supabase Dashboard → Project Settings → API

const SUPABASE_URL = 'https://wtkbsvopuvtxiprjtqqx.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_Yyt1XI--EtpYXbsdFy9c8A_4_tTQr9M';

// ─── CLIENT ───────────────────────────────────────────────────────────────────
// Using the Supabase CDN client (loaded in index.html)
let supabaseClient = null;

function initSupabase() {
  if (typeof window.supabase !== 'undefined') {
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    console.log('[Supabase] Client initialised');
  } else {
    console.error('[Supabase] Library not loaded');
  }
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
async function saveRecord(table, data) {
  if (!supabaseClient) return { error: 'Supabase not initialised' };
  const { data: result, error } = await supabaseClient.from(table).insert(data).select();
  return { result, error };
}

async function getAssemblers() {
  if (!supabaseClient) return [];
  const { data, error } = await supabaseClient.from('assemblers').select('*').order('operator_number');
  if (error) { console.error(error); return []; }
  return data || [];
}

async function checkDuplicateSerial(serial) {
  if (!supabaseClient) return false;
  // Check 1: Is there already a COMPLETED build card for this serial?
  const { data: builds } = await supabaseClient
    .from('weapon_builds')
    .select('id,status')
    .eq('launcher_serial', serial)
    .eq('status', 'COMPLETE')
    .limit(1);
  if (builds && builds.length > 0) return true;
  return false;
}

async function validateSerialExists(serial) {
  // Check if serial is in the weapon_serials register at all
  if (!supabaseClient) return { exists: true, status: 'UNKNOWN' };
  const { data } = await supabaseClient
    .from('weapon_serials')
    .select('serial_number, status')
    .eq('serial_number', serial)
    .limit(1);
  if (!data || data.length === 0) return { exists: false, status: null };
  return { exists: true, status: data[0].status };
}
