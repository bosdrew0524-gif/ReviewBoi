/* ============================================================
   Studydesk — on-device AI (local-ai.js)
   Runs a small language model entirely in the browser via WebGPU,
   using WebLLM (https://github.com/mlc-ai/web-llm). No server,
   no API key. First use downloads the model; after that it's
   cached and works fully offline.

   Exposes window.LocalAI — script.js calls into this and always
   has a mock fallback if this fails or is unavailable.
   ============================================================ */

const MODEL_ID = "Llama-3.2-1B-Instruct-q4f16_1-MLC";

let engine = null;
let engineLoadPromise = null;
const progressListeners = [];

function supportsWebGPU(){
  return typeof navigator !== "undefined" && "gpu" in navigator;
}

function notifyProgress(){
  progressListeners.forEach(fn => {
    try{ fn(window.LocalAI.progress, window.LocalAI.progressText); }
    catch(e){ /* ignore listener errors */ }
  });
}

async function ensureEngine(){
  if(engine) return engine;
  if(engineLoadPromise) return engineLoadPromise;

  window.LocalAI.status = "loading";
  window.LocalAI.progress = 0;

  engineLoadPromise = (async () => {
    const webllm = await import("https://esm.run/@mlc-ai/web-llm");
    const newEngine = await webllm.CreateMLCEngine(MODEL_ID, {
      initProgressCallback: (report) => {
        window.LocalAI.status = "loading";
        window.LocalAI.progress = Math.round((report.progress || 0) * 100);
        window.LocalAI.progressText = report.text || "Downloading model…";
        notifyProgress();
      }
    });
    engine = newEngine;
    window.LocalAI.status = "ready";
    window.LocalAI.progress = 100;
    notifyProgress();
    return engine;
  })();

  try{
    return await engineLoadPromise;
  } catch(err){
    engineLoadPromise = null;
    window.LocalAI.status = "error";
    notifyProgress();
    throw err;
  }
}

// Pulls the first valid JSON value out of a model response, tolerating
// markdown code fences or stray commentary around it.
function extractJson(raw){
  if(!raw) return null;
  let text = raw.replace(/```json/gi, "```").replace(/```/g, "").trim();
  const openers = ["{","["].map(ch => text.indexOf(ch)).filter(i => i !== -1);
  if(!openers.length) return null;
  const start = Math.min(...openers);
  const closers = ["}","]"].map(ch => text.lastIndexOf(ch)).filter(i => i !== -1);
  if(!closers.length) return null;
  const end = Math.max(...closers);
  const slice = text.slice(start, end + 1);
  try{ return JSON.parse(slice); } catch(e){ return null; }
}

async function chat(promptText, maxTokens){
  const eng = await ensureEngine();
  const res = await eng.chat.completions.create({
    messages: [{ role: "user", content: promptText }],
    temperature: 0.4,
    max_tokens: maxTokens || 900
  });
  return res.choices[0].message.content;
}

// Chat + JSON parse, with up to `retries` repair attempts if the model's
// output doesn't parse — asks the model to fix its own broken JSON instead
// of giving up, so a single malformed response doesn't kill the pipeline.
async function chatJSON(promptText, maxTokens, retries){
  retries = retries === undefined ? 2 : retries;
  let raw = await chat(promptText, maxTokens);
  let parsed = extractJson(raw);
  let attempt = 0;
  while(!parsed && attempt < retries){
    attempt++;
    const repairPrompt = `This was supposed to be valid JSON but didn't parse. Return ONLY corrected, valid JSON — no prose, no markdown fences:\n\n${raw}`;
    raw = await chat(repairPrompt, maxTokens);
    parsed = extractJson(raw);
  }
  return parsed;
}

// Structured per-chunk analysis: extracts facts/definitions/etc as JSON
// instead of writing prose directly. This is what the knowledge pipeline
// (knowledge-pipeline.js) calls once per chunk.
async function analyzeChunk({ materialTitle, section, text }){
  const prompt = `You are analyzing study material titled "${materialTitle}"${section ? `, section "${section}"` : ""}. ` +
`Read the text below and extract structured information as STRICT JSON only (no prose, no markdown ` +
`fences), in exactly this shape:
{"topic":"the main topic of this section","key_concepts":["concept 1","concept 2"],"definitions":[{"term":"Term","def":"one clear sentence"}],"important_facts":["fact 1"],"examples":["example 1"],"relationships":["a cause/effect or comparison statement"],"possible_questions":["a possible exam question"]}

Only include information actually present in the text below — do not invent anything. If you're not ` +
`confident something is really stated in the text, prefix that item's text with "UNCERTAIN:".

TEXT:
"""${text.slice(0, 3000)}"""`;

  const parsed = await chatJSON(prompt, 700, 2);
  if(!parsed || typeof parsed !== "object") return null;

  return {
    topic: typeof parsed.topic === "string" ? parsed.topic : "",
    key_concepts: Array.isArray(parsed.key_concepts) ? parsed.key_concepts.filter(x => typeof x === "string") : [],
    definitions: Array.isArray(parsed.definitions) ? parsed.definitions.filter(d => d && d.term && d.def) : [],
    important_facts: Array.isArray(parsed.important_facts) ? parsed.important_facts.filter(x => typeof x === "string") : [],
    examples: Array.isArray(parsed.examples) ? parsed.examples.filter(x => typeof x === "string") : [],
    relationships: Array.isArray(parsed.relationships) ? parsed.relationships.filter(x => typeof x === "string") : [],
    possible_questions: Array.isArray(parsed.possible_questions) ? parsed.possible_questions.filter(x => typeof x === "string") : []
  };
}

async function summarize(subjectName, corpusText){
  const prompt = `You are helping a student study "${subjectName}". Using ONLY the notes ` +
`below, respond with STRICT JSON and nothing else (no prose, no markdown fences), in exactly ` +
`this shape:
{"simple":"a short 2-3 sentence plain-language summary, in your own words, not copied verbatim from the notes",
"keyPoints":["point 1","point 2","point 3","point 4"],
"keywords":["term1","term2","term3","term4","term5","term6"],
"definitions":[{"term":"Term","def":"one concise sentence explaining the term, in your own words"}],
"reviewer":"a short numbered study-notes paragraph, use \\n between lines"}

NOTES:
"""${corpusText.slice(0, 6000)}"""`;
  const raw = await chat(prompt, 700);
  const parsed = extractJson(raw);
  if(!parsed || !parsed.simple) return null;
  parsed.generatedAt = Date.now();
  parsed.source = "local-ai";
  return parsed;
}

async function generateQuiz(subjectName, corpusText, count, difficulty){
  const prompt = `You are a quiz writer helping a student study "${subjectName}" at ${difficulty} ` +
`difficulty. Using ONLY the notes below, write exactly ${count} multiple-choice questions in this ` +
`style: each "question" should be a definition or description of a concept WITHOUT naming the term ` +
`itself, and the correct "options" entry should be the term being described (like a fill-in-the-blank ` +
`or "what term does this describe" quiz, not a question that already contains the answer). ` +
`Respond with STRICT JSON only (no prose, no markdown fences): an array of objects shaped like:
{"question":"a definition or description that does not name the term","options":["A","B","C","D"],"correctIndex":0,"explanation":"why that term is correct, referencing the notes"}

Rules: exactly 4 options per question, correctIndex is the 0-based index of the right option, never ` +
`include the correct term's exact word inside the question text itself, and every question must be ` +
`answerable from the notes.

NOTES:
"""${corpusText.slice(0, 6000)}"""`;
  const raw = await chat(prompt, 1400);
  const parsed = extractJson(raw);
  if(!Array.isArray(parsed) || !parsed.length) return null;
  return parsed.filter(q =>
    q && q.question && Array.isArray(q.options) && q.options.length === 4 &&
    typeof q.correctIndex === "number" && q.correctIndex >= 0 && q.correctIndex < 4
  );
}

window.LocalAI = {
  supported: supportsWebGPU(),
  status: "idle",        // idle | loading | ready | error
  progress: 0,
  progressText: "",
  modelId: MODEL_ID,
  onProgress(fn){ progressListeners.push(fn); },
  async enable(){
    if(!supportsWebGPU()){
      window.LocalAI.status = "error";
      throw new Error("WebGPU isn't available in this browser.");
    }
    await ensureEngine();
  },
  summarize,
  generateQuiz,
  analyzeChunk
};
