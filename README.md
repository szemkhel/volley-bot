# Volley Bot 🏐

WhatsApp bot for our volleyball group: weekly polls, reminders, attendance tracking,
cost settlement, ranking, and a subscribable calendar feed. Runs on Node.js (Baileys).

## Contributing
- Branch from `main`, open a PR. Master is protected (PR required).
- The bot always runs `main`; merges auto-deploy to the server within ~3 min.

## Local setup
```
npm ci
cp .env.example .env        # fill in secrets (kept out of git)
cp config.example.json config.json
node index.js
```

Secrets live in `.env` (git-ignored). Never commit real credentials.
