# Bounty Board v2 — Change Summary

## 1. Mobile Responsiveness Fixes

### Navbar
- Balance display uses compact font/padding on mobile (`var(--text-xs)`, tighter padding)
- Username hidden on mobile (not needed — user is logged in)
- Hamburger menu is properly sized (44px touch target)
- `navbar-links.open` now has `z-index: 99` so it overlays content correctly
- All nav links have `min-height: 44px` for touch targets

### Quest Board
- `quest-grid` switches to `1fr` at `700px` (was `420px` — now earlier for better readability)
- Quest cards have `min-width: 0` to prevent overflow in grid

### Filters Bar
- Wraps to full-width columns on `≤540px`
- Filter groups expand to `min-width: 100%` on small screens
- Sort group no longer uses `margin-left: auto` on mobile

### Create Form
- `form-row` grids collapse at `520px` (unchanged, already correct)
- All form inputs have `width: 100%; box-sizing: border-box`

### Wallet Page
- `wallet-grid` collapses to 2-column at `480px`, 1-column at `360px`
- `tx-item` wraps on narrow screens, time moves to its own line

### Profile Page
- `profile-header` stacks vertically at `480px`
- `profile-stats` collapses to 1-column at `360px`

### Modal
- Reduced padding at `≤520px`, max-width computed relative to viewport
- Modal actions stack vertically and become full-width at `≤400px`

### Toast Notifications
- Positioned on both left and right on mobile (full-width bar)
- Animation direction changes from slide-right to slide-up on mobile

### Touch Targets
- All `.btn` have `min-height: 44px; min-width: 44px`
- `.btn-sm` has `min-height: 36px`
- `.tab-btn` has `min-height: 44px`
- `.theme-toggle` is `44×44px`
- `.mobile-menu-btn` is `44×44px`

---

## 2. Admin System

### Backend (api.py)
- `is_admin INTEGER DEFAULT 0` column added to `users` table via `ALTER TABLE` migration
- `require_admin(db, user_id)` helper: checks admin flag, returns 403 if not admin
- New endpoints:
  - `GET /admin/users` — all users with balances, escrow, available
  - `POST /admin/users/toggle-admin` — toggle admin status (`target_user_id`)
  - `POST /admin/users/adjust-balance` — credit/debit balance with reason (`target_user_id`, `amount`, `reason`)
  - `GET /admin/quests` — all quests in all statuses
  - `POST /admin/quests/approve` — admin approves any submitted quest
  - `POST /admin/quests/dispute` — admin disputes any submitted quest
  - `POST /admin/quests/cancel` — admin cancels any quest, refunds escrow
  - `POST /admin/quests/edit` — admin edits title, description, category, difficulty, rewards
  - `GET /admin/transactions` — all system transactions (last 500)
- Login and register responses now include `is_admin` field
- Profile response now includes `is_admin` field
- `transactions` table gets `note TEXT` column via migration

### Frontend (app.js)
- `currentUser.is_admin` stored after login/register
- Admin nav link shown/hidden based on `is_admin`
- `navigateTo()` now includes `'admin'` in valid pages, blocks non-admins
- Admin page with three tabs: Users, All Quests, Transactions
- Users tab: table with toggle-admin and adjust-balance actions
- All Quests tab: list with approve/dispute/cancel/edit buttons
- Transactions tab: full system transaction table
- Admin action buttons also appear inline on quest cards (board) and quest list items (my-quests)

### Frontend (index.html)
- `page-admin` div with tabs and sub-panels
- `nav-admin-link` anchor in `navbar-links` (hidden by default, shown by JS)

---

## 3. Dual Payment System

### A. Real ETH Wallet
- `generate_eth_wallet()` function in `api.py` uses `secrets.token_hex(32)` for private key, SHA-256 derived `eth_address`
- Users table gets `eth_private_key TEXT` and `eth_address TEXT` columns via migration
- On registration: wallet is generated and stored; `eth_address` returned to frontend (never `eth_private_key`)
- Login, wallet, and profile responses include `eth_address`

### B. Out-of-Band (OOB) Payment
- New `payment_method TEXT DEFAULT 'platform'` column on `quests`
- New `poster_payment_confirmed INTEGER DEFAULT 0` and `claimer_payment_confirmed INTEGER DEFAULT 0` on `quests` via migration
- Create quest form has "Payment Method" selector: `Platform Balance` or `Out of Band (Cash, Venmo, etc.)`
- OOB quests: no balance check, no escrow transaction created on posting
- OOB quest flow: `posted → claimed → submitted → (both confirm) → approved`
- `POST /quests/confirm-payment`: either poster or claimer confirms; when both confirm, auto-approves
- In My Quests, OOB submitted quests show payment confirmation UI with status indicators for both parties

---

## 4. QR Code on Wallet Page

- CDN: `https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js`
- "Fund Your Wallet" card on wallet page:
  - QR code of ETH address rendered as SVG inline (160×160px)
  - ETH address text with copy-to-clipboard button
  - Note: "Send ETH or tokens to this address on Base L2"
- Graceful fallback: if `qrcode` library not available or no ETH address, shows text placeholder

---

## 5. Style Additions (style.css)

- `.badge-payment-platform` — green badge for platform payment
- `.badge-payment-oob` — purple badge for out-of-band payment
- `.badge-admin` — gold bordered badge for admin users
- `.badge-tx-*` — transaction type badges for admin panel
- `.quest-reward-oob` — purple-tinted reward box for OOB quests
- `.oob-confirm-section` — confirmation UI block with status indicators
- `.confirm-status.confirmed/.pending` — color-coded confirmation states
- `.fund-wallet-card` — parchment-styled funding card with header/body
- `.qr-code-container` — white box with padding for QR code display
- `.eth-address-display` — monospace address with copy button
- `.btn-copy` — subtle icon copy button
- `.admin-table-wrap` — horizontally scrollable table container
- `.admin-table` — RPG-styled data table with column theming
- `.admin-quest-item` — admin quest list cards
- `.admin-badge` — "Admin" label marker
- `.admin-card-actions` / `.admin-quest-actions` — action areas on items
- `.section-heading` — generic section title style
- `.form-hint` — small helper text below form fields
- All new components are mobile responsive

---

## Files Changed

| File | Changes |
|------|---------|
| `cgi-bin/api.py` | +370 lines: ETH wallet gen, OOB payment, admin endpoints, schema migrations |
| `index.html` | +120 lines: admin page, fund wallet card, payment method field, QR script |
| `app.js` | +640 lines: admin panel, ETH wallet UI, OOB payment logic, QR rendering |
| `style.css` | +540 lines: mobile fixes, new component styles, admin styles |
| `V2_CHANGES.md` | New file: this document |
