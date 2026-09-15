/* ============================================================
   Studydesk — knowledge pipeline (knowledge-pipeline.js)

   File → Clean → Detect sections → Chunk → Analyze each chunk
   (local AI or offline fallback) → save to a per-material
   knowledge base in IndexedDB → assemble reviewers from that
   knowledge base on demand (cheap, no re-analysis needed).

   Self-contained: does not depend on script.js internals, so
   load order relative to script.js doesn't matter.
   ============================================================ */

const KB_CHUNK_CHAR_BUDGET = 1400;
const KB_DB_NAME = "studydesk_kb";
const KB_STORE = "materials_kb";

/* ---------------- tiny text helpers (self-contained) ---------------- */
function kbSplitSentences(text){
  return (text || "").replace(/\s+/g, " ").trim()
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 8);
}
function kbCapitalize(w){ return w ? w.charAt(0).toUpperCase() + w.slice(1) : w; }
function kbShuffle(arr){
  const a = arr.slice();
  for(let i = a.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const KB_STOPWORDS = new Set((
  "the a an and or but if of in on at to for with from by is are was were be been being " +
  "this that these those it its as into than then so such not no can may might will would should could"
).split(" "));
function kbKeywords(text, limit){
  const freq = {};
  (text.toLowerCase().match(/[a-z][a-z\-]{3,}/g) || []).forEach(w => {
    if(KB_STOPWORDS.has(w)) return;
    freq[w] = (freq[w] || 0) + 1;
  });
  return Object.entries(freq).sort((a,b)=>b[1]-a[1]).slice(0, limit || 6).map(([w])=>w);
}

/* ============================================================
   1) CLEANING — whitespace, and best-effort repeated
      header/footer removal (uses the "\n"-per-page boundaries
      our PDF extractor already leaves behind).
   ============================================================ */
function kbCleanText(rawText){
  if(!rawText) return "";
  const blocks = rawText.split("\n").map(b => b.replace(/[ \t]+/g, " ").trim()).filter(Boolean);
  if(blocks.length < 4) return blocks.join("\n\n");

  // Detect a repeated leading/trailing phrase across many blocks (page
  // headers/footers) and strip just that phrase, not the whole block.
  const firstWords = blocks.map(b => b.split(" ").slice(0,6).join(" "));
  const lastWords = blocks.map(b => b.split(" ").slice(-6).join(" "));
  const countMap = (arr) => arr.reduce((m,v)=>{ m[v]=(m[v]||0)+1; return m; }, {});
  const firstCounts = countMap(firstWords);
  const lastCounts = countMap(lastWords);
  const threshold = Math.max(3, Math.floor(blocks.length * 0.4));
  const repeatedFirst = Object.entries(firstCounts).find(([k,c]) => c >= threshold && k.length > 6);
  const repeatedLast = Object.entries(lastCounts).find(([k,c]) => c >= threshold && k.length > 6);

  const cleaned = blocks.map((b, i) => {
    let out = b;
    if(repeatedFirst && firstWords[i] === repeatedFirst[0]) out = out.slice(repeatedFirst[0].length).trim();
    if(repeatedLast && lastWords[i] === repeatedLast[0]) out = out.slice(0, out.length - repeatedLast[0].length).trim();
    return out;
  }).filter(Boolean);

  return cleaned.join("\n\n");
}

/* ============================================================
   2) SECTION DETECTION — best-effort heading detection.
      Falls back to "one big section" if nothing is found,
      which is common for flattened PDF text.
   ============================================================ */
function kbDetectSections(text){
  const patterns = [
    /^#{1,6}\s+.+$/gm,                                             // markdown headings
    /\bChapter\s+\d+[:.\-]?\s*[A-Z][^\n.]{0,80}/g,                 // "Chapter 4: ..."
    /(?:^|\n)\s*\d{1,2}(?:\.\d{1,2}){0,2}\s+[A-Z][A-Za-z0-9 ,\-]{3,70}(?=\n|$)/g, // "3.2 Transport Layer"
    /(?:^|\n)([A-Z][A-Z0-9 ,:\-]{5,60})(?=\n)/g                     // ALL CAPS short lines
  ];

  const matches = [];
  patterns.forEach(re => {
    let m;
    re.lastIndex = 0;
    while((m = re.exec(text)) !== null){
      const title = m[0].replace(/^#{1,6}\s+/, "").trim();
      if(title.length >= 3 && title.length <= 90){
        matches.push({ index: m.index, title });
      }
      if(re.lastIndex === m.index) re.lastIndex++; // avoid infinite loop on zero-width
    }
  });

  matches.sort((a,b) => a.index - b.index);
  const deduped = [];
  matches.forEach(m => {
    const prev = deduped[deduped.length - 1];
    if(!prev || m.index - prev.index > 30) deduped.push(m);
  });

  if(deduped.length < 2){
    return [{ title: "Full document", start: 0, end: text.length }];
  }

  const sections = [];
  for(let i = 0; i < deduped.length; i++){
    const start = deduped[i].index;
    const end = i + 1 < deduped.length ? deduped[i+1].index : text.length;
    sections.push({ title: deduped[i].title, start, end });
  }
  return sections;
}

/* ============================================================
   3) CHUNKING — prefers paragraph, then sentence boundaries;
      never splits mid-sentence if avoidable.
   ============================================================ */
function kbChunkSection(sectionText, budget){
  budget = budget || KB_CHUNK_CHAR_BUDGET;
  const paragraphs = sectionText.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const chunks = [];
  let current = "";

  function flush(){
    if(current.trim().length > 0) chunks.push(current.trim());
    current = "";
  }

  paragraphs.forEach(p => {
    if(p.length > budget){
      // paragraph itself is too big — split by sentence
      const sentences = kbSplitSentences(p);
      sentences.forEach(s => {
        if((current + " " + s).length > budget) flush();
        current = (current + " " + s).trim();
      });
    } else if((current + "\n\n" + p).length > budget){
      flush();
      current = p;
    } else {
      current = current ? current + "\n\n" + p : p;
    }
  });
  flush();
  return chunks.length ? chunks : [sectionText.trim()].filter(Boolean);
}

function kbBuildChunks(materialId, materialTitle, cleanedText){
  const sections = kbDetectSections(cleanedText);
  const chunks = [];
  let chunkIndex = 0;
  sections.forEach(sec => {
    const sectionText = cleanedText.slice(sec.start, sec.end).trim();
    if(!sectionText) return;
    const pieces = kbChunkSection(sectionText);
    pieces.forEach(text => {
      chunks.push({
        id: `${materialId}-c${chunkIndex}`,
        materialId, materialTitle,
        section: sec.title,
        chunkIndex: chunkIndex,
        text,
        charCount: text.length
      });
      chunkIndex++;
    });
  });
  return chunks;
}

/* ============================================================
   4) OFFLINE FALLBACK ANALYSIS — same JSON shape as the local
      AI's analyzeChunk, so the rest of the pipeline never has
      to know which one produced a given chunk's analysis.
   ============================================================ */
function kbAnalyzeChunkMock(chunk){
  const text = chunk.text;
  const sentences = kbSplitSentences(text);
  const keywords = kbKeywords(text, 6);
  const definitions = keywords.slice(0,3).map(k => {
    const s = sentences.find(s => s.toLowerCase().includes(k));
    return { term: kbCapitalize(k), def: s ? s.slice(0,160) : `${kbCapitalize(k)} is discussed in this section.` };
  });
  const examples = sentences.filter(s => /for example|e\.g\.|such as|for instance/i.test(s)).slice(0,2);
  const relationships = sentences.filter(s => /because|therefore|leads to|causes|results in|due to|compared to|versus|whereas/i.test(s)).slice(0,2);
  return {
    topic: chunk.section || keywords[0] || "",
    key_concepts: keywords,
    definitions,
    important_facts: sentences.slice(0, 3),
    examples,
    relationships,
    possible_questions: keywords.slice(0,3).map(k => `What is ${kbCapitalize(k)}?`)
  };
}

/* ============================================================
   5) INDEXEDDB KNOWLEDGE BASE
   ============================================================ */
let kbDbPromise = null;
function kbOpenDB(){
  if(kbDbPromise) return kbDbPromise;
  kbDbPromise = new Promise((resolve, reject) => {
    if(!("indexedDB" in window)){ reject(new Error("IndexedDB not available")); return; }
    const req = indexedDB.open(KB_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if(!db.objectStoreNames.contains(KB_STORE)){
        db.createObjectStore(KB_STORE, { keyPath: "materialId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return kbDbPromise;
}

async function kbGet(materialId){
  const db = await kbOpenDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KB_STORE, "readonly");
    const req = tx.objectStore(KB_STORE).get(materialId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function kbPut(record){
  const db = await kbOpenDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KB_STORE, "readwrite");
    tx.objectStore(KB_STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function kbDelete(materialId){
  const db = await kbOpenDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KB_STORE, "readwrite");
    tx.objectStore(KB_STORE).delete(materialId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function kbGetMany(materialIds){
  const results = await Promise.all(materialIds.map(id => kbGet(id).catch(() => null)));
  return results.filter(Boolean);
}

async function kbExportAll(){
  const db = await kbOpenDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KB_STORE, "readonly");
    const req = tx.objectStore(KB_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function kbImportAll(records){
  const db = await kbOpenDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KB_STORE, "readwrite");
    const store = tx.objectStore(KB_STORE);
    store.clear();
    (records || []).forEach(r => store.put(r));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ============================================================
   6) ORCHESTRATION — analyze a material, chunk by chunk,
      saving progress after every chunk so a refresh mid-way
      can resume instead of starting over.
   ============================================================ */
async function analyzeMaterial(material, opts){
  opts = opts || {};
  const onProgress = opts.onProgress || function(){};
  const useLocalAI = !!opts.useLocalAI;

  let record = await kbGet(material.id).catch(() => null);

  if(!record || opts.forceReanalyze){
    const cleaned = kbCleanText(material.text || "");
    const chunks = kbBuildChunks(material.id, material.title, cleaned);
    record = {
      materialId: material.id,
      materialTitle: material.title,
      status: "analyzing",
      chunks,
      analyses: [],
      completedCount: 0,
      totalCount: chunks.length,
      startedAt: Date.now(),
      updatedAt: Date.now()
    };
    await kbPut(record);
  }

  if(record.status === "complete" && !opts.forceReanalyze){
    onProgress(record.completedCount, record.totalCount, "Already analyzed");
    return record;
  }

  for(let i = record.completedCount; i < record.chunks.length; i++){
    if(opts.signal && opts.signal.cancelled) break;
    const chunk = record.chunks[i];
    onProgress(i, record.totalCount, `Analyzing "${chunk.section}" (chunk ${i+1} of ${record.totalCount})`);

    let analysis = null;
    if(useLocalAI && window.LocalAI && window.LocalAI.supported){
      try{
        if(window.LocalAI.status !== "ready") await window.LocalAI.enable();
        analysis = await window.LocalAI.analyzeChunk({
          materialTitle: material.title, section: chunk.section, text: chunk.text
        });
      }catch(err){
        console.warn("Local AI chunk analysis failed, using offline fallback:", err);
      }
    }
    if(!analysis) analysis = kbAnalyzeChunkMock(chunk);

    record.analyses.push({
      chunkId: chunk.id,
      section: chunk.section,
      source: { material: material.title, section: chunk.section },
      ...analysis
    });
    record.completedCount = i + 1;
    record.updatedAt = Date.now();
    await kbPut(record);
  }

  record.status = record.completedCount >= record.totalCount ? "complete" : "partial";
  record.updatedAt = Date.now();
  await kbPut(record);
  onProgress(record.completedCount, record.totalCount, record.status === "complete" ? "Done" : "Paused");
  return record;
}

/* ============================================================
   7) REVIEWER ASSEMBLY — pure JS, no AI calls: organizes
      already-extracted concepts into the final reviewer. Cheap
      to re-run in any mode, any number of times.
   ============================================================ */
function kbStripUncertain(str){
  if(typeof str !== "string") return { text: str, uncertain: false };
  const m = str.match(/^\s*UNCERTAIN:\s*/i);
  return m ? { text: str.slice(m[0].length).trim(), uncertain: true } : { text: str, uncertain: false };
}

function kbDedupeByKey(items, keyFn){
  const seen = new Set();
  const out = [];
  items.forEach(item => {
    const k = keyFn(item).toLowerCase().trim();
    if(k && !seen.has(k)){ seen.add(k); out.push(item); }
  });
  return out;
}

function buildReviewerFromKB(kbRecords, mode){
  mode = mode || "standard";
  const allAnalyses = kbRecords.flatMap(r => (r.analyses || []));

  if(allAnalyses.length === 0) return null;

  const bySection = [];
  const sectionSeen = new Set();
  allAnalyses.forEach(a => {
    const key = `${a.source.material}::${a.section}`;
    if(!sectionSeen.has(key)){
      sectionSeen.add(key);
      bySection.push({ material: a.source.material, section: a.section, concepts: [] });
    }
    const bucket = bySection.find(b => b.material === a.source.material && b.section === a.section);
    bucket.concepts.push(...(a.key_concepts || []));
  });

  const wrap = (text, source) => {
    const { text: clean, uncertain } = kbStripUncertain(text);
    return { text: clean, uncertain, source };
  };

  const allDefinitions = kbDedupeByKey(
    allAnalyses.flatMap(a => (a.definitions || []).map(d => ({ ...d, source: a.source }))),
    d => d.term
  ).map(d => ({ term: d.term, ...wrap(d.def, d.source) }));

  const allFacts = kbDedupeByKey(
    allAnalyses.flatMap(a => (a.important_facts || []).map(f => ({ text: f, source: a.source }))),
    f => f.text
  ).map(f => wrap(f.text, f.source));

  const allExamples = kbDedupeByKey(
    allAnalyses.flatMap(a => (a.examples || []).map(e => ({ text: e, source: a.source }))),
    e => e.text
  ).map(e => wrap(e.text, e.source));

  const allRelationships = kbDedupeByKey(
    allAnalyses.flatMap(a => (a.relationships || []).map(r => ({ text: r, source: a.source }))),
    r => r.text
  ).map(r => wrap(r.text, r.source));

  const comparisonRe = /\bvs\.?\b|versus|compared to|difference between|unlike|whereas/i;
  const comparisons = allRelationships.filter(r => comparisonRe.test(r.text));
  const relationships = allRelationships.filter(r => !comparisonRe.test(r.text));

  const processRe = /^\s*(step\s*\d+|first,|second,|third,|then,|finally,|\d+[\.\)])/i;
  const processes = allFacts.filter(f => processRe.test(f.text));

  const allConcepts = kbDedupeByKey(
    allAnalyses.flatMap(a => (a.key_concepts || []).map(c => ({ text: c, source: a.source }))),
    c => c.text
  ).map(c => wrap(c.text, c.source));

  const topics = kbDedupeByKey(
    allAnalyses.filter(a => a.topic).map(a => ({ text: a.topic, source: a.source })),
    t => t.text
  );

  const overviewParts = topics.slice(0,5).map(t => t.text);
  const overview = overviewParts.length
    ? `This material covers: ${overviewParts.join(", ")}.`
    : "This material has been analyzed and its key concepts extracted below.";

  const quickReview = allFacts.slice(0, 8).length ? allFacts.slice(0,8) :
    allConcepts.slice(0,8).map(c => ({ text: c.text, uncertain: c.uncertain, source: c.source }));

  const reviewer = {
    mode,
    generatedAt: Date.now(),
    overview,
    mainTopics: bySection.map(b => ({
      material: b.material, section: b.section,
      concepts: [...new Set(b.concepts)].slice(0, mode === "detailed" ? 12 : 6)
    })),
    keyConcepts: allConcepts.slice(0, mode === "quick" ? 0 : mode === "examCram" ? 6 : 16),
    definitions: allDefinitions.slice(0, mode === "quick" ? 0 : mode === "examCram" ? 14 : 20),
    importantFacts: allFacts.slice(0, mode === "quick" ? 0 : mode === "detailed" ? 30 : 10),
    examples: (mode === "quick" || mode === "examCram") ? [] : allExamples.slice(0, 10),
    comparisons: (mode === "quick" || mode === "examCram") ? [] : comparisons.slice(0, 8),
    processes: (mode === "quick" || mode === "examCram") ? [] : processes.slice(0, 8),
    relationships: mode === "detailed" ? relationships.slice(0, 12) : [],
    quickReview
  };

  if(mode === "quick"){
    reviewer.mainTopics = [];
  }

  return reviewer;
}

/* ---------------- Public API ---------------- */
window.KnowledgePipeline = {
  analyzeMaterial,
  buildReviewerFromKB,
  kb: {
    get: kbGet,
    put: kbPut,
    delete: kbDelete,
    getMany: kbGetMany,
    exportAll: kbExportAll,
    importAll: kbImportAll
  }
};
