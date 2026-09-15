/* ============================================================
   STUDYDESK — app logic
   Vanilla JS. Data model + rendering + a swappable "AI" layer.
   Search for "AI HOOK" to see where a real API would plug in.
   ============================================================ */

/* ---------------- Constants ---------------- */
const STORAGE_KEY = "studydesk_data_v1";
const SWATCHES = ["#1F6F5C", "#E3A33D", "#4C6EF5", "#C1503D", "#8452C9", "#2B8FA8"];
const STOPWORDS = new Set((
  "the a an and or but if of in on at to for with from by is are was were be been being " +
  "this that these those it its as into than then so such not no can may might will would should could"
).split(" ").filter(Boolean));

/* ---------------- State ---------------- */
let state = {
  subjects: [],       // { id, name, color, createdAt, materials:[], quizHistory:[] }
  activeSubjectId: null,
  activePage: "dashboard", // 'dashboard' | 'subject'
  activeTab: "materials",
  currentQuiz: null    // transient in-progress quiz, not persisted once finished
};

let pendingDeleteId = null;

/* ---------------- Storage ---------------- */
function saveState(){
  const toSave = {
    subjects: state.subjects,
    activeSubjectId: state.activeSubjectId
  };
  try{
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
  }catch(e){
    console.warn("Could not save to Local Storage", e);
    showToast("Couldn't save — your browser storage may be full.");
  }
}

function loadState(){
  const raw = localStorage.getItem(STORAGE_KEY);
  if(!raw){
    seedSampleData();
    saveState();
    return;
  }
  try{
    const parsed = JSON.parse(raw);
    state.subjects = parsed.subjects || [];
    state.subjects.forEach(s => {
      if(s.aiSummary === undefined) s.aiSummary = null;
      (s.materials || []).forEach(m => { if(m.status === undefined) m.status = "ready"; });
    });
    state.activeSubjectId = parsed.activeSubjectId || (state.subjects[0] && state.subjects[0].id) || null;
  }catch(e){
    console.warn("Corrupt saved data, starting fresh", e);
    seedSampleData();
  }
}

function seedSampleData(){
  const now = Date.now();
  state.subjects = [
    makeSubject("Mathematics", SWATCHES[0]),
    makeSubject("Programming", SWATCHES[1]),
    makeSubject("Networking", SWATCHES[2]),
  ];

  // Give Mathematics one sample material + generated content, so the app feels alive.
  const math = state.subjects[0];
  math.materials.push(makeMaterial(
    "Quadratic Equations — Notes",
    "text",
    "A quadratic equation is a polynomial equation of degree two, generally written as ax^2 + bx + c = 0, " +
    "where a is not equal to zero. The solutions to a quadratic equation are called its roots. The quadratic " +
    "formula states that x equals negative b plus or minus the square root of b squared minus four a c, all " +
    "divided by two a. The discriminant is the expression b squared minus four a c. When the discriminant is " +
    "positive, the equation has two distinct real roots. When the discriminant equals zero, the equation has " +
    "exactly one repeated real root. When the discriminant is negative, the equation has two complex roots. " +
    "Factoring, completing the square, and the quadratic formula are the three common methods used to solve " +
    "quadratic equations. A parabola is the graph of a quadratic function, and its vertex represents the " +
    "maximum or minimum point of the curve."
  ));
  math.quizHistory.push({
    id: uid(), date: now - 86400000*2, difficulty:"medium", total:5, score:4,
    questions: [] // historic entries may not retain full question detail
  });

  state.activeSubjectId = math.id;
}

/* ---------------- Helpers ---------------- */
function uid(){ return Math.random().toString(36).slice(2,10) + Date.now().toString(36); }

function makeSubject(name, color){
  return {
    id: uid(),
    name: name,
    color: color || SWATCHES[state.subjects.length % SWATCHES.length],
    createdAt: Date.now(),
    materials: [],
    quizHistory: [],
    aiSummary: null   // cached generated {simple,keyPoints,keywords,definitions,reviewer,source}
  };
}

/* ---------------- PDF / DOCX text extraction ---------------- */
// Uses pdf.js and mammoth.js (loaded via <script> tags in index.html) to pull
// real text out of uploaded files, client-side, no server involved.
if(window.pdfjsLib){
  pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}

async function extractPdfText(file){
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  let text = "";
  for(let i = 1; i <= pdf.numPages; i++){
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map(it => it.str).join(" ") + "\n";
  }
  return text.trim();
}

async function extractDocxText(file){
  const buffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer: buffer });
  return (result.value || "").trim();
}

function makeMaterial(title, type, extractedText, status){
  return {
    id: uid(),
    title: title,
    type: type,        // 'text' | 'txt' | 'pdf' | 'docx'
    addedAt: Date.now(),
    text: extractedText || "",
    status: status || "ready"   // 'ready' | 'processing' | 'error'
  };
}

function getSubject(id){
  return state.subjects.find(s => s.id === id);
}

function activeSubject(){
  return getSubject(state.activeSubjectId);
}

function fmtDate(ts){
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month:"short", day:"numeric", year:"numeric" });
}

function timeAgo(ts){
  const diff = Date.now() - ts;
  const min = Math.floor(diff/60000);
  if(min < 1) return "just now";
  if(min < 60) return min + "m ago";
  const hr = Math.floor(min/60);
  if(hr < 24) return hr + "h ago";
  const day = Math.floor(hr/24);
  if(day < 7) return day + "d ago";
  return fmtDate(ts);
}

function showToast(msg){
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(()=> t.classList.remove("show"), 2400);
}

function escapeHtml(str){
  return (str || "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

/* ============================================================
   AI HOOK — mock "AI" text analysis layer.
   Replace the bodies of these functions with real API calls
   (e.g. to Anthropic's API) while keeping the same signatures,
   and the rest of the app keeps working unchanged.
   ============================================================ */

function getSubjectCorpus(subject){
  return subject.materials.map(m => m.text).filter(Boolean).join(" ");
}

// Sentences grouped by material, so summaries/quizzes can draw from every
// material instead of only the first one in the concatenated corpus.
function getMaterialSentenceGroups(subject){
  return subject.materials
    .filter(m => m.text)
    .map(m => ({ material: m, sentences: splitSentences(m.text) }))
    .filter(g => g.sentences.length > 0);
}

// Pulls sentences round-robin across materials (1 from each, then repeat)
// so every uploaded material is represented, not just whichever was added first.
function roundRobinSentences(groups, count){
  const picked = [];
  const cursors = groups.map(() => 0);
  let round = 0;
  while(picked.length < count && groups.some((g,i) => cursors[i] < g.sentences.length)){
    for(let i = 0; i < groups.length && picked.length < count; i++){
      const g = groups[i];
      if(cursors[i] < g.sentences.length){
        picked.push(g.sentences[cursors[i]]);
        cursors[i]++;
      }
    }
    round++;
    if(round > 50) break; // safety valve
  }
  return picked;
}

function extractKeywords(text, limit){
  limit = limit || 8;
  const freq = {};
  const words = (text.toLowerCase().match(/[a-z][a-z\-]{3,}/g) || []);
  words.forEach(w => {
    if(STOPWORDS.has(w)) return;
    freq[w] = (freq[w] || 0) + 1;
  });
  return Object.entries(freq)
    .sort((a,b)=> b[1]-a[1])
    .slice(0, limit)
    .map(([w]) => w);
}

function splitSentences(text){
  return (text || "").replace(/\s+/g," ").trim()
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 12);
}

// Grabs a short window of words around a keyword's occurrence in a sentence,
// instead of quoting the entire sentence — shorter, and more "definition"-shaped.
function extractSnippet(sentence, keyword, windowSize){
  windowSize = windowSize || 9;
  const words = sentence.split(/\s+/);
  const idx = words.findIndex(w => w.toLowerCase().replace(/[^a-z-]/g,"") === keyword);
  if(idx === -1) return truncate(sentence, 140);
  const start = Math.max(0, idx - windowSize);
  const end = Math.min(words.length, idx + windowSize + 1);
  let snippet = words.slice(start, end).join(" ");
  if(start > 0) snippet = "…" + snippet;
  if(end < words.length) snippet = snippet + "…";
  return snippet;
}

// Replaces the keyword itself with a blank, so the quiz actually tests recall
// instead of quoting the answer back at the person.
function maskTerm(snippet, keyword){
  const re = new RegExp(`\\b${keyword}\\w*\\b`, "gi");
  return snippet.replace(re, "_____");
}

// AI HOOK: swap for a real summarization call. (This is the offline fallback —
// see local-ai.js for the on-device model path, wired in via triggerSummaryGeneration below.)
function generateSummaryMock(subject){
  const text = getSubjectCorpus(subject);
  if(!text) return null;

  const groups = getMaterialSentenceGroups(subject);
  const orderedSentences = roundRobinSentences(groups, 24); // draws from every material

  const simple = orderedSentences.slice(0, groups.length || 1).slice(0,3).join(" ") ||
    orderedSentences.slice(0,2).join(" ") || text.slice(0,220);
  const keyPoints = orderedSentences.slice(0, Math.min(6, orderedSentences.length));
  const keywords = extractKeywords(text, 8);
  const definitions = keywords.slice(0, 4).map(k => {
    const sentence = orderedSentences.find(s => s.toLowerCase().includes(k)) ||
      `${capitalize(k)} is a key concept covered in this subject's materials.`;
    return { term: capitalize(k), def: extractSnippet(sentence, k, 12) };
  });
  const reviewer = keyPoints.map((s,i) => `${i+1}. ${s}`).join("\n");

  return { simple, keyPoints, keywords, definitions, reviewer, generatedAt: Date.now(), source: "mock" };
}

function capitalize(w){ return w.charAt(0).toUpperCase() + w.slice(1); }

// AI HOOK: swap for a real quiz-generation call. (Offline fallback — see
// local-ai.js for the on-device model path.)
// Question format: the definition/context is the QUESTION, the term is the
// ANSWER — a fill-in-the-blank / "what term does this describe" style,
// rather than quoting a whole sentence back with the term visible in it.
function generateQuizMock(subject, count, difficulty){
  const text = getSubjectCorpus(subject);
  const groups = getMaterialSentenceGroups(subject);
  const sentences = roundRobinSentences(groups, 60);
  const keywords = extractKeywords(text, 24);
  const questions = [];

  const genericBank = genericQuestionBank(subject.name, difficulty);

  const usedKeywords = new Set();
  for(const kw of keywords){
    if(questions.length >= count) break;
    if(usedKeywords.has(kw)) continue;
    const sentence = sentences.find(s => s.toLowerCase().includes(kw));
    if(!sentence) continue;
    usedKeywords.add(kw);

    const snippet = extractSnippet(sentence, kw, 10);
    const masked = maskTerm(snippet, kw);
    if(!masked.includes("_____")) continue; // masking failed, skip rather than leak the answer

    const otherKeywords = keywords.filter(k => k !== kw);
    const distractors = shuffle(otherKeywords).slice(0,3).map(capitalize);
    while(distractors.length < 3) distractors.push(capitalize(kw) + " (related)");

    const options = shuffle([capitalize(kw), ...distractors]);
    questions.push({
      id: uid(),
      question: `Which term fills in the blank: "${masked}"`,
      options,
      correctIndex: options.indexOf(capitalize(kw)),
      explanation: `Your notes say: "${truncate(sentence, 150)}" — so "${capitalize(kw)}" is the term being described.`,
      difficulty
    });
  }

  // Fill remaining slots with the generic bank for this subject.
  let gi = 0;
  while(questions.length < count && gi < genericBank.length){
    questions.push(genericBank[gi]);
    gi++;
  }
  // If still short (tiny subject, huge count), cycle the generic bank.
  while(questions.length < count && genericBank.length){
    questions.push({ ...genericBank[questions.length % genericBank.length], id: uid() });
  }

  return shuffle(questions).slice(0, count);
}

function truncate(s, n){ return s.length > n ? s.slice(0,n-1) + "…" : s; }

function shuffle(arr){
  const a = arr.slice();
  for(let i = a.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i+1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function genericQuestionBank(subjectName, difficulty){
  // Fallback pool so a quiz can always be generated, even with no materials yet.
  const pools = {
    easy: [
      { q: `What is the most effective first step when starting to study a new topic in ${subjectName}?`,
        options:["Reviewing key terms and definitions first","Skipping straight to practice tests","Memorizing without context","Ignoring foundational concepts"], correct:0,
        exp:"Building a base of definitions and terms makes later material easier to connect to." },
      { q: `In ${subjectName}, why is regular review considered helpful for long-term retention?`,
        options:["It has no real effect","It strengthens memory through spaced repetition","It only helps right before a test","It replaces the need to understand concepts"], correct:1,
        exp:"Spaced, repeated review is well-supported for moving knowledge into long-term memory." },
    ],
    medium: [
      { q: `Which approach best helps connect separate concepts within ${subjectName}?`,
        options:["Studying each topic in total isolation","Building a concept map linking related ideas","Avoiding comparisons between topics","Only reading definitions"], correct:1,
        exp:"Concept maps reveal relationships between ideas, which deepens understanding beyond memorization." },
      { q: `When practicing problems in ${subjectName}, what typically indicates a real gap in understanding?`,
        options:["Getting every answer right immediately","Struggling only with unfamiliar wording of the same idea","Finishing quickly","Recognizing all vocabulary"], correct:1,
        exp:"If unfamiliar phrasing of a familiar idea causes trouble, the concept isn't fully internalized yet." },
    ],
    hard: [
      { q: `In ${subjectName}, which strategy best supports transferring knowledge to unfamiliar problem types?`,
        options:["Rote memorization of solved examples","Practicing the underlying principle across varied contexts","Repeating identical practice sets","Studying only worked examples without variation"], correct:1,
        exp:"Applying a principle in varied contexts builds flexible understanding, not just pattern recall." },
      { q: `What is a common sign of surface-level (rather than deep) learning in ${subjectName}?`,
        options:["Being able to explain the reasoning behind an answer","Only recognizing answers rather than deriving them","Teaching the concept to someone else successfully","Applying the idea to a new scenario"], correct:1,
        exp:"Recognition without the ability to derive or explain usually signals shallow understanding." },
    ]
  };
  const set = pools[difficulty] || pools.medium;
  return set.map(item => ({
    id: uid(),
    question: item.q,
    options: item.options,
    correctIndex: item.correct,
    explanation: item.exp,
    difficulty
  }));
}

/* ============================================================
   LOCAL AI INTEGRATION
   Wraps window.LocalAI (defined in local-ai.js, a WebLLM engine
   that runs a small model fully on-device). Falls back to the
   mock functions above whenever local AI is off, unsupported,
   or fails for any reason — so the app always produces something.
   ============================================================ */
function useLocalAI(){
  return localStorage.getItem("studydesk_use_local_ai") === "1";
}
function setUseLocalAI(v){
  localStorage.setItem("studydesk_use_local_ai", v ? "1" : "0");
}

// Keeps the cached summary honest when materials change: quick-scan summaries
// are cheap, so just auto-refresh them; a real on-device AI summary is left
// alone (regenerating is slow/deliberate) but flagged as stale so the user
// knows to hit Regenerate if they want the new material folded in.
function markSummaryStaleOrRegen(subj){
  if(!subj.aiSummary) return;
  if(subj.aiSummary.source === "mock"){
    subj.aiSummary = generateSummaryMock(subj);
  } else {
    subj.aiSummary.stale = true;
  }
}

async function triggerSummaryGeneration(subj){
  const corpus = getSubjectCorpus(subj);
  if(!corpus){
    subj.aiSummary = null;
    renderAll(); renderSubjectPage();
    return;
  }

  const usingLocal = useLocalAI() && window.LocalAI && window.LocalAI.supported;
  ["panel-summary","panel-reviewer"].forEach(id => {
    const el = document.getElementById(id);
    if(el) el.innerHTML = `<div class="empty-state"><h3>Generating…</h3><p>${
      usingLocal ? "Thinking with the on-device model — this can take a bit, especially the first time." : "Scanning your materials."
    }</p></div>`;
  });

  let result = null;
  if(usingLocal){
    try{
      if(window.LocalAI.status !== "ready") await window.LocalAI.enable();
      result = await window.LocalAI.summarize(subj.name, corpus);
    }catch(err){
      console.warn("Local AI summary failed, falling back to quick-scan:", err);
      showToast("On-device AI had trouble — used quick-scan instead.");
    }
  }
  if(!result) result = generateSummaryMock(subj);

  subj.aiSummary = result;
  renderAll(); renderSubjectPage();
}

// Builds quiz questions from the analyzed knowledge base (definitions +
// key concepts, each with a source), in the same fill-in-the-blank /
// "what term does this describe" style as the corpus-based mock.
function buildQuizFromKB(kbRecords, count, difficulty){
  const analyses = kbRecords.flatMap(r => r.analyses || []);
  const pool = [];
  analyses.forEach(a => {
    (a.definitions || []).forEach(d => {
      if(d && d.term && d.def) pool.push({ term: d.term, def: d.def, source: a.source });
    });
  });
  if(pool.length < 2) return null;

  const terms = pool.map(p => capitalize(p.term));
  const questions = shuffle(pool).slice(0, count).map(p => {
    const otherTerms = terms.filter(t => t.toLowerCase() !== p.term.toLowerCase());
    const distractors = shuffle(otherTerms).slice(0,3);
    while(distractors.length < 3) distractors.push(capitalize(p.term) + " (related)");
    const options = shuffle([capitalize(p.term), ...distractors]);
    return {
      id: uid(),
      question: `Which term fills in the blank: "${p.def.replace(new RegExp(`\\b${p.term}\\w*\\b`,"gi"), "_____")}"`,
      options,
      correctIndex: options.indexOf(capitalize(p.term)),
      explanation: `From your analyzed materials (${p.source.material}${p.source.section ? " → " + p.source.section : ""}): ${p.def}`,
      difficulty
    };
  });
  return questions.length ? questions : null;
}

async function buildQuizQuestions(subj, count, difficulty){
  const corpus = getSubjectCorpus(subj);

  // Prefer the analyzed knowledge base when it exists — better grounded,
  // source-linked, and doesn't need another AI call at all.
  if(window.KnowledgePipeline){
    try{
      const materialIds = subj.materials.filter(m => m.text).map(m => m.id);
      const records = await window.KnowledgePipeline.kb.getMany(materialIds);
      const analyzed = records.filter(r => r && r.analyses && r.analyses.length);
      if(analyzed.length){
        const kbQuestions = buildQuizFromKB(analyzed, count, difficulty);
        if(kbQuestions) return kbQuestions;
      }
    }catch(err){
      console.warn("Could not build quiz from knowledge base, falling back:", err);
    }
  }

  const usingLocal = useLocalAI() && window.LocalAI && window.LocalAI.supported && corpus.trim().length >= 40;

  if(usingLocal){
    try{
      if(window.LocalAI.status !== "ready") await window.LocalAI.enable();
      const raw = await window.LocalAI.generateQuiz(subj.name, corpus, count, difficulty);
      if(raw && raw.length){
        return raw.slice(0, count).map(q => ({
          id: uid(),
          question: q.question,
          options: q.options,
          correctIndex: q.correctIndex,
          explanation: q.explanation || "Based on your study materials.",
          difficulty
        }));
      }
    }catch(err){
      console.warn("Local AI quiz failed, falling back to quick-scan:", err);
      showToast("On-device AI had trouble — used quick-scan questions instead.");
    }
  }
  return generateQuizMock(subj, count, difficulty);
}

/* ============================================================
   RENDERING
   ============================================================ */
function renderAll(){
  renderSidebar();
  if(state.activePage === "dashboard"){
    document.getElementById("pageTitle").textContent = "Dashboard";
    renderDashboard();
  } else {
    const subj = activeSubject();
    document.getElementById("pageTitle").textContent = subj ? subj.name : "Subject";
    renderSubjectPage();
  }
  saveState();
}

function renderSidebar(){
  document.getElementById("navDashboard").dataset.active = state.activePage === "dashboard" ? "true" : "false";
  const list = document.getElementById("subjectList");
  if(state.subjects.length === 0){
    list.innerHTML = `<div style="padding:10px;color:#8792a0;font-size:12.5px;">No subjects yet.</div>`;
    return;
  }
  list.innerHTML = state.subjects.map(s => `
    <div class="subject-pill ${s.id === state.activeSubjectId && state.activePage==='subject' ? 'active':''}" data-id="${s.id}">
      <span class="dot" style="background:${s.color}"></span>
      <span class="s-name">${escapeHtml(s.name)}</span>
      <span class="s-count">${s.materials.length}</span>
    </div>
  `).join("");
  list.querySelectorAll(".subject-pill").forEach(el => {
    el.addEventListener("click", () => {
      state.activeSubjectId = el.dataset.id;
      state.activePage = "subject";
      state.activeTab = "materials";
      closeMobileSidebar();
      renderAll();
    });
  });
}

/* ---------------- Dashboard ---------------- */
function renderDashboard(){
  const totalSubjects = state.subjects.length;
  const totalMaterials = state.subjects.reduce((n,s)=> n + s.materials.length, 0);
  const allQuizzes = state.subjects.flatMap(s => s.quizHistory.map(q => ({...q, subjectName:s.name, color:s.color})));
  const totalQuizzes = allQuizzes.length;
  const avgScore = totalQuizzes ? Math.round(
    allQuizzes.reduce((sum,q)=> sum + (q.score / q.total), 0) / totalQuizzes * 100
  ) : 0;

  const view = document.getElementById("view");
  view.innerHTML = `
    <div class="hero-row">
      <div>
        <h2 class="hero-greeting">Welcome back 👋</h2>
        <p class="hero-sub">Here's where your studying stands across every subject.</p>
      </div>
    </div>

    <div class="stat-row">
      <div class="stat-card"><div class="stat-num">${totalSubjects}</div><div class="stat-label">Subjects</div></div>
      <div class="stat-card"><div class="stat-num">${totalMaterials}</div><div class="stat-label">Materials saved</div></div>
      <div class="stat-card"><div class="stat-num">${totalQuizzes}</div><div class="stat-label">Quizzes taken</div></div>
      <div class="stat-card"><div class="stat-num">${avgScore}%</div><div class="stat-label">Average score</div></div>
    </div>

    <div class="section-heading"><h2>Your subjects</h2></div>
    <div id="dashSubjectGrid"></div>

    <div class="section-heading"><h2>Recent activity</h2></div>
    <div id="dashActivity"></div>
  `;

  const grid = document.getElementById("dashSubjectGrid");
  if(state.subjects.length === 0){
    grid.innerHTML = `
      <div class="empty-state">
        <h3>No subjects yet</h3>
        <p>Create your first subject to start uploading materials and generating reviewers.</p>
        <button class="btn btn-primary" id="emptyCreateBtn">+ Create subject</button>
      </div>`;
    document.getElementById("emptyCreateBtn").addEventListener("click", () => openSubjectModal("create"));
  } else {
    grid.className = "subject-grid";
    grid.innerHTML = state.subjects.map(s => {
      const quizzes = s.quizHistory;
      const avg = quizzes.length ? Math.round(quizzes.reduce((n,q)=>n+q.score/q.total,0)/quizzes.length*100) : null;
      return `
        <div class="subject-card" style="border-top-color:${s.color}" data-id="${s.id}">
          <h3>${escapeHtml(s.name)}</h3>
          <div class="meta-row">
            <span>${s.materials.length} materials</span>
            <span>${quizzes.length} quizzes</span>
          </div>
          <div class="progress-track"><div class="progress-fill" style="width:${avg ?? 0}%; background:${s.color}"></div></div>
          <div class="meta-row">${avg !== null ? `Average score: ${avg}%` : "No quizzes yet"}</div>
        </div>`;
    }).join("");
    grid.querySelectorAll(".subject-card").forEach(el => {
      el.addEventListener("click", () => {
        state.activeSubjectId = el.dataset.id;
        state.activePage = "subject";
        state.activeTab = "materials";
        renderAll();
      });
    });
  }

  const activityBox = document.getElementById("dashActivity");
  const events = [];
  state.subjects.forEach(s => {
    s.materials.forEach(m => events.push({ ts:m.addedAt, color:s.color, text:`Added <b>${escapeHtml(m.title)}</b> to ${escapeHtml(s.name)}` }));
    s.quizHistory.forEach(q => events.push({ ts:q.date, color:s.color, text:`Scored <b>${q.score}/${q.total}</b> on a ${q.difficulty} quiz in ${escapeHtml(s.name)}`, score:q.score/q.total }));
  });
  events.sort((a,b)=> b.ts - a.ts);
  if(events.length === 0){
    activityBox.innerHTML = `<div class="empty-state"><h3>Nothing yet</h3><p>Upload a material or take a quiz to see activity here.</p></div>`;
  } else {
    activityBox.className = "activity-list";
    activityBox.innerHTML = events.slice(0,8).map(e => `
      <div class="activity-item">
        <span class="dot" style="background:${e.color}"></span>
        <span class="a-text">${e.text}</span>
        ${e.score !== undefined ? `<span class="score-chip ${e.score>=0.8?'score-good':e.score>=0.5?'score-mid':'score-low'}">${Math.round(e.score*100)}%</span>` : ""}
        <span class="a-time">${timeAgo(e.ts)}</span>
      </div>
    `).join("");
  }
}

/* ---------------- Subject page ---------------- */
function renderSubjectPage(){
  const subj = activeSubject();
  const view = document.getElementById("view");
  if(!subj){
    view.innerHTML = `<div class="empty-state"><h3>Subject not found</h3><p>Pick a subject from the sidebar.</p></div>`;
    return;
  }

  view.innerHTML = `
    <div class="subject-header">
      <span class="swatch" style="background:${subj.color}"></span>
      <h1>${escapeHtml(subj.name)}</h1>
      <div class="subject-header-actions">
        <button class="btn btn-outline btn-sm" id="renameSubjectBtn">Rename</button>
        <button class="btn btn-outline btn-sm" id="deleteSubjectBtn" style="color:var(--red);border-color:var(--red-tint)">Delete</button>
      </div>
    </div>

    <div class="tab-row" id="tabRow">
      ${tabButton("materials","Study materials")}
      ${tabButton("summary","AI summary")}
      ${tabButton("reviewer","Reviewer notes")}
      ${tabButton("quiz","Quiz generator")}
      ${tabButton("history","Quiz history")}
    </div>

    <div class="panel ${state.activeTab==='materials'?'active':''}" id="panel-materials"></div>
    <div class="panel ${state.activeTab==='summary'?'active':''}" id="panel-summary"></div>
    <div class="panel ${state.activeTab==='reviewer'?'active':''}" id="panel-reviewer"></div>
    <div class="panel ${state.activeTab==='quiz'?'active':''}" id="panel-quiz"></div>
    <div class="panel ${state.activeTab==='history'?'active':''}" id="panel-history"></div>
  `;

  document.getElementById("renameSubjectBtn").addEventListener("click", () => openSubjectModal("rename", subj.id));
  document.getElementById("deleteSubjectBtn").addEventListener("click", () => openDeleteModal(subj.id));

  document.querySelectorAll("#tabRow .tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      state.activeTab = btn.dataset.tab;
      renderSubjectPage();
    });
  });

  renderMaterialsPanel(subj);
  renderSummaryPanel(subj);
  renderReviewerPanel(subj);
  renderQuizPanel(subj);
  renderHistoryPanel(subj);
}

function tabButton(id, label){
  return `<button class="tab-btn ${state.activeTab===id?'active':''}" data-tab="${id}">${label}</button>`;
}

/* ---- Materials panel ---- */
function renderMaterialsPanel(subj){
  const panel = document.getElementById("panel-materials");
  panel.innerHTML = `
    <div class="upload-zone" id="uploadZone">
      <div class="u-icon">📤</div>
      <h3>Drag & drop files here</h3>
      <p>Supports .txt, .pdf, and .docx — or paste text directly.</p>
      <div class="upload-actions">
        <button class="btn btn-primary btn-sm" id="chooseFileBtn">Choose file</button>
        <button class="btn btn-ghost btn-sm" id="pasteTextBtn">Paste text</button>
      </div>
      <input type="file" id="fileInput" accept=".txt,.pdf,.docx" style="display:none" multiple>
    </div>
    <div class="material-list" id="materialList"></div>
  `;

  const zone = document.getElementById("uploadZone");
  const fileInput = document.getElementById("fileInput");
  document.getElementById("chooseFileBtn").addEventListener("click", () => fileInput.click());
  document.getElementById("pasteTextBtn").addEventListener("click", () => openPasteModal());
  fileInput.addEventListener("change", (e) => handleFiles(e.target.files, subj));

  ["dragenter","dragover"].forEach(evt => zone.addEventListener(evt, (e)=>{
    e.preventDefault(); zone.classList.add("drag-over");
  }));
  ["dragleave","drop"].forEach(evt => zone.addEventListener(evt, (e)=>{
    e.preventDefault(); zone.classList.remove("drag-over");
  }));
  zone.addEventListener("drop", (e) => {
    if(e.dataTransfer.files && e.dataTransfer.files.length){
      handleFiles(e.dataTransfer.files, subj);
    }
  });

  const list = document.getElementById("materialList");
  if(subj.materials.length === 0){
    list.innerHTML = `<div class="empty-state"><h3>No materials yet</h3><p>Upload a file or paste text to get started.</p></div>`;
    return;
  }
  const icons = { text:"📝", txt:"📄", pdf:"📕", docx:"📘" };
  list.innerHTML = subj.materials.map(m => {
    let metaLine;
    if(m.status === "processing"){
      metaLine = `${m.type.toUpperCase()} · extracting text…`;
    } else if(m.status === "error"){
      metaLine = `${m.type.toUpperCase()} · couldn't extract text — try pasting it instead`;
    } else if(m.status === "empty"){
      metaLine = `${m.type.toUpperCase()} · added ${timeAgo(m.addedAt)} · no readable text found (likely a scanned/image file — OCR would be needed, which this app doesn't do)`;
    } else {
      metaLine = `${m.type.toUpperCase()} · added ${timeAgo(m.addedAt)} · ${m.text.length} characters`;
    }
    const warn = (m.status === "error" || m.status === "empty");
    return `
    <div class="material-card">
      <div class="material-card-top">
        <div class="material-icon">${m.status === "processing" ? "⏳" : icons[m.type] || "📄"}</div>
        <div class="material-info">
          <div class="m-name">${escapeHtml(m.title)}</div>
          <div class="m-meta" style="${warn ? 'color:var(--red)':''}">${metaLine}</div>
        </div>
        <button class="icon-btn" data-id="${m.id}" title="Delete material">🗑</button>
      </div>
      <div class="kb-row" id="kb-row-${m.id}">
        ${m.text ? `<div class="kb-status">Checking analysis status…</div>` : ""}
      </div>
    </div>
  `;
  }).join("");
  list.querySelectorAll(".icon-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const removedId = btn.dataset.id;
      subj.materials = subj.materials.filter(m => m.id !== removedId);
      markSummaryStaleOrRegen(subj);
      if(window.KnowledgePipeline) window.KnowledgePipeline.kb.delete(removedId).catch(()=>{});
      delete kbStatusCache[removedId];
      showToast("Material removed.");
      renderAll();
      renderSubjectPage();
    });
  });

  refreshMaterialKbStatuses(subj);
}

/* ---- Analyze Material (knowledge pipeline) ---- */
function kbStatusRowHTML(material, rec){
  if(!material.text) return "";
  const previewBtn = `<button class="btn btn-ghost btn-sm preview-btn" data-id="${material.id}">👁 Preview text</button>`;
  const previewBlock = `<pre class="text-preview" id="preview-${material.id}" style="display:none;">${escapeHtml(material.text.slice(0, 4000))}${material.text.length > 4000 ? "\n\n… (truncated preview, full text is used for analysis)" : ""}</pre>`;

  if(!rec){
    return `<div class="kb-status"><button class="btn btn-outline btn-sm analyze-btn" data-id="${material.id}">🔬 Analyze material</button>${previewBtn}</div>${previewBlock}`;
  }
  if(rec.status === "complete"){
    const sectionCount = new Set((rec.analyses||[]).map(a=>a.section)).size;
    const conceptCount = (rec.analyses||[]).reduce((n,a)=> n + (a.key_concepts||[]).length + (a.definitions||[]).length, 0);
    return `
      <div class="kb-status kb-done">
        <span>✓ Analyzed — ${sectionCount} section(s), ~${conceptCount} concepts</span>
        <button class="btn btn-ghost btn-sm analyze-btn" data-id="${material.id}" data-force="1">Re-analyze</button>
        ${previewBtn}
      </div>${previewBlock}`;
  }
  if(rec.status === "analyzing" || rec.status === "partial"){
    return `
      <div class="kb-status">
        <span>⏸ Partially analyzed (${rec.completedCount}/${rec.totalCount})</span>
        <button class="btn btn-primary btn-sm analyze-btn" data-id="${material.id}">Resume analysis</button>
        ${previewBtn}
      </div>${previewBlock}`;
  }
  return `<div class="kb-status"><button class="btn btn-outline btn-sm analyze-btn" data-id="${material.id}">🔬 Analyze material</button>${previewBtn}</div>${previewBlock}`;
}

function analyzingRowHTML(completed, total, label){
  const pct = total ? Math.round((completed/total)*100) : 0;
  return `
    <div class="kb-status kb-analyzing">
      <div>${escapeHtml(label || "Analyzing…")} — ${completed}/${total}</div>
      <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
    </div>`;
}

function wireAnalyzeButton(subj, material){
  const row = document.getElementById(`kb-row-${material.id}`);
  if(!row) return;
  const btn = row.querySelector(".analyze-btn");
  if(btn) btn.addEventListener("click", () => startAnalyzeMaterial(subj, material, btn.dataset.force === "1"));
  const pbtn = row.querySelector(".preview-btn");
  if(pbtn) pbtn.addEventListener("click", () => {
    const pre = document.getElementById(`preview-${material.id}`);
    if(pre) pre.style.display = pre.style.display === "none" ? "block" : "none";
  });
}

async function refreshMaterialKbStatuses(subj){
  if(!window.KnowledgePipeline) return;
  for(const m of subj.materials){
    if(!m.text) continue;
    try{
      const rec = kbStatusCache[m.id] !== undefined ? kbStatusCache[m.id] : await window.KnowledgePipeline.kb.get(m.id);
      kbStatusCache[m.id] = rec;
      const row = document.getElementById(`kb-row-${m.id}`);
      if(row){
        row.innerHTML = kbStatusRowHTML(m, rec);
        wireAnalyzeButton(subj, m);
      }
    }catch(err){
      console.warn("Could not read knowledge base status for", m.id, err);
    }
  }
}

async function startAnalyzeMaterial(subj, material, forceReanalyze){
  const row = document.getElementById(`kb-row-${material.id}`);
  const useLA = useLocalAI() && window.LocalAI && window.LocalAI.supported;
  if(row) row.innerHTML = analyzingRowHTML(0, 1, "Starting…");

  try{
    const rec = await window.KnowledgePipeline.analyzeMaterial(material, {
      useLocalAI: useLA,
      forceReanalyze: !!forceReanalyze,
      onProgress: (completed, total, label) => {
        const r = document.getElementById(`kb-row-${material.id}`);
        if(r) r.innerHTML = analyzingRowHTML(completed, total, label);
      }
    });
    kbStatusCache[material.id] = rec;
    showToast(rec.status === "complete" ? `Analyzed "${material.title}"` : `Paused — analyzed ${rec.completedCount}/${rec.totalCount} sections`);
  }catch(err){
    console.warn("Analysis failed:", err);
    showToast(`Couldn't analyze "${material.title}".`);
  }

  const r = document.getElementById(`kb-row-${material.id}`);
  if(r){
    r.innerHTML = kbStatusRowHTML(material, kbStatusCache[material.id]);
    wireAnalyzeButton(subj, material);
  }
}

function handleFiles(fileList, subj){
  Array.from(fileList).forEach(file => {
    const ext = file.name.split(".").pop().toLowerCase();
    if(!["txt","pdf","docx"].includes(ext)){
      showToast(`Unsupported file type: ${file.name}`);
      return;
    }
    if(ext === "txt"){
      const reader = new FileReader();
      reader.onload = () => {
        subj.materials.push(makeMaterial(file.name, "txt", String(reader.result)));
        markSummaryStaleOrRegen(subj);
        showToast(`Added "${file.name}"`);
        renderAll(); renderSubjectPage();
      };
      reader.readAsText(file);
      return;
    }

    // PDF / DOCX: show it right away as "processing", then extract real text
    // in the background with pdf.js / mammoth.js and fill it in once done.
    const material = makeMaterial(file.name, ext, "", "processing");
    subj.materials.push(material);
    renderAll(); renderSubjectPage();

    const extractor = ext === "pdf" ? extractPdfText : extractDocxText;
    const libAvailable = ext === "pdf" ? !!window.pdfjsLib : !!window.mammoth;

    if(!libAvailable){
      material.status = "error";
      material.text = "";
      showToast(`Couldn't load the ${ext.toUpperCase()} reader — check your connection and try again.`);
      renderAll(); renderSubjectPage();
      return;
    }

    extractor(file).then(text => {
      material.text = text;
      material.status = text.length > 0 ? "ready" : "empty";
      markSummaryStaleOrRegen(subj);
      showToast(`Extracted text from "${file.name}"`);
      renderAll(); renderSubjectPage();
    }).catch(err => {
      console.warn("Extraction failed:", err);
      material.status = "error";
      showToast(`Couldn't read "${file.name}" — try pasting its text instead.`);
      renderAll(); renderSubjectPage();
    });
  });
}

/* ---- Summary panel ---- */
/* ---- Summary panel (AI-analysis-backed, with legacy fallback) ---- */
let reviewerModeBySubject = {};
const kbStatusCache = {};

function renderSummaryPanel(subj){
  const panel = document.getElementById("panel-summary");
  const corpus = getSubjectCorpus(subj);
  if(!corpus){
    panel.innerHTML = `<div class="empty-state"><h3>Nothing to summarize yet</h3><p>Add a study material with extracted text to generate a summary.</p></div>`;
    return;
  }

  const materialIds = subj.materials.filter(m => m.text).map(m => m.id);
  panel.innerHTML = `<div class="empty-state"><h3>Loading…</h3><p>Checking for analyzed materials.</p></div>`;

  window.KnowledgePipeline.kb.getMany(materialIds).then(records => {
    const analyzed = records.filter(r => r && r.analyses && r.analyses.length);
    if(analyzed.length === 0){
      renderLegacySummaryPanel(subj);
      return;
    }
    const mode = reviewerModeBySubject[subj.id] || "standard";
    const reviewer = window.KnowledgePipeline.buildReviewerFromKB(analyzed, mode);
    renderKBSummary(panel, subj, reviewer, mode);
  }).catch(err => {
    console.warn("Knowledge base unavailable, falling back to quick-scan:", err);
    renderLegacySummaryPanel(subj);
  });
}

function sourceTag(item){
  if(!item || !item.source) return "";
  const s = item.source;
  return `<div class="src-tag">Source: ${escapeHtml(s.material)}${s.section ? " → " + escapeHtml(s.section) : ""}</div>`;
}
function uncertainBadge(item){
  return item && item.uncertain ? `<span class="badge-wrong" style="margin-left:6px;">⚠ uncertain</span>` : "";
}

function renderKBSummary(panel, subj, reviewer, mode){
  const modes = [
    ["quick","Quick"], ["standard","Standard"], ["detailed","Detailed"], ["examCram","Exam Cram"]
  ];
  panel.innerHTML = `
    <div class="notice-banner">
      <span>⚡ Built from your analyzed materials' knowledge base — no re-processing needed.</span>
    </div>
    <div class="segmented" style="max-width:480px;margin-bottom:18px;">
      ${modes.map(([id,label]) => `<button class="seg-btn ${mode===id?'active':''}" data-mode="${id}">${label}</button>`).join("")}
    </div>
    <div class="ai-grid">
      <div class="ai-card" style="grid-column:1/-1;">
        <h3><span class="tag-icon" style="background:var(--teal-tint);color:var(--teal-dark)">📄</span>Overview</h3>
        <p>${escapeHtml(reviewer.overview)}</p>
      </div>
      ${reviewer.keyConcepts.length ? `
      <div class="ai-card">
        <h3><span class="tag-icon" style="background:var(--teal-tint);color:var(--teal-dark)">#</span>Key concepts</h3>
        <div>${reviewer.keyConcepts.map(c => `<span class="keyword-chip">${escapeHtml(capitalize(c.text))}${uncertainBadge(c)}</span>`).join("")}</div>
      </div>` : ""}
      ${reviewer.definitions.length ? `
      <div class="ai-card">
        <h3><span class="tag-icon" style="background:var(--amber-tint);color:var(--amber-dark)">Aa</span>Definitions</h3>
        ${reviewer.definitions.map(d => `<div class="def-item"><b>${escapeHtml(d.term)}:</b> ${escapeHtml(d.text)}${uncertainBadge(d)}${sourceTag(d)}</div>`).join("")}
      </div>` : ""}
      ${reviewer.importantFacts.length ? `
      <div class="ai-card">
        <h3><span class="tag-icon" style="background:var(--teal-tint);color:var(--teal-dark)">★</span>Important facts</h3>
        <ul>${reviewer.importantFacts.map(f => `<li>${escapeHtml(f.text)}${uncertainBadge(f)}${sourceTag(f)}</li>`).join("")}</ul>
      </div>` : ""}
      ${reviewer.examples.length ? `
      <div class="ai-card">
        <h3><span class="tag-icon" style="background:var(--amber-tint);color:var(--amber-dark)">💡</span>Examples</h3>
        <ul>${reviewer.examples.map(e => `<li>${escapeHtml(e.text)}${sourceTag(e)}</li>`).join("")}</ul>
      </div>` : ""}
      ${reviewer.comparisons.length ? `
      <div class="ai-card">
        <h3><span class="tag-icon" style="background:var(--teal-tint);color:var(--teal-dark)">⇄</span>Comparisons</h3>
        <ul>${reviewer.comparisons.map(c => `<li>${escapeHtml(c.text)}${sourceTag(c)}</li>`).join("")}</ul>
      </div>` : ""}
      ${reviewer.processes.length ? `
      <div class="ai-card">
        <h3><span class="tag-icon" style="background:var(--amber-tint);color:var(--amber-dark)">▶</span>Processes</h3>
        <ol>${reviewer.processes.map(p => `<li>${escapeHtml(p.text)}${sourceTag(p)}</li>`).join("")}</ol>
      </div>` : ""}
      ${reviewer.quickReview.length ? `
      <div class="ai-card" style="grid-column:1/-1;">
        <h3><span class="tag-icon" style="background:var(--teal-tint);color:var(--teal-dark)">✓</span>Quick review — must remember</h3>
        <ul>${reviewer.quickReview.map(q => `<li>${escapeHtml(q.text)}${uncertainBadge(q)}</li>`).join("")}</ul>
      </div>` : ""}
    </div>
  `;
  panel.querySelectorAll(".seg-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      reviewerModeBySubject[subj.id] = btn.dataset.mode;
      renderSummaryPanel(subj);
    });
  });
}

function renderLegacySummaryPanel(subj){
  const panel = document.getElementById("panel-summary");
  const data = subj.aiSummary;
  if(!data){
    panel.innerHTML = `
      <div class="empty-state">
        <h3>No summary yet</h3>
        <p>For best results, analyze this subject's materials from the Study materials tab first. Or generate a quick summary right away:</p>
        <button class="btn btn-primary" id="genSummaryBtn">Generate quick summary</button>
      </div>`;
    document.getElementById("genSummaryBtn").addEventListener("click", () => triggerSummaryGeneration(subj));
    return;
  }

  const sourceLabel = data.source === "local-ai" ? "⚡ Generated with on-device AI" : "🔎 Generated with quick-scan (no AI)";
  const staleNote = data.stale ? " — new material added since this was generated" : "";
  panel.innerHTML = `
    <div class="notice-banner" style="${data.stale ? 'background:var(--red-tint);border-color:#EFC6BB;color:var(--red);':''}">
      <span>${sourceLabel}${staleNote} · Tip: analyze materials in the Study materials tab for deeper, source-linked results.</span>
      <button class="btn btn-ghost btn-sm" id="regenSummaryBtn" style="margin-left:auto;">Regenerate</button>
    </div>
    <div class="ai-grid">
      <div class="ai-card">
        <h3><span class="tag-icon" style="background:var(--teal-tint);color:var(--teal-dark)">📄</span>Simple summary</h3>
        <p>${escapeHtml(data.simple)}</p>
      </div>
      <div class="ai-card">
        <h3><span class="tag-icon" style="background:var(--amber-tint);color:var(--amber-dark)">★</span>Key points</h3>
        <ul>${data.keyPoints.map(k => `<li>${escapeHtml(k)}</li>`).join("")}</ul>
      </div>
      <div class="ai-card">
        <h3><span class="tag-icon" style="background:var(--teal-tint);color:var(--teal-dark)">#</span>Important keywords</h3>
        <div>${data.keywords.map(k => `<span class="keyword-chip">${escapeHtml(capitalize(k))}</span>`).join("")}</div>
      </div>
      <div class="ai-card">
        <h3><span class="tag-icon" style="background:var(--amber-tint);color:var(--amber-dark)">Aa</span>Definitions</h3>
        ${data.definitions.map(d => `<div class="def-item"><b>${escapeHtml(d.term)}:</b> ${escapeHtml(d.def)}</div>`).join("")}
      </div>
    </div>
  `;
  document.getElementById("regenSummaryBtn").addEventListener("click", () => triggerSummaryGeneration(subj));
}

/* ---- Reviewer panel (long-form, AI-analysis-backed with legacy fallback) ---- */
function renderReviewerPanel(subj){
  const panel = document.getElementById("panel-reviewer");
  const corpus = getSubjectCorpus(subj);
  if(!corpus){
    panel.innerHTML = `<div class="empty-state"><h3>No reviewer notes yet</h3><p>Add study materials first so notes can be generated.</p></div>`;
    return;
  }

  const materialIds = subj.materials.filter(m => m.text).map(m => m.id);
  panel.innerHTML = `<div class="empty-state"><h3>Loading…</h3><p>Checking for analyzed materials.</p></div>`;

  window.KnowledgePipeline.kb.getMany(materialIds).then(records => {
    const analyzed = records.filter(r => r && r.analyses && r.analyses.length);
    if(analyzed.length === 0){
      renderLegacyReviewerPanel(subj);
      return;
    }
    const mode = reviewerModeBySubject[subj.id] || "standard";
    const reviewer = window.KnowledgePipeline.buildReviewerFromKB(analyzed, mode);
    const lines = [];
    reviewer.mainTopics.forEach(t => {
      lines.push(`■ ${t.section} (${t.material})`);
      t.concepts.forEach(c => lines.push(`   • ${capitalize(c)}`));
    });
    if(reviewer.processes.length){
      lines.push("", "Processes:");
      reviewer.processes.forEach((p,i) => lines.push(`  ${i+1}. ${p.text}`));
    }
    lines.push("", "Quick review:");
    reviewer.quickReview.forEach((q,i) => lines.push(`  ${i+1}. ${q.text}${q.uncertain ? " (uncertain)" : ""}`));

    panel.innerHTML = `
      <div class="ai-card" style="max-width:720px">
        <h3><span class="tag-icon" style="background:var(--teal-tint);color:var(--teal-dark)">📚</span>Study reviewer — ${mode}</h3>
        <p style="white-space:pre-line">${escapeHtml(lines.join("\n"))}</p>
      </div>
    `;
  }).catch(err => {
    console.warn("Knowledge base unavailable, falling back to quick-scan:", err);
    renderLegacyReviewerPanel(subj);
  });
}

function renderLegacyReviewerPanel(subj){
  const panel = document.getElementById("panel-reviewer");
  const data = subj.aiSummary;
  if(!data){
    panel.innerHTML = `
      <div class="empty-state">
        <h3>No reviewer notes yet</h3>
        <p>Generate a summary first — reviewer notes come from the same pass.</p>
        <button class="btn btn-primary" id="genReviewerBtn">Generate now</button>
      </div>`;
    document.getElementById("genReviewerBtn").addEventListener("click", () => triggerSummaryGeneration(subj));
    return;
  }
  panel.innerHTML = `
    <div class="ai-card" style="max-width:720px">
      <h3><span class="tag-icon" style="background:var(--teal-tint);color:var(--teal-dark)">📚</span>Study reviewer</h3>
      <p style="white-space:pre-line">${escapeHtml(data.reviewer)}</p>
    </div>
  `;
}

/* ---- Quiz panel ---- */
function renderQuizPanel(subj){
  const panel = document.getElementById("panel-quiz");

  if(state.currentQuiz && state.currentQuiz.subjectId === subj.id && !state.currentQuiz.finished){
    renderQuizInProgress(panel, subj);
    return;
  }
  if(state.currentQuiz && state.currentQuiz.subjectId === subj.id && state.currentQuiz.finished){
    renderQuizResults(panel, subj);
    return;
  }

  panel.innerHTML = `
    <div class="quiz-launch">
      <h3>Ready to test yourself on ${escapeHtml(subj.name)}?</h3>
      <p>Pick how many questions and how hard you want it, and we'll build a quiz from your materials.</p>
      <button class="btn btn-primary" id="startQuizBtn">Generate quiz</button>
    </div>
  `;
  document.getElementById("startQuizBtn").addEventListener("click", openQuizSetupModal);
}

function renderQuizInProgress(panel, subj){
  const quiz = state.currentQuiz;
  const total = quiz.questions.length;
  const idx = quiz.currentIndex;
  const q = quiz.questions[idx];
  const answered = quiz.answers[idx] !== undefined;
  const progressPct = Math.round(((idx) / total) * 100);

  panel.innerHTML = `
    <div class="quiz-box">
      <div class="quiz-top">
        <div class="progress-track" style="flex:1"><div class="progress-fill" style="width:${progressPct}%"></div></div>
        <div class="q-count">Question ${idx+1} of ${total}</div>
      </div>
      <div class="quiz-question">${escapeHtml(q.question)}</div>
      <div class="choice-list" id="choiceList">
        ${q.options.map((opt,i) => `
          <button class="choice-item ${quiz.answers[idx]===i ? 'selected':''}" data-i="${i}">
            <span class="choice-letter">${String.fromCharCode(65+i)}</span>
            <span>${escapeHtml(opt)}</span>
          </button>
        `).join("")}
      </div>
      <div class="quiz-nav">
        <button class="btn btn-ghost btn-sm" id="prevQBtn" ${idx===0?'disabled':''}>← Previous</button>
        <div class="quiz-dots">
          ${quiz.questions.map((_,i) => `<button class="q-dot ${quiz.answers[i]!==undefined?'answered':''} ${i===idx?'current':''}" data-i="${i}"></button>`).join("")}
        </div>
        ${idx === total-1
          ? `<button class="btn btn-primary btn-sm" id="submitQuizBtn">Submit quiz</button>`
          : `<button class="btn btn-primary btn-sm" id="nextQBtn">Next →</button>`}
      </div>
    </div>
  `;

  panel.querySelectorAll(".choice-item").forEach(btn => {
    btn.addEventListener("click", () => {
      quiz.answers[idx] = parseInt(btn.dataset.i, 10);
      renderQuizInProgress(panel, subj);
    });
  });
  panel.querySelectorAll(".q-dot").forEach(dot => {
    dot.addEventListener("click", () => {
      quiz.currentIndex = parseInt(dot.dataset.i, 10);
      renderQuizInProgress(panel, subj);
    });
  });
  const prevBtn = document.getElementById("prevQBtn");
  if(prevBtn) prevBtn.addEventListener("click", () => { quiz.currentIndex--; renderQuizInProgress(panel, subj); });
  const nextBtn = document.getElementById("nextQBtn");
  if(nextBtn) nextBtn.addEventListener("click", () => { quiz.currentIndex++; renderQuizInProgress(panel, subj); });
  const submitBtn = document.getElementById("submitQuizBtn");
  if(submitBtn) submitBtn.addEventListener("click", () => submitQuiz(subj));
}

function submitQuiz(subj){
  const quiz = state.currentQuiz;
  let score = 0;
  quiz.questions.forEach((q,i) => {
    if(quiz.answers[i] === q.correctIndex) score++;
  });
  quiz.finished = true;
  quiz.score = score;

  subj.quizHistory.unshift({
    id: uid(),
    date: Date.now(),
    difficulty: quiz.difficulty,
    total: quiz.questions.length,
    score: score,
    questions: quiz.questions.map((q,i) => ({
      question: q.question, options: q.options, correctIndex: q.correctIndex,
      explanation: q.explanation, chosenIndex: quiz.answers[i]
    }))
  });

  renderAll();
  renderSubjectPage();
}

function renderQuizResults(panel, subj){
  const quiz = state.currentQuiz;
  const total = quiz.questions.length;
  const pct = Math.round((quiz.score/total)*100);
  const tier = pct >= 80 ? "" : pct >= 50 ? "mid" : "low";

  panel.innerHTML = `
    <div class="result-hero">
      <div class="result-score ${tier}">${quiz.score}/${total}</div>
      <p>${pct}% correct on this ${quiz.difficulty} quiz</p>
      <div class="result-actions">
        <button class="btn btn-outline" id="retryQuizBtn">Retry this quiz</button>
        <button class="btn btn-primary" id="newQuizBtn">Generate new quiz</button>
      </div>
    </div>
    <div id="reviewList"></div>
  `;

  const reviewList = document.getElementById("reviewList");
  reviewList.innerHTML = quiz.questions.map((q,i) => {
    const chosen = quiz.answers[i];
    const correct = chosen === q.correctIndex;
    return `
      <div class="review-item">
        <div class="r-q">${escapeHtml(q.question)} <span class="${correct?'badge-correct':'badge-wrong'}">${correct ? "Correct" : "Incorrect"}</span></div>
        ${chosen !== undefined ? `<div class="r-line ${correct?'ok':'bad'}">Your answer: ${escapeHtml(q.options[chosen])}</div>` : `<div class="r-line bad">You didn't answer this one.</div>`}
        ${!correct ? `<div class="r-line ok">Correct answer: ${escapeHtml(q.options[q.correctIndex])}</div>` : ""}
        <div class="r-explain">${escapeHtml(q.explanation)}</div>
      </div>
    `;
  }).join("");

  document.getElementById("retryQuizBtn").addEventListener("click", () => {
    state.currentQuiz = {
      subjectId: subj.id, difficulty: quiz.difficulty,
      questions: quiz.questions, answers: {}, currentIndex: 0, finished: false
    };
    renderSubjectPage();
  });
  document.getElementById("newQuizBtn").addEventListener("click", () => {
    state.currentQuiz = null;
    renderSubjectPage();
  });
}

/* ---- History panel ---- */
function renderHistoryPanel(subj){
  const panel = document.getElementById("panel-history");
  if(subj.quizHistory.length === 0){
    panel.innerHTML = `<div class="empty-state"><h3>No quiz history yet</h3><p>Generate and complete a quiz to see your scores here.</p></div>`;
    return;
  }
  panel.innerHTML = `
    <table class="history-table">
      <thead><tr><th>Date</th><th>Difficulty</th><th>Score</th><th>Percentage</th></tr></thead>
      <tbody>
        ${subj.quizHistory.map(q => {
          const pct = Math.round((q.score/q.total)*100);
          return `<tr>
            <td>${fmtDate(q.date)}</td>
            <td style="text-transform:capitalize">${q.difficulty}</td>
            <td>${q.score}/${q.total}</td>
            <td><span class="score-chip ${pct>=80?'score-good':pct>=50?'score-mid':'score-low'}">${pct}%</span></td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>
  `;
}

/* ============================================================
   MODALS
   ============================================================ */
let subjectModalMode = "create";
let subjectModalTargetId = null;

function openSubjectModal(mode, subjectId){
  subjectModalMode = mode;
  subjectModalTargetId = subjectId || null;
  const overlay = document.getElementById("subjectModalOverlay");
  const title = document.getElementById("subjectModalTitle");
  const input = document.getElementById("subjectNameInput");
  const confirmBtn = document.getElementById("subjectModalConfirm");

  if(mode === "create"){
    title.textContent = "Create subject";
    confirmBtn.textContent = "Create";
    input.value = "";
  } else {
    title.textContent = "Rename subject";
    confirmBtn.textContent = "Save changes";
    input.value = getSubject(subjectId).name;
  }
  overlay.classList.add("open");
  setTimeout(() => input.focus(), 50);
}

function closeSubjectModal(){
  document.getElementById("subjectModalOverlay").classList.remove("open");
}

function openDeleteModal(subjectId){
  pendingDeleteId = subjectId;
  const subj = getSubject(subjectId);
  document.getElementById("deleteModalText").textContent =
    `This removes "${subj.name}" along with all its materials, summaries, and quiz history. This can't be undone.`;
  document.getElementById("deleteModalOverlay").classList.add("open");
}
function closeDeleteModal(){
  document.getElementById("deleteModalOverlay").classList.remove("open");
  pendingDeleteId = null;
}

/* ---------------- Backup / restore ---------------- */
async function exportBackup(){
  showToast("Preparing backup…");
  let kbRecords = [];
  try{
    if(window.KnowledgePipeline) kbRecords = await window.KnowledgePipeline.kb.exportAll();
  }catch(err){
    console.warn("Could not export knowledge base:", err);
  }

  const payload = {
    app: "studydesk",
    backupVersion: 2,   // v1 = subjects only; v2 adds the analyzed knowledge base
    exportedAt: Date.now(),
    subjects: state.subjects,
    activeSubjectId: state.activeSubjectId,
    useLocalAI: useLocalAI(),
    knowledgeBase: kbRecords   // does NOT include the AI model itself, just extracted concepts
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0,10);
  const a = document.createElement("a");
  a.href = url;
  a.download = `studydesk-backup-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast("Backup downloaded.");
}

function importBackupFile(file){
  const reader = new FileReader();
  reader.onload = async () => {
    let parsed;
    try{
      parsed = JSON.parse(String(reader.result));
    }catch(err){
      showToast("That file isn't valid JSON.");
      return;
    }
    if(!parsed || !Array.isArray(parsed.subjects)){
      showToast("That file doesn't look like a Studydesk backup.");
      return;
    }
    const kbNote = Array.isArray(parsed.knowledgeBase) && parsed.knowledgeBase.length
      ? ` and ${parsed.knowledgeBase.length} analyzed material(s)` : "";
    const ok = confirm(
      `This will replace everything currently saved with ${parsed.subjects.length} subject(s)${kbNote} from the backup. This can't be undone. Continue?`
    );
    if(!ok) return;

    state.subjects = parsed.subjects;
    state.subjects.forEach(s => {
      if(s.aiSummary === undefined) s.aiSummary = null;
      (s.materials || []).forEach(m => { if(m.status === undefined) m.status = "ready"; });
    });
    state.activeSubjectId = parsed.activeSubjectId || (state.subjects[0] && state.subjects[0].id) || null;
    state.activePage = "dashboard";
    if(typeof parsed.useLocalAI === "boolean") setUseLocalAI(parsed.useLocalAI);

    // v1 backups have no knowledgeBase field — nothing to restore, old behavior preserved.
    if(Array.isArray(parsed.knowledgeBase) && window.KnowledgePipeline){
      try{
        await window.KnowledgePipeline.kb.importAll(parsed.knowledgeBase);
        Object.keys(kbStatusCache).forEach(k => delete kbStatusCache[k]);
      }catch(err){
        console.warn("Could not restore knowledge base:", err);
        showToast("Subjects restored, but the analyzed knowledge base couldn't be restored.");
      }
    }

    document.getElementById("backupModalOverlay").classList.remove("open");
    showToast("Backup restored.");
    renderAll();
  };
  reader.readAsText(file);
}

function openPasteModal(){
  document.getElementById("pasteTitleInput").value = "";
  document.getElementById("pasteTextInput").value = "";
  document.getElementById("pasteModalOverlay").classList.add("open");
  setTimeout(()=> document.getElementById("pasteTitleInput").focus(), 50);
}
function closePasteModal(){
  document.getElementById("pasteModalOverlay").classList.remove("open");
}

let quizSetupDifficulty = "medium";
function openQuizSetupModal(){
  quizSetupDifficulty = "medium";
  document.querySelectorAll("#difficultySeg .seg-btn").forEach(b => b.classList.toggle("active", b.dataset.diff==="medium"));
  document.getElementById("quizCountInput").value = 5;
  document.getElementById("quizCountValue").textContent = 5;

  const subj = activeSubject();
  const corpus = subj ? getSubjectCorpus(subj) : "";
  const notice = document.getElementById("quizCorpusNotice");
  notice.style.display = "block";
  notice.style.color = "var(--ink-soft)";
  notice.textContent = "Checking your analyzed materials…";

  const materialIds = subj ? subj.materials.filter(m => m.text).map(m => m.id) : [];
  const kbCheck = window.KnowledgePipeline ? window.KnowledgePipeline.kb.getMany(materialIds) : Promise.resolve([]);

  kbCheck.then(records => {
    const analyzed = records.filter(r => r && r.analyses && r.analyses.length);
    const definitionCount = analyzed.flatMap(r => r.analyses).reduce((n,a)=>n+(a.definitions||[]).length, 0);
    if(analyzed.length && definitionCount >= 2){
      notice.style.color = "var(--teal-dark)";
      notice.textContent = `Drawing from your analyzed knowledge base — ${definitionCount} extracted terms available.`;
    } else if(corpus.trim().length < 40){
      notice.style.color = "var(--amber-dark)";
      notice.textContent = "No usable material text found yet, so this quiz will use general study-skill questions instead of ones from your notes. Add a .txt file, pasted text, or a PDF/DOCX with readable text — or analyze it in the Study materials tab — to get subject-specific questions.";
    } else {
      const words = corpus.trim().split(/\s+/).length;
      notice.textContent = `Drawing from about ${words} words of material. Tip: analyzing this material first (Study materials tab) gives more accurate, source-linked questions.`;
    }
  }).catch(() => {
    notice.textContent = corpus.trim().length >= 40 ? "Drawing from your uploaded material." : "No usable material text found yet — this quiz will use general study-skill questions.";
  });

  document.getElementById("quizSetupOverlay").classList.add("open");
}
function closeQuizSetupModal(){
  document.getElementById("quizSetupOverlay").classList.remove("open");
}

/* ============================================================
   EVENT WIRING (runs once)
   ============================================================ */
function wireGlobalEvents(){
  document.getElementById("navDashboard").addEventListener("click", () => {
    state.activePage = "dashboard";
    closeMobileSidebar();
    renderAll();
  });

  document.getElementById("openCreateSubject").addEventListener("click", () => openSubjectModal("create"));

  // Subject modal
  document.getElementById("subjectModalCancel").addEventListener("click", closeSubjectModal);
  document.getElementById("subjectModalOverlay").addEventListener("click", (e) => {
    if(e.target.id === "subjectModalOverlay") closeSubjectModal();
  });
  document.getElementById("subjectModalConfirm").addEventListener("click", () => {
    const name = document.getElementById("subjectNameInput").value.trim();
    if(!name){ showToast("Give the subject a name first."); return; }
    if(subjectModalMode === "create"){
      const subj = makeSubject(name);
      state.subjects.push(subj);
      state.activeSubjectId = subj.id;
      state.activePage = "subject";
      state.activeTab = "materials";
      showToast(`Created "${name}"`);
    } else {
      const subj = getSubject(subjectModalTargetId);
      subj.name = name;
      showToast("Subject renamed.");
    }
    closeSubjectModal();
    renderAll();
  });
  document.getElementById("subjectNameInput").addEventListener("keydown", (e) => {
    if(e.key === "Enter") document.getElementById("subjectModalConfirm").click();
  });

  // Delete modal
  document.getElementById("deleteModalCancel").addEventListener("click", closeDeleteModal);
  document.getElementById("deleteModalOverlay").addEventListener("click", (e) => {
    if(e.target.id === "deleteModalOverlay") closeDeleteModal();
  });
  document.getElementById("deleteModalConfirm").addEventListener("click", () => {
    const wasActive = state.activeSubjectId === pendingDeleteId;
    state.subjects = state.subjects.filter(s => s.id !== pendingDeleteId);
    if(wasActive){
      state.activeSubjectId = state.subjects[0] ? state.subjects[0].id : null;
      state.activePage = "dashboard";
    }
    showToast("Subject deleted.");
    closeDeleteModal();
    renderAll();
  });

  // Paste modal
  document.getElementById("pasteModalCancel").addEventListener("click", closePasteModal);
  document.getElementById("pasteModalOverlay").addEventListener("click", (e) => {
    if(e.target.id === "pasteModalOverlay") closePasteModal();
  });
  document.getElementById("pasteModalConfirm").addEventListener("click", () => {
    const title = document.getElementById("pasteTitleInput").value.trim() || "Pasted notes";
    const text = document.getElementById("pasteTextInput").value.trim();
    if(!text){ showToast("Paste some text first."); return; }
    const subj = activeSubject();
    subj.materials.push(makeMaterial(title, "text", text));
    markSummaryStaleOrRegen(subj);
    showToast("Material added.");
    closePasteModal();
    renderAll();
    renderSubjectPage();
  });

  // Quiz setup modal
  document.getElementById("quizCountInput").addEventListener("input", (e) => {
    document.getElementById("quizCountValue").textContent = e.target.value;
  });
  document.querySelectorAll("#difficultySeg .seg-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#difficultySeg .seg-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      quizSetupDifficulty = btn.dataset.diff;
    });
  });
  document.getElementById("quizSetupCancel").addEventListener("click", closeQuizSetupModal);
  document.getElementById("quizSetupOverlay").addEventListener("click", (e) => {
    if(e.target.id === "quizSetupOverlay") closeQuizSetupModal();
  });
  document.getElementById("quizSetupConfirm").addEventListener("click", async () => {
    const subj = activeSubject();
    const count = parseInt(document.getElementById("quizCountInput").value, 10);
    const difficulty = quizSetupDifficulty;
    const confirmBtn = document.getElementById("quizSetupConfirm");
    const cancelBtn = document.getElementById("quizSetupCancel");
    const originalLabel = confirmBtn.textContent;

    confirmBtn.disabled = true;
    cancelBtn.disabled = true;
    confirmBtn.textContent = "Generating…";

    const questions = await buildQuizQuestions(subj, count, difficulty);

    confirmBtn.disabled = false;
    cancelBtn.disabled = false;
    confirmBtn.textContent = originalLabel;

    state.currentQuiz = {
      subjectId: subj.id, difficulty,
      questions, answers: {}, currentIndex: 0, finished: false
    };
    closeQuizSetupModal();
    renderSubjectPage();
  });

  // Mobile sidebar
  document.getElementById("menuBtn").addEventListener("click", openMobileSidebar);
  document.getElementById("sidebarClose").addEventListener("click", closeMobileSidebar);
  document.getElementById("sidebarScrim").addEventListener("click", closeMobileSidebar);

  // Local AI modal
  document.getElementById("openLocalAIModal").addEventListener("click", () => {
    refreshLocalAIModalUI();
    document.getElementById("localAIModalOverlay").classList.add("open");
  });
  document.getElementById("localAIModalClose").addEventListener("click", () => {
    document.getElementById("localAIModalOverlay").classList.remove("open");
  });
  document.getElementById("localAIModalOverlay").addEventListener("click", (e) => {
    if(e.target.id === "localAIModalOverlay") document.getElementById("localAIModalOverlay").classList.remove("open");
  });
  document.getElementById("useLocalAIToggle").addEventListener("change", (e) => {
    setUseLocalAI(e.target.checked);
  });
  document.getElementById("localAIEnableBtn").addEventListener("click", async () => {
    if(!window.LocalAI || !window.LocalAI.supported) return;
    refreshLocalAIModalUI();
    try{
      await window.LocalAI.enable();
      setUseLocalAI(true);
      showToast("On-device AI is ready.");
    }catch(err){
      console.warn("Could not enable local AI:", err);
      showToast("Couldn't enable on-device AI on this device.");
    }
    refreshLocalAIModalUI();
  });
  if(window.LocalAI){
    window.LocalAI.onProgress(() => refreshLocalAIModalUI());
  }

  // Backup & restore modal
  document.getElementById("openBackupModal").addEventListener("click", () => {
    document.getElementById("backupModalOverlay").classList.add("open");
  });
  document.getElementById("backupModalClose").addEventListener("click", () => {
    document.getElementById("backupModalOverlay").classList.remove("open");
  });
  document.getElementById("backupModalOverlay").addEventListener("click", (e) => {
    if(e.target.id === "backupModalOverlay") document.getElementById("backupModalOverlay").classList.remove("open");
  });
  document.getElementById("exportBackupBtn").addEventListener("click", exportBackup);
  document.getElementById("importBackupBtn").addEventListener("click", () => {
    document.getElementById("importBackupInput").click();
  });
  document.getElementById("importBackupInput").addEventListener("change", (e) => {
    if(e.target.files && e.target.files[0]) importBackupFile(e.target.files[0]);
    e.target.value = "";
  });
}

function refreshLocalAIModalUI(){
  const statusText = document.getElementById("localAIStatusText");
  const progressWrap = document.getElementById("localAIProgressWrap");
  const progressFill = document.getElementById("localAIProgressFill");
  const enableBtn = document.getElementById("localAIEnableBtn");
  const toggle = document.getElementById("useLocalAIToggle");
  const LA = window.LocalAI;

  if(!LA || !LA.supported){
    statusText.textContent = "Your browser doesn't support WebGPU, so on-device AI isn't available here. Try a recent Chrome or Edge on desktop, or Chrome on a newer Android phone.";
    enableBtn.disabled = true;
    toggle.disabled = true;
    toggle.checked = false;
    progressWrap.style.display = "none";
    return;
  }

  toggle.checked = useLocalAI();
  toggle.disabled = LA.status !== "ready";

  if(LA.status === "idle"){
    statusText.textContent = `Runs a small language model (${LA.modelId}) entirely on this device — no server, no account. First-time setup downloads roughly 700MB–1GB, cached afterward so it works fully offline from then on.`;
    enableBtn.disabled = false;
    enableBtn.textContent = "Download & enable";
    progressWrap.style.display = "none";
  } else if(LA.status === "loading"){
    statusText.textContent = LA.progressText || "Downloading model…";
    enableBtn.disabled = true;
    enableBtn.textContent = "Downloading…";
    progressWrap.style.display = "block";
    progressFill.style.width = LA.progress + "%";
  } else if(LA.status === "ready"){
    statusText.textContent = "Ready — runs fully on this device and works offline from now on.";
    enableBtn.disabled = true;
    enableBtn.textContent = "Enabled";
    progressWrap.style.display = "none";
  } else if(LA.status === "error"){
    statusText.textContent = "Couldn't start the on-device model. Your device or browser may not have enough GPU memory, or the download was interrupted.";
    enableBtn.disabled = false;
    enableBtn.textContent = "Try again";
    progressWrap.style.display = "none";
  }
}

function openMobileSidebar(){
  document.getElementById("sidebar").classList.add("open");
  document.getElementById("sidebarScrim").classList.add("show");
}
function closeMobileSidebar(){
  document.getElementById("sidebar").classList.remove("open");
  document.getElementById("sidebarScrim").classList.remove("show");
}

/* ============================================================
   INIT
   ============================================================ */
function init(){
  loadState();
  if(!state.activeSubjectId && state.subjects.length){
    state.activeSubjectId = state.subjects[0].id;
  }
  state.activePage = state.subjects.length ? "dashboard" : "dashboard";
  wireGlobalEvents();
  renderAll();
}

document.addEventListener("DOMContentLoaded", init);
