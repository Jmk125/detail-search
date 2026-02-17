# Detail Search

A Node.js application for indexing and searching construction detail sheets using OpenAI Vision.

## Setup on Raspberry Pi

### 1. Install system dependencies

```bash
sudo apt update
sudo apt install -y poppler-utils nodejs npm
```

### 2. Clone / copy the project

Copy the project folder to your Pi, e.g. `/home/pi/detail-search`

### 3. Install Node dependencies

```bash
cd /home/pi/detail-search
npm install
```

### 4. Configure your OpenAI API key

```bash
cp .env.example .env
nano .env
```

Set `OPENAI_API_KEY=sk-...` to your key.

### 5. Run the server

```bash
node server.js
```

Access it from any machine on your network at:
`http://<raspberry-pi-ip>:3737`

---

## Run as a background service (systemd)

Create `/etc/systemd/system/detail-search.service`:

```ini
[Unit]
Description=Detail Search
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/detail-search
ExecStart=/usr/bin/node server.js
Restart=on-failure
EnvironmentFile=/home/pi/detail-search/.env

[Install]
WantedBy=multi-user.target
```

Then enable it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable detail-search
sudo systemctl start detail-search
```

---

## How it works

1. **Create a project** (e.g. "Oberlin Middle School")
2. **Upload PDFs** — single or multi-page detail sheets
3. **AI indexes each page** — GPT-4o reads the page, identifies all details, describes them, and extracts keywords
4. **Search** — type any keyword and get ranked results; click a result to open the full sheet with the relevant detail highlighted

## Highlighting

When you open a result and click a detail in the right panel, the app dims the rest of the sheet and draws a box around the region where that detail lives. Since the AI estimates location (top-left, bottom-right, etc.), accuracy is good but not pixel-perfect — that's a future enhancement.

## Storage

- PDFs are stored in `uploads/pdfs/`
- Page images in `uploads/pages/`
- Index database in `data/` (NeDB flat files)

## Notes

- Indexing runs in the background after upload — the page auto-refreshes every 5 seconds to show progress
- Multiple PDFs can be uploaded at once; they queue and process sequentially
- OpenAI API costs: GPT-4o vision at high detail is roughly $0.01–0.03 per page depending on complexity
