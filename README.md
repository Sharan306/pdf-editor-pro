# PDF Editor Pro

A free, fully-featured browser-based PDF editor — no installs, no subscriptions, no Adobe required.

**Live app:** [pdf-editor-pro-production.up.railway.app](https://pdf-editor-pro-production.up.railway.app)

---

## Features

### Editing Tools
- **Auto text overlay** — click any text in your PDF to edit it instantly (like macOS Preview)
- Add Text, Highlight, Underline, Strikethrough
- Freehand Draw, Rectangle, Circle, Line, Arrow
- Sticky Notes, Stamps, Insert Images
- Eraser, Select & Move objects

### Form Tools
- Form Text Fields, Checkboxes, Radio Buttons
- Redaction (black-box sensitive content)
- Watermark (text or image, any opacity/rotation)
- Signature (draw, type, or upload)

### AI Tools (powered by Claude)
- Rewrite, Fix Grammar, Improve Writing
- Shorten, Expand, Formal tone, Casual tone
- Convert to Bullet Points
- Translate to any language
- Summarize entire document
- Custom AI prompt

### Other
- OCR — extract text from scanned PDFs (Tesseract.js)
- Find & Replace across all pages
- Page thumbnails, zoom, fit-to-page
- Export PDF with all annotations embedded
- Keyboard shortcuts (⌘Z undo, ⌘S save, ⌘O open, ⌘F find)

---

## Tech Stack

| Library | Purpose |
|---|---|
| [PDF.js 3.11](https://mozilla.github.io/pdf.js/) | PDF rendering & text extraction |
| [Fabric.js 5.3](http://fabricjs.com/) | Canvas-based drawing & annotations |
| [pdf-lib 1.17](https://pdf-lib.js.org/) | PDF export with embedded edits |
| [Tesseract.js 5](https://tesseract.projectnaptha.com/) | OCR for scanned PDFs |
| [Claude API](https://anthropic.com) | AI text editing |
| Express.js | Lightweight server + API proxy |

---

## Self-Hosting

### Run locally

```bash
git clone https://github.com/Sharan306/pdf-editor-pro.git
cd pdf-editor-pro
npm install
ANTHROPIC_API_KEY=sk-ant-... node server.js
```

Open [http://localhost:3000](http://localhost:3000)

### Deploy to Railway

1. Fork this repo
2. Create a new project on [Railway](https://railway.app) → Deploy from GitHub
3. Add environment variable: `ANTHROPIC_API_KEY=sk-ant-...`
4. Generate a public domain under Settings → Networking

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes (for AI features) | Your Anthropic API key from [console.anthropic.com](https://console.anthropic.com) |
| `PORT` | No | Server port (default: 3000) |

---

## License

MIT — free to use, modify, and deploy.
