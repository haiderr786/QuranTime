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

  // ── GET /api/ping  (health check — tells client Groq is available) ────────
  if (req.method === 'GET' && req.url === '/api/ping') {
    if (GROQ_API_KEY) {
      res.writeHead(200); res.end('ok');
    } else {
      res.writeHead(503); res.end('no key');
    }
    return;
  }

  // ── POST /api/tafsir  (Groq llama streaming) ──────────────────────────────
  if (req.method === 'POST' && req.url === '/api/tafsir') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { surahName, surahNum, ayahNum, translation } = JSON.parse(body);

        const systemPrompt = `You are a knowledgeable Islamic scholar giving a modern, practical reflection on a Quran verse. Respond ONLY in this exact format with no extra text before or after:

MEANING
[2-3 clear sentences explaining what this verse means in simple modern language. Focus on the core message, not academic detail.]

TAKEAWAYS
- [one concrete, real-world action a person can take today]
- [one mindset shift or reflection prompt]
- [one practical habit or reminder for daily life]

Keep it grounded, honest, and relevant to everyday modern life. No academic language.`;

        const userPrompt = `Verse: Quran ${surahNum}:${ayahNum} (Surah ${surahName})\nTranslation: "${translation}"`;

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });

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

        if (!groqRes.ok) {
          const err = await groqRes.text();
          throw new Error(`Groq ${groqRes.status}: ${err}`);
        }

        const reader  = groqRes.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const lines = decoder.decode(value, { stream: true }).split('\n');
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const payload = line.slice(6).trim();
            if (payload === '[DONE]') {
              res.write('data: [DONE]\n\n');
              continue;
            }
            try {
              const obj  = JSON.parse(payload);
              const text = obj.choices?.[0]?.delta?.content;
              if (text) res.write(`data: ${JSON.stringify({ text })}\n\n`);
            } catch { /* partial chunk */ }
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
