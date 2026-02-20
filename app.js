// Bore Log Extractor
// ROIs per page: header, desc (0..TotalDepth), spt
// Output: header fields + layers (from/to + OCR text) + spt (depth + N)
// PDF.js: v3.11.174 (global pdfjsLib), Tesseract v5

const els = {
  pdfInput: document.getElementById("pdfInput"),
  prevBtn: document.getElementById("prevBtn"),
  nextBtn: document.getElementById("nextBtn"),
  pageLabel: document.getElementById("pageLabel"),
  totalDepth: document.getElementById("totalDepth"),
  langSelect: document.getElementById("langSelect"),
  renderBtn: document.getElementById("renderBtn"),
  roiType: document.getElementById("roiType"),
  toggleDrawBtn: document.getElementById("toggleDrawBtn"),
  extractBtn: document.getElementById("extractBtn"),
  exportBtn: document.getElementById("exportBtn"),
  clearRoiBtn: document.getElementById("clearRoiBtn"),

  zoomRange: document.getElementById("zoomRange"),
  zoomLabel: document.getElementById("zoomLabel"),
  showRoiChk: document.getElementById("showRoiChk"),

  statusText: document.getElementById("statusText"),
  progressBar: document.getElementById("progressBar"),

  pdfCanvas: document.getElementById("pdfCanvas"),
  overlayCanvas: document.getElementById("overlayCanvas"),

  selType: document.getElementById("selType"),
  selX: document.getElementById("selX"),
  selY: document.getElementById("selY"),
  selW: document.getElementById("selW"),
  selH: document.getElementById("selH"),
  deleteBtn: document.getElementById("deleteBtn"),

  outputText: document.getElementById("outputText"),
};

const pdfCtx = els.pdfCanvas.getContext("2d");
const ovCtx = els.overlayCanvas.getContext("2d");

let pdfDoc = null;
let pageNum = 1;
let pageCount = 0;

let renderScale = 2.2; // rendering scale for OCR accuracy
let viewZoom = 1.2;

let drawMode = false;
let isDrawing = false;
let drawStart = null;
let tempRect = null;

let selectedRoiId = null;
let currentPdfObjectUrl = null;

// ROIs per page: {header:{}, desc:{}, spt:{}}
const pageRois = new Map();

// extracted data per page
const extractedByPage = new Map();

function uid() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function setStatus(text, progress = null) {
  els.statusText.textContent = text;
  if (progress === null) return;
  const pct = Math.max(0, Math.min(100, Math.round(progress * 100)));
  els.progressBar.style.width = `${pct}%`;
}

function enableUI(on) {
  els.prevBtn.disabled = !on;
  els.nextBtn.disabled = !on;
  els.renderBtn.disabled = !on;
  els.toggleDrawBtn.disabled = !on;
  els.extractBtn.disabled = !on;
  els.exportBtn.disabled = !on;
  els.clearRoiBtn.disabled = !on;
}

function updatePageLabel() {
  els.pageLabel.textContent = `Page ${pageNum} / ${pageCount || "-"}`;
  els.prevBtn.disabled = !pdfDoc || pageNum <= 1;
  els.nextBtn.disabled = !pdfDoc || pageNum >= pageCount;
}

function setDrawMode(on) {
  drawMode = on;
  els.toggleDrawBtn.textContent = `Draw Mode: ${drawMode ? "On" : "Off"}`;
  els.toggleDrawBtn.classList.toggle("primary", drawMode);
  els.overlayCanvas.style.cursor = drawMode ? "crosshair" : "default";
}

function setViewZoomFromUI() {
  viewZoom = Number(els.zoomRange.value) / 100;
  els.zoomLabel.textContent = `${Math.round(viewZoom * 100)}%`;
  applyCanvasZoom();
  redrawOverlay();
}

function applyCanvasZoom() {
  const s = viewZoom;
  els.pdfCanvas.style.transformOrigin = "top left";
  els.overlayCanvas.style.transformOrigin = "top left";
  els.pdfCanvas.style.transform = `scale(${s})`;
  els.overlayCanvas.style.transform = `scale(${s})`;

  const w = els.pdfCanvas.width;
  const h = els.pdfCanvas.height;
  els.pdfCanvas.style.width = `${w * s}px`;
  els.pdfCanvas.style.height = `${h * s}px`;
  els.overlayCanvas.style.width = `${w * s}px`;
  els.overlayCanvas.style.height = `${h * s}px`;
}

function clampRectToPage(r) {
  const W = els.pdfCanvas.width;
  const H = els.pdfCanvas.height;
  const x = Math.max(0, Math.min(W, r.x));
  const y = Math.max(0, Math.min(H, r.y));
  const w = Math.max(1, Math.min(W - x, r.w));
  const h = Math.max(1, Math.min(H - y, r.h));
  return { x, y, w, h };
}

function normalizeRect(a, b) {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function getRoisForPage(n) {
  if (!pageRois.has(n)) pageRois.set(n, {});
  return pageRois.get(n);
}

function setRoi(n, type, rect) {
  const rois = getRoisForPage(n);
  rois[type] = { id: uid(), type, rect };
  pageRois.set(n, rois);
}

function deleteSelectedRoi() {
  const rois = getRoisForPage(pageNum);
  for (const k of Object.keys(rois)) {
    if (rois[k]?.id === selectedRoiId) delete rois[k];
  }
  selectedRoiId = null;
  updateSelectedPanel(null);
  redrawOverlay();
}

function updateSelectedPanel(roi) {
  if (!roi) {
    els.selType.value = "";
    els.selX.value = "";
    els.selY.value = "";
    els.selW.value = "";
    els.selH.value = "";
    els.deleteBtn.disabled = true;
    return;
  }
  els.selType.value = roi.type;
  els.selX.value = Math.round(roi.rect.x);
  els.selY.value = Math.round(roi.rect.y);
  els.selW.value = Math.round(roi.rect.w);
  els.selH.value = Math.round(roi.rect.h);
  els.deleteBtn.disabled = false;
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function drawROI(roi, isSelected) {
  const { x, y, w, h } = roi.rect;
  ovCtx.save();

  const color = roi.type === "header"
    ? "rgba(255, 215, 115, 0.85)"
    : roi.type === "desc"
      ? "rgba(106,166,255,0.85)"
      : "rgba(86,240,179,0.85)";

  ovCtx.lineWidth = isSelected ? 3 : 2;
  ovCtx.strokeStyle = isSelected ? "rgba(255,255,255,0.95)" : color;
  ovCtx.fillStyle = isSelected ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.04)";
  roundRect(ovCtx, x, y, w, h, 10);
  ovCtx.fill();
  ovCtx.stroke();

  ovCtx.font = "12px ui-monospace, Menlo, Consolas, monospace";
  ovCtx.fillStyle = "rgba(0,0,0,0.55)";
  const tag = roi.type.toUpperCase();
  const tw = ovCtx.measureText(tag).width;
  roundRect(ovCtx, x, Math.max(0, y - 18), tw + 12, 18, 8);
  ovCtx.fill();
  ovCtx.fillStyle = "rgba(233,238,255,0.95)";
  ovCtx.fillText(tag, x + 6, Math.max(13, y - 5));

  ovCtx.restore();
}

function redrawOverlay() {
  ovCtx.clearRect(0, 0, els.overlayCanvas.width, els.overlayCanvas.height);
  if (!els.showRoiChk.checked) return;

  const rois = getRoisForPage(pageNum);
  for (const key of ["header", "desc", "spt"]) {
    if (!rois[key]) continue;
    drawROI(rois[key], rois[key].id === selectedRoiId);
  }

  if (tempRect) {
    ovCtx.save();
    ovCtx.setLineDash([6, 5]);
    ovCtx.lineWidth = 2;
    ovCtx.strokeStyle = "rgba(255,255,255,0.9)";
    ovCtx.fillStyle = "rgba(255,255,255,0.10)";
    roundRect(ovCtx, tempRect.x, tempRect.y, tempRect.w, tempRect.h, 10);
    ovCtx.fill();
    ovCtx.stroke();
    ovCtx.restore();
  }
}

function getMousePagePos(evt) {
  const rect = els.overlayCanvas.getBoundingClientRect();
  const xCss = evt.clientX - rect.left;
  const yCss = evt.clientY - rect.top;
  return { x: xCss / viewZoom, y: yCss / viewZoom };
}

function hitTestROI(pt) {
  const rois = getRoisForPage(pageNum);
  const all = Object.values(rois).filter(Boolean);
  for (let i = all.length - 1; i >= 0; i--) {
    const r = all[i].rect;
    if (pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y && pt.y <= r.y + r.h) {
      return all[i];
    }
  }
  return null;
}

// ---------- PDF LOAD/RENDER ----------

async function loadPdfFromUrl(url) {
  setStatus("Loading PDF…", 0);
  const task = pdfjsLib.getDocument({ url, disableStream: true, disableAutoFetch: true });
  pdfDoc = await task.promise;
  pageCount = pdfDoc.numPages;
  pageNum = 1;
  updatePageLabel();
  enableUI(true);
  setStatus(`PDF loaded (${pageCount} pages). Render page 1.`, 1);
}

async function renderPage() {
  if (!pdfDoc) return;

  setStatus(`Rendering page ${pageNum}…`, 0);

  const page = await pdfDoc.getPage(pageNum);
  const viewport = page.getViewport({ scale: renderScale });

  els.pdfCanvas.width = Math.floor(viewport.width);
  els.pdfCanvas.height = Math.floor(viewport.height);
  els.overlayCanvas.width = els.pdfCanvas.width;
  els.overlayCanvas.height = els.pdfCanvas.height;

  pdfCtx.clearRect(0, 0, els.pdfCanvas.width, els.pdfCanvas.height);
  await page.render({ canvasContext: pdfCtx, viewport }).promise;

  applyCanvasZoom();
  redrawOverlay();

  els.extractBtn.disabled = false;
  els.exportBtn.disabled = false;
  els.clearRoiBtn.disabled = false;

  setStatus(`Rendered page ${pageNum}.`, 1);
}

// ---------- HEADER extraction via PDF text (ROI filter) ----------
// Convert PDF text item transform to viewport pixel coords.
function itemToViewportXY(item, viewport) {
  // item.transform = [a,b,c,d,e,f], where e,f are text position in PDF space
  const [a,b,c,d,e,f] = item.transform;
  const pt = viewport.convertToViewportPoint(e, f);
  return { x: pt[0], y: pt[1] };
}

function parseHeaderFromText(fullText) {
  // Flexible regex: depends on your PDF format.
  const nameMatch = fullText.match(/\bB\d+\-\d+\b/);
  const latMatch = fullText.match(/LATITUDE:\s*([-\d.]+)/i);
  const lonMatch = fullText.match(/LONGITUDE:\s*([-\d.]+)/i);
  const elevMatch = fullText.match(/ELEVATION:\s*([-\d.]+)\s*feet/i);

  // Water table: try to find "DEPTH TO - WATER"
  // We'll capture numbers if present.
  let waterInitial = null;
  let water24 = null;
  const waterLine = fullText.match(/DEPTH TO\s*-\s*WATER[^]*?(INITIAL[^]*?)(AFTER\s*24[^]*?)?/i);
  if (waterLine) {
    const nums = fullText.match(/DEPTH TO\s*-\s*WATER[^]*?([0-9]+(\.[0-9]+)?)/i);
    if (nums) waterInitial = Number(nums[1]);
  }
  // If your PDF has explicit "AFTER 24 HOURS" values, you can improve regex later.

  return {
    name: nameMatch ? nameMatch[0] : null,
    latitude: latMatch ? Number(latMatch[1]) : null,
    longitude: lonMatch ? Number(lonMatch[1]) : null,
    elevation_ft: elevMatch ? Number(elevMatch[1]) : null,
    water_table: { initial_ft: waterInitial, after_24h_ft: water24 }
  };
}

async function extractHeader(page, viewport, headerROI) {
  const tc = await page.getTextContent();
  const items = tc.items || [];
  const parts = [];

  for (const it of items) {
    const s = (it.str || "").trim();
    if (!s) continue;
    const { x, y } = itemToViewportXY(it, viewport);

    // Note: y in viewport has origin top-left (PDF.js viewport)
    if (
      x >= headerROI.x && x <= headerROI.x + headerROI.w &&
      y >= headerROI.y && y <= headerROI.y + headerROI.h
    ) {
      parts.push(s);
    }
  }

  const text = parts.join(" ");
  return parseHeaderFromText(text);
}

// ---------- Horizontal line detection inside DESCRIPTION ROI ----------

function detectHorizontalLinesInROI(canvas, roi, opts = {}) {
  const ctx = canvas.getContext("2d");
  const { x, y, w, h } = roi;

  const {
    inkThreshold = 170, // lower = stricter black
    rowInkRatio = 0.45, // fraction of row that must be ink to count
    minGapPx = 10
  } = opts;

  const img = ctx.getImageData(Math.floor(x), Math.floor(y), Math.floor(w), Math.floor(h));
  const data = img.data;
  const W = img.width;
  const H = img.height;

  const candidates = [];

  for (let row = 0; row < H; row++) {
    let ink = 0;
    for (let col = 0; col < W; col++) {
      const i = (row * W + col) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
      if (a < 10) continue;
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (lum < inkThreshold) ink++;
    }
    const ratio = ink / W;
    if (ratio >= rowInkRatio) candidates.push(row);
  }

  // merge consecutive rows
  const merged = [];
  let start = null;

  for (let i = 0; i < candidates.length; i++) {
    const r = candidates[i];
    const prev = i ? candidates[i - 1] : null;
    if (start === null) start = r;

    if (prev !== null && r !== prev + 1) {
      const mid = Math.round((start + prev) / 2);
      merged.push(mid);
      start = r;
    }
  }
  if (start !== null && candidates.length) {
    const end = candidates[candidates.length - 1];
    merged.push(Math.round((start + end) / 2));
  }

  merged.sort((a, b) => a - b);
  const filtered = [];
  for (const ly of merged) {
    if (!filtered.length || (ly - filtered[filtered.length - 1]) >= minGapPx) filtered.push(ly);
  }

  // ROI-local -> page y
  return filtered.map(ly => y + ly);
}

function yToDepthFt(y, descROI, totalDepthFt) {
  const t = (y - descROI.y) / descROI.h;
  const clamped = Math.max(0, Math.min(1, t));
  return clamped * totalDepthFt;
}

function buildLayerIntervals(descROI, lineYs, totalDepthFt) {
  const ys = lineYs.slice().sort((a, b) => a - b);
  const depths = ys.map(y => yToDepthFt(y, descROI, totalDepthFt));

  const layers = [];
  let from = 0;

  for (const d of depths) {
    if (d - from >= 0.10) {
      layers.push({ from_ft: round2(from), to_ft: round2(d), description: "" });
      from = d;
    }
  }
  if (totalDepthFt - from >= 0.10) {
    layers.push({ from_ft: round2(from), to_ft: round2(totalDepthFt), description: "" });
  }
  return layers;
}

// ---------- OCR helpers ----------

function cropCanvas(srcCanvas, rect) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.floor(rect.w));
  c.height = Math.max(1, Math.floor(rect.h));
  const ctx = c.getContext("2d");
  ctx.drawImage(
    srcCanvas,
    rect.x, rect.y, rect.w, rect.h,
    0, 0, c.width, c.height
  );
  return c;
}

// OCR description per layer interval (crop inside descROI)
async function ocrLayersFromDescROI(descROI, layers, lang) {
  const results = [];

  for (let i = 0; i < layers.length; i++) {
    const L = layers[i];

    // map depth interval back to y pixels inside descROI
    const y1 = descROI.y + (L.from_ft / Number(els.totalDepth.value)) * descROI.h;
    const y2 = descROI.y + (L.to_ft / Number(els.totalDepth.value)) * descROI.h;

    const rect = clampRectToPage({
      x: descROI.x,
      y: Math.floor(y1),
      w: descROI.w,
      h: Math.max(2, Math.floor(y2 - y1))
    });

    setStatus(`OCR description layer ${i + 1}/${layers.length} (${L.from_ft}-${L.to_ft} ft)…`, i / layers.length);

    const crop = cropCanvas(els.pdfCanvas, rect);
    const res = await Tesseract.recognize(crop, lang);
    const text = (res?.data?.text || "").trim().replace(/\s+\n/g, "\n");

    results.push({
      from_ft: L.from_ft,
      to_ft: L.to_ft,
      description: text
    });
  }

  setStatus("Description OCR done.", 1);
  return results;
}

// OCR SPT ROI and convert each number's y to depth
async function extractSPTFromROI(sptROI, descROI, totalDepthFt, lang) {
  setStatus("OCR SPT column…", 0);

  const crop = cropCanvas(els.pdfCanvas, sptROI);
  const res = await Tesseract.recognize(crop, lang);

  const words = (res?.data?.words || [])
    .filter(w => w.text && w.text.trim())
    .map(w => {
      const cleaned = w.text.trim().replace(/[^\d]/g, ""); // digits only
      const n = cleaned.length ? Number(cleaned) : null;
      const yMid = (w.bbox.y0 + w.bbox.y1) / 2;
      return { n, yCropMid: yMid };
    })
    .filter(x => Number.isFinite(x.n));

  const spt = words.map(w => {
    const pageY = sptROI.y + w.yCropMid;
    const depth_ft = round2(yToDepthFt(pageY, descROI, totalDepthFt));
    return { depth_ft, n: w.n };
  });

  // sort and lightly dedupe (same depth -> keep first)
  spt.sort((a, b) => a.depth_ft - b.depth_ft);
  const out = [];
  const seen = new Set();
  for (const p of spt) {
    const key = `${p.depth_ft}-${p.n}`;
    if (!seen.has(key)) { seen.add(key); out.push(p); }
  }

  setStatus(`SPT OCR done. Found ${out.length} values.`, 1);
  return out;
}

// ---------- Main extraction ----------

async function extractThisPage() {
  if (!pdfDoc) return;

  const rois = getRoisForPage(pageNum);
  if (!rois.header || !rois.desc || !rois.spt) {
    setStatus("Please draw HEADER + DESCRIPTION + SPT ROIs first.", 0);
    return;
  }

  const totalDepthFt = Number(els.totalDepth.value) || 36;
  const lang = els.langSelect.value;

  setStatus("Preparing extraction…", 0);

  // Get page + viewport matching the rendered canvas scale
  const page = await pdfDoc.getPage(pageNum);
  const viewport = page.getViewport({ scale: renderScale });

  // 1) HEADER from PDF text inside header ROI
  setStatus("Extracting header (PDF text)…", 0.1);
  const header = await extractHeader(page, viewport, rois.header.rect);

  // 2) LAYERS from horizontal lines + OCR description
  setStatus("Detecting description divider lines…", 0.2);
  const lineYs = detectHorizontalLinesInROI(els.pdfCanvas, rois.desc.rect, {
    inkThreshold: 170,
    rowInkRatio: 0.45,
    minGapPx: 10
  });

  const layerIntervals = buildLayerIntervals(rois.desc.rect, lineYs, totalDepthFt);

  // OCR layer text
  const layers = await ocrLayersFromDescROI(rois.desc.rect, layerIntervals, lang);

  // 3) SPT table (depth + N) independent
  const spt = await extractSPTFromROI(rois.spt.rect, rois.desc.rect, totalDepthFt, lang);

  const payload = {
    page: pageNum,
    boring: header,
    total_depth_ft: totalDepthFt,
    layers,
    spt
  };

  extractedByPage.set(pageNum, payload);
  els.outputText.value = JSON.stringify(payload, null, 2);
  setStatus("Extraction complete. You can export JSON.", 1);
}

// ---------- Export ----------

function exportJSONPage() {
  const payload = extractedByPage.get(pageNum);
  if (!payload) {
    setStatus("Nothing extracted yet. Click Extract (this page).", 0);
    return;
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `page_${pageNum}_borelog.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------- Events ----------

els.pdfInput.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  try {
    if (currentPdfObjectUrl) URL.revokeObjectURL(currentPdfObjectUrl);
    currentPdfObjectUrl = URL.createObjectURL(file);

    await loadPdfFromUrl(currentPdfObjectUrl);
    els.renderBtn.disabled = false;
    await renderPage();
  } catch (err) {
    console.error(err);
    setStatus(`Failed to load PDF: ${err?.message || String(err)}`, 0);
  }
});

els.prevBtn.addEventListener("click", async () => {
  if (!pdfDoc || pageNum <= 1) return;
  pageNum--;
  updatePageLabel();
  els.outputText.value = extractedByPage.get(pageNum) ? JSON.stringify(extractedByPage.get(pageNum), null, 2) : "";
  await renderPage();
});

els.nextBtn.addEventListener("click", async () => {
  if (!pdfDoc || pageNum >= pageCount) return;
  pageNum++;
  updatePageLabel();
  els.outputText.value = extractedByPage.get(pageNum) ? JSON.stringify(extractedByPage.get(pageNum), null, 2) : "";
  await renderPage();
});

els.renderBtn.addEventListener("click", renderPage);
els.toggleDrawBtn.addEventListener("click", () => setDrawMode(!drawMode));
els.zoomRange.addEventListener("input", setViewZoomFromUI);
els.showRoiChk.addEventListener("change", redrawOverlay);

els.extractBtn.addEventListener("click", extractThisPage);
els.exportBtn.addEventListener("click", exportJSONPage);

els.clearRoiBtn.addEventListener("click", () => {
  pageRois.set(pageNum, {});
  selectedRoiId = null;
  updateSelectedPanel(null);
  redrawOverlay();
  setStatus("Cleared ROIs for this page.", 0);
});

els.deleteBtn.addEventListener("click", deleteSelectedRoi);

// Drawing / selecting ROIs on overlay
els.overlayCanvas.addEventListener("mousedown", (evt) => {
  if (!pdfDoc) return;
  const pt = getMousePagePos(evt);

  if (!drawMode) {
    const hit = hitTestROI(pt);
    selectedRoiId = hit ? hit.id : null;
    updateSelectedPanel(hit);
    redrawOverlay();
    return;
  }

  isDrawing = true;
  drawStart = pt;
  tempRect = { x: pt.x, y: pt.y, w: 1, h: 1 };
  redrawOverlay();
});

els.overlayCanvas.addEventListener("mousemove", (evt) => {
  if (!isDrawing) return;
  const pt = getMousePagePos(evt);
  tempRect = clampRectToPage(normalizeRect(drawStart, pt));
  redrawOverlay();
});

els.overlayCanvas.addEventListener("mouseup", () => {
  if (!isDrawing) return;
  isDrawing = false;

  const r = tempRect;
  tempRect = null;
  drawStart = null;

  if (!r || r.w < 10 || r.h < 10) {
    redrawOverlay();
    return;
  }

  const type = els.roiType.value;
  setRoi(pageNum, type, r);

  const rois = getRoisForPage(pageNum);
  selectedRoiId = rois[type].id;
  updateSelectedPanel(rois[type]);
  redrawOverlay();
});

els.overlayCanvas.addEventListener("mouseleave", () => {
  if (isDrawing) {
    isDrawing = false;
    tempRect = null;
    drawStart = null;
    redrawOverlay();
  }
});

// ---------- init ----------
enableUI(false);
setDrawMode(false);
setViewZoomFromUI();
updatePageLabel();
setStatus("Upload a PDF to begin.", 0);
