# Bounty Board v3 — Hot Wallet Changelog

## Overview
v3 replaces the per-user fake ETH wallet model with a **single hot wallet** model. The admin controls one real USDC wallet on Base L2. Users deposit to this shared address and submit deposit requests; the admin approves them to credit internal balances. Withdrawals follow the same manual review pattern.

---

## Backend (cgi-bin/api.py)

### New Configuration
- Added `HOT_WALLET_ADDRESS` constant (set to `0x000...000` placeholder — replace with real address)
- Added `HOT_WALLET_NOTE` constant with deposit instructions

### New Table: `fund_requests`
Tracks all deposit and withdrawal requests with fields: `user_id`, `type` (deposit/withdraw), `amount`, `status` (pending/approved/denied), `tx_hash`, `external_address`, `method` (crypto/cashapp/venmo/zelle/other), `note`, `admin_note`, `reviewed_by`, `created_at`, `reviewed_at`.

### New Endpoints
| Method | Path | Description |
|--------|------|-------------|
| GET | `/hot-wallet` | Returns hot wallet address, note, network, token (public, no auth) |
| POST | `/fund-requests` | User submits a deposit or withdraw request |
| GET | `/fund-requests` | User fetches their own fund requests |
| GET | `/admin/fund-requests` | Admin fetches all fund requests (with optional `?status=` filter) |
| POST | `/admin/fund-requests/review` | Admin approves or denies a fund request; credits/debits balance on approval |
| POST | `/admin/quests/confirm-payment` | Admin force-confirms OOB quest payment for both parties and auto-approves |

### Modified Endpoints
- **`/register`**: Default balance changed from `1000.0` to `0.0`. Removed `eth_private_key`/`eth_address` generation. Removed `eth_address` from response.
- **`/login`**: Removed `eth_address` from response.
- **`/wallet`**: Removed `eth_address`. Added `hot_wallet_address` and `hot_wallet_note` to response.
- **`/profile`**: Removed `eth_address` from response.
- **`/admin/users`**: Removed `eth_address` column from query/results.

### Schema Notes
- The `eth_private_key` and `eth_address` columns are preserved in the schema (SQLite can't DROP COLUMN) but no longer populated or returned.
- The `fund_requests` table is created via `init_db()` and is safe to run against existing databases.
- Default balance in `CREATE TABLE IF NOT EXISTS users` is now `0.0`.

---

## Frontend (index.html)

### Wallet Page
- Replaced "Fund Your Wallet" card (per-user ETH address) with **hot wallet deposit card** showing the shared Base L2 address + QR code
- Added `wallet-actions-row` with Deposit and Withdraw buttons above the card
- Added "My Fund Requests" section below the card (rendered by JS)
- Removed inline `<script>` block for `copyEthAddress()`; copy logic moved into `app.js`

### Admin Page
- Added 4th tab: **Fund Requests** (`data-admin-tab="fund-requests"`)
- Admin users table: removed ETH Address column (now has ID, Username, Balance, Available, Admin, Actions)

---

## Frontend (app.js)

### New State
- `hotWalletInfo` — caches the hot wallet address/note fetched from `/hot-wallet`

### New API Helper
- `apiPublic(path)` — GET without appending `user_id`, used for the public `/hot-wallet` endpoint

### Wallet Page Overhaul
- `loadWallet()` now fetches wallet data and hot wallet info in parallel
- `renderWallet()` shows 3 stat cards (Total Balance, Available, Escrowed) — removed "Platform Address" card
- `renderHotWallet(address, note)` renders the hot wallet QR code and address (replaces `renderEthWallet()`)
- Hot wallet copy button wired to `navigator.clipboard`
- Deposit modal: amount, method dropdown, optional tx hash/reference, optional note
- Withdraw modal: amount (max = available), method, external address/payment info, optional note
- `loadFundRequests()` and `renderFundRequests()` — fetch and display user's own fund requests with type/method/status badges

### Transaction Ledger
- Added `deposit` and `withdrawal` transaction types with appropriate icons and +/- coloring

### Profile Page
- Removed ETH address display from profile card

### Admin Panel
- `loadAdminFundRequests()` / `renderAdminFundRequests()` — admin view with Approve/Deny actions
- Approve button shows a confirmation modal; for withdrawals it displays the external address so admin knows where to send funds
- Deny button opens a modal for an optional note
- Admin quest list and my-quests list: added **"Confirm Payment"** button for OOB quests in `submitted` status (calls `/admin/quests/confirm-payment`)
- Admin users table updated to remove ETH Address column

### Auth
- `currentUser` no longer stores `eth_address`
- New users start with `$0.00` balance displayed in nav

### Payment Method Hint
- Platform: "Reward will be escrowed from your platform balance."
- Out of Band: "Payment handled externally (CashApp, Venmo, cash). Requires confirmation from both parties or an admin."

---

## Styles (style.css)

All new styles added at the end of the file under `/* V3 HOT WALLET — NEW STYLES */`:

### New Components
- `.wallet-actions-row` — flex row for Deposit/Withdraw buttons, stacks on mobile
- `.fund-requests-list` / `.fund-request-item` — user-facing fund request list cards
- `.fund-request-header`, `.fund-request-meta`, `.fund-request-details`, `.fund-request-footer`
- `.fund-req-ref`, `.fund-req-note` — reference/note display
- `.admin-fund-requests-list` / `.admin-fund-request-item` — admin view of fund requests
- `.admin-fund-req-header`, `.admin-fund-req-footer`, `.admin-fund-req-actions`
- Pending fund requests get a subtle gold border/glow highlight (`:has(.badge-fr-pending)`)

### New Badges
| Class | Use |
|-------|-----|
| `.badge-deposit` | Green — deposit type |
| `.badge-withdraw` | Blue — withdrawal type |
| `.badge-fr-pending` | Gold — pending status |
| `.badge-fr-approved` | Green — approved status |
| `.badge-fr-denied` | Burgundy — denied status |
| `.badge-method-crypto` | Blue |
| `.badge-method-cashapp` | Green (#00D632 hue) |
| `.badge-method-venmo` | Blue (#008CFF hue) |
| `.badge-method-zelle` | Purple |
| `.badge-method-other` | Stone/gray |
| `.badge-tx-deposit` | Transaction ledger — deposit |
| `.badge-tx-withdrawal` | Transaction ledger — withdrawal |

All new components are mobile-responsive.

---

## Deployment Notes

1. **Set the hot wallet address**: Edit `HOT_WALLET_ADDRESS` in `cgi-bin/api.py` before going live.
2. **Existing users**: Their balances are unchanged; they still start with whatever they had. Only brand-new registrations default to `$0.00`.
3. **Database migration**: `init_db()` handles all migrations automatically on first run — the `fund_requests` table will be created for existing databases.
4. **No breaking changes to existing quest/OOB flow**: The 2-party OOB confirmation still works; admin override is additive.
