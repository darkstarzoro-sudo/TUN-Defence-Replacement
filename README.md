# 🛡️ PW Defense & War Coordination Bot

A Discord bot for Politics & War alliance military operations.

---

## 📋 SETUP GUIDE (Step by Step)

### STEP 1 — Install Dependencies
Open a terminal in this folder in VSCode and run:
```
npm install
```
Wait for it to finish. This downloads all required libraries.

---

### STEP 2 — Create Your .env File
1. Find the file called `.env.example` in this folder
2. Make a **copy** of it
3. Rename the copy to `.env`
4. Open `.env` and fill in your values:

| Setting | Where to get it |
|--------|----------------|
| `DISCORD_TOKEN` | https://discord.com/developers/applications → Your App → Bot → Token |
| `DISCORD_CLIENT_ID` | Same page → General Information → Application ID |
| `DISCORD_GUILD_ID` | Right-click your Discord server → Copy Server ID |
| `PW_API_KEY` | https://politicsandwar.com/account → API Key section |
| `PW_ALLIANCE_ID` | Your alliance page URL on P&W (the number at the end) |

> ✅ No database setup needed! The bot creates its own database file automatically.

---

### STEP 3 — Enable Developer Mode in Discord
You need this to copy Server ID and other IDs.
1. Open Discord → Settings (gear icon)
2. Go to **Advanced**
3. Turn on **Developer Mode**

Now you can right-click servers, channels, and roles to copy their IDs.

---

### STEP 4 — Create Your Discord Bot
If you haven't already:
1. Go to https://discord.com/developers/applications
2. Click **New Application** → give it a name
3. Go to **Bot** → click **Add Bot**
4. Under **Privileged Gateway Intents**, enable:
   - ✅ Server Members Intent
   - ✅ Message Content Intent
5. Copy the **Token** into your `.env` file
6. Go to **OAuth2 → URL Generator**
   - Check `bot` and `applications.commands`
   - Check permissions: `Send Messages`, `Embed Links`, `Manage Channels`, `Manage Roles`
   - Copy the URL and open it to invite the bot to your server

---

### STEP 5 — Register Commands with Discord
Run this once to make the slash commands appear in Discord:
```
node scripts/deploy-commands.js
```

---

### STEP 6 — Start the Bot
```
npm start
```
You should see:
```
✅ Database ready
✅ Commands loaded
✅ Events loaded
✅ Bot is online! Logged in as: YourBot#1234
```

Test it by typing `/ping` in your Discord server!

---

## 📁 PROJECT STRUCTURE

```
pw-bot/
├── src/
│   ├── index.js                  ← Bot starts here
│   ├── commands/
│   │   ├── admin/                ← /ping, /config
│   │   ├── intelligence/         ← /watch, /intel, /beige, /targets
│   │   ├── military/             ← /assign, /counter, /blitz, /hq
│   │   └── reporting/            ← /report, /readiness, /health
│   ├── events/
│   │   ├── ready.js              ← Runs when bot comes online
│   │   └── interactionCreate.js  ← Handles commands & buttons
│   ├── jobs/
│   │   └── scheduler.js          ← Background monitoring jobs
│   ├── systems/                  ← Core logic (built in later phases)
│   └── utils/
│       ├── database.js           ← SQLite database (auto-creates bot.db)
│       ├── pwApi.js              ← P&W API client
│       ├── logger.js             ← Logging system
│       └── permissions.js        ← Role permission checks
├── data/
│   └── bot.db                    ← Your database (created automatically)
├── logs/                         ← Log files (created automatically)
├── scripts/
│   └── deploy-commands.js        ← Run once to register slash commands
├── .env.example                  ← Copy and rename to .env
├── .env                          ← YOUR secrets (never share!)
└── package.json
```

---

## 💬 AVAILABLE COMMANDS (Phase 1)

| Command | Description | Permission |
|---------|-------------|------------|
| `/ping` | Check if the bot is online | Everyone |
| `/config view` | View current settings | Admin |
| `/config alliance` | Set your P&W alliance ID | Admin |
| `/config channel beige` | Set beige alert channel | Admin |
| `/config channel wars` | Set war alert channel | Admin |
| `/config channel intel` | Set intelligence channel | Admin |
| `/config role military` | Set military officer role | Admin |
| `/config role government` | Set government role | Admin |

---

## 🚀 HOSTING ON RAILWAY (Later)
1. Push your code to GitHub (`.env` is blocked by `.gitignore` — safe)
2. Go to https://railway.app → New Project → Deploy from GitHub
3. Add your `.env` values manually in Railway's **Variables** tab
4. Railway runs `npm start` automatically
