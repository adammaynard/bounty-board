/* ============================================
   BOUNTY BOARD — Main Application
   ============================================ */

(function () {
  'use strict';

  const API = `__CGI_BIN__/api.py`;

  // ---- State ----
  let currentUser = null;  // { user_id, username, wallet_address, balance, escrowed, available }
  let quests = [];
  let myQuests = { posted: [], claimed: [] };
  let walletData = null;
  let profileData = null;
  let currentPage = 'board';
  let currentTab = 'posted';
  let rewardTimerId = null;

  // ---- API Helpers ----
  async function api(path, method = 'GET', body = null) {
    const opts = { method, headers: {} };
    if (method === 'GET' && currentUser) {
      const sep = path.includes('?') ? '&' : '?';
      path += `${sep}user_id=${currentUser.user_id}`;
    }
    if (body) {
      opts.headers['Content-Type'] = 'application/json';
      if (currentUser && !body.user_id) {
        body.user_id = currentUser.user_id;
      }
      opts.body = JSON.stringify(body);
    }
    try {
      const res = await fetch(`${API}${path}`, opts);
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Request failed');
      }
      return data;
    } catch (e) {
      throw e;
    }
  }

  // ---- Reward Calculation (client-side) ----
  function calcReward(quest) {
    const min = quest.min_reward;
    const max = quest.max_reward;
    const type = quest.escalation_type;
    const periodH = quest.escalation_period_hours;
    const created = new Date(quest.created_at + 'Z');
    const now = new Date();
    const elapsedH = (now - created) / 3600000;
    const ratio = Math.min(elapsedH / periodH, 1);

    let current;
    if (type === 'linear') {
      current = min + (max - min) * ratio;
    } else if (type === 'exponential') {
      current = min + (max - min) * Math.pow(ratio, 2);
    } else if (type === 'stepped') {
      const steps = 5;
      const stepRatio = Math.floor(ratio * steps) / steps;
      current = min + (max - min) * stepRatio;
    } else {
      current = min;
    }
    return Math.min(current, max);
  }

  function formatUSDC(val) {
    return parseFloat(val).toFixed(2);
  }

  function timeAgo(dateStr) {
    if (!dateStr) return '';
    const date = new Date(dateStr + (dateStr.endsWith('Z') ? '' : 'Z'));
    const now = new Date();
    const diff = (now - date) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }

  function timeRemaining(quest) {
    const created = new Date(quest.created_at + (quest.created_at.endsWith('Z') ? '' : 'Z'));
    const endTime = new Date(created.getTime() + quest.escalation_period_hours * 3600000);
    const now = new Date();
    const remaining = (endTime - now) / 1000;
    if (remaining <= 0) return 'Maxed';
    if (remaining < 3600) return `${Math.floor(remaining / 60)}m left`;
    if (remaining < 86400) return `${Math.floor(remaining / 3600)}h left`;
    return `${Math.floor(remaining / 86400)}d left`;
  }

  // ---- Toast Notifications ----
  function showToast(msg, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = msg;
    container.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('removing');
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  // ---- Gold Coin Burst Animation ----
  function coinBurst(x, y) {
    const container = document.createElement('div');
    container.className = 'coin-burst';
    container.style.left = x + 'px';
    container.style.top = y + 'px';
    for (let i = 0; i < 12; i++) {
      const coin = document.createElement('div');
      coin.className = 'coin-particle';
      const angle = (Math.PI * 2 * i) / 12;
      const dist = 40 + Math.random() * 60;
      coin.style.setProperty('--tx', `${Math.cos(angle) * dist}px`);
      coin.style.setProperty('--ty', `${Math.sin(angle) * dist - 40}px`);
      container.appendChild(coin);
    }
    document.body.appendChild(container);
    setTimeout(() => container.remove(), 1000);
  }

  // ---- Modal ----
  function showModal(title, bodyHTML, actions) {
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-body').innerHTML = bodyHTML;
    const actionsEl = document.getElementById('modal-actions');
    actionsEl.innerHTML = '';
    actions.forEach(a => {
      const btn = document.createElement('button');
      btn.className = `btn ${a.class || 'btn-outline'}`;
      btn.textContent = a.label;
      btn.onclick = () => {
        a.action();
        closeModal();
      };
      actionsEl.appendChild(btn);
    });
    overlay.classList.remove('hidden');
    requestAnimationFrame(() => overlay.classList.add('visible'));
  }

  function closeModal() {
    const overlay = document.getElementById('modal-overlay');
    overlay.classList.remove('visible');
    setTimeout(() => overlay.classList.add('hidden'), 300);
  }

  document.getElementById('modal-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal();
  });

  // ---- Theme Toggle ----
  (function () {
    const toggle = document.querySelector('[data-theme-toggle]');
    const root = document.documentElement;
    let theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    root.setAttribute('data-theme', theme);
    updateThemeIcon();

    toggle.addEventListener('click', () => {
      theme = theme === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', theme);
      toggle.setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`);
      updateThemeIcon();
    });

    function updateThemeIcon() {
      toggle.innerHTML = theme === 'dark'
        ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>'
        : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
    }
  })();

  // ---- Mobile Menu ----
  document.getElementById('mobile-menu-btn').addEventListener('click', () => {
    document.getElementById('navbar-links').classList.toggle('open');
  });

  // ---- Auth ----
  let isRegister = false;

  document.getElementById('auth-toggle-btn').addEventListener('click', () => {
    isRegister = !isRegister;
    document.getElementById('auth-title').textContent = isRegister ? 'Join the Guild' : 'Enter the Guild';
    document.getElementById('auth-subtitle').textContent = isRegister ? 'Create your adventurer profile' : 'Sign in to access the quest board';
    document.getElementById('auth-btn-text').textContent = isRegister ? 'Register' : 'Sign In';
    document.getElementById('auth-toggle-text').textContent = isRegister ? 'Already a member?' : 'New adventurer?';
    document.getElementById('auth-toggle-btn').textContent = isRegister ? 'Sign In' : 'Register';
    document.getElementById('auth-error').classList.add('hidden');
  });

  document.getElementById('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('auth-error');
    errEl.classList.add('hidden');
    const username = document.getElementById('auth-username').value.trim();
    const password = document.getElementById('auth-password').value;

    try {
      const endpoint = isRegister ? '/register' : '/login';
      const data = await api(endpoint, 'POST', { username, password });
      currentUser = {
        user_id: data.user_id,
        username: data.username,
        wallet_address: data.wallet_address,
        balance: data.balance,
        escrowed: data.escrowed || 0,
        available: data.available || data.balance
      };
      enterApp();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    }
  });

  function enterApp() {
    document.getElementById('auth-screen').classList.add('hidden');
    document.getElementById('main-app').classList.remove('hidden');
    document.getElementById('nav-username').textContent = currentUser.username;
    updateNavBalance();
    navigateTo(window.location.hash.slice(1) || 'board');
  }

  function updateNavBalance() {
    document.getElementById('nav-balance-amount').textContent = formatUSDC(currentUser.available || currentUser.balance);
  }

  // ---- Routing ----
  function navigateTo(page) {
    if (!page || !['board', 'create', 'my-quests', 'wallet', 'profile'].includes(page)) {
      page = 'board';
    }
    currentPage = page;
    window.location.hash = page;

    // Hide all pages
    document.querySelectorAll('.page').forEach(p => p.classList.add('hidden'));
    const target = document.getElementById(`page-${page}`);
    if (target) target.classList.remove('hidden');

    // Update nav
    document.querySelectorAll('.nav-link').forEach(l => {
      l.classList.toggle('active', l.dataset.nav === page);
    });

    // Close mobile menu
    document.getElementById('navbar-links').classList.remove('open');

    // Load page data
    if (page === 'board') loadBoard();
    else if (page === 'create') setupCreateForm();
    else if (page === 'my-quests') loadMyQuests();
    else if (page === 'wallet') loadWallet();
    else if (page === 'profile') loadProfile();
  }

  window.addEventListener('hashchange', () => {
    const page = window.location.hash.slice(1);
    if (currentUser) navigateTo(page);
  });

  document.querySelectorAll('.nav-link').forEach(l => {
    l.addEventListener('click', (e) => {
      e.preventDefault();
      navigateTo(l.dataset.nav);
    });
  });

  // ---- Board Page ----
  async function loadBoard() {
    const grid = document.getElementById('quest-grid');
    const empty = document.getElementById('board-empty');
    const loading = document.getElementById('board-loading');

    grid.innerHTML = '';
    grid.classList.add('hidden');
    empty.classList.add('hidden');
    loading.classList.remove('hidden');

    try {
      const data = await api('/quests');
      quests = data.quests || [];
      loading.classList.add('hidden');
      renderBoard();
      startRewardTicker();
    } catch (err) {
      loading.classList.add('hidden');
      showToast(err.message, 'error');
    }
  }

  function renderBoard() {
    const grid = document.getElementById('quest-grid');
    const empty = document.getElementById('board-empty');

    // Apply filters
    let filtered = [...quests];
    const catFilter = document.getElementById('filter-category').value;
    const diffFilter = document.getElementById('filter-difficulty').value;
    const sortBy = document.getElementById('filter-sort').value;

    if (catFilter) filtered = filtered.filter(q => q.category === catFilter);
    if (diffFilter) filtered = filtered.filter(q => q.difficulty === diffFilter);

    // Sort
    if (sortBy === 'newest') {
      filtered.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    } else if (sortBy === 'highest') {
      filtered.sort((a, b) => calcReward(b) - calcReward(a));
    } else if (sortBy === 'ending') {
      filtered.sort((a, b) => {
        const aEnd = new Date(a.created_at + 'Z').getTime() + a.escalation_period_hours * 3600000;
        const bEnd = new Date(b.created_at + 'Z').getTime() + b.escalation_period_hours * 3600000;
        return aEnd - bEnd;
      });
    }

    grid.innerHTML = '';

    if (filtered.length === 0) {
      grid.classList.add('hidden');
      empty.classList.remove('hidden');
      return;
    }

    empty.classList.add('hidden');
    grid.classList.remove('hidden');

    filtered.forEach(quest => {
      grid.appendChild(createQuestCard(quest));
    });
  }

  function createQuestCard(quest) {
    const card = document.createElement('div');
    card.className = 'quest-card';
    card.dataset.questId = quest.id;
    const reward = calcReward(quest);
    const progress = quest.escalation_period_hours > 0
      ? Math.min(((new Date() - new Date(quest.created_at + 'Z')) / (quest.escalation_period_hours * 3600000)) * 100, 100)
      : 100;

    card.innerHTML = `
      <div class="quest-card-header">
        <h3 class="quest-title">${escHtml(quest.title)}</h3>
        <span class="badge badge-difficulty-${quest.difficulty}">${quest.difficulty}</span>
      </div>
      <p class="quest-description">${escHtml(quest.description)}</p>
      <div class="quest-meta">
        <span class="badge badge-category">${quest.category}</span>
        <span class="badge badge-escalation">${capitalizeFirst(quest.escalation_type)}</span>
        <span class="quest-time">${timeRemaining(quest)}</span>
      </div>
      <div class="quest-reward">
        <div class="reward-current">
          <span class="reward-label">Current Bounty</span>
          <span class="reward-amount" data-reward-id="${quest.id}">${formatUSDC(reward)} USDC</span>
          <span class="reward-range">${formatUSDC(quest.min_reward)} — ${formatUSDC(quest.max_reward)}</span>
        </div>
        <div class="reward-progress-bar">
          <div class="reward-progress-fill" style="width: ${progress}%"></div>
        </div>
      </div>
      <div class="quest-footer">
        <span class="quest-poster">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          ${escHtml(quest.poster_username)} &middot; ${timeAgo(quest.created_at)}
        </span>
        ${quest.poster_id !== currentUser.user_id
          ? `<button class="btn btn-gold btn-sm claim-btn" data-quest-id="${quest.id}">Claim Quest</button>`
          : `<span class="badge badge-status badge-status-posted">Your Quest</span>`}
      </div>
    `;
    return card;
  }

  // Delegate click for claim buttons
  document.getElementById('quest-grid').addEventListener('click', async (e) => {
    const btn = e.target.closest('.claim-btn');
    if (!btn) return;
    const questId = parseInt(btn.dataset.questId);
    btn.disabled = true;
    btn.textContent = 'Claiming...';
    try {
      await api('/quests/claim', 'POST', { quest_id: questId });
      showToast('Quest claimed! Get to work, adventurer!', 'success');
      coinBurst(e.clientX, e.clientY);
      await refreshUserBalance();
      loadBoard();
    } catch (err) {
      showToast(err.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Claim Quest';
    }
  });

  // Filters
  ['filter-category', 'filter-difficulty', 'filter-sort'].forEach(id => {
    document.getElementById(id).addEventListener('change', renderBoard);
  });

  function startRewardTicker() {
    if (rewardTimerId) clearInterval(rewardTimerId);
    rewardTimerId = setInterval(() => {
      if (currentPage !== 'board') return;
      quests.forEach(quest => {
        const el = document.querySelector(`[data-reward-id="${quest.id}"]`);
        if (el) {
          el.textContent = `${formatUSDC(calcReward(quest))} USDC`;
        }
      });
    }, 3000);
  }

  // ---- Create Quest Page ----
  function setupCreateForm() {
    updateEscalationPreview();
  }

  ['quest-min-reward', 'quest-max-reward', 'quest-escalation', 'quest-period'].forEach(id => {
    document.getElementById(id).addEventListener('change', updateEscalationPreview);
    document.getElementById(id).addEventListener('input', updateEscalationPreview);
  });

  function updateEscalationPreview() {
    const min = parseFloat(document.getElementById('quest-min-reward').value) || 0;
    const max = parseFloat(document.getElementById('quest-max-reward').value) || 0;
    const type = document.getElementById('quest-escalation').value;
    const period = document.getElementById('quest-period').value;

    document.getElementById('esc-label-min').textContent = `${formatUSDC(min)} USDC`;
    document.getElementById('esc-label-max').textContent = `${formatUSDC(max)} USDC`;
    document.getElementById('esc-label-time').textContent = period + 'h';

    // Draw curve
    const points = [];
    const areaPoints = [];
    const w = 300;
    const h = 120;
    const steps = 50;

    for (let i = 0; i <= steps; i++) {
      const ratio = i / steps;
      let value;
      if (type === 'linear') {
        value = ratio;
      } else if (type === 'exponential') {
        value = Math.pow(ratio, 2);
      } else {
        const stepCount = 5;
        value = Math.floor(ratio * stepCount) / stepCount;
      }
      const x = (i / steps) * w;
      const y = h - (value * h);
      points.push(`${i === 0 ? 'M' : 'L'}${x},${y}`);
      areaPoints.push(`${x},${y}`);
    }

    document.getElementById('esc-path').setAttribute('d', points.join(' '));
    document.getElementById('esc-area').setAttribute('d',
      `M0,${h} ${areaPoints.map((p, i) => (i === 0 ? 'L' : '') + p).join(' L')} L${w},${h} Z`
    );
  }

  document.getElementById('create-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('create-error');
    errEl.classList.add('hidden');

    const body = {
      title: document.getElementById('quest-title').value.trim(),
      description: document.getElementById('quest-description').value.trim(),
      category: document.getElementById('quest-category').value,
      difficulty: document.getElementById('quest-difficulty').value,
      min_reward: parseFloat(document.getElementById('quest-min-reward').value),
      max_reward: parseFloat(document.getElementById('quest-max-reward').value),
      escalation_type: document.getElementById('quest-escalation').value,
      escalation_period_hours: parseFloat(document.getElementById('quest-period').value)
    };

    try {
      await api('/quests', 'POST', body);
      showToast('Quest posted! Adventurers will see it on the board.', 'success');
      e.target.reset();
      updateEscalationPreview();
      await refreshUserBalance();
      navigateTo('board');
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    }
  });

  // ---- My Quests Page ----
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentTab = btn.dataset.tab;
      renderMyQuests();
    });
  });

  async function loadMyQuests() {
    try {
      const data = await api('/my-quests');
      myQuests = data;
      renderMyQuests();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  function renderMyQuests() {
    const container = document.getElementById('my-quests-content');
    const emptyEl = document.getElementById('my-quests-empty');
    const emptyTitle = document.getElementById('my-quests-empty-title');
    const emptyText = document.getElementById('my-quests-empty-text');

    let items = [];

    if (currentTab === 'posted') {
      items = myQuests.posted.filter(q => q.status !== 'approved');
    } else if (currentTab === 'claimed') {
      items = myQuests.claimed.filter(q => q.status !== 'approved');
    } else {
      // Completed = approved quests from both posted and claimed
      const postedCompleted = myQuests.posted.filter(q => q.status === 'approved');
      const claimedCompleted = myQuests.claimed.filter(q => q.status === 'approved');
      items = [...postedCompleted, ...claimedCompleted];
      // Deduplicate
      const seen = new Set();
      items = items.filter(q => {
        if (seen.has(q.id)) return false;
        seen.add(q.id);
        return true;
      });
    }

    container.innerHTML = '';

    if (items.length === 0) {
      container.classList.add('hidden');
      emptyEl.classList.remove('hidden');
      if (currentTab === 'posted') {
        emptyTitle.textContent = 'No Posted Quests';
        emptyText.textContent = 'Post a quest to see it here!';
      } else if (currentTab === 'claimed') {
        emptyTitle.textContent = 'No Active Claims';
        emptyText.textContent = 'Claim a quest from the board to get started!';
      } else {
        emptyTitle.textContent = 'No Completed Quests';
        emptyText.textContent = 'Complete quests to build your history!';
      }
      return;
    }

    emptyEl.classList.add('hidden');
    container.classList.remove('hidden');

    items.forEach(quest => {
      container.appendChild(createQuestListItem(quest));
    });
  }

  function createQuestListItem(quest) {
    const item = document.createElement('div');
    item.className = 'quest-list-item';

    const lockedReward = quest.current_locked_reward
      ? formatUSDC(quest.current_locked_reward)
      : (quest.status === 'posted' ? formatUSDC(calcReward(quest)) : formatUSDC(quest.min_reward));

    let actionsHTML = '';
    const isMyPosted = quest.poster_id === currentUser.user_id;
    const isMyClaimed = quest.claimer_id === currentUser.user_id;

    if (quest.status === 'submitted' && isMyPosted) {
      actionsHTML = `
        <button class="btn btn-success btn-sm action-approve" data-quest-id="${quest.id}">Approve</button>
        <button class="btn btn-danger btn-sm action-dispute" data-quest-id="${quest.id}">Dispute</button>
      `;
    } else if ((quest.status === 'claimed' || quest.status === 'disputed') && isMyClaimed) {
      actionsHTML = `
        <button class="btn btn-gold btn-sm action-submit" data-quest-id="${quest.id}">Submit Complete</button>
        <button class="btn btn-outline btn-sm action-abandon" data-quest-id="${quest.id}">Abandon</button>
      `;
    }

    let noteHTML = '';
    if (quest.completion_note) {
      noteHTML = `<div class="note-box"><strong>Completion Note:</strong> ${escHtml(quest.completion_note)}</div>`;
    }
    if (quest.dispute_reason) {
      noteHTML += `<div class="note-box" style="border-color: var(--color-burgundy);"><strong>Dispute Reason:</strong> ${escHtml(quest.dispute_reason)}</div>`;
    }

    item.innerHTML = `
      <div class="quest-list-header">
        <div>
          <h4 class="quest-list-title">${escHtml(quest.title)}</h4>
          <p style="font-size: var(--text-sm); color: var(--color-text-muted); margin-top: var(--space-1);">${escHtml(quest.description)}</p>
        </div>
        <span class="badge badge-status badge-status-${quest.status}">${capitalizeFirst(quest.status)}</span>
      </div>
      <div class="quest-list-info">
        <span class="badge badge-category">${quest.category}</span>
        <span class="badge badge-difficulty-${quest.difficulty}">${quest.difficulty}</span>
        <span style="color: var(--color-gold); font-weight: 700; font-family: var(--font-display);">
          ${lockedReward} USDC
        </span>
        ${quest.poster_username ? `<span>Posted by: ${escHtml(quest.poster_username)}</span>` : ''}
        ${quest.claimer_username ? `<span>Claimed by: ${escHtml(quest.claimer_username)}</span>` : ''}
        <span>${timeAgo(quest.created_at)}</span>
      </div>
      ${noteHTML}
      ${actionsHTML ? `<div class="quest-actions">${actionsHTML}</div>` : ''}
    `;
    return item;
  }

  // Delegate actions for my quests
  document.getElementById('my-quests-content').addEventListener('click', async (e) => {
    const approveBtn = e.target.closest('.action-approve');
    const disputeBtn = e.target.closest('.action-dispute');
    const submitBtn = e.target.closest('.action-submit');
    const abandonBtn = e.target.closest('.action-abandon');

    if (approveBtn) {
      const questId = parseInt(approveBtn.dataset.questId);
      approveBtn.disabled = true;
      try {
        await api('/quests/approve', 'POST', { quest_id: questId });
        showToast('Quest approved! Gold has been transferred.', 'success');
        coinBurst(e.clientX, e.clientY);
        await refreshUserBalance();
        loadMyQuests();
      } catch (err) {
        showToast(err.message, 'error');
        approveBtn.disabled = false;
      }
    }

    if (disputeBtn) {
      const questId = parseInt(disputeBtn.dataset.questId);
      showModal('Dispute Quest', `
        <p style="margin-bottom: var(--space-4); font-size: var(--text-sm); color: var(--color-text-muted);">
          Explain why the quest submission is not acceptable.
        </p>
        <div class="form-group">
          <label for="dispute-reason">Reason</label>
          <textarea id="dispute-reason" class="form-input" placeholder="Describe the issue..." required></textarea>
        </div>
      `, [
        { label: 'Cancel', class: 'btn-outline', action: () => {} },
        {
          label: 'Submit Dispute', class: 'btn-danger', action: async () => {
            const reason = document.getElementById('dispute-reason').value.trim();
            if (!reason) { showToast('Please provide a reason', 'error'); return; }
            try {
              await api('/quests/dispute', 'POST', { quest_id: questId, dispute_reason: reason });
              showToast('Quest disputed. Claimer has been notified.', 'info');
              loadMyQuests();
            } catch (err) {
              showToast(err.message, 'error');
            }
          }
        }
      ]);
    }

    if (submitBtn) {
      const questId = parseInt(submitBtn.dataset.questId);
      showModal('Submit Quest Completion', `
        <p style="margin-bottom: var(--space-4); font-size: var(--text-sm); color: var(--color-text-muted);">
          Add a note about how you completed the quest.
        </p>
        <div class="form-group">
          <label for="completion-note">Completion Note</label>
          <textarea id="completion-note" class="form-input" placeholder="Describe what you did..."></textarea>
        </div>
      `, [
        { label: 'Cancel', class: 'btn-outline', action: () => {} },
        {
          label: 'Submit', class: 'btn-gold', action: async () => {
            const note = document.getElementById('completion-note').value.trim();
            try {
              await api('/quests/submit', 'POST', { quest_id: questId, completion_note: note });
              showToast('Quest submitted for review!', 'success');
              loadMyQuests();
            } catch (err) {
              showToast(err.message, 'error');
            }
          }
        }
      ]);
    }

    if (abandonBtn) {
      const questId = parseInt(abandonBtn.dataset.questId);
      showModal('Abandon Quest?', `
        <p style="font-size: var(--text-sm); color: var(--color-text-muted);">
          Are you sure you want to abandon this quest? It will return to the board for others to claim.
        </p>
      `, [
        { label: 'Keep Quest', class: 'btn-outline', action: () => {} },
        {
          label: 'Abandon', class: 'btn-danger', action: async () => {
            try {
              await api('/quests/abandon', 'POST', { quest_id: questId });
              showToast('Quest abandoned. It has returned to the board.', 'info');
              loadMyQuests();
            } catch (err) {
              showToast(err.message, 'error');
            }
          }
        }
      ]);
    }
  });

  // ---- Wallet Page ----
  async function loadWallet() {
    try {
      const data = await api('/wallet');
      walletData = data;
      currentUser.balance = data.balance;
      currentUser.escrowed = data.escrowed;
      currentUser.available = data.available;
      updateNavBalance();
      renderWallet();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  function renderWallet() {
    if (!walletData) return;

    const statsEl = document.getElementById('wallet-stats');
    statsEl.innerHTML = `
      <div class="wallet-stat">
        <span class="wallet-stat-label">Total Balance</span>
        <span class="wallet-stat-value gold">${formatUSDC(walletData.balance)} USDC</span>
      </div>
      <div class="wallet-stat">
        <span class="wallet-stat-label">Available</span>
        <span class="wallet-stat-value green">${formatUSDC(walletData.available)} USDC</span>
      </div>
      <div class="wallet-stat">
        <span class="wallet-stat-label">Escrowed</span>
        <span class="wallet-stat-value muted">${formatUSDC(walletData.escrowed)} USDC</span>
      </div>
      <div class="wallet-stat">
        <span class="wallet-stat-label">Wallet Address</span>
        <span class="wallet-address">${walletData.wallet_address}</span>
      </div>
    `;

    const txList = document.getElementById('tx-list');
    const emptyEl = document.getElementById('wallet-empty');

    if (!walletData.transactions || walletData.transactions.length === 0) {
      txList.classList.add('hidden');
      emptyEl.classList.remove('hidden');
      return;
    }

    emptyEl.classList.add('hidden');
    txList.classList.remove('hidden');
    txList.innerHTML = '';

    walletData.transactions.forEach(tx => {
      const isIncoming = tx.to_user_id === currentUser.user_id && tx.type === 'payment';
      const isOutgoing = tx.from_user_id === currentUser.user_id && tx.type === 'payment';
      const isEscrow = tx.type === 'escrow';
      const isRefund = tx.type === 'refund';

      let iconClass = 'escrow';
      let iconSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
      let title = 'Escrow';
      let amountClass = 'negative';
      let sign = '-';

      if (isIncoming) {
        iconClass = 'payment-in';
        iconSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>';
        title = 'Payment Received';
        amountClass = 'positive';
        sign = '+';
      } else if (isOutgoing) {
        iconClass = 'payment-out';
        iconSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>';
        title = 'Payment Sent';
        amountClass = 'negative';
        sign = '-';
      } else if (isRefund) {
        iconClass = 'refund';
        iconSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>';
        title = 'Escrow Refund';
        amountClass = 'positive';
        sign = '+';
      }

      const counterparty = isIncoming ? (tx.from_username || '') : (tx.to_username || '');

      const item = document.createElement('div');
      item.className = 'tx-item';
      item.innerHTML = `
        <div class="tx-icon ${iconClass}">${iconSvg}</div>
        <div class="tx-details">
          <div class="tx-title">${title}</div>
          <div class="tx-sub">
            ${tx.quest_title ? escHtml(tx.quest_title) : ''}
            ${counterparty ? ` &middot; ${escHtml(counterparty)}` : ''}
          </div>
        </div>
        <span class="tx-amount ${amountClass}">${sign}${formatUSDC(tx.amount)}</span>
        <span class="tx-time">${timeAgo(tx.created_at)}</span>
      `;
      txList.appendChild(item);
    });
  }

  // ---- Profile Page ----
  async function loadProfile() {
    try {
      const data = await api('/profile');
      profileData = data;
      currentUser.balance = data.balance;
      currentUser.escrowed = data.escrowed;
      currentUser.available = data.available;
      updateNavBalance();
      renderProfile();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  function renderProfile() {
    if (!profileData) return;

    const card = document.getElementById('profile-card');
    const initial = profileData.username.charAt(0).toUpperCase();

    card.innerHTML = `
      <div class="profile-header">
        <div class="profile-avatar">
          <svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        </div>
        <div>
          <h3 class="profile-name">${escHtml(profileData.username)}</h3>
          <p class="profile-joined">Joined ${new Date(profileData.created_at + 'Z').toLocaleDateString()}</p>
          <p class="wallet-address" style="margin-top: var(--space-1);">${profileData.wallet_address}</p>
        </div>
      </div>
      <div class="profile-stats">
        <div class="profile-stat">
          <div class="profile-stat-value">${formatUSDC(profileData.balance)}</div>
          <div class="profile-stat-label">Total USDC</div>
        </div>
        <div class="profile-stat">
          <div class="profile-stat-value">${formatUSDC(profileData.available)}</div>
          <div class="profile-stat-label">Available</div>
        </div>
        <div class="profile-stat">
          <div class="profile-stat-value">${profileData.quests_posted}</div>
          <div class="profile-stat-label">Quests Posted</div>
        </div>
        <div class="profile-stat">
          <div class="profile-stat-value">${profileData.quests_completed}</div>
          <div class="profile-stat-label">Quests Completed</div>
        </div>
      </div>
    `;
  }

  document.getElementById('logout-btn').addEventListener('click', () => {
    currentUser = null;
    document.getElementById('main-app').classList.add('hidden');
    document.getElementById('auth-screen').classList.remove('hidden');
    document.getElementById('auth-username').value = '';
    document.getElementById('auth-password').value = '';
    document.getElementById('auth-error').classList.add('hidden');
    if (rewardTimerId) clearInterval(rewardTimerId);
  });

  // ---- Utility ----
  function escHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function capitalizeFirst(str) {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  async function refreshUserBalance() {
    try {
      const data = await api('/wallet');
      currentUser.balance = data.balance;
      currentUser.escrowed = data.escrowed;
      currentUser.available = data.available;
      updateNavBalance();
    } catch (e) {
      // silently fail
    }
  }

})();
