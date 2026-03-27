import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const GROQ_API_KEY     = process.env.GROQ_API_KEY     || '';
const GROQ_MODEL       = 'llama-3.1-8b-instant';
const GROQ_API_URL     = 'https://api.groq.com/openai/v1/chat/completions';

const MIME = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  // ── CORS ──────────────────────────────────────────────────────────────────
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── GET /api/ping  (server health — always 200 if server is up) ──────────
  if (req.method === 'GET' && req.url === '/api/ping') {
    res.writeHead(200); res.end('ok');
    return;
  }

  // ── GET /api/ai-status  (tells client if AI is available) ─────────────────
  if (req.method === 'GET' && req.url === '/api/ai-status') {
    if (GROQ_API_KEY) {
      res.writeHead(200); res.end('ok');
      return;
    }
    try {
      const r = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(1500) });
      if (r.ok) { res.writeHead(200); res.end('ok'); }
      else       { res.writeHead(503); res.end('no ai'); }
    } catch {
      res.writeHead(503); res.end('no ai');
    }
    return;
  }

  // ── POST /api/tafsir  (Groq if key set, else Ollama fallback) ─────────────
  if (req.method === 'POST' && req.url === '/api/tafsir') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { surahName, surahNum, ayahNum, translation } = JSON.parse(body);

        const systemPrompt = `You are a knowledgeable Islamic scholar. Draw your explanation from the most reputable classical and modern tafsir works — primarily Ibn Kathir (Tafsir Ibn Kathir), al-Tabari (Jami' al-Bayan), al-Sa'di (Taysir al-Karim al-Rahman), Mawdudi (Tafhim al-Quran), and al-Qurtubi (al-Jami' li-Ahkam al-Quran). Use whichever is most relevant to this verse.

Respond ONLY in this exact format with no extra text before or after:

MEANING
[2-3 clear sentences explaining what this verse means. Ground it in what the classical scholars said, translated into simple modern language. No academic jargon.]

TAKEAWAYS
- [one concrete, real-world action a person can take today]
- [one mindset shift or reflection prompt]
- [one practical habit or reminder for daily life]

SOURCES
- [Scholar name — Book title, brief note on what they emphasised about this verse]
- [Second scholar if relevant]

Keep it honest, grounded, and relevant to everyday modern life.`;

        const userPrompt = `Verse: Quran ${surahNum}:${ayahNum} (Surah ${surahName})\nTranslation: "${translation}"`;

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });

        if (GROQ_API_KEY) {
          // ── Groq (production) ────────────────────────────────────────────
          const groqRes = await fetch(GROQ_API_URL, {
            method: 'POST',
            headers: {
              'Content-Type':  'application/json',
              'Authorization': `Bearer ${GROQ_API_KEY}`,
            },
            body: JSON.stringify({
              model: GROQ_MODEL,
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user',   content: userPrompt   },
              ],
              stream: true,
              max_tokens: 400,
              temperature: 0.7,
            }),
          });

          if (!groqRes.ok) throw new Error(`Groq ${groqRes.status}: ${await groqRes.text()}`);

          const reader  = groqRes.body.getReader();
          const decoder = new TextDecoder();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            for (const line of decoder.decode(value, { stream: true }).split('\n')) {
              if (!line.startsWith('data: ')) continue;
              const payload = line.slice(6).trim();
              if (payload === '[DONE]') { res.write('data: [DONE]\n\n'); continue; }
              try {
                const text = JSON.parse(payload).choices?.[0]?.delta?.content;
                if (text) res.write(`data: ${JSON.stringify({ text })}\n\n`);
              } catch { /* partial */ }
            }
          }
        } else {
          // ── Ollama (local dev fallback) ──────────────────────────────────
          const ollamaRes = await fetch('http://localhost:11434/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: 'llama3.2',
              prompt: `${systemPrompt}\n\n${userPrompt}`,
              stream: true,
            }),
          });

          if (!ollamaRes.ok) throw new Error(`Ollama ${ollamaRes.status}`);

          const reader  = ollamaRes.body.getReader();
          const decoder = new TextDecoder();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            for (const line of decoder.decode(value).split('\n').filter(Boolean)) {
              try {
                const obj = JSON.parse(line);
                if (obj.response) res.write(`data: ${JSON.stringify({ text: obj.response })}\n\n`);
                if (obj.done)     res.write('data: [DONE]\n\n');
              } catch { /* partial */ }
            }
          }
        }

        res.end();
      } catch (err) {
        res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      }
    });
    return;
  }

  // ── Static files ─────────────────────────────────────────────────────────
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.join(__dirname, urlPath);
  const ext      = path.extname(filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`QuranTime running at http://localhost:${PORT}`));
