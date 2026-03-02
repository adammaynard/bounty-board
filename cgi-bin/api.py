#!/usr/bin/env python3
import json, os, sys, sqlite3, hashlib, time, random, string
from datetime import datetime, timezone

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data.db')

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
            balance REAL DEFAULT 1000.0,
            created_at TEXT DEFAULT (datetime('now'))
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
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (from_user_id) REFERENCES users(id),
            FOREIGN KEY (to_user_id) REFERENCES users(id),
            FOREIGN KEY (quest_id) REFERENCES quests(id)
        );
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

def get_escrowed(db, user_id):
    row = db.execute("""
        SELECT COALESCE(SUM(max_reward), 0) as escrowed
        FROM quests
        WHERE poster_id = ? AND status IN ('posted', 'claimed', 'submitted')
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
        "INSERT INTO users (username, password_hash, wallet_address, balance) VALUES (?, ?, ?, 1000.0)",
        [username, pw_hash, wallet]
    )
    db.commit()
    
    user = db.execute("SELECT * FROM users WHERE username = ?", [username]).fetchone()
    respond({
        "user_id": user['id'],
        "username": user['username'],
        "wallet_address": user['wallet_address'],
        "balance": user['balance'],
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
    
    user = db.execute("SELECT * FROM users WHERE id = ?", [user_id]).fetchone()
    if not user:
        error("User not found", 404)
    
    escrowed = get_escrowed(db, user_id)
    available = user['balance'] - escrowed
    
    if max_reward > available:
        error(f"Insufficient funds. Available: {available:.2f} USDC, Required escrow: {max_reward:.2f} USDC")
    
    db.execute("""
        INSERT INTO quests (poster_id, title, description, category, difficulty, 
                           min_reward, max_reward, escalation_type, escalation_period_hours, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'posted')
    """, [user_id, title, description, category, difficulty, min_reward, max_reward, 
          escalation_type, escalation_period_hours])
    
    quest_id = db.execute("SELECT last_insert_rowid()").fetchone()[0]
    
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
    
    # Refund the difference between max_reward and locked reward back to poster's available
    # Actually, the escrow stays at max_reward until completion. On approval, only locked amount transfers.
    # The difference is "returned" by reducing the escrow entry. Let's keep it simple:
    # Escrow is based on max_reward for posted quests, but for claimed quests we still track max_reward.
    # On approval, we transfer current_locked_reward and refund (max - locked).
    
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
    if quest['status'] != 'submitted':
        error("Quest must be in submitted status to approve")
    
    locked_reward = quest['current_locked_reward']
    max_reward = quest['max_reward']
    claimer_id = quest['claimer_id']
    poster_id = quest['poster_id']
    now = datetime.now(timezone.utc).isoformat()
    
    # Transfer locked reward from poster to claimer
    db.execute("UPDATE users SET balance = balance - ? WHERE id = ?", [locked_reward, poster_id])
    db.execute("UPDATE users SET balance = balance + ? WHERE id = ?", [locked_reward, claimer_id])
    
    # Record payment transaction
    db.execute("""
        INSERT INTO transactions (from_user_id, to_user_id, quest_id, amount, type)
        VALUES (?, ?, ?, ?, 'payment')
    """, [poster_id, claimer_id, quest_id, locked_reward])
    
    # If max_reward > locked_reward, refund the difference
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
    
    respond({"quest": dict(quest)})

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
                         completion_note = NULL, dispute_reason = NULL
        WHERE id = ?
    """, [quest_id])
    db.commit()
    
    respond({"message": "Quest abandoned and returned to board"})

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
        "quests_posted": posted_count,
        "quests_completed": completed_count,
        "created_at": user['created_at']
    })

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
        elif path == '/my-quests' and method == 'GET':
            handle_my_quests(db, params)
        elif path == '/wallet' and method == 'GET':
            handle_wallet(db, params)
        elif path == '/profile' and method == 'GET':
            handle_profile(db, params)
        else:
            error(f"Unknown endpoint: {method} {path}", 404)
    finally:
        db.close()

if __name__ == '__main__':
    main()
