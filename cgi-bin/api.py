#!/usr/bin/env python3
import json, os, sys, sqlite3, hashlib, time, random, string, secrets
from datetime import datetime, timezone

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data.db')

# ============================================================================
# HOT WALLET & BLOCKCHAIN CONFIGURATION
# ============================================================================
# Public address of the hot wallet (shown to users for deposits)
HOT_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000'  # Replace with actual address
HOT_WALLET_NOTE = 'Send USDC on Base L2 to this address, then submit a deposit request.'

# USDC contract on Base L2 mainnet (official Circle deployment)
USDC_CONTRACT_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
USDC_DECIMALS = 6  # USDC uses 6 decimal places

# Base L2 chain ID
BASE_CHAIN_ID = 8453

# RPC endpoint for Base L2 — override with BOUNTY_BASE_RPC_URL env var
# Default: Base public RPC (rate-limited, fine for low-volume use)
BASE_RPC_URL = os.environ.get('BOUNTY_BASE_RPC_URL', 'https://mainnet.base.org')

# Hot wallet private key — loaded from env var or file
# SECURITY: Never hardcode this. Set via:
#   export BOUNTY_HOT_WALLET_KEY="0xYourPrivateKey"
# OR place the key (hex string) in a file and set:
#   export BOUNTY_HOT_WALLET_KEY_FILE="/path/to/keyfile"
HOT_WALLET_PRIVATE_KEY = None
_key_env = os.environ.get('BOUNTY_HOT_WALLET_KEY', '').strip()
_key_file = os.environ.get('BOUNTY_HOT_WALLET_KEY_FILE', '').strip()
if _key_env:
    HOT_WALLET_PRIVATE_KEY = _key_env
elif _key_file and os.path.isfile(_key_file):
    with open(_key_file, 'r') as f:
        HOT_WALLET_PRIVATE_KEY = f.read().strip()

# Minimal ERC-20 ABI for transfer + balanceOf
ERC20_ABI = json.loads('[{"constant":false,"inputs":[{"name":"to","type":"address"},{"name":"value","type":"uint256"}],"name":"transfer","outputs":[{"name":"","type":"bool"}],"type":"function"},{"constant":true,"inputs":[{"name":"owner","type":"address"}],"name":"balanceOf","outputs":[{"name":"","type":"uint256"}],"type":"function"}]')

# ============================================================================
# USDC TRANSFER HELPER
# ============================================================================
def send_usdc(to_address, amount_usdc):
    """Send USDC on Base L2 from the hot wallet. Returns tx hash hex string.
    Raises RuntimeError on failure.
    """
    try:
        from web3 import Web3
    except ImportError:
        raise RuntimeError(
            'web3 package not installed. Run: pip install web3'
        )

    if not HOT_WALLET_PRIVATE_KEY:
        raise RuntimeError(
            'Hot wallet private key not configured. '
            'Set BOUNTY_HOT_WALLET_KEY or BOUNTY_HOT_WALLET_KEY_FILE env var.'
        )

    w3 = Web3(Web3.HTTPProvider(BASE_RPC_URL))
    if not w3.is_connected():
        raise RuntimeError(f'Cannot connect to Base RPC: {BASE_RPC_URL}')

    # Derive hot wallet address from private key
    account = w3.eth.account.from_key(HOT_WALLET_PRIVATE_KEY)

    # Validate destination address
    if not w3.is_address(to_address):
        raise RuntimeError(f'Invalid destination address: {to_address}')
    to_address = w3.to_checksum_address(to_address)

    # USDC contract
    usdc = w3.eth.contract(
        address=w3.to_checksum_address(USDC_CONTRACT_ADDRESS),
        abi=ERC20_ABI
    )

    # Convert human-readable amount to raw (6 decimals)
    raw_amount = int(amount_usdc * (10 ** USDC_DECIMALS))

    # Check USDC balance
    balance = usdc.functions.balanceOf(account.address).call()
    if balance < raw_amount:
        balance_human = balance / (10 ** USDC_DECIMALS)
        raise RuntimeError(
            f'Insufficient USDC in hot wallet. '
            f'Need {amount_usdc:.2f}, have {balance_human:.2f}'
        )

    # Check ETH balance for gas
    eth_balance = w3.eth.get_balance(account.address)
    if eth_balance < w3.to_wei(0.0001, 'ether'):  # ~$0.05 min gas buffer
        raise RuntimeError(
            'Hot wallet needs ETH for gas fees on Base. '
            f'Current balance: {w3.from_wei(eth_balance, "ether"):.6f} ETH'
        )

    # Build transfer transaction
    nonce = w3.eth.get_transaction_count(account.address)
    tx = usdc.functions.transfer(to_address, raw_amount).build_transaction({
        'chainId': BASE_CHAIN_ID,
        'gas': 65000,  # ERC-20 transfers on Base typically use ~50k gas
        'nonce': nonce,
    })

    # Use EIP-1559 fee estimation if available, otherwise legacy gasPrice
    try:
        latest = w3.eth.get_block('latest')
        base_fee = latest.get('baseFeePerGas', 0)
        if base_fee > 0:
            # EIP-1559: set maxFeePerGas with headroom
            tx['maxFeePerGas'] = base_fee * 2 + w3.to_wei(0.001, 'gwei')
            tx['maxPriorityFeePerGas'] = w3.to_wei(0.001, 'gwei')
            tx.pop('gasPrice', None)
        else:
            tx['gasPrice'] = w3.eth.gas_price
    except Exception:
        tx['gasPrice'] = w3.eth.gas_price

    # Sign and send
    signed_tx = w3.eth.account.sign_transaction(tx, HOT_WALLET_PRIVATE_KEY)
    tx_hash = w3.eth.send_raw_transaction(signed_tx.raw_transaction)

    return tx_hash.hex()

def get_db():
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA foreign_keys=ON")
    init_db(db)
    return db

def init_db(db):
    db.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            wallet_address TEXT NOT NULL,
            balance REAL DEFAULT 0.0,
            created_at TEXT DEFAULT (datetime('now')),
            is_admin INTEGER DEFAULT 0,
            eth_private_key TEXT,
            eth_address TEXT
        );
        CREATE TABLE IF NOT EXISTS quests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            poster_id INTEGER NOT NULL,
            claimer_id INTEGER,
            title TEXT NOT NULL,
            description TEXT NOT NULL,
            category TEXT NOT NULL,
            difficulty TEXT NOT NULL,
            min_reward REAL NOT NULL,
            max_reward REAL NOT NULL,
            current_locked_reward REAL,
            escalation_type TEXT NOT NULL,
            escalation_period_hours REAL NOT NULL,
            status TEXT DEFAULT 'posted',
            completion_note TEXT,
            dispute_reason TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            claimed_at TEXT,
            completed_at TEXT,
            payment_method TEXT DEFAULT 'platform',
            poster_payment_confirmed INTEGER DEFAULT 0,
            claimer_payment_confirmed INTEGER DEFAULT 0,
            FOREIGN KEY (poster_id) REFERENCES users(id),
            FOREIGN KEY (claimer_id) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            from_user_id INTEGER,
            to_user_id INTEGER,
            quest_id INTEGER,
            amount REAL NOT NULL,
            type TEXT NOT NULL,
            note TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (from_user_id) REFERENCES users(id),
            FOREIGN KEY (to_user_id) REFERENCES users(id),
            FOREIGN KEY (quest_id) REFERENCES quests(id)
        );
        CREATE TABLE IF NOT EXISTS fund_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            type TEXT NOT NULL,
            amount REAL NOT NULL,
            status TEXT DEFAULT 'pending',
            tx_hash TEXT,
            external_address TEXT,
            method TEXT DEFAULT 'crypto',
            note TEXT,
            admin_note TEXT,
            reviewed_by INTEGER,
            created_at TEXT DEFAULT (datetime('now')),
            reviewed_at TEXT,
            FOREIGN KEY (user_id) REFERENCES users(id),
            FOREIGN KEY (reviewed_by) REFERENCES users(id)
        );
    """)
    db.commit()

    # ALTER TABLE migrations for existing databases
    existing_user_cols = [row[1] for row in db.execute("PRAGMA table_info(users)").fetchall()]
    if 'is_admin' not in existing_user_cols:
        db.execute("ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0")
        db.commit()
    if 'eth_private_key' not in existing_user_cols:
        db.execute("ALTER TABLE users ADD COLUMN eth_private_key TEXT")
        db.commit()
    if 'eth_address' not in existing_user_cols:
        db.execute("ALTER TABLE users ADD COLUMN eth_address TEXT")
        db.commit()

    existing_quest_cols = [row[1] for row in db.execute("PRAGMA table_info(quests)").fetchall()]
    if 'payment_method' not in existing_quest_cols:
        db.execute("ALTER TABLE quests ADD COLUMN payment_method TEXT DEFAULT 'platform'")
        db.commit()
    if 'poster_payment_confirmed' not in existing_quest_cols:
        db.execute("ALTER TABLE quests ADD COLUMN poster_payment_confirmed INTEGER DEFAULT 0")
        db.commit()
    if 'claimer_payment_confirmed' not in existing_quest_cols:
        db.execute("ALTER TABLE quests ADD COLUMN claimer_payment_confirmed INTEGER DEFAULT 0")
        db.commit()

    existing_tx_cols = [row[1] for row in db.execute("PRAGMA table_info(transactions)").fetchall()]
    if 'note' not in existing_tx_cols:
        db.execute("ALTER TABLE transactions ADD COLUMN note TEXT")
        db.commit()

    # fund_requests table — create if not exists (already handled above via executescript)
    # but we ensure the table exists for old databases that didn't have it
    existing_tables = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
    if 'fund_requests' not in existing_tables:
        db.execute("""
            CREATE TABLE fund_requests (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                type TEXT NOT NULL,
                amount REAL NOT NULL,
                status TEXT DEFAULT 'pending',
                tx_hash TEXT,
                external_address TEXT,
                method TEXT DEFAULT 'crypto',
                note TEXT,
                admin_note TEXT,
                reviewed_by INTEGER,
                created_at TEXT DEFAULT (datetime('now')),
                reviewed_at TEXT,
                FOREIGN KEY (user_id) REFERENCES users(id),
                FOREIGN KEY (reviewed_by) REFERENCES users(id)
            )
        """)
        db.commit()


def gen_wallet():
    hex_chars = '0123456789abcdef'
    return '0x' + ''.join(random.choice(hex_chars) for _ in range(40))

def hash_password(pw):
    return hashlib.sha256(pw.encode('utf-8')).hexdigest()

def respond(data, status=200):
    print(f"Status: {status}")
    print("Content-Type: application/json")
    print()
    print(json.dumps(data))
    sys.exit(0)

def error(msg, status=400):
    respond({"error": msg}, status)

def get_body():
    try:
        length = int(os.environ.get('CONTENT_LENGTH', 0))
        if length > 0:
            return json.loads(sys.stdin.read(length))
    except:
        pass
    return {}

def parse_qs(qs):
    params = {}
    if not qs:
        return params
    for pair in qs.split('&'):
        if '=' in pair:
            k, v = pair.split('=', 1)
            params[k] = v
    return params

def get_user_id(body=None, params=None):
    uid = None
    if body and 'user_id' in body:
        uid = body['user_id']
    if params and 'user_id' in params:
        uid = params['user_id']
    if uid is None:
        error("Authentication required", 401)
    return int(uid)

def require_admin(db, user_id):
    row = db.execute("SELECT is_admin FROM users WHERE id = ?", [user_id]).fetchone()
    if not row:
        error("User not found", 404)
    if not row['is_admin']:
        error("Admin privileges required", 403)

def get_escrowed(db, user_id):
    row = db.execute("""
        SELECT COALESCE(SUM(max_reward), 0) as escrowed
        FROM quests
        WHERE poster_id = ? AND status IN ('posted', 'claimed', 'submitted')
        AND payment_method = 'platform'
    """, [user_id]).fetchone()
    return row['escrowed']

def calc_current_reward(quest):
    min_r = quest['min_reward']
    max_r = quest['max_reward']
    esc_type = quest['escalation_type']
    period_hours = quest['escalation_period_hours']
    created = datetime.fromisoformat(quest['created_at']).replace(tzinfo=timezone.utc)
    now = datetime.now(timezone.utc)
    elapsed_hours = (now - created).total_seconds() / 3600.0
    ratio = min(elapsed_hours / period_hours, 1.0) if period_hours > 0 else 1.0

    if esc_type == 'linear':
        current = min_r + (max_r - min_r) * ratio
    elif esc_type == 'exponential':
        current = min_r + (max_r - min_r) * (ratio ** 2)
    elif esc_type == 'stepped':
        steps = 5
        step_ratio = int(ratio * steps) / steps
        current = min_r + (max_r - min_r) * step_ratio
    else:
        current = min_r

    return round(min(current, max_r), 2)

def handle_register(db, body):
    username = body.get('username', '').strip()
    password = body.get('password', '')
    if not username or not password:
        error("Username and password required")
    if len(username) < 2:
        error("Username must be at least 2 characters")
    if len(password) < 4:
        error("Password must be at least 4 characters")

    existing = db.execute("SELECT id FROM users WHERE username = ?", [username]).fetchone()
    if existing:
        error("Username already taken")

    wallet = gen_wallet()
    pw_hash = hash_password(password)

    db.execute(
        "INSERT INTO users (username, password_hash, wallet_address, balance) VALUES (?, ?, ?, 0.0)",
        [username, pw_hash, wallet]
    )
    db.commit()

    user = db.execute("SELECT * FROM users WHERE username = ?", [username]).fetchone()
    respond({
        "user_id": user['id'],
        "username": user['username'],
        "wallet_address": user['wallet_address'],
        "balance": user['balance'],
        "is_admin": bool(user['is_admin']),
        "created_at": user['created_at']
    }, 201)

def handle_login(db, body):
    username = body.get('username', '').strip()
    password = body.get('password', '')
    if not username or not password:
        error("Username and password required")

    pw_hash = hash_password(password)
    user = db.execute(
        "SELECT * FROM users WHERE username = ? AND password_hash = ?",
        [username, pw_hash]
    ).fetchone()

    if not user:
        error("Invalid username or password", 401)

    escrowed = get_escrowed(db, user['id'])
    respond({
        "user_id": user['id'],
        "username": user['username'],
        "wallet_address": user['wallet_address'],
        "balance": user['balance'],
        "escrowed": escrowed,
        "available": round(user['balance'] - escrowed, 2),
        "is_admin": bool(user['is_admin']),
        "created_at": user['created_at']
    })

def handle_get_quests(db, params):
    rows = db.execute("""
        SELECT q.*, u.username as poster_username
        FROM quests q
        JOIN users u ON q.poster_id = u.id
        WHERE q.status = 'posted'
        ORDER BY q.created_at DESC
    """).fetchall()

    quests = []
    for r in rows:
        q = dict(r)
        q['current_reward'] = calc_current_reward(q)
        quests.append(q)

    respond({"quests": quests})

def handle_create_quest(db, body):
    user_id = get_user_id(body)
    title = body.get('title', '').strip()
    description = body.get('description', '').strip()
    category = body.get('category', '')
    difficulty = body.get('difficulty', '')
    min_reward = float(body.get('min_reward', 0))
    max_reward = float(body.get('max_reward', 0))
    escalation_type = body.get('escalation_type', 'linear')
    escalation_period_hours = float(body.get('escalation_period_hours', 24))
    payment_method = body.get('payment_method', 'platform')

    if not title:
        error("Title required")
    if not description:
        error("Description required")
    if min_reward <= 0:
        error("Minimum reward must be positive")
    if max_reward < min_reward:
        error("Maximum reward must be >= minimum reward")
    if escalation_period_hours <= 0:
        error("Escalation period must be positive")

    valid_categories = ['Chores', 'Errands', 'Projects', 'Favors', 'Learning', 'Creative']
    if category not in valid_categories:
        error(f"Invalid category. Must be one of: {', '.join(valid_categories)}")

    valid_difficulties = ['Easy', 'Medium', 'Hard', 'Epic']
    if difficulty not in valid_difficulties:
        error(f"Invalid difficulty. Must be one of: {', '.join(valid_difficulties)}")

    valid_escalation = ['linear', 'exponential', 'stepped']
    if escalation_type not in valid_escalation:
        error(f"Invalid escalation type")

    valid_payment = ['platform', 'out_of_band']
    if payment_method not in valid_payment:
        error("Invalid payment method")

    user = db.execute("SELECT * FROM users WHERE id = ?", [user_id]).fetchone()
    if not user:
        error("User not found", 404)

    # Only check balance for platform payment method
    if payment_method == 'platform':
        escrowed = get_escrowed(db, user_id)
        available = user['balance'] - escrowed
        if max_reward > available:
            error(f"Insufficient funds. Available: {available:.2f} USDC, Required escrow: {max_reward:.2f} USDC")

    db.execute("""
        INSERT INTO quests (poster_id, title, description, category, difficulty,
                           min_reward, max_reward, escalation_type, escalation_period_hours,
                           status, payment_method)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'posted', ?)
    """, [user_id, title, description, category, difficulty, min_reward, max_reward,
          escalation_type, escalation_period_hours, payment_method])

    quest_id = db.execute("SELECT last_insert_rowid()").fetchone()[0]

    # Only create escrow transaction for platform payments
    if payment_method == 'platform':
        db.execute("""
            INSERT INTO transactions (from_user_id, quest_id, amount, type)
            VALUES (?, ?, ?, 'escrow')
        """, [user_id, quest_id, max_reward])

    db.commit()

    quest = db.execute("""
        SELECT q.*, u.username as poster_username
        FROM quests q JOIN users u ON q.poster_id = u.id
        WHERE q.id = ?
    """, [quest_id]).fetchone()

    q = dict(quest)
    q['current_reward'] = calc_current_reward(q)
    respond({"quest": q}, 201)

def handle_claim_quest(db, body):
    user_id = get_user_id(body)
    quest_id = body.get('quest_id')
    if not quest_id:
        error("quest_id required")

    quest = db.execute("SELECT * FROM quests WHERE id = ?", [quest_id]).fetchone()
    if not quest:
        error("Quest not found", 404)
    if quest['status'] != 'posted':
        error("Quest is not available for claiming")
    if quest['poster_id'] == user_id:
        error("Cannot claim your own quest")

    current_reward = calc_current_reward(dict(quest))
    now = datetime.now(timezone.utc).isoformat()

    db.execute("""
        UPDATE quests SET claimer_id = ?, current_locked_reward = ?, status = 'claimed', claimed_at = ?
        WHERE id = ?
    """, [user_id, current_reward, now, quest_id])

    db.commit()

    quest = db.execute("""
        SELECT q.*, u.username as poster_username, c.username as claimer_username
        FROM quests q
        JOIN users u ON q.poster_id = u.id
        LEFT JOIN users c ON q.claimer_id = c.id
        WHERE q.id = ?
    """, [quest_id]).fetchone()

    respond({"quest": dict(quest)})

def handle_submit_quest(db, body):
    user_id = get_user_id(body)
    quest_id = body.get('quest_id')
    completion_note = body.get('completion_note', '').strip()

    if not quest_id:
        error("quest_id required")

    quest = db.execute("SELECT * FROM quests WHERE id = ?", [quest_id]).fetchone()
    if not quest:
        error("Quest not found", 404)
    if quest['claimer_id'] != user_id:
        error("You are not the claimer of this quest")
    if quest['status'] != 'claimed' and quest['status'] != 'disputed':
        error("Quest cannot be submitted in current status")

    db.execute("""
        UPDATE quests SET status = 'submitted', completion_note = ? WHERE id = ?
    """, [completion_note, quest_id])
    db.commit()

    quest = db.execute("""
        SELECT q.*, u.username as poster_username, c.username as claimer_username
        FROM quests q
        JOIN users u ON q.poster_id = u.id
        LEFT JOIN users c ON q.claimer_id = c.id
        WHERE q.id = ?
    """, [quest_id]).fetchone()

    respond({"quest": dict(quest)})

def do_approve_quest(db, quest_id):
    """Shared approval logic used by both normal and admin approval."""
    quest = db.execute("SELECT * FROM quests WHERE id = ?", [quest_id]).fetchone()
    if not quest:
        error("Quest not found", 404)
    if quest['status'] != 'submitted':
        error("Quest must be in submitted status to approve")

    locked_reward = quest['current_locked_reward']
    max_reward = quest['max_reward']
    claimer_id = quest['claimer_id']
    poster_id = quest['poster_id']
    payment_method = quest['payment_method'] or 'platform'
    now = datetime.now(timezone.utc).isoformat()

    if payment_method == 'platform':
        # Transfer locked reward from poster to claimer
        db.execute("UPDATE users SET balance = balance - ? WHERE id = ?", [locked_reward, poster_id])
        db.execute("UPDATE users SET balance = balance + ? WHERE id = ?", [locked_reward, claimer_id])

        db.execute("""
            INSERT INTO transactions (from_user_id, to_user_id, quest_id, amount, type)
            VALUES (?, ?, ?, ?, 'payment')
        """, [poster_id, claimer_id, quest_id, locked_reward])

        refund = round(max_reward - locked_reward, 2)
        if refund > 0:
            db.execute("""
                INSERT INTO transactions (to_user_id, quest_id, amount, type)
                VALUES (?, ?, ?, 'refund')
            """, [poster_id, quest_id, refund])

    # Update quest status
    db.execute("""
        UPDATE quests SET status = 'approved', completed_at = ? WHERE id = ?
    """, [now, quest_id])

    db.commit()

    quest = db.execute("""
        SELECT q.*, u.username as poster_username, c.username as claimer_username
        FROM quests q
        JOIN users u ON q.poster_id = u.id
        LEFT JOIN users c ON q.claimer_id = c.id
        WHERE q.id = ?
    """, [quest_id]).fetchone()

    return dict(quest)

def handle_approve_quest(db, body):
    user_id = get_user_id(body)
    quest_id = body.get('quest_id')

    if not quest_id:
        error("quest_id required")

    quest = db.execute("SELECT * FROM quests WHERE id = ?", [quest_id]).fetchone()
    if not quest:
        error("Quest not found", 404)
    if quest['poster_id'] != user_id:
        error("Only the quest poster can approve")

    result = do_approve_quest(db, quest_id)
    respond({"quest": result})

def handle_dispute_quest(db, body):
    user_id = get_user_id(body)
    quest_id = body.get('quest_id')
    dispute_reason = body.get('dispute_reason', '').strip()

    if not quest_id:
        error("quest_id required")
    if not dispute_reason:
        error("Dispute reason required")

    quest = db.execute("SELECT * FROM quests WHERE id = ?", [quest_id]).fetchone()
    if not quest:
        error("Quest not found", 404)
    if quest['poster_id'] != user_id:
        error("Only the quest poster can dispute")
    if quest['status'] != 'submitted':
        error("Quest must be in submitted status to dispute")

    db.execute("""
        UPDATE quests SET status = 'disputed', dispute_reason = ? WHERE id = ?
    """, [dispute_reason, quest_id])
    db.commit()

    quest = db.execute("""
        SELECT q.*, u.username as poster_username, c.username as claimer_username
        FROM quests q
        JOIN users u ON q.poster_id = u.id
        LEFT JOIN users c ON q.claimer_id = c.id
        WHERE q.id = ?
    """, [quest_id]).fetchone()

    respond({"quest": dict(quest)})

def handle_abandon_quest(db, body):
    user_id = get_user_id(body)
    quest_id = body.get('quest_id')

    if not quest_id:
        error("quest_id required")

    quest = db.execute("SELECT * FROM quests WHERE id = ?", [quest_id]).fetchone()
    if not quest:
        error("Quest not found", 404)
    if quest['claimer_id'] != user_id:
        error("Only the claimer can abandon")
    if quest['status'] not in ('claimed', 'disputed'):
        error("Quest cannot be abandoned in current status")

    db.execute("""
        UPDATE quests SET claimer_id = NULL, current_locked_reward = NULL,
                         status = 'posted', claimed_at = NULL,
                         completion_note = NULL, dispute_reason = NULL,
                         poster_payment_confirmed = 0, claimer_payment_confirmed = 0
        WHERE id = ?
    """, [quest_id])
    db.commit()

    respond({"message": "Quest abandoned and returned to board"})

def handle_confirm_payment(db, body):
    """Either poster or claimer confirms OOB payment. When both confirm, auto-approve."""
    user_id = get_user_id(body)
    quest_id = body.get('quest_id')

    if not quest_id:
        error("quest_id required")

    quest = db.execute("SELECT * FROM quests WHERE id = ?", [quest_id]).fetchone()
    if not quest:
        error("Quest not found", 404)

    if quest['payment_method'] != 'out_of_band':
        error("This quest does not use out-of-band payment")
    if quest['status'] != 'submitted':
        error("Quest must be submitted before confirming payment")

    is_poster = quest['poster_id'] == user_id
    is_claimer = quest['claimer_id'] == user_id

    if not is_poster and not is_claimer:
        error("You are not a participant in this quest")

    if is_poster:
        db.execute("UPDATE quests SET poster_payment_confirmed = 1 WHERE id = ?", [quest_id])
    if is_claimer:
        db.execute("UPDATE quests SET claimer_payment_confirmed = 1 WHERE id = ?", [quest_id])
    db.commit()

    # Re-fetch to check both confirmed
    quest = db.execute("SELECT * FROM quests WHERE id = ?", [quest_id]).fetchone()
    if quest['poster_payment_confirmed'] and quest['claimer_payment_confirmed']:
        result = do_approve_quest(db, quest_id)
        respond({"quest": result, "auto_approved": True})
    else:
        quest = db.execute("""
            SELECT q.*, u.username as poster_username, c.username as claimer_username
            FROM quests q
            JOIN users u ON q.poster_id = u.id
            LEFT JOIN users c ON q.claimer_id = c.id
            WHERE q.id = ?
        """, [quest_id]).fetchone()
        respond({"quest": dict(quest), "auto_approved": False})

def handle_my_quests(db, params):
    user_id = get_user_id(params=params)

    posted = db.execute("""
        SELECT q.*, u.username as poster_username, c.username as claimer_username
        FROM quests q
        JOIN users u ON q.poster_id = u.id
        LEFT JOIN users c ON q.claimer_id = c.id
        WHERE q.poster_id = ?
        ORDER BY q.created_at DESC
    """, [user_id]).fetchall()

    claimed = db.execute("""
        SELECT q.*, u.username as poster_username, c.username as claimer_username
        FROM quests q
        JOIN users u ON q.poster_id = u.id
        LEFT JOIN users c ON q.claimer_id = c.id
        WHERE q.claimer_id = ?
        ORDER BY q.claimed_at DESC
    """, [user_id]).fetchall()

    posted_list = []
    for r in posted:
        q = dict(r)
        if q['status'] == 'posted':
            q['current_reward'] = calc_current_reward(q)
        posted_list.append(q)

    claimed_list = []
    for r in claimed:
        q = dict(r)
        claimed_list.append(q)

    respond({"posted": posted_list, "claimed": claimed_list})

def handle_wallet(db, params):
    user_id = get_user_id(params=params)

    user = db.execute("SELECT * FROM users WHERE id = ?", [user_id]).fetchone()
    if not user:
        error("User not found", 404)

    escrowed = get_escrowed(db, user_id)

    transactions = db.execute("""
        SELECT t.*,
               fu.username as from_username,
               tu.username as to_username,
               q.title as quest_title
        FROM transactions t
        LEFT JOIN users fu ON t.from_user_id = fu.id
        LEFT JOIN users tu ON t.to_user_id = tu.id
        LEFT JOIN quests q ON t.quest_id = q.id
        WHERE t.from_user_id = ? OR t.to_user_id = ?
        ORDER BY t.created_at DESC
    """, [user_id, user_id]).fetchall()

    respond({
        "balance": user['balance'],
        "escrowed": escrowed,
        "available": round(user['balance'] - escrowed, 2),
        "wallet_address": user['wallet_address'],
        "hot_wallet_address": HOT_WALLET_ADDRESS,
        "hot_wallet_note": HOT_WALLET_NOTE,
        "transactions": [dict(t) for t in transactions]
    })

def handle_profile(db, params):
    user_id = get_user_id(params=params)

    user = db.execute("SELECT * FROM users WHERE id = ?", [user_id]).fetchone()
    if not user:
        error("User not found", 404)

    escrowed = get_escrowed(db, user_id)

    posted_count = db.execute(
        "SELECT COUNT(*) as c FROM quests WHERE poster_id = ?", [user_id]
    ).fetchone()['c']

    completed_count = db.execute(
        "SELECT COUNT(*) as c FROM quests WHERE claimer_id = ? AND status = 'approved'", [user_id]
    ).fetchone()['c']

    respond({
        "user_id": user['id'],
        "username": user['username'],
        "wallet_address": user['wallet_address'],
        "balance": user['balance'],
        "escrowed": escrowed,
        "available": round(user['balance'] - escrowed, 2),
        "is_admin": bool(user['is_admin']),
        "quests_posted": posted_count,
        "quests_completed": completed_count,
        "created_at": user['created_at']
    })

# ============================================================
# HOT WALLET ENDPOINTS
# ============================================================

def handle_hot_wallet(db, params):
    data = {
        "address": HOT_WALLET_ADDRESS,
        "note": HOT_WALLET_NOTE,
        "network": "Base L2",
        "token": "USDC",
        "auto_withdraw_enabled": HOT_WALLET_PRIVATE_KEY is not None,
    }
    respond(data)

def handle_hot_wallet_status(db, params):
    """Admin-only: check hot wallet on-chain balances and config status."""
    user_id = params.get('user_id')
    if not user_id:
        error("Authentication required", 401)
    require_admin(db, user_id)

    status = {
        "address": HOT_WALLET_ADDRESS,
        "auto_withdraw_configured": HOT_WALLET_PRIVATE_KEY is not None,
        "rpc_url": BASE_RPC_URL,
        "usdc_contract": USDC_CONTRACT_ADDRESS,
        "usdc_balance": None,
        "eth_balance": None,
        "error": None,
    }

    if HOT_WALLET_PRIVATE_KEY:
        try:
            from web3 import Web3
            w3 = Web3(Web3.HTTPProvider(BASE_RPC_URL))
            if not w3.is_connected():
                status['error'] = 'Cannot connect to Base RPC'
            else:
                account = w3.eth.account.from_key(HOT_WALLET_PRIVATE_KEY)
                status['address'] = account.address  # derived from key
                usdc = w3.eth.contract(
                    address=w3.to_checksum_address(USDC_CONTRACT_ADDRESS),
                    abi=ERC20_ABI
                )
                raw_balance = usdc.functions.balanceOf(account.address).call()
                status['usdc_balance'] = round(raw_balance / (10 ** USDC_DECIMALS), 2)
                eth_wei = w3.eth.get_balance(account.address)
                status['eth_balance'] = round(float(w3.from_wei(eth_wei, 'ether')), 6)
        except ImportError:
            status['error'] = 'web3 package not installed'
        except Exception as e:
            status['error'] = str(e)

    respond(status)

def handle_create_fund_request(db, body):
    user_id = get_user_id(body)
    req_type = body.get('type')  # 'deposit' or 'withdraw'
    amount = float(body.get('amount', 0))
    tx_hash = body.get('tx_hash', '').strip()
    external_address = body.get('external_address', '').strip()
    method = body.get('method', 'crypto')
    note = body.get('note', '').strip()

    if req_type not in ('deposit', 'withdraw'):
        error("Type must be 'deposit' or 'withdraw'")
    if amount <= 0:
        error("Amount must be positive")

    if req_type == 'withdraw':
        if not external_address:
            error("External wallet address / payment info required for withdrawals")
        # Check user has sufficient available balance
        user = db.execute("SELECT * FROM users WHERE id = ?", [user_id]).fetchone()
        escrowed = get_escrowed(db, user_id)
        available = user['balance'] - escrowed
        if amount > available:
            error(f"Insufficient available balance. Available: {available:.2f} USDC")

    valid_methods = ['crypto', 'cashapp', 'venmo', 'zelle', 'other']
    if method not in valid_methods:
        method = 'other'

    db.execute("""
        INSERT INTO fund_requests (user_id, type, amount, tx_hash, external_address, method, note)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    """, [user_id, req_type, amount, tx_hash or None, external_address or None, method, note or None])
    db.commit()

    respond({"message": f"{req_type.capitalize()} request submitted for review"}, 201)

def handle_get_fund_requests(db, params):
    user_id = get_user_id(params=params)
    rows = db.execute("""
        SELECT fr.*, r.username as reviewer_username
        FROM fund_requests fr
        LEFT JOIN users r ON fr.reviewed_by = r.id
        WHERE fr.user_id = ?
        ORDER BY fr.created_at DESC
    """, [user_id]).fetchall()
    respond({"requests": [dict(r) for r in rows]})

def handle_admin_fund_requests(db, params):
    user_id = get_user_id(params=params)
    require_admin(db, user_id)
    status_filter = params.get('status', '')

    query = """
        SELECT fr.*, u.username as requester_username, r.username as reviewer_username
        FROM fund_requests fr
        JOIN users u ON fr.user_id = u.id
        LEFT JOIN users r ON fr.reviewed_by = r.id
    """
    args = []
    if status_filter:
        query += " WHERE fr.status = ?"
        args.append(status_filter)
    query += " ORDER BY fr.created_at DESC LIMIT 200"

    rows = db.execute(query, args).fetchall()
    respond({"requests": [dict(r) for r in rows]})

def handle_admin_review_fund_request(db, body):
    user_id = get_user_id(body)
    require_admin(db, user_id)

    request_id = body.get('request_id')
    action = body.get('action')  # 'approve' or 'deny'
    admin_note = body.get('admin_note', '').strip()

    if not request_id:
        error("request_id required")
    if action not in ('approve', 'deny'):
        error("action must be 'approve' or 'deny'")

    req = db.execute("SELECT * FROM fund_requests WHERE id = ?", [request_id]).fetchone()
    if not req:
        error("Request not found", 404)
    if req['status'] != 'pending':
        error("Request already reviewed")

    now = datetime.now(timezone.utc).isoformat()

    if action == 'approve':
        if req['type'] == 'deposit':
            # Credit user balance
            db.execute("UPDATE users SET balance = balance + ? WHERE id = ?", [req['amount'], req['user_id']])
            method_label = req['method'] if req['method'] else 'crypto'
            note_str = f"Deposit via {method_label}"
            if req['note']:
                note_str += f" — {req['note']}"
            db.execute("""
                INSERT INTO transactions (to_user_id, amount, type, note)
                VALUES (?, ?, 'deposit', ?)
            """, [req['user_id'], req['amount'], note_str])
        elif req['type'] == 'withdraw':
            # Debit user balance
            user = db.execute("SELECT * FROM users WHERE id = ?", [req['user_id']]).fetchone()
            escrowed = get_escrowed(db, req['user_id'])
            available = user['balance'] - escrowed
            if req['amount'] > available:
                error(f"User no longer has sufficient balance. Available: {available:.2f}")

            ext_addr = req['external_address'] if req['external_address'] else 'N/A'
            on_chain_tx_hash = None

            # Automated USDC transfer for crypto withdrawals
            if req['method'] == 'crypto' and ext_addr and ext_addr != 'N/A':
                try:
                    on_chain_tx_hash = send_usdc(ext_addr, req['amount'])
                except RuntimeError as e:
                    error(f"On-chain transfer failed: {e}")
                except Exception as e:
                    error(f"Unexpected error during transfer: {e}")

            db.execute("UPDATE users SET balance = balance - ? WHERE id = ?", [req['amount'], req['user_id']])
            note_str = f"Withdrawal to {ext_addr}"
            if req['method'] and req['method'] != 'crypto':
                note_str += f" via {req['method']}"
            if on_chain_tx_hash:
                note_str += f" | tx: {on_chain_tx_hash}"
            db.execute("""
                INSERT INTO transactions (from_user_id, amount, type, note)
                VALUES (?, ?, 'withdrawal', ?)
            """, [req['user_id'], req['amount'], note_str])

            # Store on-chain tx hash on the fund request
            if on_chain_tx_hash:
                db.execute(
                    "UPDATE fund_requests SET tx_hash = ? WHERE id = ?",
                    [on_chain_tx_hash, request_id]
                )

    result_status = 'approved' if action == 'approve' else 'denied'
    db.execute("""
        UPDATE fund_requests SET status = ?, admin_note = ?, reviewed_by = ?, reviewed_at = ?
        WHERE id = ?
    """, [result_status, admin_note or None, user_id, now, request_id])
    db.commit()

    response_data = {"message": f"Request {action}d"}
    if action == 'approve' and req['type'] == 'withdraw':
        response_data['auto_transferred'] = on_chain_tx_hash is not None
        if on_chain_tx_hash:
            response_data['tx_hash'] = on_chain_tx_hash
            response_data['explorer_url'] = f"https://basescan.org/tx/{on_chain_tx_hash}"
    respond(response_data)

def handle_admin_confirm_payment(db, body):
    """Admin force-confirms both sides of an OOB quest payment."""
    user_id = get_user_id(body)
    require_admin(db, user_id)
    quest_id = body.get('quest_id')

    if not quest_id:
        error("quest_id required")

    quest = db.execute("SELECT * FROM quests WHERE id = ?", [quest_id]).fetchone()
    if not quest:
        error("Quest not found", 404)
    if quest['payment_method'] != 'out_of_band':
        error("Not an out-of-band quest")
    if quest['status'] != 'submitted':
        error("Quest must be in submitted status")

    # Admin force-confirms both sides
    db.execute("UPDATE quests SET poster_payment_confirmed = 1, claimer_payment_confirmed = 1 WHERE id = ?", [quest_id])
    db.commit()

    # Now auto-approve
    result = do_approve_quest(db, quest_id)
    respond({"quest": result, "admin_confirmed": True})

# ============================================================
# ADMIN ENDPOINTS
# ============================================================

def handle_admin_users(db, params):
    user_id = get_user_id(params=params)
    require_admin(db, user_id)

    users = db.execute("""
        SELECT u.id, u.username, u.balance, u.is_admin, u.created_at,
               COALESCE((SELECT SUM(max_reward) FROM quests
                         WHERE poster_id = u.id AND status IN ('posted','claimed','submitted')
                         AND payment_method = 'platform'), 0) as escrowed
        FROM users u
        ORDER BY u.created_at DESC
    """).fetchall()

    result = []
    for u in users:
        row = dict(u)
        row['available'] = round(row['balance'] - row['escrowed'], 2)
        row['is_admin'] = bool(row['is_admin'])
        result.append(row)

    respond({"users": result})

def handle_admin_toggle_admin(db, body):
    user_id = get_user_id(body)
    require_admin(db, user_id)

    target_id = body.get('target_user_id')
    if not target_id:
        error("target_user_id required")

    target = db.execute("SELECT * FROM users WHERE id = ?", [target_id]).fetchone()
    if not target:
        error("Target user not found", 404)

    new_status = 0 if target['is_admin'] else 1
    db.execute("UPDATE users SET is_admin = ? WHERE id = ?", [new_status, target_id])
    db.commit()

    respond({"user_id": target_id, "is_admin": bool(new_status)})

def handle_admin_adjust_balance(db, body):
    user_id = get_user_id(body)
    require_admin(db, user_id)

    target_id = body.get('target_user_id')
    amount = body.get('amount')
    reason = body.get('reason', 'Admin adjustment').strip()

    if not target_id:
        error("target_user_id required")
    if amount is None:
        error("amount required")

    amount = float(amount)
    target = db.execute("SELECT * FROM users WHERE id = ?", [target_id]).fetchone()
    if not target:
        error("Target user not found", 404)

    db.execute("UPDATE users SET balance = balance + ? WHERE id = ?", [amount, target_id])

    if amount > 0:
        db.execute("""
            INSERT INTO transactions (to_user_id, amount, type, note)
            VALUES (?, ?, 'admin_credit', ?)
        """, [target_id, amount, reason])
    else:
        db.execute("""
            INSERT INTO transactions (from_user_id, amount, type, note)
            VALUES (?, ?, 'admin_debit', ?)
        """, [target_id, abs(amount), reason])

    db.commit()

    new_balance = db.execute("SELECT balance FROM users WHERE id = ?", [target_id]).fetchone()['balance']
    respond({"user_id": target_id, "new_balance": new_balance, "adjustment": amount})

def handle_admin_quests(db, params):
    user_id = get_user_id(params=params)
    require_admin(db, user_id)

    rows = db.execute("""
        SELECT q.*, u.username as poster_username, c.username as claimer_username
        FROM quests q
        JOIN users u ON q.poster_id = u.id
        LEFT JOIN users c ON q.claimer_id = c.id
        ORDER BY q.created_at DESC
    """).fetchall()

    quests = []
    for r in rows:
        q = dict(r)
        if q['status'] == 'posted':
            q['current_reward'] = calc_current_reward(q)
        quests.append(q)

    respond({"quests": quests})

def handle_admin_approve_quest(db, body):
    user_id = get_user_id(body)
    require_admin(db, user_id)

    quest_id = body.get('quest_id')
    if not quest_id:
        error("quest_id required")

    result = do_approve_quest(db, quest_id)
    respond({"quest": result})

def handle_admin_dispute_quest(db, body):
    user_id = get_user_id(body)
    require_admin(db, user_id)

    quest_id = body.get('quest_id')
    dispute_reason = body.get('dispute_reason', 'Admin dispute').strip()

    if not quest_id:
        error("quest_id required")

    quest = db.execute("SELECT * FROM quests WHERE id = ?", [quest_id]).fetchone()
    if not quest:
        error("Quest not found", 404)
    if quest['status'] != 'submitted':
        error("Quest must be in submitted status to dispute")

    db.execute("""
        UPDATE quests SET status = 'disputed', dispute_reason = ? WHERE id = ?
    """, [dispute_reason, quest_id])
    db.commit()

    quest = db.execute("""
        SELECT q.*, u.username as poster_username, c.username as claimer_username
        FROM quests q
        JOIN users u ON q.poster_id = u.id
        LEFT JOIN users c ON q.claimer_id = c.id
        WHERE q.id = ?
    """, [quest_id]).fetchone()

    respond({"quest": dict(quest)})

def handle_admin_cancel_quest(db, body):
    user_id = get_user_id(body)
    require_admin(db, user_id)

    quest_id = body.get('quest_id')
    if not quest_id:
        error("quest_id required")

    quest = db.execute("SELECT * FROM quests WHERE id = ?", [quest_id]).fetchone()
    if not quest:
        error("Quest not found", 404)
    if quest['status'] in ('approved', 'cancelled'):
        error("Quest cannot be cancelled in current status")

    # Refund escrow if platform payment
    if quest['payment_method'] == 'platform' and quest['status'] in ('posted', 'claimed', 'submitted', 'disputed'):
        db.execute("""
            INSERT INTO transactions (to_user_id, quest_id, amount, type, note)
            VALUES (?, ?, ?, 'refund', 'Admin cancellation refund')
        """, [quest['poster_id'], quest_id, quest['max_reward']])

    db.execute("UPDATE quests SET status = 'cancelled' WHERE id = ?", [quest_id])
    db.commit()

    respond({"message": "Quest cancelled and escrow refunded"})

def handle_admin_edit_quest(db, body):
    user_id = get_user_id(body)
    require_admin(db, user_id)

    quest_id = body.get('quest_id')
    if not quest_id:
        error("quest_id required")

    quest = db.execute("SELECT * FROM quests WHERE id = ?", [quest_id]).fetchone()
    if not quest:
        error("Quest not found", 404)

    title = body.get('title', quest['title']).strip()
    description = body.get('description', quest['description']).strip()
    category = body.get('category', quest['category'])
    difficulty = body.get('difficulty', quest['difficulty'])
    min_reward = float(body.get('min_reward', quest['min_reward']))
    max_reward = float(body.get('max_reward', quest['max_reward']))

    valid_categories = ['Chores', 'Errands', 'Projects', 'Favors', 'Learning', 'Creative']
    if category not in valid_categories:
        error("Invalid category")

    valid_difficulties = ['Easy', 'Medium', 'Hard', 'Epic']
    if difficulty not in valid_difficulties:
        error("Invalid difficulty")

    db.execute("""
        UPDATE quests SET title=?, description=?, category=?, difficulty=?, min_reward=?, max_reward=?
        WHERE id=?
    """, [title, description, category, difficulty, min_reward, max_reward, quest_id])
    db.commit()

    quest = db.execute("""
        SELECT q.*, u.username as poster_username, c.username as claimer_username
        FROM quests q
        JOIN users u ON q.poster_id = u.id
        LEFT JOIN users c ON q.claimer_id = c.id
        WHERE q.id = ?
    """, [quest_id]).fetchone()

    respond({"quest": dict(quest)})

def handle_admin_transactions(db, params):
    user_id = get_user_id(params=params)
    require_admin(db, user_id)

    transactions = db.execute("""
        SELECT t.*,
               fu.username as from_username,
               tu.username as to_username,
               q.title as quest_title
        FROM transactions t
        LEFT JOIN users fu ON t.from_user_id = fu.id
        LEFT JOIN users tu ON t.to_user_id = tu.id
        LEFT JOIN quests q ON t.quest_id = q.id
        ORDER BY t.created_at DESC
        LIMIT 500
    """).fetchall()

    respond({"transactions": [dict(t) for t in transactions]})

def main():
    method = os.environ.get('REQUEST_METHOD', 'GET')
    path = os.environ.get('PATH_INFO', '')
    qs = os.environ.get('QUERY_STRING', '')
    params = parse_qs(qs)

    body = {}
    if method == 'POST':
        body = get_body()

    db = get_db()

    try:
        if path == '/register' and method == 'POST':
            handle_register(db, body)
        elif path == '/login' and method == 'POST':
            handle_login(db, body)
        elif path == '/quests' and method == 'GET':
            handle_get_quests(db, params)
        elif path == '/quests' and method == 'POST':
            handle_create_quest(db, body)
        elif path == '/quests/claim' and method == 'POST':
            handle_claim_quest(db, body)
        elif path == '/quests/submit' and method == 'POST':
            handle_submit_quest(db, body)
        elif path == '/quests/approve' and method == 'POST':
            handle_approve_quest(db, body)
        elif path == '/quests/dispute' and method == 'POST':
            handle_dispute_quest(db, body)
        elif path == '/quests/abandon' and method == 'POST':
            handle_abandon_quest(db, body)
        elif path == '/quests/confirm-payment' and method == 'POST':
            handle_confirm_payment(db, body)
        elif path == '/my-quests' and method == 'GET':
            handle_my_quests(db, params)
        elif path == '/wallet' and method == 'GET':
            handle_wallet(db, params)
        elif path == '/profile' and method == 'GET':
            handle_profile(db, params)
        elif path == '/hot-wallet' and method == 'GET':
            handle_hot_wallet(db, params)
        elif path == '/hot-wallet/status' and method == 'GET':
            handle_hot_wallet_status(db, params)
        elif path == '/fund-requests' and method == 'POST':
            handle_create_fund_request(db, body)
        elif path == '/fund-requests' and method == 'GET':
            handle_get_fund_requests(db, params)
        # Admin endpoints
        elif path == '/admin/users' and method == 'GET':
            handle_admin_users(db, params)
        elif path == '/admin/users/toggle-admin' and method == 'POST':
            handle_admin_toggle_admin(db, body)
        elif path == '/admin/users/adjust-balance' and method == 'POST':
            handle_admin_adjust_balance(db, body)
        elif path == '/admin/quests' and method == 'GET':
            handle_admin_quests(db, params)
        elif path == '/admin/quests/approve' and method == 'POST':
            handle_admin_approve_quest(db, body)
        elif path == '/admin/quests/dispute' and method == 'POST':
            handle_admin_dispute_quest(db, body)
        elif path == '/admin/quests/cancel' and method == 'POST':
            handle_admin_cancel_quest(db, body)
        elif path == '/admin/quests/edit' and method == 'POST':
            handle_admin_edit_quest(db, body)
        elif path == '/admin/quests/confirm-payment' and method == 'POST':
            handle_admin_confirm_payment(db, body)
        elif path == '/admin/transactions' and method == 'GET':
            handle_admin_transactions(db, params)
        elif path == '/admin/fund-requests' and method == 'GET':
            handle_admin_fund_requests(db, params)
        elif path == '/admin/fund-requests/review' and method == 'POST':
            handle_admin_review_fund_request(db, body)
        else:
            error(f"Unknown endpoint: {method} {path}", 404)
    finally:
        db.close()

if __name__ == '__main__':
    main()
