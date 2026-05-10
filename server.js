/* PDF Editor Pro — proxy server
   Set ANTHROPIC_API_KEY in env to enable shared AI (users won't need their own key).
   Set RATE_LIMIT_PER_HOUR to control max AI requests per IP per hour (default: 20).

   Usage:
     npm install
     ANTHROPIC_API_KEY=sk-ant-... node server.js
     Open http://localhost:3000
*/
const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname)));

// ── In-memory rate limiter (resets on server restart) ──
const RATE_LIMIT = parseInt(process.env.RATE_LIMIT_PER_HOUR || '20', 10);
const ipCounts = new Map(); // ip → { count, resetAt }

function getRealIP(req) {
    return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

function checkRateLimit(ip) {
    const now = Date.now();
    const entry = ipCounts.get(ip);
    if (!entry || now > entry.resetAt) {
        ipCounts.set(ip, { count: 1, resetAt: now + 3600_000 });
        return true;
    }
    if (entry.count >= RATE_LIMIT) return false;
    entry.count++;
    return true;
}

// ── Claude proxy ──
app.post('/api/claude', async (req, res) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
        return res.status(400).json({ error: 'ANTHROPIC_API_KEY env var not set' });
    }

    const ip = getRealIP(req);
    if (!checkRateLimit(ip)) {
        return res.status(429).json({ error: `Rate limit reached (${RATE_LIMIT} requests/hour). Try again later.` });
    }

    const { prompt, model = 'claude-haiku-4-5-20251001', maxTokens = 2048 } = req.body;

    try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model,
                max_tokens: maxTokens,
                messages: [{ role: 'user', content: prompt }]
            })
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            return res.status(response.status).json({ error: err.error?.message || 'API error' });
        }

        const data = await response.json();
        res.json({ content: data.content[0].text });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n✅ PDF Editor Pro running at http://localhost:${PORT}`);
    console.log(`   Shared AI key: ${process.env.ANTHROPIC_API_KEY ? 'YES — users need no key' : 'NO — users need their own key'}`);
    console.log(`   Rate limit: ${RATE_LIMIT} AI requests/IP/hour`);
});
