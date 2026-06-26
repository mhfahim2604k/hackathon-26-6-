/* QueueStorm Investigator — frontend logic */

(function () {
  'use strict';

  const BACKEND = 'http://localhost:8000';

  // ---------- DOM refs ----------
  const $ = (sel) => document.querySelector(sel);
  const form = $('#ticketForm');
  const submitBtn = $('#submitBtn');
  const spinner = $('#spinner');
  const txnList = $('#txnList');
  const addTxnBtn = $('#addTxnBtn');
  const txnTemplate = $('#txnRowTemplate');

  const statusPill = $('#statusPill');
  const statusDot = $('#statusDot');
  const statusText = $('#statusText');

  const resultEmpty = $('#resultEmpty');
  const resultError = $('#resultError');
  const resultBody = $('#resultBody');
  const chipsRow = $('#chipsRow');
  const kvTxn = $('#kvTxn');
  const kvConfidence = $('#kvConfidence');
  const agentSummary = $('#agentSummary');
  const recommendedAction = $('#recommendedAction');
  const customerReply = $('#customerReply');
  const reasonSection = $('#reasonSection');
  const reasonCodes = $('#reasonCodes');
  const violationSection = $('#violationSection');
  const violationList = $('#violationList');

  // ---------- Backend health ----------
  async function checkBackend() {
    try {
      const res = await fetch(`${BACKEND}/health`, { method: 'GET' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data && data.status === 'ok') {
        setStatus('ok', 'Backend online');
      } else {
        setStatus('bad', 'Backend responded unexpectedly');
      }
    } catch (err) {
      setStatus('bad', 'Backend unreachable');
    }
  }

  function setStatus(kind, text) {
    statusPill.classList.remove('ok', 'bad');
    if (kind) statusPill.classList.add(kind);
    statusText.textContent = text;
  }

  // ---------- Transaction rows ----------
  function addTxnRow() {
    const node = txnTemplate.content.firstElementChild.cloneNode(true);
    node.querySelector('.remove-txn').addEventListener('click', () => {
      node.remove();
      if (txnList.children.length === 0) addTxnRow();
    });
    txnList.appendChild(node);
  }

  function collectTransactions() {
    const rows = txnList.querySelectorAll('.txn-row');
    const out = [];
    for (const row of rows) {
      const get = (key) => row.querySelector(`[data-key="${key}"]`);
      const txn = {
        transaction_id: get('transaction_id').value.trim(),
        timestamp: get('timestamp').value.trim(),
        type: get('type').value,
        amount: Number(get('amount').value),
        counterparty: get('counterparty').value.trim(),
        status: get('status').value,
      };
      // Skip rows that are completely empty.
      const allEmpty = Object.values(txn).every(
        (v) => v === '' || (typeof v === 'number' && Number.isNaN(v))
      );
      if (allEmpty) continue;
      out.push(txn);
    }
    return out;
  }

  function validateTransaction(txn) {
    const errs = [];
    if (!txn.transaction_id) errs.push('transaction_id missing');
    if (!txn.timestamp) errs.push('timestamp missing');
    if (!txn.type) errs.push('type missing');
    if (!Number.isFinite(txn.amount) || txn.amount < 0) errs.push('amount invalid');
    if (!txn.counterparty) errs.push('counterparty missing');
    if (!txn.status) errs.push('status missing');
    return errs;
  }

  // ---------- Form submission ----------
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError();

    const ticket_id = $('#ticket_id').value.trim();
    const complaint = $('#complaint').value.trim();

    if (!ticket_id) return showError({ error: 'validation', message: 'ticket_id is required.' });
    if (!complaint) return showError({ error: 'empty_complaint', message: 'Customer complaint cannot be empty.' });

    const transactions = collectTransactions();
    for (const t of transactions) {
      const errs = validateTransaction(t);
      if (errs.length) {
        return showError({
          error: 'validation',
          message: `Transaction ${t.transaction_id || '(unnamed)'} is incomplete: ${errs.join(', ')}.`,
        });
      }
    }

    const body = { ticket_id, complaint };
    const language = $('#language').value;
    const channel = $('#channel').value;
    const user_type = $('#user_type').value;
    const campaign_context = $('#campaign_context').value.trim();

    if (language) body.language = language;
    if (channel) body.channel = channel;
    if (user_type) body.user_type = user_type;
    if (campaign_context) body.campaign_context = campaign_context;
    if (transactions.length) body.transaction_history = transactions;

    setBusy(true);
    try {
      const res = await fetch(`${BACKEND}/analyze-ticket`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showError(data);
        return;
      }
      renderResult(data);
    } catch (err) {
      showError({
        error: 'network_error',
        message: `Backend unreachable — is the server running on ${BACKEND}?`,
      });
    } finally {
      setBusy(false);
    }
  });

  function setBusy(busy) {
    submitBtn.disabled = busy;
    spinner.hidden = !busy;
    submitBtn.querySelector('.btn-label').textContent = busy ? 'Analyzing…' : 'Analyze ticket';
  }

  // ---------- Result rendering ----------
  function renderResult(r) {
    resultEmpty.hidden = true;
    resultError.hidden = true;
    resultBody.hidden = false;

    // Chips row: case_type, severity, evidence_verdict, department, human_review_required
    chipsRow.innerHTML = '';
    addChip(chipsRow, formatLabel(r.case_type));
    addChip(chipsRow, `severity: ${r.severity}`, `chip-severity-${r.severity}`);
    addChip(chipsRow, `verdict: ${r.evidence_verdict}`, `chip-verdict-${r.evidence_verdict}`);
    addChip(chipsRow, formatLabel(r.department));
    addChip(
      chipsRow,
      `human review: ${r.human_review_required ? 'required' : 'not required'}`,
      r.human_review_required ? 'chip-review-true' : 'chip-review-false'
    );

    // Key-value row
    kvTxn.textContent = r.relevant_transaction_id || '—';
    kvConfidence.textContent =
      typeof r.confidence === 'number' ? r.confidence.toFixed(2) : '—';

    // Cards
    agentSummary.textContent = r.agent_summary || '—';
    recommendedAction.textContent = r.recommended_next_action || '—';
    customerReply.textContent = r.customer_reply || '—';

    // Reason codes
    if (Array.isArray(r.reason_codes) && r.reason_codes.length) {
      reasonCodes.innerHTML = '';
      for (const code of r.reason_codes) addChip(reasonCodes, code, null, true);
      reasonSection.hidden = false;
    } else {
      reasonSection.hidden = true;
    }

    // Safety violations — the backend currently does not include this
    // field in the response body (it's logged server-side only), but we
    // render it if a future response shape ever includes it.
    if (Array.isArray(r.safety_violations) && r.safety_violations.length) {
      violationList.innerHTML = '';
      for (const v of r.safety_violations) {
        const li = document.createElement('li');
        li.textContent = typeof v === 'string' ? v : JSON.stringify(v);
        violationList.appendChild(li);
      }
      violationSection.hidden = false;
    } else {
      violationSection.hidden = true;
    }

    // On small screens, scroll the result into view.
    if (window.innerWidth < 980) {
      resultBody.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function addChip(parent, text, extraClass, small) {
    const span = document.createElement('span');
    span.className = 'chip';
    if (extraClass) span.classList.add(extraClass);
    if (small) parent.parentElement.classList.add('chips-small');
    span.textContent = text;
    parent.appendChild(span);
  }

  function formatLabel(s) {
    if (!s) return '—';
    return String(s).replace(/_/g, ' ');
  }

  // ---------- Error banner ----------
  function showError(err) {
    resultEmpty.hidden = true;
    resultBody.hidden = true;
    resultError.hidden = false;

    const title = err.error || 'error';
    const msg = err.message || 'Something went wrong.';

    let html = `<strong>${escapeHtml(title)}</strong>${escapeHtml(msg)}`;
    if (Array.isArray(err.issues) && err.issues.length) {
      html += '<pre>' + escapeHtml(JSON.stringify(err.issues, null, 2)) + '</pre>';
    } else if (err.details) {
      html += '<pre>' + escapeHtml(JSON.stringify(err.details, null, 2)) + '</pre>';
    }
    resultError.innerHTML = html;
  }

  function clearError() {
    resultError.hidden = true;
    resultError.innerHTML = '';
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ---------- Init ----------
  addTxnBtn.addEventListener('click', addTxnRow);
  addTxnRow(); // start with one row
  checkBackend();
})();