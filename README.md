# Bounty Board — Family Quest Board

An RPG-themed quest board web app where family members post jobs with escalating USDC rewards on Base (Ethereum L2).

## Features

- **Quest Board** — Browse available quests with real-time reward ticking
- **Reward Escalation** — Choose Linear, Exponential, or Stepped price curves when posting
- **Full Quest Lifecycle** — Post → Claim → Submit → Approve (or Dispute)
- **Wallet System** — Each member starts with 1,000 USDC. Funds are escrowed when posting quests
- **Transaction Ledger** — Full history of escrow, payments, and refunds
- **RPG Theme** — Parchment surfaces, Cinzel medieval headings, gold accents, difficulty badges
- **Dark Mode** — Toggle between parchment (light) and dungeon (dark) themes

## Tech Stack

- **Frontend**: Vanilla HTML/CSS/JS (no framework, no build step)
- **Backend**: Python 3 CGI script with SQLite
- **Fonts**: Cinzel (display) + Inter (body) via Google Fonts
- **Design**: Custom RPG parchment color palette, fluid type scale, 4px spacing grid

## Quest Lifecycle

1. **Posted** — Quest appears on the board, reward escalates over time
2. **Claimed** — Someone takes the quest, reward locks at current value
3. **Submitted** — Claimer marks it complete with a note
4. **Approved** — Poster confirms, USDC transfers from escrow to claimer
5. **Disputed** — Poster can reject with a reason; claimer can retry or abandon

## Project Structure

```
bounty-board/
├── index.html          # Single-page app with hash-based routing
├── base.css            # Reset and foundation styles
├── style.css           # RPG theme design tokens and components
├── app.js              # Frontend application logic
├── cgi-bin/
│   └── api.py          # Python/SQLite REST API backend
└── README.md
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | /register | Create account (gets wallet + 1000 USDC) |
| POST | /login | Authenticate |
| GET | /quests | List available quests |
| POST | /quests | Create a quest (escrows funds) |
| POST | /quests/claim | Claim a quest |
| POST | /quests/submit | Submit quest completion |
| POST | /quests/approve | Approve and transfer payment |
| POST | /quests/dispute | Dispute a submission |
| POST | /quests/abandon | Abandon a claimed quest |
| GET | /my-quests | Get your posted/claimed quests |
| GET | /wallet | Balance and transaction history |
| GET | /profile | User profile and stats |

## License

MIT
