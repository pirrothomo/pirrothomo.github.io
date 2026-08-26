/* Streaming PDF reader.
   Only the pages actually being looked at are fetched and rendered, so an
   80 MB book opens in a couple of seconds over HTTP range requests. */

const $ = (s) => document.querySelector(s);

const STRINGS = {
  sq: { loading: "Duke hapur librin…", failed: "Libri nuk u hap dot.", retry: "Provo përsëri" },
  en: { loading: "Opening the book…", failed: "The book could not be opened.", retry: "Try again" },
};

const params = new URLSearchParams(location.search);
const LANG = params.get("lang") === "en" ? "en" : "sq";
const T = STRINGS[LANG];

const slug = params.get("b");
let book = null;

// Resolve against the PAGE, not this module. A relative specifier passed to
// import() resolves against the module's own URL (/assets/reader.js), which
// would look for /assets/vendor/pdfjs/... and 404.
const pageDir = new URL(location.pathname.includes("/en/") ? "../" : "./", location.href);
const abs = (p) => new URL(p, pageDir).href;

const viewer = $("#viewer");
const statusEl = $("#status");
const pageNow = $("#page-now");
const pageTot = $("#page-tot");
const pageIn = $("#page-in");

let pdfjsLib = null;
let pdf = null;
let scale = 1;
let pageBoxes = [];
const rendering = new Map();
let renderedOrder = [];
const MAX_RENDERED = 8;

// A page rendered to the full width of a wide monitor is far bigger than
// anyone wants to read. Cap the base width; zoom still goes past it.
const MAX_BASE_WIDTH = 960;

function setStatus(msg, showRetry) {
  statusEl.innerHTML = "";
  if (!msg) { statusEl.hidden = true; return; }
  statusEl.hidden = false;
  const p = document.createElement("p");
  p.textContent = msg;
  statusEl.appendChild(p);
  if (showRetry) {
    const b = document.createElement("button");
    b.className = "btn";
    b.textContent = T.retry;
    b.onclick = () => location.reload();
    statusEl.appendChild(b);
  }
}

function targetWidth() {
  const pad = window.innerWidth < 700 ? 16 : 48;
  const avail = Math.max(240, viewer.clientWidth - pad);
  const base = Math.min(avail, MAX_BASE_WIDTH);
  return Math.max(240, Math.min(base * scale, avail * 4));
}

/* Boxes always carry an explicit height derived from their aspect ratio. If a
   box is ever left height:auto with no canvas it collapses, the document height
   changes underneath the scroll position, and the viewer jumps to page 1. */
function sizeBox(box, w) {
  const ratio = +box.dataset.ratio || 1.4;
  box.style.width = w + "px";
  box.style.height = Math.round(w * ratio) + "px";
}

const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting) renderPage(+e.target.dataset.n);
  }
}, { rootMargin: "120% 0px" });

const ioCurrent = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting && e.intersectionRatio > 0.35) {
      const n = +e.target.dataset.n;
      pageNow.textContent = n;
      if (document.activeElement !== pageIn) pageIn.value = n;
    }
  }
}, { threshold: [0.35, 0.6] });

async function build() {
  setStatus(T.loading, false);

  pdfjsLib = await import(abs("vendor/pdfjs/pdf.min.mjs"));
  pdfjsLib.GlobalWorkerOptions.workerSrc = abs("vendor/pdfjs/pdf.worker.min.mjs");

  const task = pdfjsLib.getDocument({
    url: abs("pdf/" + slug + ".pdf"),
    cMapUrl: abs("vendor/pdfjs/cmaps/"),
    cMapPacked: true,
    standardFontDataUrl: abs("vendor/pdfjs/standard_fonts/"),
    disableAutoFetch: true,
    disableStream: false,
    rangeChunkSize: 262144,
  });

  pdf = await task.promise;
  setStatus(null);

  pageTot.textContent = pdf.numPages;
  pageIn.max = pdf.numPages;

  const first = await pdf.getPage(1);
  const vp1 = first.getViewport({ scale: 1 });
  const ratio = vp1.height / vp1.width;

  viewer.innerHTML = "";
  pageBoxes = [];
  const w = targetWidth();
  for (let n = 1; n <= pdf.numPages; n++) {
    const box = document.createElement("div");
    box.className = "pg";
    box.dataset.n = n;
    box.dataset.ratio = ratio;          // corrected once the page renders
    sizeBox(box, w);
    const label = document.createElement("span");
    label.className = "pg-num";
    label.textContent = n;
    box.appendChild(label);
    viewer.appendChild(box);
    pageBoxes.push(box);
    io.observe(box);
    ioCurrent.observe(box);
  }
  renderPage(1);
}

async function renderPage(n) {
  const box = pageBoxes[n - 1];
  if (!box || box.dataset.done === "1" || rendering.has(n)) return;
  rendering.set(n, true);
  try {
    const page = await pdf.getPage(n);
    const w = targetWidth();
    const unit = page.getViewport({ scale: 1 });
    const s = w / unit.width;
    const vp = page.getViewport({ scale: s });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    // page sizes can vary slightly within a book
    box.dataset.ratio = vp.height / vp.width;
    sizeBox(box, w);

    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(vp.width * dpr);
    canvas.height = Math.floor(vp.height * dpr);
    canvas.style.width = "100%";
    canvas.style.height = "100%";

    await page.render({
      canvasContext: canvas.getContext("2d", { alpha: false }),
      viewport: vp,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
    }).promise;

    box.querySelector("canvas")?.remove();
    box.querySelector(".textLayer")?.remove();
    box.insertBefore(canvas, box.firstChild);

    // Selectable text on top of the picture. Scanned items carry no text and
    // simply get an empty layer.
    try {
      const layer = document.createElement("div");
      layer.className = "textLayer";
      layer.style.setProperty("--scale-factor", s);
      layer.style.setProperty("--total-scale-factor", s);
      box.appendChild(layer);
      const tl = new pdfjsLib.TextLayer({
        textContentSource: page.streamTextContent(),
        container: layer,
        viewport: vp,
      });
      await tl.render();
    } catch (err) {
      box.querySelector(".textLayer")?.remove();
    }

    box.dataset.done = "1";
    renderedOrder.push(n);
    trim();
  } catch (err) {
    console.error("page", n, err);
  } finally {
    rendering.delete(n);
  }
}

/* Hundreds of canvases would exhaust memory; drop the ones far from view.
   The box keeps its size, so nothing shifts when a canvas goes away. */
function trim() {
  if (renderedOrder.length <= MAX_RENDERED) return;
  const cur = +pageNow.textContent || 1;
  renderedOrder.sort((a, b) => Math.abs(a - cur) - Math.abs(b - cur));
  while (renderedOrder.length > MAX_RENDERED) {
    const drop = renderedOrder.pop();
    const box = pageBoxes[drop - 1];
    if (!box) continue;
    box.querySelector("canvas")?.remove();
    box.querySelector(".textLayer")?.remove();
    box.dataset.done = "0";
  }
}

/* Resizing (including turning a phone on its side) must keep the reader where
   it was. Remember the page and how far into it we are, then restore. */
function reflow() {
  if (!pdf) return;
  const cur = +pageNow.textContent || 1;
  const curBox = pageBoxes[cur - 1];
  let frac = 0;
  if (curBox) {
    const r = curBox.getBoundingClientRect();
    if (r.height > 0) frac = Math.min(1, Math.max(0, -r.top / r.height));
  }

  const w = targetWidth();
  for (const box of pageBoxes) {
    box.querySelector("canvas")?.remove();
    box.querySelector(".textLayer")?.remove();
    box.dataset.done = "0";
    sizeBox(box, w);
  }
  renderedOrder = [];

  const target = pageBoxes[cur - 1];
  if (target) {
    const prev = viewer.style.scrollBehavior;
    viewer.style.scrollBehavior = "auto";
    viewer.scrollTop = target.offsetTop - viewer.offsetTop + frac * target.offsetHeight;
    viewer.style.scrollBehavior = prev;
  }
  renderPage(cur);
  renderPage(cur + 1);
}

function goTo(n, smooth) {
  if (!pdf) return;
  n = Math.max(1, Math.min(pdf.numPages, n | 0));
  const box = pageBoxes[n - 1];
  if (!box) return;
  box.scrollIntoView({ behavior: smooth === false ? "auto" : "smooth", block: "start" });
  pageNow.textContent = n;
  // Don't wait for the observer: a jump should start drawing immediately.
  renderPage(n);
  renderPage(n + 1);
  renderPage(n - 1);
}

$("#zoom-in").onclick = () => { scale = Math.min(4, scale * 1.25); reflow(); };
$("#zoom-out").onclick = () => { scale = Math.max(0.4, scale / 1.25); reflow(); };
$("#zoom-fit").onclick = () => { scale = 1; reflow(); };

// Typing a page number jumps straight there: smooth-scrolling across hundreds
// of pages is slow and renders everything on the way.
pageIn.addEventListener("change", () => goTo(+pageIn.value, false));
pageIn.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { goTo(+pageIn.value, false); pageIn.blur(); }
});

document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT") return;
  const cur = +pageNow.textContent || 1;
  if (e.key === "ArrowRight" || e.key === "PageDown") { goTo(cur + 1); e.preventDefault(); }
  if (e.key === "ArrowLeft" || e.key === "PageUp") { goTo(cur - 1); e.preventDefault(); }
  if (e.key === "Home") { goTo(1); e.preventDefault(); }
  if (e.key === "End") { goTo(pdf ? pdf.numPages : 1); e.preventDefault(); }
  if (e.key === "+" || e.key === "=") $("#zoom-in").click();
  if (e.key === "-") $("#zoom-out").click();
});

let rt;
function onResize() { clearTimeout(rt); rt = setTimeout(reflow, 200); }
window.addEventListener("resize", onResize);
if (screen.orientation && screen.orientation.addEventListener) {
  screen.orientation.addEventListener("change", onResize);
}

async function boot() {
  let works = {};
  try {
    const res = await fetch(abs("works.json"), { cache: "no-cache" });
    if (res.ok) works = await res.json();
  } catch (err) {
    console.error("works.json", err);
  }
  book = works[slug];
  if (!book) {
    setStatus(T.failed, false);
    return;
  }
  const name = book[LANG] || book.sq || slug;
  document.title = name + " — Pirro Thomo";
  $("#book-title").textContent = name;
  const dl = $("#dl");
  dl.href = abs("pdf/" + slug + ".pdf");
  dl.setAttribute("download", "");
  $("#back").href = abs(LANG === "en" ? "en/" : "./");
  try {
    await build();
  } catch (err) {
    console.error(err);
    setStatus(T.failed, true);
  }
}

boot();
