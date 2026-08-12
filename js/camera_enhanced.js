// ─── ENHANCED CAMERA + OCR MODULE ─────────────────────────────────────────────
// Uses OpenCV.js preprocessing + Tesseract.js for dot-matrix serial recognition
// Loads OpenCV from CDN — no installation needed on tablet

let tesseractWorker = null;
let openCVReady = false;

// ── Known serial format patterns ──────────────────────────────────────────────
// Add confirmed formats here once Michiel confirms them
// Examples:
//   RLL: "RLL NNNNN"     e.g. RLL 26004
//   XRGL: "XNN NNNN LLL" e.g. X26 3007 RSA
const SERIAL_FORMATS = {
  'RLL':    { pattern: /^RLL\s?\d{4,6}$/i,          hint: 'RLL followed by 4-6 digits' },
  'XRGL40': { pattern: /^[A-Z]\d{2}\s?\d{4}\s?[A-Z]{2,3}$/i, hint: 'Letter+2digits space 4digits space 2-3letters' },
  'GRN40':  { pattern: /^GRN\s?\d{4,6}$/i,           hint: 'GRN followed by 4-6 digits' },
  'ANY':    { pattern: /^[A-Z0-9\s\-]{4,20}$/i,      hint: 'Any alphanumeric serial' },
};

// ── Common dot-matrix OCR confusion pairs ─────────────────────────────────────
// Used to suggest corrections when confidence is low
const CONFUSION_PAIRS = [
  ['0', '9'], ['0', 'O'], ['1', 'I'], ['1', 'L'],
  ['5', 'S'], ['8', 'B'], ['6', 'G'], ['2', 'Z'],
  ['7', 'T'], ['4', 'A'],
];

// ── OpenCV load ───────────────────────────────────────────────────────────────
function loadOpenCV() {
  return new Promise((resolve) => {
    if (typeof cv !== 'undefined' && cv.Mat) { openCVReady = true; resolve(); return; }
    const script = document.createElement('script');
    script.src = 'https://docs.opencv.org/4.8.0/opencv.js';
    script.async = true;
    script.onload = () => {
      // OpenCV needs a moment to initialise its WASM
      const check = setInterval(() => {
        if (typeof cv !== 'undefined' && cv.Mat) {
          clearInterval(check);
          openCVReady = true;
          resolve();
        }
      }, 100);
    };
    script.onerror = () => { openCVReady = false; resolve(); }; // fallback gracefully
    document.head.appendChild(script);
  });
}

// ── Tesseract init ────────────────────────────────────────────────────────────
async function initOCR() {
  if (tesseractWorker) return;
  try {
    tesseractWorker = await Tesseract.createWorker('eng');
    await tesseractWorker.setParameters({
      // Allow only characters that appear in serial numbers
      tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789- ',
      // Treat as single line of text
      tessedit_pageseg_mode: '7',
    });
    console.log('[OCR] Tesseract ready');
  } catch(e) {
    console.error('[OCR] Tesseract init failed:', e);
  }

  // Load OpenCV in background
  loadOpenCV().then(() => {
    console.log('[OCR] OpenCV ready:', openCVReady);
  });
}

// ── Main capture function ─────────────────────────────────────────────────────
async function captureSerial(fieldId, photoKey) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.capture = 'environment';
  input.style.display = 'none';
  document.body.appendChild(input);

  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) { document.body.removeChild(input); return; }

    const reader = new FileReader();
    reader.onload = async (ev) => {
      const base64 = ev.target.result;

      // Store original photo
      if (state.formData) state.formData[photoKey] = base64;

      // Show thumbnail
      const thumb = document.getElementById(`thumb-${fieldId}`);
      if (thumb) { thumb.src = base64; thumb.style.display = 'block'; }

      // Disable input field while processing
      const inp = document.getElementById(fieldId);
      if (inp) { inp.disabled = true; inp.placeholder = 'Processing…'; }

      const statusEl = document.getElementById('ocr-status');
      if (statusEl) statusEl.textContent = '📷 Photo captured — enhancing image…';
      showToast('Enhancing image…', 'ok');

      try {
        // Step 1: Preprocess with OpenCV if available
        let processedBase64 = base64;
        if (openCVReady) {
          processedBase64 = await preprocessDotMatrix(base64);
          if (statusEl) statusEl.textContent = '🔍 Image enhanced — reading serial…';
        } else {
          if (statusEl) statusEl.textContent = '🔍 Reading serial (basic mode)…';
        }

        // Step 2: OCR with Tesseract
        if (!tesseractWorker) await initOCR();
        const { data } = await tesseractWorker.recognize(processedBase64);

        // Step 3: Clean and validate result
        let rawText = data.text.trim().toUpperCase()
          .replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
        const confidence = Math.round(data.confidence);

        // Step 4: Apply dot-matrix correction heuristics
        const corrected = applyDotMatrixCorrections(rawText, fieldId);

        // Step 5: Show result with confidence
        if (inp) {
          inp.value = corrected;
          inp.disabled = false;
          inp.placeholder = 'Confirm or correct';
          // Colour-code the field by confidence
          inp.style.borderBottomColor =
            confidence >= 85 ? 'var(--pass)' :
            confidence >= 65 ? 'var(--warn)' : 'var(--fail)';
        }

        // Step 6: Show confidence feedback
        const confMsg = confidence >= 85
          ? `✅ Serial read — ${confidence}% confidence. Please confirm.`
          : confidence >= 65
          ? `⚠ ${confidence}% confidence — check carefully before confirming`
          : `❌ Low confidence (${confidence}%) — please retake or type manually`;

        if (statusEl) statusEl.textContent = confMsg;

        const toastType = confidence >= 85 ? 'ok' : confidence >= 65 ? 'warn' : 'error';
        showToast(`Read: ${corrected} (${confidence}%)`, toastType);

        // Step 7: Show retake suggestion if low confidence
        if (confidence < 65) {
          showRetakeSuggestion(fieldId, photoKey);
        }

        // Trigger confirm field for launcher serial
        if (fieldId === 'inp-launcher-serial' && typeof resetSerialConfirm === 'function') {
          resetSerialConfirm();
        }

      } catch(err) {
        console.error('[OCR] Failed:', err);
        if (inp) { inp.disabled = false; inp.placeholder = 'Type manually'; }
        if (statusEl) statusEl.textContent = '⚠ Could not read — please type manually';
        showToast('OCR failed — type manually', 'warn');
      }
    };
    reader.readAsDataURL(file);
    document.body.removeChild(input);
  };
  input.click();
}

// ── OpenCV dot-matrix preprocessing ──────────────────────────────────────────
async function preprocessDotMatrix(base64) {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.onload = () => {
        try {
          // Create canvas for OpenCV processing
          const canvas = document.createElement('canvas');
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);

          // Read into OpenCV mat
          const src = cv.imread(canvas);
          const dst = new cv.Mat();
          const gray = new cv.Mat();
          const enhanced = new cv.Mat();

          // 1. Convert to grayscale
          cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

          // 2. Upscale 2x for better dot detection
          const scaled = new cv.Mat();
          cv.resize(gray, scaled, new cv.Size(gray.cols * 2, gray.rows * 2), 0, 0, cv.INTER_CUBIC);

          // 3. Black-hat morphological operation to enhance dots
          // (brings out dark dots against light/reflective metal background)
          const kernel = cv.getStructuringElement(
            cv.MORPH_ELLIPSE,
            new cv.Size(7, 7)
          );
          const blackhat = new cv.Mat();
          cv.morphologyEx(scaled, blackhat, cv.MORPH_BLACKHAT, kernel);

          // 4. Gaussian blur to smooth noise
          const blurred = new cv.Mat();
          cv.GaussianBlur(blackhat, blurred, new cv.Size(3, 3), 0);

          // 5. Adaptive threshold to get clean black/white
          cv.adaptiveThreshold(
            blurred, enhanced,
            255,
            cv.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv.THRESH_BINARY_INV,
            11, 2
          );

          // 6. Dilate slightly to connect dot clusters into characters
          const dilKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
          cv.dilate(enhanced, dst, dilKernel);

          // Write result to canvas
          const outCanvas = document.createElement('canvas');
          outCanvas.width = dst.cols;
          outCanvas.height = dst.rows;
          cv.imshow(outCanvas, dst);

          // Cleanup
          src.delete(); dst.delete(); gray.delete(); enhanced.delete();
          scaled.delete(); blackhat.delete(); blurred.delete();
          kernel.delete(); dilKernel.delete();

          // Return as base64
          resolve(outCanvas.toDataURL('image/png'));
        } catch(cvErr) {
          console.warn('[OpenCV] Processing failed, using original:', cvErr);
          resolve(base64);
        }
      };
      img.onerror = () => resolve(base64);
      img.src = base64;
    } catch(e) {
      resolve(base64);
    }
  });
}

// ── Dot-matrix character correction heuristics ────────────────────────────────
function applyDotMatrixCorrections(text, fieldId) {
  // Determine which card type we're on
  const cardType = (state && state.cardType) ? state.cardType : 'ANY';

  // Remove common OCR artifacts
  let cleaned = text
    .replace(/[^A-Z0-9\s\-]/g, '') // remove non-serial chars
    .replace(/\s+/g, ' ')
    .trim();

  // Apply position-aware corrections based on known serial formats
  if (cardType === 'RLL' || fieldId === 'inp-launcher-serial') {
    // RLL serials: starts with RLL followed by numbers
    // Fix common confusions in numeric positions
    cleaned = cleaned
      .replace(/^RL[L1I]/, 'RLL')   // Fix RLL prefix
      .replace(/O/g, '0')            // O→0 in numeric sections (after prefix)
      ;
    // Re-protect the RLL prefix
    if (cleaned.startsWith('RLL')) {
      cleaned = 'RLL' + cleaned.slice(3).replace(/[A-Z]/g, c => {
        const map = {'O':'0','I':'1','S':'5','B':'8','G':'6','Z':'2','T':'7'};
        return map[c] || c;
      });
    }
  }

  if (cardType === 'XRGL40') {
    // X26 3007 RSA format
    // First char should be letter, positions 2-3 numbers, then 4 numbers, then letters
    const parts = cleaned.split(/\s+/);
    if (parts.length >= 1) {
      // Part 1: Letter + 2 digits (e.g. X26)
      if (parts[0] && parts[0].length >= 3) {
        const p0 = parts[0];
        parts[0] = p0[0] +  // keep letter
          p0.slice(1).replace(/O/g,'0').replace(/I/g,'1').replace(/S/g,'5');
      }
      // Part 2: 4 digits (e.g. 3007)
      if (parts[1]) {
        parts[1] = parts[1].replace(/O/g,'0').replace(/I/g,'1')
                            .replace(/S/g,'5').replace(/B/g,'8')
                            .replace(/G/g,'6').replace(/Z/g,'2');
      }
      // Part 3: Letters (e.g. RSA) — keep as letters
    }
    cleaned = parts.join(' ');
  }

  return cleaned;
}

// ── Retake suggestion UI ──────────────────────────────────────────────────────
function showRetakeSuggestion(fieldId, photoKey) {
  // Remove any existing retake button
  const existingBtn = document.getElementById(`retake-${fieldId}`);
  if (existingBtn) existingBtn.remove();

  const inp = document.getElementById(fieldId);
  if (!inp || !inp.parentNode) return;

  const retakeBtn = document.createElement('button');
  retakeBtn.id = `retake-${fieldId}`;
  retakeBtn.className = 'cam-btn';
  retakeBtn.style.cssText = 'background:#fdf2f2;border-color:var(--fail);color:var(--fail);margin-top:4px;width:auto;padding:4px 10px;font-size:11px;';
  retakeBtn.textContent = '📷 Retake Photo';
  retakeBtn.onclick = () => {
    retakeBtn.remove();
    captureSerial(fieldId, photoKey);
  };
  inp.parentNode.insertBefore(retakeBtn, inp.nextSibling);
}

// Expose initOCR globally so app.js can call it on login
window.initOCR = initOCR;
window.captureSerial = captureSerial;
