// Vercel serverless function: parchi (photo ya text) ko Google Gemini (free tier) se padhwata hai.
// API key sirf yahan server par rehti hai — kabhi browser mein nahi jaati.

const PROMPT = `You read Indian medical prescriptions (handwritten or printed, English/Hindi/Hinglish).
Report ONLY what is actually written on the prescription. Never guess or suggest a dose yourself.

For every medicine, return:
- "brand": name as written (e.g. "Telma 40")
- "salt": generic salt name in English (e.g. "Telmisartan"); infer from the brand only if you are sure
- "strength": number in mg as a string if written (e.g. "40"), else ""
- "dose": pattern morning-afternoon-night like "1-0-1" ONLY if the frequency is written (1-0-1, BD, TDS, OD, HS, "din mein do baar" etc. -> convert: OD="1-0-0", BD="1-0-1", TDS="1-1-1", HS="0-0-1"); if not written, ""
- "qty": how much per dose in simple Hinglish, ONLY if written or clearly implied by "Tab"/"Cap" with 1 (e.g. "1 goli", "½ goli", "5 ml", "2 boond"), else ""
- "days": duration if written (e.g. "5 din", "1 mahina"), else ""
- "note": timing instruction in simple Hinglish if written (e.g. "Khane ke baad", "Khaali pet", "Nashte se pehle"), else ""
- "confidence": "high" | "medium" | "low" for how sure you are you read this medicine correctly

If the input is not a prescription, return [].
Respond with ONLY a JSON array of these objects.`;

const MODELS = [process.env.GEMINI_MODEL, "gemini-3-flash-preview", "gemini-3.1-flash-lite"].filter(Boolean);

// Bahut simple rate limit: ek IP se 1 minute mein 5 request (best effort)
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < 60000);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > 5;
}

async function ask(model, key, parts) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig: { temperature: 0, responseMimeType: "application/json" },
    }),
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (limited(ip)) return res.status(429).json({ error: "Too many requests" });

  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: "GEMINI_API_KEY set nahi hai" });

  const { image, text } = req.body || {};
  const parts = [];
  if (image && typeof image.data === "string") {
    if (!["image/jpeg", "image/png", "image/webp"].includes(image.media_type))
      return res.status(400).json({ error: "Sirf JPG/PNG/WebP" });
    if (image.data.length > 4_000_000) return res.status(413).json({ error: "Photo bahut badi hai" });
    parts.push({ inline_data: { mime_type: image.media_type, data: image.data } });
    parts.push({ text: PROMPT + "\n\nThe attached image is the prescription." });
  } else if (typeof text === "string" && text.trim() && text.length < 5000) {
    parts.push({ text: PROMPT + "\n\nPrescription text:\n" + text });
  } else {
    return res.status(400).json({ error: "Photo ya text bhejein" });
  }

  try {
    let r, used;
    for (const m of MODELS) {
      r = await ask(m, key, parts);
      used = m;
      if (r.status !== 404) break; // model band ho gaya ho to agla try karo
    }
    if (r.status === 429) return res.status(429).json({ error: "Aaj ki free limit poori ho gayi" });
    if (!r.ok) {
      console.error("Gemini error", used, r.status, (await r.text()).slice(0, 500));
      return res.status(502).json({ error: "AI se jawab nahi mila" });
    }
    const data = await r.json();
    const out = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("");
    const clean = out.replace(/```json|```/g, "").trim();
    const s = clean.indexOf("["), e = clean.lastIndexOf("]");
    let medicines = [];
    try { medicines = JSON.parse(clean.slice(s, e + 1)); } catch { medicines = []; }

    // Privacy: photo ya parchi yahan kahin save nahi hoti — sirf jawab wapas jaata hai
    return res.status(200).json({ medicines: Array.isArray(medicines) ? medicines : [] });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
}
