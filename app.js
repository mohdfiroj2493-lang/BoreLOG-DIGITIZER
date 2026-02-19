/* PDF OCR + Box + Depth Tool (GitHub Pages friendly)
 * - Loads PDF via Blob Object URL (avoids "Reading PDF bytes..." hang)
 * - PDF.js renders a page to pdfCanvas
 * - overlayCanvas draws OCR + manual boxes with depth ordering
 * - OCR uses Tesseract.js on the rendered page image
 *
 * Coordinates:
 * - All box rects are stored in "page pixels" (same space as pdfCanvas at render scale).
 */

const els = {
  pdfInput: document.getElementById("pdfInput"),
  langSelect: document.getElementById("langSelect"),
  prevPageBtn: document.getElementById("prevPageBtn"),
  nextPageBtn: document.getElementById("nextPageBtn"),
  pageLabel: document.getElementById("pageLabel"),
  renderBtn: document.getElementById("renderBtn"),
  runOcrBtn: document.getElementById("runOcrBtn"),
  toggleDrawBtn: document.getElementById("toggleDrawBtn"),
  exportBtn: document.getElementById("exportBtn"),
  clearManualBtn: document.getElementById("clearManualBtn"),
  clearOcrBtn: document.getElementById("clearOcrBtn"),

  zoomRange: document.getElementById("zoomRange"),
  zoomLabel: document.getElementById("zoomLabel"),

  showOcrChk: document.getElementById("showOcrChk"),
  showManualChk: document.getElementById("showManualChk"),
  showTextChk: document.getElementById("showTextChk"),

  statusText: document.getElementById("statusText"),
  progressBar: document.getElementById("progressBar"),

  stage: document.getElementById("stage"),
  pdfCanvas: document.getElementById("pdfCanvas"),
  overlayCanvas: document.getElementById("overlayCanvas"),

  selType: document.getElementById("selType"),
  selText: document.getElementById("selText"),
  selDepth: document.getElementById("selDepth"),
  selX: document.getElementById("selX"),
  selY: document.getElementById("selY"),
  selW: document.getElementById("selW"),
  selH: document.getElementById("selH"),
  deleteBtn: document.getElementById("deleteBtn"),
  bringFrontBtn: document.getElementById("bringFrontBtn"),
  sendBackBtn: document.getElementById("sendBackBtn"),

  ocrText: document.getElementById("ocrText"),
  copyTextBtn: document.getElementById("copyTextBtn"),

  ocrCount: document.getElementById("ocrCount"),
  manualCount: document.getElementById("manualCount"),
};

const pdfCtx = els.pdfCanvas.getContext("2d");
const ovCtx = els.overlayCanvas.getContext("2d");

// PDF state
let pdfDoc = null;
let pageNum = 1;
let pageCount = 0;

// Render scale for PDF page (higher = better OCR, slower)
let renderScale = 2.2;

// Overlay view zoom (visual zoom, CSS)
let viewZoom = 1.2;

// Boxes per page: pagesBoxes.get(pageNum) = [{id,type,rect,text,conf,depth}]
const pagesBoxes = new Map();

let selectedId = null;
let drawMode = false;

// Manual draw state
let isDrawing = false;
let drawStart = null;
let tempRect = null;

// For GitHub Pages-friendly PDF loading
let currentPdfObjectUrl = null;

function uid() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function setStatus(text, progress = null) {
  els.statusText.textContent = text;
  if (progress === null) return;
  const pct = Math.max(0, Math.min(100, Math.round(progress * 100)));
  els.progressBar.style.width = `${pct}%`;
}

function enableUI(enabled) {
  els.prevPageBtn.disabled = !enabled;
  els.nextPageBtn.disabled = !enabled;
  els.renderBtn.disabled = !enabled;
  els.runOcrBtn.disabled = !enabled;
  els.toggleDrawBtn.disabled = !enabled;
  els.exportBtn.disabled = !enabled;
  els.clearManualBtn.disabled = !enabled;
  els.clearOcrBtn.disabled = !enabled;
  els.copyTextBtn.disabled = !enabled;
}

function getBoxesForPage(n) {
  if (!pagesBoxes.has(n)) pagesBoxes.set(n, []);
  return pagesBoxes.get(n);
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
  const scale = viewZoom;

  els.pdfCanvas.style.transformOrigin = "top left";
  els.overlayCanvas.style.transformOrigin = "top left";
  els.pdfCanvas.style.transform = `scale(${scale})`;
  els.overlayCanvas.style.transform = `scale(${scale})`;

  // Fix layout size (scroll area matches scaled size)
  const w = els.pdfCanvas.width;
  const h = els.pdfCanvas.height;
  els.pdfCanvas.style.width = `${w * scale}px`;
  els.pdfCanvas.style.height = `${h * scale}px`;
  els.overlayCanvas.style.width = `${w * scale}px`;
  els.overlayCanvas.style.height = `${h * scale}px`;
}

function updateCounts() {
  const boxes = getBoxesForPage(pageNum);
  const o = boxes.filter(b => b.type === "ocr").length;
  const m = boxes.filter(b => b.type === "manual").length;
  els.ocrCount.textContent = String(o);
  els.manualCount.textContent = String(m);
}

function updatePageLabel() {
  els.pageLabel.textContent = `Page ${pageNum} / ${pageCount || "-"}`;
  els.prevPageBtn.disabled = !pdfDoc || pageNum <= 1;
  els.nextPageBtn.disabled = !pdfDoc || pageNum >= pageCount;
}

function clearSelectionIfMissing() {
  const boxes = getBoxesForPage(pageNum);
  if (selectedId && !boxes.find(b => b.id === selectedId)) selectedId = null;
}

function selectBox(id) {
  selectedId = id;
  const boxes = getBoxesForPage(pageNum);
  const b = boxes.find(x => x.id === id) || null;

  const hasSel = !!b;
  els.deleteBtn.disabled = !hasSel;
  els.bringFrontBtn.disabled = !hasSel;
  els.sendBackBtn.disabled = !hasSel;

  if (!b) {
    els.selType.value = "";
    els.selText.value = "";
    els.selDepth.value = 0;
    els.selX.value = "";
    els.selY.value = "";
    els.selW.value = "";
    els.selH.value = "";
    redrawOverlay();
    return;
  }

  els.selType.value = b.type;
  els.selDepth.value = b.depth ?? 0;

  els.selX.value = Math.round(b.rect.x);
  els.selY.value = Math.round(b.rect.y);
  els.selW.value = Math.round(b.rect.w);
  els.selH.value = Math.round(b.rect.h);

  const isOCR = b.type === "ocr";
  els.selText.value = b.text ?? "";
  els.selText.disabled = isOCR;

  redrawOverlay();
}

function getSortedBoxesForDraw() {
  const boxes = getBoxesForPage(pageNum);
  const showOCR = els.showOcrChk.checked;
  const showManual = els.showManualChk.checked;

  return boxes
    .filter(b => (b.type === "ocr" ? showOCR : showManual))
    .slice()
    .sort((a, b) => (a.depth - b.depth) || (a.type.localeCompare(b.type)));
}

function redrawOverlay() {
  ovCtx.clearRect(0, 0, els.overlayCanvas.width, els.overlayCanvas.height);

  const sorted = getSortedBoxesForDraw();
  for (const b of sorted) drawBox(b);

  if (tempRect) drawTempRect(tempRect);
}

function drawBox(b) {
  const sel = b.id === selectedId;
  const { x, y, w, h } = b.rect;

  ovCtx.save();

  const isOCR = b.type === "ocr";
  ovCtx.lineWidth = sel ? 3 : 2;

  if (isOCR) {
    ovCtx.strokeStyle = sel ? "rgba(255,255,255,0.95)" : "rgba(106,166,255,0.85)";
    ovCtx.fillStyle = sel ? "rgba(106,166,255,0.22)" : "rgba(106,166,255,0.12)";
  } else {
    ovCtx.strokeStyle = sel ? "rgba(255,255,255,0.95)" : "rgba(86,240,179,0.85)";
    ovCtx.fillStyle = sel ? "rgba(86,240,179,0.20)" : "rgba(86,240,179,0.10)";
  }

  roundRect(ovCtx, x, y, w, h, 6);
  ovCtx.fill();
  ovCtx.stroke();

  if (els.showTextChk.checked) {
    const label = isOCR ? `${(b.text || "").trim()}` : `${(b.text || "manual").trim()}`;
    const depthTag = `d=${b.depth ?? 0}`;
    const confTag = isOCR && typeof b.conf === "number" ? ` c=${Math.round(b.conf)}` : "";
    const tag = `${depthTag}${confTag}`;

    ovCtx.font = "12px ui-monospace, Menlo, Consolas, monospace";
    const pad = 6;
    const labelText = label.length ? label : (isOCR ? "(word)" : "(manual)");
    const text = `${labelText}  [${tag}]`;

    const tw = ovCtx.measureText(text).width;
    const bx = x;
    const by = Math.max(0, y - 18);

    ovCtx.fillStyle = "rgba(0,0,0,0.55)";
    roundRect(ovCtx, bx, by, tw + pad * 2, 18, 8);
    ovCtx.fill();

    ovCtx.fillStyle = "rgba(233,238,255,0.95)";
    ovCtx.fillText(text, bx + pad, by + 13);
  }

  ovCtx.restore();
}

function drawTempRect(r) {
  ovCtx.save();
  ovCtx.lineWidth = 2;
  ovCtx.setLineDash([6, 5]);
  ovCtx.strokeStyle = "rgba(255,255,255,0.9)";
  ovCtx.fillStyle = "rgba(255,255,255,0.12)";
  roundRect(ovCtx, r.x, r.y, r.w, r.h, 6);
  ovCtx.fill();
  ovCtx.stroke();
  ovCtx.restore();
}

function roundRect(context, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  context.beginPath();
  context.moveTo(x + rr, y);
  context.arcTo(x + w, y, x + w, y + h, rr);
  context.arcTo(x + w, y + h, x, y + h, rr);
  context.arcTo(x, y + h, x, y, rr);
  context.arcTo(x, y, x + w, y, rr);
  context.closePath();
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
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const w = Math.abs(a.x - b.x);
  const h = Math.abs(a.y - b.y);
  return { x, y, w, h };
}

function hitTest(pt) {
  const visible = getSortedBoxesForDraw();
  for (let i = visible.length - 1; i >= 0; i--) {
    const b = visible[i];
    const r = b.rect;
    if (pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y && pt.y <= r.y + r.h) {
      return b.id;
    }
  }
  return null;
}

// Convert mouse point to page pixels (accounts for CSS zoom)
function getMousePagePos(evt) {
  const rect = els.overlayCanvas.getBoundingClientRect();
  const xCss = evt.clientX - rect.left;
  const yCss = evt.clientY - rect.top;
  return { x: xCss / viewZoom, y: yCss / viewZoom };
}

/* -------------------- PDF loading (Blob URL - GitHub Pages friendly) -------------------- */

async function loadPdfFromUrl(url) {
  // Configure worker BEFORE getDocument
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.worker.min.js";

  const loadingTask = pdfjsLib.getDocument({
    url,
    disableStream: true,
    disableAutoFetch: true,
  });

  pdfDoc = await loadingTask.promise;
  pageCount = pdfDoc.numPages;
  pageNum = 1;

  updatePageLabel();
  setStatus(`PDF loaded. ${pageCount} page(s). Rendering page 1…`, 0);

  enableUI(true);
  els.renderBtn.disabled = false;
  els.runOcrBtn.disabled = true;

  els.ocrText.value = "";
  selectedId = null;
  setDrawMode(false);
}

async function renderPage() {
  if (!pdfDoc) return;

  setStatus(`Rendering page ${pageNum}…`, 0);

  const page = await pdfDoc.getPage(pageNum);

  // Auto OCR-friendly render scale based on viewZoom
  renderScale = Math.max(1.8, Math.min(3.2, 2.1 + (viewZoom - 1.0)));

  const viewport = page.getViewport({ scale: renderScale });

  els.pdfCanvas.width = Math.floor(viewport.width);
  els.pdfCanvas.height = Math.floor(viewport.height);
  els.overlayCanvas.width = els.pdfCanvas.width;
  els.overlayCanvas.height = els.pdfCanvas.height;

  pdfCtx.clearRect(0, 0, els.pdfCanvas.width, els.pdfCanvas.height);

  await page.render({ canvasContext: pdfCtx, viewport }).promise;

  if (!pagesBoxes.has(pageNum)) pagesBoxes.set(pageNum, []);

  applyCanvasZoom();
  updateCounts();
  clearSelectionIfMissing();
  selectBox(selectedId);

  els.runOcrBtn.disabled = false;
  els.exportBtn.disabled = false;
  els.clearManualBtn.disabled = false;
  els.clearOcrBtn.disabled = false;
  els.copyTextBtn.disabled = false;

  setStatus(`Rendered page ${pageNum}.`, 1);
  redrawOverlay();
}

/* -------------------- OCR -------------------- */

async function runOCRThisPage() {
  if (!pdfDoc) return;

  if (els.pdfCanvas.width === 0 || els.pdfCanvas.height === 0) {
    await renderPage();
  }

  const lang = els.langSelect.value;

  setStatus("Initializing OCR…", 0);
  els.runOcrBtn.disabled = true;

  // Clear OCR boxes for this page
  const boxes = getBoxesForPage(pageNum);
  for (let i = boxes.length - 1; i >= 0; i--) {
    if (boxes[i].type === "ocr") boxes.splice(i, 1);
  }
  if (selectedId && !boxes.find(b => b.id === selectedId)) selectBox(null);

  updateCounts();
  redrawOverlay();

  try {
    const result = await Tesseract.recognize(els.pdfCanvas, lang, {
      logger: (m) => {
        if (m.status === "recognizing text") {
          setStatus(`OCR: ${Math.round((m.progress || 0) * 100)}%`, m.progress || 0);
        } else {
          setStatus(`OCR: ${m.status}`, null);
        }
      },
    });

    const words = (result?.data?.words || []).filter(w => (w?.bbox && w.text && w.text.trim().length));

    for (const w of words) {
      const x0 = w.bbox.x0, y0 = w.bbox.y0, x1 = w.bbox.x1, y1 = w.bbox.y1;
      boxes.push({
        id: uid(),
        type: "ocr",
        rect: clampRectToPage({ x: x0, y: y0, w: (x1 - x0), h: (y1 - y0) }),
        text: w.text,
        conf: w.confidence,
        depth: 0,
      });
    }

    els.ocrText.value = (result?.data?.text || "").trim();
    setStatus(`OCR done. Found ${words.length} word boxes on page ${pageNum}.`, 1);

    updateCounts();
    redrawOverlay();
  } catch (err) {
    console.error(err);
    setStatus("OCR failed. Open DevTools Console for details.", 0);
  } finally {
    els.runOcrBtn.disabled = false;
  }
}

/* -------------------- Export / Clear -------------------- */

function exportJSONPage() {
  if (!pdfDoc) return;

  const boxes = getBoxesForPage(pageNum);
  const payload = {
    page: pageNum,
    pageCount,
    render: {
      width: els.pdfCanvas.width,
      height: els.pdfCanvas.height,
      renderScale,
      viewZoom
    },
    ocrText: els.ocrText.value || "",
    boxes: boxes.map(b => ({
      id: b.id,
      type: b.type,
      text: b.text ?? "",
      conf: typeof b.conf === "number" ? b.conf : null,
      depth: b.depth ?? 0,
      rect: { ...b.rect }
    }))
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `page_${pageNum}_ocr_boxes.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function clearManualPage() {
  const boxes = getBoxesForPage(pageNum);
  for (let i = boxes.length - 1; i >= 0; i--) {
    if (boxes[i].type === "manual") boxes.splice(i, 1);
  }
  if (selectedId && !boxes.find(b => b.id === selectedId)) selectBox(null);
  updateCounts();
  redrawOverlay();
}

function clearOcrPage() {
  const boxes = getBoxesForPage(pageNum);
  for (let i = boxes.length - 1; i >= 0; i--) {
    if (boxes[i].type === "ocr") boxes.splice(i, 1);
  }
  els.ocrText.value = "";
  if (selectedId && !boxes.find(b => b.id === selectedId)) selectBox(null);
  updateCounts();
  redrawOverlay();
}

/* -------------------- Mouse Interaction on overlay -------------------- */

els.overlayCanvas.addEventListener("mousedown", (evt) => {
  if (!pdfDoc) return;

  const pt = getMousePagePos(evt);

  if (drawMode) {
    isDrawing = true;
    drawStart = pt;
    tempRect = { x: pt.x, y: pt.y, w: 1, h: 1 };
    redrawOverlay();
    return;
  }

  const hit = hitTest(pt);
  selectBox(hit);
});

els.overlayCanvas.addEventListener("mousemove", (evt) => {
  if (!pdfDoc || !isDrawing) return;

  const pt = getMousePagePos(evt);
  const r = normalizeRect(drawStart, pt);
  tempRect = clampRectToPage(r);
  redrawOverlay();
});

els.overlayCanvas.addEventListener("mouseup", () => {
  if (!pdfDoc || !isDrawing) return;

  isDrawing = false;

  const r = tempRect;
  tempRect = null;
  drawStart = null;

  if (r && r.w >= 8 && r.h >= 8) {
    const boxes = getBoxesForPage(pageNum);
    const newBox = {
      id: uid(),
      type: "manual",
      rect: r,
      text: "manual",
      conf: null,
      depth: 1,
    };
    boxes.push(newBox);
    updateCounts();
    selectBox(newBox.id);
  } else {
    redrawOverlay();
  }
});

els.overlayCanvas.addEventListener("mouseleave", () => {
  if (!pdfDoc) return;
  if (isDrawing) {
    isDrawing = false;
    tempRect = null;
    drawStart = null;
    redrawOverlay();
  }
});

/* -------------------- Side panel editing -------------------- */

els.selText.addEventListener("input", () => {
  const boxes = getBoxesForPage(pageNum);
  const b = boxes.find(x => x.id === selectedId);
  if (!b || b.type === "ocr") return;
  b.text = els.selText.value;
  redrawOverlay();
});

els.selDepth.addEventListener("input", () => {
  const boxes = getBoxesForPage(pageNum);
  const b = boxes.find(x => x.id === selectedId);
  if (!b) return;
  b.depth = Number(els.selDepth.value) || 0;
  redrawOverlay();
});

els.deleteBtn.addEventListener("click", () => {
  const boxes = getBoxesForPage(pageNum);
  const idx = boxes.findIndex(x => x.id === selectedId);
  if (idx === -1) return;
  boxes.splice(idx, 1);
  selectBox(null);
  updateCounts();
  redrawOverlay();
});

els.bringFrontBtn.addEventListener("click", () => {
  const boxes = getBoxesForPage(pageNum);
  const b = boxes.find(x => x.id === selectedId);
  if (!b) return;
  b.depth = (b.depth || 0) + 1;
  els.selDepth.value = b.depth;
  redrawOverlay();
});

els.sendBackBtn.addEventListener("click", () => {
  const boxes = getBoxesForPage(pageNum);
  const b = boxes.find(x => x.id === selectedId);
  if (!b) return;
  b.depth = (b.depth || 0) - 1;
  els.selDepth.value = b.depth;
  redrawOverlay();
});

/* -------------------- Buttons / Controls -------------------- */

els.pdfInput.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  try {
    // Cleanup old object URL
    if (currentPdfObjectUrl) {
      URL.revokeObjectURL(currentPdfObjectUrl);
      currentPdfObjectUrl = null;
    }

    setStatus("Creating PDF object URL…", 0);

    // Blob URL works great on GitHub Pages
    currentPdfObjectUrl = URL.createObjectURL(file);

    setStatus("Loading PDF into PDF.js…", 0);

    await loadPdfFromUrl(currentPdfObjectUrl);

    await renderPage();
  } catch (err) {
    console.error(err);
    setStatus("Failed to load PDF. Open DevTools Console for details.", 0);
  }
});

els.prevPageBtn.addEventListener("click", async () => {
  if (!pdfDoc || pageNum <= 1) return;
  pageNum -= 1;
  updatePageLabel();
  selectedId = null;
  els.ocrText.value = "";
  await renderPage();
});

els.nextPageBtn.addEventListener("click", async () => {
  if (!pdfDoc || pageNum >= pageCount) return;
  pageNum += 1;
  updatePageLabel();
  selectedId = null;
  els.ocrText.value = "";
  await renderPage();
});

els.renderBtn.addEventListener("click", renderPage);
els.runOcrBtn.addEventListener("click", runOCRThisPage);
els.toggleDrawBtn.addEventListener("click", () => setDrawMode(!drawMode));
els.exportBtn.addEventListener("click", exportJSONPage);
els.clearManualBtn.addEventListener("click", clearManualPage);
els.clearOcrBtn.addEventListener("click", clearOcrPage);

els.zoomRange.addEventListener("input", setViewZoomFromUI);
els.showOcrChk.addEventListener("change", redrawOverlay);
els.showManualChk.addEventListener("change", redrawOverlay);
els.showTextChk.addEventListener("change", redrawOverlay);

els.copyTextBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(els.ocrText.value || "");
    setStatus("Copied OCR text to clipboard.", null);
  } catch {
    setStatus("Copy failed (browser blocked clipboard).", null);
  }
});

/* -------------------- Missing buttons wiring (delete / depth already) -------------------- */

els.clearManualBtn.addEventListener("click", clearManualPage);
els.clearOcrBtn.addEventListener("click", clearOcrPage);

/* -------------------- Init -------------------- */

enableUI(false);
setDrawMode(false);
setViewZoomFromUI();
updatePageLabel();
setStatus("Upload a PDF to begin.", 0);
