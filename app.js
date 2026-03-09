/* ============================================
   BOUNTY BOARD v2 — Main Application
   ============================================ */

(function () {
  'use strict';

  const API = `__CGI_BIN__/api.py`;

  // ---- State ----
  let currentUser = null;  // { user_id, username, wallet_address, eth_address, balance, escrowed, available, is_admin }
  let quests = [];
  let myQuests = { posted: [], claimed: [] };
  let walletData = null;
  let profileData = null;
  let currentPage = 'board';
  let currentTab = 'posted';
  let adminTab = 'users';
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
        eth_address: data.eth_address || null,
        balance: data.balance,
        escrowed: data.escrowed || 0,
        available: data.available || data.balance,
        is_admin: data.is_admin || false
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

    // Show admin link if user is admin
    if (currentUser.is_admin) {
      document.getElementById('nav-admin-link').classList.remove('hidden');
    } else {
      document.getElementById('nav-admin-link').classList.add('hidden');
    }

    navigateTo(window.location.hash.slice(1) || 'board');
  }

  function updateNavBalance() {
    document.getElementById('nav-balance-amount').textContent = formatUSDC(currentUser.available || currentUser.balance);
  }

  // ---- Routing ----
  const VALID_PAGES = ['board', 'create', 'my-quests', 'wallet', 'profile', 'admin'];

  function navigateTo(page) {
    if (!page || !VALID_PAGES.includes(page)) {
      page = 'board';
    }
    // Non-admins can't visit admin page
    if (page === 'admin' && !currentUser.is_admin) {
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
    else if (page === 'admin') loadAdminPage();
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

    let filtered = [...quests];
    const catFilter = document.getElementById('filter-category').value;
    const diffFilter = document.getElementById('filter-difficulty').value;
    const sortBy = document.getElementById('filter-sort').value;

    if (catFilter) filtered = filtered.filter(q => q.category === catFilter);
    if (diffFilter) filtered = filtered.filter(q => q.difficulty === diffFilter);

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

  function getPaymentBadgeHTML(quest) {
    if (!quest.payment_method || quest.payment_method === 'platform') {
      return `<span class="badge badge-payment-platform">Platform</span>`;
    } else {
      return `<span class="badge badge-payment-oob">Out-of-Band</span>`;
    }
  }

  function createQuestCard(quest) {
    const card = document.createElement('div');
    card.className = 'quest-card';
    card.dataset.questId = quest.id;
    const reward = calcReward(quest);
    const progress = quest.escalation_period_hours > 0
      ? Math.min(((new Date() - new Date(quest.created_at + 'Z')) / (quest.escalation_period_hours * 3600000)) * 100, 100)
      : 100;

    const isOOB = quest.payment_method === 'out_of_band';
    const rewardNote = isOOB
      ? `<span class="oob-note">Payment arranged directly</span>`
      : '';

    let adminActionsHTML = '';
    if (currentUser.is_admin) {
      adminActionsHTML = `
        <div class="admin-card-actions">
          <span class="admin-badge">Admin</span>
          <button class="btn btn-outline btn-sm admin-cancel-quest" data-quest-id="${quest.id}">Cancel</button>
        </div>
      `;
    }

    card.innerHTML = `
      <div class="quest-card-header">
        <h3 class="quest-title">${escHtml(quest.title)}</h3>
        <span class="badge badge-difficulty-${quest.difficulty}">${quest.difficulty}</span>
      </div>
      <p class="quest-description">${escHtml(quest.description)}</p>
      <div class="quest-meta">
        <span class="badge badge-category">${quest.category}</span>
        <span class="badge badge-escalation">${capitalizeFirst(quest.escalation_type)}</span>
        ${getPaymentBadgeHTML(quest)}
        <span class="quest-time">${timeRemaining(quest)}</span>
      </div>
      <div class="quest-reward ${isOOB ? 'quest-reward-oob' : ''}">
        <div class="reward-current">
          <span class="reward-label">${isOOB ? 'Agreed Reward' : 'Current Bounty'}</span>
          <span class="reward-amount" data-reward-id="${quest.id}">${formatUSDC(reward)} USDC</span>
          <span class="reward-range">${formatUSDC(quest.min_reward)} — ${formatUSDC(quest.max_reward)}</span>
          ${rewardNote}
        </div>
        ${!isOOB ? `<div class="reward-progress-bar">
          <div class="reward-progress-fill" style="width: ${progress}%"></div>
        </div>` : ''}
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
      ${adminActionsHTML}
    `;
    return card;
  }

  // Delegate click for claim buttons and admin actions on board
  document.getElementById('quest-grid').addEventListener('click', async (e) => {
    const claimBtn = e.target.closest('.claim-btn');
    const cancelBtn = e.target.closest('.admin-cancel-quest');

    if (claimBtn) {
      const questId = parseInt(claimBtn.dataset.questId);
      claimBtn.disabled = true;
      claimBtn.textContent = 'Claiming...';
      try {
        await api('/quests/claim', 'POST', { quest_id: questId });
        showToast('Quest claimed! Get to work, adventurer!', 'success');
        coinBurst(e.clientX, e.clientY);
        await refreshUserBalance();
        loadBoard();
      } catch (err) {
        showToast(err.message, 'error');
        claimBtn.disabled = false;
        claimBtn.textContent = 'Claim Quest';
      }
    }

    if (cancelBtn) {
      const questId = parseInt(cancelBtn.dataset.questId);
      showModal('Cancel Quest', `
        <p style="font-size: var(--text-sm); color: var(--color-text-muted);">
          Are you sure you want to cancel this quest? Escrow (if any) will be refunded to the poster.
        </p>
      `, [
        { label: 'Keep Quest', class: 'btn-outline', action: () => {} },
        {
          label: 'Cancel Quest', class: 'btn-danger', action: async () => {
            try {
              await api('/admin/quests/cancel', 'POST', { quest_id: questId });
              showToast('Quest cancelled.', 'info');
              loadBoard();
            } catch (err) {
              showToast(err.message, 'error');
            }
          }
        }
      ]);
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

  document.getElementById('quest-payment-method').addEventListener('change', (e) => {
    const hint = document.getElementById('payment-method-hint');
    if (e.target.value === 'out_of_band') {
      hint.textContent = 'No escrow required. Both poster and claimer confirm payment externally when quest is done.';
      hint.style.color = 'var(--color-gold)';
    } else {
      hint.textContent = 'Reward will be escrowed from your balance. Both parties confirm on-chain.';
      hint.style.color = '';
    }
  });

  function updateEscalationPreview() {
    const min = parseFloat(document.getElementById('quest-min-reward').value) || 0;
    const max = parseFloat(document.getElementById('quest-max-reward').value) || 0;
    const type = document.getElementById('quest-escalation').value;
    const period = document.getElementById('quest-period').value;

    document.getElementById('esc-label-min').textContent = `${formatUSDC(min)} USDC`;
    document.getElementById('esc-label-max').textContent = `${formatUSDC(max)} USDC`;
    document.getElementById('esc-label-time').textContent = period + 'h';

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
      escalation_period_hours: parseFloat(document.getElementById('quest-period').value),
      payment_method: document.getElementById('quest-payment-method').value
    };

    try {
      await api('/quests', 'POST', body);
      showToast('Quest posted! Adventurers will see it on the board.', 'success');
      e.target.reset();
      updateEscalationPreview();
      // Reset payment method hint
      document.getElementById('payment-method-hint').textContent = 'Reward will be escrowed from your balance. Both parties confirm on-chain.';
      document.getElementById('payment-method-hint').style.color = '';
      await refreshUserBalance();
      navigateTo('board');
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    }
  });

  // ---- My Quests Page ----
  document.querySelectorAll('.tab-btn[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn[data-tab]').forEach(b => b.classList.remove('active'));
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
      items = myQuests.posted.filter(q => q.status !== 'approved' && q.status !== 'cancelled');
    } else if (currentTab === 'claimed') {
      items = myQuests.claimed.filter(q => q.status !== 'approved' && q.status !== 'cancelled');
    } else {
      const postedCompleted = myQuests.posted.filter(q => q.status === 'approved');
      const claimedCompleted = myQuests.claimed.filter(q => q.status === 'approved');
      items = [...postedCompleted, ...claimedCompleted];
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
    const isOOB = quest.payment_method === 'out_of_band';

    if (quest.status === 'submitted' && isMyPosted) {
      if (isOOB) {
        // OOB: show payment confirmation button instead of approve
        const posterConfirmed = quest.poster_payment_confirmed;
        actionsHTML = `
          <div class="oob-confirm-section">
            <p class="oob-confirm-note">Out-of-band quest: both parties must confirm payment.</p>
            <div class="oob-confirm-status">
              <span class="confirm-status ${posterConfirmed ? 'confirmed' : 'pending'}">
                ${posterConfirmed ? '✓' : '○'} Poster (you)
              </span>
              <span class="confirm-status ${quest.claimer_payment_confirmed ? 'confirmed' : 'pending'}">
                ${quest.claimer_payment_confirmed ? '✓' : '○'} Claimer
              </span>
            </div>
            ${!posterConfirmed ? `<button class="btn btn-success btn-sm action-confirm-payment" data-quest-id="${quest.id}">Confirm I Paid</button>` : ''}
            <button class="btn btn-danger btn-sm action-dispute" data-quest-id="${quest.id}">Dispute</button>
          </div>
        `;
      } else {
        actionsHTML = `
          <button class="btn btn-success btn-sm action-approve" data-quest-id="${quest.id}">Approve</button>
          <button class="btn btn-danger btn-sm action-dispute" data-quest-id="${quest.id}">Dispute</button>
        `;
      }
    } else if ((quest.status === 'claimed' || quest.status === 'disputed') && isMyClaimed) {
      actionsHTML = `
        <button class="btn btn-gold btn-sm action-submit" data-quest-id="${quest.id}">Submit Complete</button>
        <button class="btn btn-outline btn-sm action-abandon" data-quest-id="${quest.id}">Abandon</button>
      `;
    } else if (quest.status === 'submitted' && isMyClaimed && isOOB) {
      // Claimer can also confirm OOB payment
      const claimerConfirmed = quest.claimer_payment_confirmed;
      actionsHTML = `
        <div class="oob-confirm-section">
          <p class="oob-confirm-note">Out-of-band quest: confirm you received payment.</p>
          <div class="oob-confirm-status">
            <span class="confirm-status ${quest.poster_payment_confirmed ? 'confirmed' : 'pending'}">
              ${quest.poster_payment_confirmed ? '✓' : '○'} Poster
            </span>
            <span class="confirm-status ${claimerConfirmed ? 'confirmed' : 'pending'}">
              ${claimerConfirmed ? '✓' : '○'} Claimer (you)
            </span>
          </div>
          ${!claimerConfirmed ? `<button class="btn btn-success btn-sm action-confirm-payment" data-quest-id="${quest.id}">Confirm Received</button>` : ''}
        </div>
      `;
    }

    // Admin actions on list items
    let adminActionsHTML = '';
    if (currentUser.is_admin) {
      adminActionsHTML = `
        <div class="admin-quest-actions">
          <span class="admin-badge">Admin</span>
          ${quest.status === 'submitted' ? `<button class="btn btn-success btn-sm admin-approve-quest" data-quest-id="${quest.id}">Admin Approve</button>` : ''}
          ${quest.status === 'submitted' ? `<button class="btn btn-danger btn-sm admin-dispute-quest" data-quest-id="${quest.id}">Admin Dispute</button>` : ''}
          ${!['approved','cancelled'].includes(quest.status) ? `<button class="btn btn-outline btn-sm admin-cancel-quest" data-quest-id="${quest.id}">Cancel</button>` : ''}
          <button class="btn btn-outline btn-sm admin-edit-quest" data-quest-id="${quest.id}">Edit</button>
        </div>
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
        <div style="min-width: 0; flex: 1;">
          <h4 class="quest-list-title">${escHtml(quest.title)}</h4>
          <p style="font-size: var(--text-sm); color: var(--color-text-muted); margin-top: var(--space-1);">${escHtml(quest.description)}</p>
        </div>
        <span class="badge badge-status badge-status-${quest.status}">${capitalizeFirst(quest.status)}</span>
      </div>
      <div class="quest-list-info">
        <span class="badge badge-category">${quest.category}</span>
        <span class="badge badge-difficulty-${quest.difficulty}">${quest.difficulty}</span>
        ${getPaymentBadgeHTML(quest)}
        <span style="color: var(--color-gold); font-weight: 700; font-family: var(--font-display);">
          ${lockedReward} USDC
        </span>
        ${quest.poster_username ? `<span>Posted by: ${escHtml(quest.poster_username)}</span>` : ''}
        ${quest.claimer_username ? `<span>Claimed by: ${escHtml(quest.claimer_username)}</span>` : ''}
        <span>${timeAgo(quest.created_at)}</span>
      </div>
      ${noteHTML}
      ${actionsHTML ? `<div class="quest-actions">${actionsHTML}</div>` : ''}
      ${adminActionsHTML}
    `;
    return item;
  }

  // Delegate actions for my quests
  document.getElementById('my-quests-content').addEventListener('click', async (e) => {
    const approveBtn = e.target.closest('.action-approve');
    const disputeBtn = e.target.closest('.action-dispute');
    const submitBtn = e.target.closest('.action-submit');
    const abandonBtn = e.target.closest('.action-abandon');
    const confirmPayBtn = e.target.closest('.action-confirm-payment');
    const adminApproveBtn = e.target.closest('.admin-approve-quest');
    const adminDisputeBtn = e.target.closest('.admin-dispute-quest');
    const adminCancelBtn = e.target.closest('.admin-cancel-quest');
    const adminEditBtn = e.target.closest('.admin-edit-quest');

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

    if (confirmPayBtn) {
      const questId = parseInt(confirmPayBtn.dataset.questId);
      confirmPayBtn.disabled = true;
      confirmPayBtn.textContent = 'Confirming...';
      try {
        const result = await api('/quests/confirm-payment', 'POST', { quest_id: questId });
        if (result.auto_approved) {
          showToast('Both parties confirmed! Quest approved.', 'success');
          coinBurst(e.clientX, e.clientY);
          await refreshUserBalance();
        } else {
          showToast('Payment confirmed. Waiting for other party.', 'info');
        }
        loadMyQuests();
      } catch (err) {
        showToast(err.message, 'error');
        confirmPayBtn.disabled = false;
        confirmPayBtn.textContent = 'Confirm Payment';
      }
    }

    // Admin actions on my-quests items
    if (adminApproveBtn) {
      const questId = parseInt(adminApproveBtn.dataset.questId);
      adminApproveBtn.disabled = true;
      try {
        await api('/admin/quests/approve', 'POST', { quest_id: questId });
        showToast('Quest approved by admin.', 'success');
        coinBurst(e.clientX, e.clientY);
        await refreshUserBalance();
        loadMyQuests();
      } catch (err) {
        showToast(err.message, 'error');
        adminApproveBtn.disabled = false;
      }
    }

    if (adminDisputeBtn) {
      const questId = parseInt(adminDisputeBtn.dataset.questId);
      showModal('Admin Dispute Quest', `
        <div class="form-group">
          <label for="admin-dispute-reason">Reason</label>
          <textarea id="admin-dispute-reason" class="form-input" placeholder="Admin dispute reason..."></textarea>
        </div>
      `, [
        { label: 'Cancel', class: 'btn-outline', action: () => {} },
        {
          label: 'Dispute', class: 'btn-danger', action: async () => {
            const reason = document.getElementById('admin-dispute-reason').value.trim() || 'Admin dispute';
            try {
              await api('/admin/quests/dispute', 'POST', { quest_id: questId, dispute_reason: reason });
              showToast('Quest disputed by admin.', 'info');
              loadMyQuests();
            } catch (err) {
              showToast(err.message, 'error');
            }
          }
        }
      ]);
    }

    if (adminCancelBtn) {
      const questId = parseInt(adminCancelBtn.dataset.questId);
      showModal('Admin Cancel Quest', `
        <p style="font-size: var(--text-sm); color: var(--color-text-muted);">
          Cancel this quest and refund escrow to the poster?
        </p>
      `, [
        { label: 'Keep', class: 'btn-outline', action: () => {} },
        {
          label: 'Cancel Quest', class: 'btn-danger', action: async () => {
            try {
              await api('/admin/quests/cancel', 'POST', { quest_id: questId });
              showToast('Quest cancelled by admin.', 'info');
              loadMyQuests();
            } catch (err) {
              showToast(err.message, 'error');
            }
          }
        }
      ]);
    }

    if (adminEditBtn) {
      const questId = parseInt(adminEditBtn.dataset.questId);
      const quest = [...myQuests.posted, ...myQuests.claimed].find(q => q.id === questId);
      if (!quest) return;
      showAdminEditQuestModal(quest);
    }
  });

  function showAdminEditQuestModal(quest) {
    showModal('Admin Edit Quest', `
      <div class="form-group">
        <label for="admin-edit-title">Title</label>
        <input id="admin-edit-title" class="form-input" value="${escHtml(quest.title)}">
      </div>
      <div class="form-group" style="margin-top: var(--space-3);">
        <label for="admin-edit-desc">Description</label>
        <textarea id="admin-edit-desc" class="form-input">${escHtml(quest.description)}</textarea>
      </div>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); margin-top: var(--space-3);">
        <div class="form-group">
          <label for="admin-edit-min">Min Reward</label>
          <input type="number" id="admin-edit-min" class="form-input" value="${quest.min_reward}" step="0.01">
        </div>
        <div class="form-group">
          <label for="admin-edit-max">Max Reward</label>
          <input type="number" id="admin-edit-max" class="form-input" value="${quest.max_reward}" step="0.01">
        </div>
      </div>
    `, [
      { label: 'Cancel', class: 'btn-outline', action: () => {} },
      {
        label: 'Save Changes', class: 'btn-gold', action: async () => {
          try {
            await api('/admin/quests/edit', 'POST', {
              quest_id: quest.id,
              title: document.getElementById('admin-edit-title').value.trim(),
              description: document.getElementById('admin-edit-desc').value.trim(),
              min_reward: parseFloat(document.getElementById('admin-edit-min').value),
              max_reward: parseFloat(document.getElementById('admin-edit-max').value),
              category: quest.category,
              difficulty: quest.difficulty
            });
            showToast('Quest updated.', 'success');
            loadMyQuests();
          } catch (err) {
            showToast(err.message, 'error');
          }
        }
      }
    ]);
  }

  // ---- Wallet Page ----
  async function loadWallet() {
    try {
      const data = await api('/wallet');
      walletData = data;
      currentUser.balance = data.balance;
      currentUser.escrowed = data.escrowed;
      currentUser.available = data.available;
      if (data.eth_address) {
        currentUser.eth_address = data.eth_address;
      }
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
        <span class="wallet-stat-label">Platform Address</span>
        <span class="wallet-address">${walletData.wallet_address || 'N/A'}</span>
      </div>
    `;

    // Render ETH QR code
    renderEthWallet(walletData.eth_address);

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
      const isAdminCredit = tx.type === 'admin_credit';
      const isAdminDebit = tx.type === 'admin_debit';

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
      } else if (isAdminCredit) {
        iconClass = 'payment-in';
        title = 'Admin Credit';
        amountClass = 'positive';
        sign = '+';
      } else if (isAdminDebit) {
        iconClass = 'payment-out';
        title = 'Admin Debit';
        amountClass = 'negative';
        sign = '-';
      }

      const counterparty = isIncoming ? (tx.from_username || '') : (tx.to_username || '');

      const item = document.createElement('div');
      item.className = 'tx-item';
      item.innerHTML = `
        <div class="tx-icon ${iconClass}">${iconSvg}</div>
        <div class="tx-details">
          <div class="tx-title">${title}</div>
          <div class="tx-sub">
            ${tx.quest_title ? escHtml(tx.quest_title) : (tx.note ? escHtml(tx.note) : '')}
            ${counterparty ? ` &middot; ${escHtml(counterparty)}` : ''}
          </div>
        </div>
        <span class="tx-amount ${amountClass}">${sign}${formatUSDC(tx.amount)}</span>
        <span class="tx-time">${timeAgo(tx.created_at)}</span>
      `;
      txList.appendChild(item);
    });
  }

  function renderEthWallet(ethAddress) {
    const qrContainer = document.getElementById('qr-code-container');
    const ethAddrText = document.getElementById('eth-address-text');
    const fundCard = document.getElementById('fund-wallet-card');

    if (!ethAddress) {
      if (ethAddrText) ethAddrText.textContent = 'Not available';
      if (qrContainer) qrContainer.innerHTML = '<p class="qr-placeholder">No ETH address on file.</p>';
      return;
    }

    if (ethAddrText) ethAddrText.textContent = ethAddress;

    if (qrContainer && typeof qrcode !== 'undefined') {
      try {
        const qr = qrcode(0, 'M');
        qr.addData(ethAddress);
        qr.make();
        qrContainer.innerHTML = qr.createSvgTag({ scalable: true });
        const svgEl = qrContainer.querySelector('svg');
        if (svgEl) {
          svgEl.style.width = '160px';
          svgEl.style.height = '160px';
          svgEl.style.borderRadius = '8px';
        }
      } catch (err) {
        qrContainer.innerHTML = `<p class="qr-placeholder">${ethAddress}</p>`;
      }
    } else if (qrContainer) {
      qrContainer.innerHTML = `<p class="qr-placeholder">${ethAddress}</p>`;
    }
  }

  // ---- Profile Page ----
  async function loadProfile() {
    try {
      const data = await api('/profile');
      profileData = data;
      currentUser.balance = data.balance;
      currentUser.escrowed = data.escrowed;
      currentUser.available = data.available;
      currentUser.is_admin = data.is_admin || false;
      updateNavBalance();
      renderProfile();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  function renderProfile() {
    if (!profileData) return;

    const card = document.getElementById('profile-card');

    const adminBadge = profileData.is_admin
      ? `<span class="badge badge-admin">Admin</span>`
      : '';

    card.innerHTML = `
      <div class="profile-header">
        <div class="profile-avatar">
          <svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        </div>
        <div>
          <h3 class="profile-name">${escHtml(profileData.username)} ${adminBadge}</h3>
          <p class="profile-joined">Joined ${new Date(profileData.created_at + 'Z').toLocaleDateString()}</p>
          <p class="wallet-address" style="margin-top: var(--space-1);">${profileData.wallet_address || ''}</p>
          ${profileData.eth_address ? `<p class="wallet-address" style="margin-top: var(--space-1); color: var(--color-gold-hover);">ETH: ${profileData.eth_address}</p>` : ''}
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

  // ---- Admin Page ----
  document.querySelectorAll('.tab-btn[data-admin-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn[data-admin-tab]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      adminTab = btn.dataset.adminTab;
      showAdminTab(adminTab);
    });
  });

  function showAdminTab(tab) {
    document.querySelectorAll('.admin-tab-content').forEach(el => el.classList.add('hidden'));
    const tabEl = document.getElementById(`admin-tab-${tab}`);
    if (tabEl) tabEl.classList.remove('hidden');
  }

  async function loadAdminPage() {
    if (!currentUser || !currentUser.is_admin) {
      navigateTo('board');
      return;
    }
    showAdminTab(adminTab);
    loadAdminUsers();
    loadAdminQuests();
    loadAdminTransactions();
  }

  async function loadAdminUsers() {
    try {
      const data = await api('/admin/users');
      renderAdminUsers(data.users);
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  function renderAdminUsers(users) {
    const tbody = document.getElementById('admin-users-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    users.forEach(u => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${u.id}</td>
        <td class="admin-td-username">${escHtml(u.username)}</td>
        <td>${formatUSDC(u.balance)}</td>
        <td>${formatUSDC(u.available)}</td>
        <td class="admin-td-eth"><code class="eth-addr-short">${u.eth_address ? u.eth_address.slice(0, 10) + '...' : 'N/A'}</code></td>
        <td>
          <span class="badge ${u.is_admin ? 'badge-admin' : 'badge-status-posted'}">${u.is_admin ? 'Admin' : 'User'}</span>
        </td>
        <td class="admin-td-actions">
          <button class="btn btn-outline btn-sm admin-toggle-admin" data-user-id="${u.id}" data-is-admin="${u.is_admin}">
            ${u.is_admin ? 'Remove Admin' : 'Make Admin'}
          </button>
          <button class="btn btn-outline btn-sm admin-adjust-bal" data-user-id="${u.id}">Adjust Balance</button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  }

  document.getElementById('admin-users-tbody').addEventListener('click', async (e) => {
    const toggleBtn = e.target.closest('.admin-toggle-admin');
    const adjustBtn = e.target.closest('.admin-adjust-bal');

    if (toggleBtn) {
      const userId = parseInt(toggleBtn.dataset.userId);
      toggleBtn.disabled = true;
      try {
        await api('/admin/users/toggle-admin', 'POST', { target_user_id: userId });
        showToast('Admin status toggled.', 'success');
        loadAdminUsers();
      } catch (err) {
        showToast(err.message, 'error');
        toggleBtn.disabled = false;
      }
    }

    if (adjustBtn) {
      const userId = parseInt(adjustBtn.dataset.userId);
      showModal('Adjust Balance', `
        <div class="form-group">
          <label for="adjust-amount">Amount (positive to add, negative to subtract)</label>
          <input type="number" id="adjust-amount" class="form-input" placeholder="e.g. 100 or -50" step="0.01">
        </div>
        <div class="form-group" style="margin-top: var(--space-3);">
          <label for="adjust-reason">Reason</label>
          <input type="text" id="adjust-reason" class="form-input" placeholder="Admin adjustment reason...">
        </div>
      `, [
        { label: 'Cancel', class: 'btn-outline', action: () => {} },
        {
          label: 'Apply', class: 'btn-gold', action: async () => {
            const amount = parseFloat(document.getElementById('adjust-amount').value);
            const reason = document.getElementById('adjust-reason').value.trim() || 'Admin adjustment';
            if (isNaN(amount)) { showToast('Enter a valid amount', 'error'); return; }
            try {
              await api('/admin/users/adjust-balance', 'POST', { target_user_id: userId, amount, reason });
              showToast(`Balance adjusted by ${amount > 0 ? '+' : ''}${amount.toFixed(2)} USDC.`, 'success');
              loadAdminUsers();
            } catch (err) {
              showToast(err.message, 'error');
            }
          }
        }
      ]);
    }
  });

  async function loadAdminQuests() {
    try {
      const data = await api('/admin/quests');
      renderAdminQuests(data.quests);
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  function renderAdminQuests(quests) {
    const container = document.getElementById('admin-quests-list');
    if (!container) return;
    container.innerHTML = '';

    if (!quests || quests.length === 0) {
      container.innerHTML = '<p class="text-muted text-center" style="padding: var(--space-8);">No quests found.</p>';
      return;
    }

    quests.forEach(quest => {
      const item = document.createElement('div');
      item.className = 'admin-quest-item';

      const lockedReward = quest.current_locked_reward
        ? formatUSDC(quest.current_locked_reward)
        : formatUSDC(quest.max_reward);

      item.innerHTML = `
        <div class="admin-quest-item-header">
          <div style="flex: 1; min-width: 0;">
            <strong class="quest-list-title">${escHtml(quest.title)}</strong>
            <p style="font-size: var(--text-xs); color: var(--color-text-muted); margin-top: 2px;">
              ${escHtml(quest.poster_username)} → ${quest.claimer_username ? escHtml(quest.claimer_username) : 'Unclaimed'}
            </p>
          </div>
          <div style="display: flex; align-items: center; gap: var(--space-2); flex-shrink: 0;">
            <span class="badge badge-status badge-status-${quest.status}">${capitalizeFirst(quest.status)}</span>
            ${getPaymentBadgeHTML(quest)}
            <span style="color: var(--color-gold); font-weight: 700; font-size: var(--text-sm);">${lockedReward} USDC</span>
          </div>
        </div>
        <div class="admin-quest-item-actions">
          ${quest.status === 'submitted' ? `<button class="btn btn-success btn-sm admin-approve-quest" data-quest-id="${quest.id}">Approve</button>` : ''}
          ${quest.status === 'submitted' ? `<button class="btn btn-danger btn-sm admin-dispute-quest" data-quest-id="${quest.id}">Dispute</button>` : ''}
          ${!['approved','cancelled'].includes(quest.status) ? `<button class="btn btn-outline btn-sm admin-cancel-quest" data-quest-id="${quest.id}">Cancel</button>` : ''}
          <button class="btn btn-outline btn-sm admin-edit-quest" data-quest-id="${quest.id}" data-quest='${JSON.stringify({id:quest.id,title:quest.title,description:quest.description,category:quest.category,difficulty:quest.difficulty,min_reward:quest.min_reward,max_reward:quest.max_reward})}'>Edit</button>
        </div>
      `;
      container.appendChild(item);
    });
  }

  document.getElementById('admin-quests-list').addEventListener('click', async (e) => {
    const approveBtn = e.target.closest('.admin-approve-quest');
    const disputeBtn = e.target.closest('.admin-dispute-quest');
    const cancelBtn = e.target.closest('.admin-cancel-quest');
    const editBtn = e.target.closest('.admin-edit-quest');

    if (approveBtn) {
      const questId = parseInt(approveBtn.dataset.questId);
      approveBtn.disabled = true;
      try {
        await api('/admin/quests/approve', 'POST', { quest_id: questId });
        showToast('Quest approved.', 'success');
        coinBurst(e.clientX, e.clientY);
        await refreshUserBalance();
        loadAdminQuests();
      } catch (err) {
        showToast(err.message, 'error');
        approveBtn.disabled = false;
      }
    }

    if (disputeBtn) {
      const questId = parseInt(disputeBtn.dataset.questId);
      showModal('Admin Dispute Quest', `
        <div class="form-group">
          <label for="admin-dispute-reason-2">Reason</label>
          <textarea id="admin-dispute-reason-2" class="form-input" placeholder="Admin dispute reason..."></textarea>
        </div>
      `, [
        { label: 'Cancel', class: 'btn-outline', action: () => {} },
        {
          label: 'Dispute', class: 'btn-danger', action: async () => {
            const reason = document.getElementById('admin-dispute-reason-2').value.trim() || 'Admin dispute';
            try {
              await api('/admin/quests/dispute', 'POST', { quest_id: questId, dispute_reason: reason });
              showToast('Quest disputed by admin.', 'info');
              loadAdminQuests();
            } catch (err) {
              showToast(err.message, 'error');
            }
          }
        }
      ]);
    }

    if (cancelBtn) {
      const questId = parseInt(cancelBtn.dataset.questId);
      showModal('Cancel Quest', `
        <p style="font-size: var(--text-sm); color: var(--color-text-muted);">
          Cancel this quest and refund any escrow to the poster?
        </p>
      `, [
        { label: 'Keep', class: 'btn-outline', action: () => {} },
        {
          label: 'Cancel Quest', class: 'btn-danger', action: async () => {
            try {
              await api('/admin/quests/cancel', 'POST', { quest_id: questId });
              showToast('Quest cancelled.', 'info');
              loadAdminQuests();
            } catch (err) {
              showToast(err.message, 'error');
            }
          }
        }
      ]);
    }

    if (editBtn) {
      const quest = JSON.parse(editBtn.dataset.quest);
      showAdminEditQuestModalAdmin(quest);
    }
  });

  function showAdminEditQuestModalAdmin(quest) {
    showModal('Admin Edit Quest', `
      <div class="form-group">
        <label for="admin-edit-title-2">Title</label>
        <input id="admin-edit-title-2" class="form-input" value="${escHtml(quest.title)}">
      </div>
      <div class="form-group" style="margin-top: var(--space-3);">
        <label for="admin-edit-desc-2">Description</label>
        <textarea id="admin-edit-desc-2" class="form-input">${escHtml(quest.description)}</textarea>
      </div>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); margin-top: var(--space-3);">
        <div class="form-group">
          <label for="admin-edit-min-2">Min Reward</label>
          <input type="number" id="admin-edit-min-2" class="form-input" value="${quest.min_reward}" step="0.01">
        </div>
        <div class="form-group">
          <label for="admin-edit-max-2">Max Reward</label>
          <input type="number" id="admin-edit-max-2" class="form-input" value="${quest.max_reward}" step="0.01">
        </div>
      </div>
    `, [
      { label: 'Cancel', class: 'btn-outline', action: () => {} },
      {
        label: 'Save Changes', class: 'btn-gold', action: async () => {
          try {
            await api('/admin/quests/edit', 'POST', {
              quest_id: quest.id,
              title: document.getElementById('admin-edit-title-2').value.trim(),
              description: document.getElementById('admin-edit-desc-2').value.trim(),
              min_reward: parseFloat(document.getElementById('admin-edit-min-2').value),
              max_reward: parseFloat(document.getElementById('admin-edit-max-2').value),
              category: quest.category,
              difficulty: quest.difficulty
            });
            showToast('Quest updated.', 'success');
            loadAdminQuests();
          } catch (err) {
            showToast(err.message, 'error');
          }
        }
      }
    ]);
  }

  async function loadAdminTransactions() {
    try {
      const data = await api('/admin/transactions');
      renderAdminTransactions(data.transactions);
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  function renderAdminTransactions(transactions) {
    const tbody = document.getElementById('admin-tx-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    if (!transactions || transactions.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; color: var(--color-text-muted); padding: var(--space-6);">No transactions.</td></tr>';
      return;
    }
    transactions.forEach(tx => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${tx.id}</td>
        <td><span class="badge badge-tx-${tx.type}">${tx.type}</span></td>
        <td>${tx.from_username ? escHtml(tx.from_username) : '—'}</td>
        <td>${tx.to_username ? escHtml(tx.to_username) : '—'}</td>
        <td>${tx.quest_title ? escHtml(tx.quest_title) : '—'}</td>
        <td style="font-weight: 700; color: var(--color-gold);">${formatUSDC(tx.amount)}</td>
        <td>${tx.note ? escHtml(tx.note) : '—'}</td>
        <td>${timeAgo(tx.created_at)}</td>
      `;
      tbody.appendChild(tr);
    });
  }

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
