import { mountLearning } from './learning.js';

const $ = (selector) => document.querySelector(selector);
function el(tag, text, attrs = {}) {
  const node = document.createElement(tag);
  if (text !== null) node.textContent = text;
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}
const add = (node, ...children) => (node.append(...children), node);
const date = (value) => new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(value));
const dayTime = (value) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
const meta = (...parts) => add(el('p', null, { class: 'meta' }), ...parts.filter(Boolean).map((part) => el('span', part)));
let data, draftId, page = 0, query = '', filter = 'all', acting = false, refreshing = false, staleDashboard = false;
const size = 12;
const sections = {
  dashboard: ['Dashboard','WORKSPACE / OVERVIEW','See what needs your attention across applications, outreach, and interview prep.'],
  applications: ['Applications','WORKSPACE / TRACKING','Browse tracked opportunities and their next actions.'],
  settings: ['Settings','WORKSPACE / PREFERENCES','Manage local display preferences and check sending status.'],
  alerts: ['Job alerts', '01 / OPPORTUNITIES', 'New roles from your alerts and company boards, newest first.'],
  outreach: ['Outreach', '02 / OUTREACH', 'Review messages, manage applications, and track conversations after sending.'],
  followups: ['Follow-ups', 'OUTREACH / REMINDERS', 'Plan the next step and review previous follow-ups. No automatic notifications or email.'],
  analytics: ['Outreach analytics', 'OUTREACH / ACTIVITY', 'Counts from your saved outreach records and explicitly recorded outcomes.'],
  application: ['Application', 'OUTREACH / APPLICATION', 'See the linked posting, saved contact, and associated outreach.'],
  replies: ['Replies', '03 / INBOX', 'Read responses to your JobAgent outreach without searching through Gmail.'],
  learning: ['Learning', '04 / INTERVIEW PREP', 'Open a posting’s prep brief to see what to study first.'],
};
const route = () => location.hash.slice(1).split('/');
const tab = () => route()[0] === 'drafts' ? 'outreach' : Object.hasOwn(sections,route()[0]) ? route()[0] : 'dashboard';
function notify(message = '') { $('#message').hidden = !message; $('#message').textContent = message; }
function safePosting(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}
const closed = ['EXPIRED', 'REJECTED_BY_USER', 'CLOSED'];
function alerts(view) {
  const controls = el('div', null, { class: 'controls' });
  const search = el('input', null, { type: 'search', placeholder: 'Search roles, companies or locations…', 'aria-label': 'Search alerts' });
  search.value = query;
  const select = el('select', null, { 'aria-label': 'Filter job alerts' });
  for (const [value, title] of [['all', 'All alerts'], ['matches', `Matches (≥${data.matchThreshold})`]]) select.add(new Option(title, value));
  select.value = filter;
  const results = el('div', null);
  const renderResults = () => {
    const jobs = data.jobs.filter((j) => (filter !== 'matches' || (j.fit_score >= data.matchThreshold && !closed.includes(j.state) && j.state !== 'REJECTED')) && `${j.title} ${j.company} ${j.location}`.toLowerCase().includes(query.trim().toLowerCase()));
    const pages = Math.max(1, Math.ceil(jobs.length / size));
    page = Math.min(page, pages - 1);
    const header = add(el('div', null, { class: 'list-label' }), el('span', `${jobs.length} ${jobs.length === 1 ? 'result' : 'results'} · Last 30 days`), el('span', 'Newest first'));
    const list = el('div', null, { class: 'list' });
    for (const j of jobs.slice(page * size, (page + 1) * size)) {
      const mark = el('span', j.company.trim().split(/\s+/).slice(0, 2).map((part) => Array.from(part)[0]).join('').toUpperCase() || '—', { class: 'mark', 'aria-hidden': 'true' });
      const info = add(el('div', null), el('h2', j.title), meta(j.company, j.location, j.source === 'gmail-alert' ? 'Email alert' : j.source, date(j.first_seen_at)));
      if (j.reasoning) info.append(add(el('details', null), el('summary', 'Match notes'), el('p', j.reasoning, { class: 'why' })));
      const actions = add(el('div', null, { class: 'job-actions' }), el('span', j.fit_score === null ? 'Not scored' : `${j.fit_score}/100`, { class: `badge${j.fit_score >= data.matchThreshold ? '' : ' neutral'}` }));
      const url = safePosting(j.url);
      if (url) actions.append(el('a', ['EXPIRED', 'CLOSED'].includes(j.state) ? 'View posting ↗' : 'Apply ↗', { href: url, target: '_blank', rel: 'noopener noreferrer', class: 'button' }));
      const prep = el('button', 'Prep', { type: 'button', 'aria-label': `Prepare for ${j.title}` });
      prep.onclick = () => { location.hash = `learning/${j.id}`; };
      actions.append(prep);
      list.append(add(el('article', null, { class: 'job' }), mark, info, actions));
    }
    results.replaceChildren(header, jobs.length ? list : el('p', 'No jobs match this view.', { class: 'empty' }));
    if (pages > 1) {
      const prev = el('button', 'Previous'), next = el('button', 'Next');
      prev.disabled = page === 0; next.disabled = page === pages - 1;
      const step = (n) => { page += n; renderResults(); (n > 0 ? results.querySelector('.pager button:last-child:not(:disabled)') : results.querySelector('.pager button:first-child:not(:disabled)'))?.focus(); };
      prev.onclick = () => step(-1); next.onclick = () => step(1);
      results.append(add(el('div', null, { class: 'pager' }), prev, el('span', `${page + 1} of ${pages}`), next));
    }
  };
  search.oninput = () => { query = search.value; page = 0; renderResults(); };
  select.onchange = () => { filter = select.value; page = 0; renderResults(); };
  view.append(add(controls, search, select), results);
  renderResults();
}

const draftStatuses = [
  ['Needs Review', 'review', '◷'], ['Approved', 'approved', '✓'],
  ['Sent', 'sent', '↗'], ['Archived', 'archived', '–'],
];
const draftControls = { query: '', status: 'all', sort: 'newest', group: 'status' };
const buffers = new Map();
const trackingBuffers = new Map();
const draftFields = ({ email, subject, body }) => ({ email, subject, body });
const sameContent = (a, b) => a.email === b.email && a.subject === b.subject && a.body === b.body;
const editable = (draft) => draft.editable === 1 && draft.status === 'Needs Review' && !draft.delete_requested_at;
const canSend = (draft) => editable(draft) && !draft.local_only && data.sendingArmed && !!draft.contact_active && draft.state === 'PENDING_APPROVAL';
const actionButton = (label, onClick, className) => {
  const button = el('button', label, { type: 'button', ...(className ? { class: className } : {}) });
  button.onclick = onClick;
  return button;
};
function statusBadge(status) {
  const [, key, icon] = draftStatuses.find(([name]) => name === status) ?? ['', 'archived', '–'];
  return add(el('span', null, { class: `draft-badge ${key}` }), el('span', icon, { 'aria-hidden': 'true' }), document.createTextNode(status ?? 'Unknown'));
}
function draftStatusText(draft) {
  if (draft.delete_requested_at) return 'Deletion pending. Retry deleting this draft to finish removing it.';
  if (draft.status === 'Sent') return draft.replied_at ? 'Sent · Reply received' : 'Sent · No reply recorded';
  if (draft.status === 'Approved') return 'Approved for the scheduled sender';
  if (draft.status === 'Archived') return 'Archived · Not eligible to send';
  if (!draft.contact_active) return 'Contact is inactive';
  if (!editable(draft)) return 'This draft is no longer available to edit or queue.';
  return 'Awaiting your review';
}
async function draftRequest(draft, action, payload, { pending, reload = false, success } = {}) {
  if (acting || refreshing || staleDashboard) return;
  acting = true;
  updateRefreshButton();
  notify(pending);
  const active = document.activeElement;
  const focusId = active?.id;
  const listScroll = $('#outreachList')?.scrollTop;
  render();
  try {
    let response, result;
    try {
      response = await fetch(`/api/drafts/${draft.id}/${action}`, {
        method: 'POST',
        headers: { 'X-JobAgent-Action': action, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      result = await response.json();
    } catch {
      if (reload) staleDashboard = true;
      notify(reload ? 'Could not confirm the update. Refresh before trying again.' : 'Could not complete the request. Try again.');
      return;
    }
    if (!response.ok) {
      const message = result.message ?? `The request failed (${response.status}).`;
      if (reload && response.status >= 500) staleDashboard = true;
      if (response.status === 409 || (reload && action === 'delete')) {
        try { await loadDashboard(); } catch { staleDashboard = true; }
      }
      notify(message);
      return;
    }
    success?.(result);
    if (reload) {
      try { await loadDashboard(); }
      catch {
        staleDashboard = true;
        notify('The update succeeded, but the latest data could not load. Refresh before making another change.');
        return;
      }
    }
    notify(result.message);
  } finally {
    acting = false;
    updateRefreshButton();
    render();
    if (tab() === 'outreach') {
      if (listScroll !== undefined && $('#outreachList')) $('#outreachList').scrollTop = listScroll;
      const restoreButton = focusId && document.getElementById(focusId);
      (restoreButton && !restoreButton.disabled ? restoreButton : $('#draftDetail'))?.focus({ preventScroll: true });
    }
  }
}
const dialog = $('#confirm');
let confirmation;
function confirmDraft(draft, action) {
  const deleting = action === 'delete';
  confirmation = { draft, action };
  $('#confirmTitle').textContent = deleting ? 'Delete this draft?' : 'Review and queue this email';
  $('#confirmCopy').textContent = deleting
    ? `Permanently remove “${draft.subject}” from Gmail and JobAgent? The original job posting stays in your alerts.`
    : 'JobAgent queues this saved draft for the scheduled sender, subject to the daily cap. It does not send immediately.';
  $('#confirmPreview').hidden = deleting;
  $('#confirmPreview').replaceChildren(...(deleting ? [] : [
    el('p', `To: ${draft.email}`), el('p', `Subject: ${draft.subject}`), el('p', draft.body, { class: 'email-content' }),
  ]));
  $('#confirmReviewLabel').hidden = deleting;
  $('#confirmReview').checked = false;
  const button = $('#confirmAction');
  button.value = action;
  button.textContent = deleting ? 'Delete draft' : 'Confirm and queue';
  button.className = deleting ? 'danger solid' : 'primary';
  button.disabled = !deleting;
  dialog.returnValue = '';
  dialog.showModal();
}
$('#confirmReview').onchange = () => { $('#confirmAction').disabled = !$('#confirmReview').checked; };
$('#confirmForm').onsubmit = (event) => {
  // Close the native dialog ourselves; the page CSP deliberately forbids form submissions.
  event.preventDefault();
  const action = event.submitter?.value;
  if (action === 'send' && !$('#confirmReview').checked) return;
  dialog.close(action ?? 'cancel');
};
dialog.addEventListener('close', () => {
  const saved = confirmation;
  confirmation = undefined;
  if (!saved || saved.action !== dialog.returnValue) return;
  const { draft, action } = saved;
  const session = buffers.get(draft.id);
  if (action === 'send' && (!$('#confirmReview').checked || !canSend(draft) || session?.editing || session?.preview)) return;
  void draftRequest(draft, action, action === 'send' ? { revision: draft.revision, reviewed: true } : {}, {
    pending: action === 'delete' ? 'Checking the draft in Gmail…' : 'Updating the send queue…',
    reload: true,
    success: () => buffers.delete(draft.id),
  });
});
function draftDetails(draft, busy) {
  const section = add(el('section', null, { class: 'draft-subpanel' }), el('h3', 'Application & timeline'));
  const linked = (data.applications ?? []).find((app) => app.id === draft.application_id);
  const applicationTitle = linked?.title ?? draft.application_title;
  if (applicationTitle && draft.application_id) section.append(add(el('p', null, { class: 'application-link' }),
    el('span', 'Linked application: '), el('a', applicationTitle, { href: `#application/${draft.application_id}` })));
  else section.append(el('p', 'No application linked.', { class: 'help' }));

  const applications = data.applications ?? [];
  const choices = el('select', null, { id: 'draftApplication', 'aria-labelledby': 'draftApplicationLabel' });
  const search = el('input', null, { type:'search', placeholder:'Company or job title', 'aria-label':'Search applications' });
  const currentApplication = String(draft.application_id ?? '');
  const tracking = trackingBuffers.get(draft.id);
  const followUp = el('input', null, { id: 'draftFollowUp', type: 'date' });
  const allow = el('input', null, { type:'checkbox' });
  followUp.value = tracking?.date ?? '';
  allow.checked = !!tracking?.allow;
  const appForm = el('form', null, { class: 'application-form' });
  const save = el('button', 'Save tracking', { id: 'saveTracking', type: 'submit' });
  const syncTracking = () => {
    const changed = choices.value !== currentApplication || !!followUp.value;
    save.disabled = busy || !changed || (!!followUp.value && !draft.sent_at && !allow.checked);
    if (changed) trackingBuffers.set(draft.id, { application:choices.value,date:followUp.value,allow:allow.checked });
    else trackingBuffers.delete(draft.id);
  };
  const populate = (keep) => {
    const term = search.value.trim().toLowerCase();
    choices.replaceChildren(new Option('No application (unlink)', ''), new Option('Create from this message', 'create'));
    for (const app of applications) if (String(app.id)===keep || `${app.company} ${app.title}`.toLowerCase().includes(term))
      choices.add(new Option(`${app.title} · ${app.company}`,String(app.id)));
    choices.value=keep;
  };
  populate(tracking?.application ?? currentApplication);
  search.oninput=()=>populate(choices.value);
  appForm.oninput = syncTracking;
  syncTracking();
  choices.disabled = followUp.disabled = allow.disabled = busy;
  appForm.onsubmit = (event) => {
    event.preventDefault();
    if (save.disabled) return;
    const payload = { applicationId: choices.value && choices.value !== 'create' ? Number(choices.value) : null, create: choices.value === 'create' };
    if (followUp.value) Object.assign(payload,{followUpAt:`${followUp.value}T00:00:00.000Z`,allowUnsent:allow.checked});
    void draftRequest(draft,'application',payload,{pending:'Saving tracking…',reload:true,success:()=>trackingBuffers.delete(draft.id)});
  };
  section.append(add(appForm,search,
    add(el('label',null),el('span','Application',{id:'draftApplicationLabel'}),choices),
    add(el('label',null),el('span','Follow-up date'),followUp),
    ...(!draft.sent_at?[add(el('label',null),allow,' Allow reminder for this unsent message')]:[]),save));
  if (draft.sent_at) {
    const outcome=el('select',null,{'aria-label':'Manual outcome'});
    outcome.add(new Option('No manual outcome',''));
    for (const value of ['Awaiting Response','Replied','Interested','Interview Scheduled','Not Interested','No Response','Bounced']) outcome.add(new Option(value,value));
    outcome.value=draft.outcome??''; outcome.disabled=busy;
    const button=actionButton('Save outcome',()=>void draftRequest(draft,'outcome',{outcome:outcome.value||null},{pending:'Saving manual outcome…',reload:true}));
    button.disabled=busy;
    section.append(el('h4','Communication outcome'),el('p',`Recorded evidence: ${draft.replied_at?'Reply recorded':draft.bounced_at?'Bounce recorded':'No reply or bounce recorded'}. Manual outcomes do not replace delivery history.`,{class:'help'}),add(el('div',null,{class:'buttons'}),outcome,button));
  }

  const timeline = el('ol', null, { class:'draft-timeline', 'aria-label':'Outreach activity' });
  const items=(data.activity??[]).filter((event)=>event.outreach_id===draft.id);
  for (const event of items) timeline.append(add(el('li',null),el('span',`${event.kind} · ${event.source}${event.detail?` — ${event.detail}`:''}`),el('time',dayTime(event.at),{datetime:event.at})));
  section.append(el('h4','Activity'),items.length?timeline:el('p','No recorded activity.',{class:'help'}));
  const count=(data.followups??[]).filter((f)=>f.outreach_id===draft.id).length;
  section.append(el('a',`View follow-ups (${count})`,{href:`#followups/${draft.id}`}));
  return section;
}
function qualityPanel(result) {
  const details = add(el('section', null, { class: 'draft-subpanel', role: 'status' }), el('h3', 'Quality check'));
  const warnings = (result.warnings ?? []).map((warning) => warning.message).filter(Boolean);
  if (Array.isArray(result.duplicates) && result.duplicates.length && !result.warnings?.some((warning) => /duplicate/i.test(warning.code))) {
    warnings.push(`Found ${result.duplicates.length} possible duplicate ${result.duplicates.length === 1 ? 'message' : 'messages'}.`);
  }
  if (warnings.length) details.append(add(el('ul', null, { class: 'draft-warnings' }), ...warnings.map((warning) => el('li', warning))));
  else details.append(el('p', 'No warnings found. Still review the recipient and message before sending.', { class: 'help' }));
  if (result.mode) details.append(el('p', `Check mode: ${result.mode}`, { class: 'help' }));
  return details;
}
function renderDraft(draft, update) {
  const busy = acting || refreshing || staleDashboard;
  const session = buffers.get(draft.id);
  const editing = !!session?.editing;
  const fields = session?.fields ?? draftFields(draft);
  const dirty = !sameContent(fields, draft);
  const changedElsewhere = session?.revision !== undefined && session.revision !== draft.revision;
  const detail = add(el('article', null, { class: 'draft outreach-detail', id: 'draftDetail', tabindex: '-1', 'aria-label': 'Selected draft' }),
    add(el('div', null, { class: 'draft-heading' }), el('p', draft.company, { class: 'kicker' }), statusBadge(draft.status)),
    el('h2', draft.subject || '(No subject)'), meta(draft.title, `Drafted ${dayTime(draft.drafted_at)}`),
    el('p', draftStatusText(draft), { class: 'help draft-state' }));
  if (draft.local_only) detail.append(el('p', 'Saved locally only. This version is not synced to Gmail and cannot be queued here.', { class: 'notice warn' }));
  if (changedElsewhere || (editing && !editable(draft))) detail.append(el('p', 'This draft changed elsewhere or is now read-only. Copy your changes before discarding them.', { class: 'notice warn' }));
  const stateFor = () => {
    if (!buffers.has(draft.id)) buffers.set(draft.id, { fields: draftFields(draft), revision: draft.revision });
    return buffers.get(draft.id);
  };
  if (editing) {
    const form = el('form', null, { class: 'editor', id: 'draftEditor' });
    const save = el('button', 'Save changes', { type: 'submit', class: 'primary', id: 'saveDraft' });
    const fieldsLabel = el('p', '', { class: 'help', role: 'status' });
    const messageFields = [['email', 'Recipient', 'email'], ['subject', 'Subject', 'text'], ['body', 'Message', 'textarea']];
    const inputs = {};
    for (const [name, label, type] of messageFields) {
      const isBody = type === 'textarea';
      const input = el(isBody ? 'textarea' : 'input', null, { ...(isBody ? { rows: '11' } : { type }), maxlength: { email: 254, subject: 250, body: 20000 }[name], id: `edit-${name}`, required: '' });
      input.value = fields[name];
      input.readOnly = busy || !editable(draft) || changedElsewhere;
      inputs[name] = input;
      form.append(add(el('label', null), el('span', label), input));
    }
    const updateSave = () => {
      const hasChanges = !sameContent(session.fields, draft);
      fieldsLabel.textContent = hasChanges ? 'Unsaved changes' : 'No unsaved changes';
      save.disabled = busy || changedElsewhere || !editable(draft) || !hasChanges;
    };
    form.oninput = () => {
      for (const [key, input] of Object.entries(inputs)) session.fields[key] = input.value;
      session.quality = undefined;
      detail.querySelector('.quality-slot')?.replaceChildren();
      updateSave();
    };
    form.onsubmit = (event) => {
      event.preventDefault();
      if (save.disabled || !form.reportValidity()) return;
      void draftRequest(draft, 'edit', { ...session.fields, revision: session.revision }, {
        pending: 'Saving changes locally…', reload: true, success: () => buffers.delete(draft.id),
      });
    };
    updateSave();
    const discard = actionButton('Discard changes', () => { buffers.delete(draft.id); update('editDraft'); });
    discard.disabled = busy && !staleDashboard;
    form.append(add(el('div', null, { class: 'editor-actions buttons' }), save, discard, fieldsLabel));
    detail._composer = form;
  } else detail.append(el('p', `To: ${draft.email}`, { class: 'message-to' }), el('div', draft.body, { class: 'body' }));

  const tools = el('div', null, { class: 'draft-tools buttons', 'aria-label': 'Editing tools' });
  const copy = actionButton('Copy email', async () => {
    try { await navigator.clipboard.writeText(`To: ${fields.email}\nSubject: ${fields.subject}\n\n${fields.body}`); notify('Email copied to clipboard.'); }
    catch { notify('Could not access the clipboard. You can select and copy the email text manually.'); }
  });
  tools.append(copy);
  if (editable(draft)) {
    if (!editing) {
      const edit = actionButton('Edit draft', () => { stateFor().editing = true; update('edit-email'); });
      edit.id = 'editDraft'; edit.disabled = busy;
      tools.prepend(edit);
    }
    const quality = actionButton('Check quality', () => {
      const state = stateFor();
      void draftRequest(draft, 'quality', { ...state.fields }, {
        pending: 'Checking the email locally…', success: (result) => { state.quality = result; },
      });
    });
    quality.id = 'checkQuality'; quality.disabled = busy || changedElsewhere;
    const regenerate = actionButton('Regenerate', () => {
      const state = stateFor();
      void draftRequest(draft, 'regenerate', {}, {
        pending: 'Generating an alternative draft…', success: (result) => { state.preview = result; },
      });
    });
    regenerate.id = 'regenerateDraft'; regenerate.disabled = busy || changedElsewhere || !!session?.preview;
    const review=actionButton('AI review (local)',()=>{
      const state=stateFor();
      void draftRequest(draft,'review',state.fields,{pending:'Reviewing with the local Ollama model…',success:(result)=>{state.ai=result;}});
    });
    review.disabled=busy||changedElsewhere;
    tools.append(quality, review, regenerate);
  }
  detail.append(tools);
  if (session?.preview) {
    const preview = add(el('section', null, { class: 'draft-subpanel regen-preview', 'aria-label': 'Regenerated preview' }),
      el('h3', 'Regenerated preview'), el('p', 'This proposal uses a local template for the role. Nothing has been saved.', { class: 'help' }),
      el('p', session.preview.subject, { class: 'preview-subject' }), el('div', session.preview.body, { class: 'email-content' }));
    const apply = actionButton('Use in editor', () => {
      session.fields.subject = session.preview.subject;
      session.fields.body = session.preview.body;
      session.editing = true;
      session.quality = session.preview = undefined;
      update('edit-subject');
    }, 'primary');
    apply.disabled = busy || changedElsewhere || !editable(draft);
    const discard = actionButton('Dismiss preview', () => { session.preview = undefined; update('regenerateDraft'); });
    discard.disabled = acting;
    preview.append(add(el('div', null, { class: 'buttons editor-actions' }), apply, discard));
    detail.append(preview);
  }
  const qualitySlot = el('div', null, { class: 'quality-slot' });
  if (session?.quality) qualitySlot.append(qualityPanel(session.quality));
  if (session?.ai) {
    const box=add(el('section',null,{class:'draft-subpanel'}),el('h3','Local AI suggestions'),el('p','Review each change. Accepted wording only updates the editor, not the saved email.',{class:'help'}));
    if (!session.ai.suggestions.length) box.append(el('p','No suggestions remaining.'));
    for (const s of session.ai.suggestions) {
      const card=add(el('div',null,{class:'notice'}),el('p',s.advice));
      const dismiss=()=>{session.ai.suggestions=session.ai.suggestions.filter((item)=>item!==s);};
      const buttons=add(el('div',null,{class:'buttons'}),actionButton('Dismiss suggestion',()=>{dismiss();update();}));
      if (s.field!=='advice') {
        card.append(el('p',s.before),el('p',s.after||'(Remove this text)'));
        const apply=actionButton('Accept change',()=>{
          if (session.fields[s.field].split(s.before).length!==2) return;
          session.fields[s.field]=session.fields[s.field].replace(s.before,()=>s.after);
          session.editing=true; session.quality=undefined; dismiss(); update(`edit-${s.field}`);
        });
        apply.disabled=busy||changedElsewhere||session.fields[s.field].split(s.before).length!==2;
        buttons.prepend(apply);
      }
      card.append(buttons);box.append(card);
    }
    qualitySlot.append(box);
  }
  detail.append(qualitySlot, draftDetails(draft, busy));

  const actions = el('div', null, { class: 'draft-footer buttons', 'aria-label': 'Draft actions' });
  if (draft.status === 'Needs Review' || draft.status === 'Archived') {
    if (!draft.delete_requested_at && (editable(draft) || draft.archived_at || draft.deletable)) {
      const archived = draft.status === 'Archived';
      const archive = actionButton(archived ? 'Restore draft' : 'Archive draft', () => {
        void draftRequest(draft, 'archive', { archived: !archived }, { pending: archived ? 'Restoring draft…' : 'Archiving draft…', reload: true, success: () => buffers.delete(draft.id) });
      });
      archive.id = 'archiveDraft'; archive.disabled = busy || dirty || !!session?.preview;
      actions.append(archive);
    }
    if (draft.deletable) {
      const remove = actionButton(draft.delete_requested_at ? 'Retry delete' : 'Delete draft', () => confirmDraft(draft, 'delete'), 'danger');
      remove.id = 'deleteDraft'; remove.disabled = busy || dirty || !!session?.preview;
      actions.append(remove);
    }
  }
  if (draft.status === 'Needs Review') {
    const send = actionButton('Review & queue', () => confirmDraft(draft, 'send'), 'primary');
    send.id = 'queueDraft';
    send.disabled = busy || !canSend(draft) || editing || dirty || !!session?.preview;
    actions.append(send);
  }
  if (detail._composer) detail.append(detail._composer);
  if (actions.childElementCount) detail.append(actions);
  return detail;
}
let mobileOutreach=false;
function drafts(view) {
  const { drafts: all } = data;
  if (staleDashboard) view.append(el('p', 'This view may be out of date. Refresh before changing drafts.', { class: 'notice warn' }));
  if (!data.sendingArmed) view.append(el('p', 'Sending is disarmed. You can review and edit drafts, but no mail can be queued here.', { class: 'notice warn' }));
  const stats = el('div', null, { class: 'draft-stats', 'aria-label': 'Filter by draft status' });
  const counts = new Map(draftStatuses.map(([status]) => [status, 0]));
  for (const draft of all) counts.set(draft.status, (counts.get(draft.status) ?? 0) + 1);
  const search = el('input', null, { id: 'draftSearch', type: 'search', placeholder: 'Search messages…', 'aria-label': 'Search messages' });
  search.value = draftControls.query;
  const select = (label, options, value) => {
    const result = el('select', null, { 'aria-label': label });
    for (const [key, name] of options) result.add(new Option(name, key));
    result.value = value;
    return result;
  };
  const sort = select('Sort drafts', [['newest', 'Newest first'], ['oldest', 'Oldest first'], ['company', 'Company A–Z']], draftControls.sort);
  const group = select('Group drafts', [['status', 'Group: Status'], ['company', 'Group: Company'], ['application', 'Group: Application'], ['none', 'No grouping']], draftControls.group);
  const results = el('div', null);
  const filters = [];
  const show = () => {
    for (const [key, button] of filters) button.setAttribute('aria-pressed', String(draftControls.status === key));
    const query = draftControls.query.trim().toLowerCase();
    const matches = all.filter((draft) => (draftControls.status === 'all' || draftControls.status === draft.status) &&
      [draft.subject, draft.email, draft.company, draft.title, draft.application_title, draft.body].some((value) => value?.toLowerCase().includes(query)));
    const newest = (a, b) => Date.parse(b.drafted_at) - Date.parse(a.drafted_at) || b.id - a.id;
    matches.sort(draftControls.sort === 'oldest' ? (a, b) => newest(b, a)
      : draftControls.sort === 'company' ? (a, b) => a.company.localeCompare(b.company) || newest(a, b) : newest);
    results.replaceChildren(add(el('div', null, { class: 'list-label', role: 'status' }), el('span', `Showing ${matches.length} of ${all.length} messages`)));
    const selected = matches.find((draft) => draft.id === draftId) ?? matches[0];
    if (!selected) {
      results.append(el('p', all.length ? 'No messages match these filters.' : 'No outreach messages yet.', { class: 'empty' }));
      return;
    }
    draftId = selected.id;
    const list = el('div', null, { class: 'draft-list outreach-list', id: 'outreachList', 'aria-label': 'Draft messages' });
    const pane = el('div', null, { class: 'outreach-pane' });
    const grid=add(el('div',null,{class:`drafts-grid outreach-grid${mobileOutreach?' outreach-mobile-detail':''}`}),list,pane);
    const rows = new Map();
    const update = (focusId) => {
      const current = matches.find((draft) => draft.id === draftId) ?? selected;
      for (const [id, row] of rows) row.setAttribute('aria-pressed', String(id === current.id));
      const back=actionButton('Back to messages',()=>{mobileOutreach=false;grid.classList.remove('outreach-mobile-detail');rows.get(current.id)?.focus();},'outreach-back');
      pane.replaceChildren(back,renderDraft(current, update));
      if (focusId) (document.getElementById(focusId) ?? $('#draftDetail'))?.focus({ preventScroll: true });
    };
    const groups = new Map();
    for (const draft of matches) {
      const key = draftControls.group === 'status' ? draft.status : draftControls.group === 'company' ? draft.company : draftControls.group === 'application' ? (draft.application_id ?? 'unlinked') : '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(draft);
    }
    const keys = draftControls.group === 'status' ? draftStatuses.map(([status]) => status).filter((status) => groups.has(status)) : groups.keys();
    for (const key of keys) {
      const rowsInGroup = groups.get(key);
      const container = el('div', null, { class: 'outreach-group' });
      const heading = draftControls.group === 'application'
        ? key === 'unlinked' ? 'No application' : `${rowsInGroup[0].application_title ?? 'Application'} · ${rowsInGroup[0].company}` : key;
      if (heading) container.append(el('h2', `${heading} · ${rowsInGroup.length}`, { class: 'group-heading' }));
      for (const draft of rowsInGroup) {
        const row = add(actionButton(null, () => {
          draftId = draft.id;
          mobileOutreach=true;grid.classList.add('outreach-mobile-detail');pane.scrollTop=0;
          update();
          if (matchMedia('(max-width: 760px)').matches) $('#draftDetail')?.focus();
        }, 'draft-row'), el('b', draft.subject || '(No subject)'), meta(draft.company, date(draft.replied_at??draft.outcome_at??draft.sent_at??draft.approved_at??draft.drafted_at)), statusBadge(draft.status), ...(draft.replied_at?[el('span',' Replied',{class:'badge workspace-good'})]:[]));
        row.dataset.draft = draft.id;
        row.setAttribute('aria-controls', 'draftDetail');
        container.append(row);
        rows.set(draft.id, row);
      }
      list.append(container);
    }
    results.append(grid);
    update();
  };
  for (const [key, label, count] of [['all', 'All Messages', all.length], ...draftStatuses.map(([status]) => [status, status, counts.get(status)])]) {
    const button = add(actionButton(null, () => { draftControls.status = key; show(); }, 'draft-stat'),
      el('strong', count), key === 'all' ? el('span', label) : statusBadge(label));
    filters.push([key, button]);
    stats.append(button);
  }
  search.oninput = () => { draftControls.query = search.value; show(); };
  sort.onchange = () => { draftControls.sort = sort.value; show(); };
  group.onchange = () => { draftControls.group = group.value; show(); };
  view.append(stats, add(el('div', null, { class: 'controls draft-controls' }), search, sort, group), results);
  show();
}

let inbox, inboxError, loadingReplies = false, replyId, replyQuery = '';
async function loadReplies() {
  if (loadingReplies) return;
  loadingReplies = true;
  updateRefreshButton();
  inboxError = undefined;
  if (tab() === 'replies' && !inbox) render();
  $('#refresh').setAttribute('aria-busy', 'true');
  try {
    const response = await fetch('/api/replies');
    const result = await response.json();
    if (!response.ok) throw new Error(result.message);
    inbox = result;
  } catch (err) { inboxError = err.message || 'Could not load replies.'; }
  finally {
    loadingReplies = false;
    updateRefreshButton();
    $('#refresh').removeAttribute('aria-busy');
    if (tab() === 'replies') {
      const search = $('#replySearch');
      const focused = search && document.activeElement === search;
      const scroll = $('.draft-list')?.scrollTop;
      render();
      if (focused) $('#replySearch')?.focus({ preventScroll: true });
      if (scroll !== undefined && $('.draft-list')) $('.draft-list').scrollTop = scroll;
    }
  }
}
function replies(view) {
  if (loadingReplies && !inbox) { view.append(el('p', 'Checking Gmail threads…', { class: 'empty', role: 'status' })); return; }
  if (inboxError) view.append(el('p', inboxError, { class: 'notice warn', role: 'status' }));
  if (!inbox) return;
  if (inbox.unavailable) view.append(el('p', `${inbox.unavailable} Gmail ${inbox.unavailable === 1 ? 'thread could' : 'threads could'} not be checked. Try Refresh again shortly.`, { class: 'notice warn' }));
  const search = el('input', null, { type: 'search', placeholder: 'Filter by company, sender, or subject…', id: 'replySearch', 'aria-label': 'Search replies' });
  search.value = replyQuery;
  const results = el('div', null);
  const show = () => {
    const matching = inbox.replies.filter((r) => `${r.company} ${r.from} ${r.title} ${r.subject}`.toLowerCase().includes(replyQuery.trim().toLowerCase()));
    const selected = matching.find((r) => r.id === replyId) ?? matching[0];
    results.replaceChildren(add(el('div', null, { class: 'list-label' }), el('span', `${matching.length} ${matching.length === 1 ? 'reply' : 'replies'} · ${inbox.checked} threads checked`), el('span', 'Newest first')));
    if (!selected) {
      results.append(el('p', inbox.replies.length ? 'No replies match this search.' : inbox.unavailable ? (inbox.checked ? 'No replies found in the threads that were checked.' : 'Gmail did not return any tracked threads. Reply status is unknown.') : 'No replies yet in your JobAgent Gmail threads.', { class: 'empty' }));
      return;
    }
    replyId = selected.id;
    const list = el('div', null, { class: 'draft-list', 'aria-label': 'Replies' });
    const preview = el('article', null, { class: 'draft', tabindex: '-1' });
    const selectReply = (r) => {
      replyId = r.id;
      list.querySelector('[aria-pressed="true"]')?.setAttribute('aria-pressed', 'false');
      for (const row of list.children) if (row.dataset.reply === r.id) row.setAttribute('aria-pressed', 'true');
      preview.replaceChildren(el('p', r.company, { class: 'kicker' }), el('h2', r.subject || '(No subject)'), meta(r.from, dayTime(r.receivedAt)), el('div', r.text || 'No text preview available.', { class: 'body' }), el('a', 'Open Gmail thread ↗', { class: 'button', href: `https://mail.google.com/mail/#all/${encodeURIComponent(r.thread)}`, target: '_blank', rel: 'noopener noreferrer' }));
    };
    for (const r of matching) {
      const row = add(el('button', null, { class: 'draft-row', type: 'button', 'aria-pressed': 'false', 'data-reply': r.id }), el('b', r.subject || '(No subject)'), meta(r.company, date(r.receivedAt)));
      row.onclick = () => { selectReply(r); if (matchMedia('(max-width: 650px)').matches) preview.focus(); };
      list.append(row);
    }
    selectReply(selected);
    results.append(add(el('div', null, { class: 'drafts-grid' }), list, preview));
  };
  search.oninput = () => { replyQuery = search.value; show(); };
  view.append(add(el('div', null, { class: 'controls' }), search), results);
  show();
}

function learning(view) { mountLearning(view, route()[1]); }
function application(view) {
  const app = data.applications.find((item) => String(item.id) === route()[1]);
  if (!app) { view.append(el('p','Application not found.',{class:'empty'})); return; }
  const card=add(el('article',null,{class:'panel'}),el('h2',app.title),meta(app.company,app.recipient,`Created ${date(app.created_at)}`));
  const url=safePosting(app.url);
  if (url) card.append(el('a','Open original posting ↗',{href:url,target:'_blank',rel:'noopener noreferrer'}));
  card.append(add(el('p',null),el('a','Open interview preparation →',{href:`#learning/${app.job_id}`})));
  const linked=data.drafts.filter((draft)=>draft.application_id===app.id);
  card.append(el('h3','Linked messages'),...linked.map((draft)=>add(el('p',null),el('a',draft.subject,{href:`#outreach/${draft.id}`}))));
  if (!linked.length) card.append(el('p','No messages linked.',{class:'help'}));
  view.append(card);
}

async function updateFollowup(id,payload) {
  if (acting || refreshing || staleDashboard) return;
  acting=true; updateRefreshButton(); render();
  try {
    const response=await fetch(`/api/followups/${id}`,{method:'POST',headers:{'Content-Type':'application/json','X-JobAgent-Action':'followup'},body:JSON.stringify(payload)});
    const result=await response.json();
    if (!response.ok) { notify(result.message); return; }
    await loadDashboard(); notify(result.message);
  } catch { staleDashboard=true; notify('Could not confirm the update. Refresh before trying again.'); }
  finally { acting=false; updateRefreshButton(); render(); }
}
function followups(view) {
  const only=route()[1];
  const disabled=acting||refreshing||staleDashboard;
  const today=data.today;
  const rows=(data.followups??[]).filter((f)=>!only||String(f.outreach_id)===only);
  const candidates=data.drafts.filter((d)=>!only||String(d.id)===only);
  if (only) view.append(el('a','Show all follow-ups',{href:'#followups'}));
  if (candidates.length) {
    const pick=el('select',null,{'aria-label':'Associated message'});
    const day=el('input',null,{type:'date',required:'','aria-label':'Due date'});
    const note=el('textarea',null,{maxlength:'2000',placeholder:'Optional note','aria-label':'Follow-up note'});
    const allow=el('input',null,{type:'checkbox'});
    const form=el('form',null,{class:'panel tracking-form'});
    const save=el('button','Add follow-up',{type:'submit',class:'primary'});
    for (const d of candidates) pick.add(new Option(`${d.company} · ${d.subject}`,String(d.id)));
    const needs=add(el('label',null,{class:'check-line'}),allow,' Allow a follow-up for this unsent message');
    const toggle=()=>{ needs.hidden=!!candidates.find((d)=>String(d.id)===pick.value)?.sent_at; save.disabled=disabled||!day.value||(!needs.hidden&&!allow.checked); };
    form.oninput=toggle; toggle();
    form.onsubmit=(event)=>{event.preventDefault();if(!save.disabled)void draftRequest({id:Number(pick.value)},'followup',{date:day.value,note:note.value,allowUnsent:!needs.hidden&&allow.checked},{pending:'Saving follow-up…',reload:true});};
    view.append(add(form,el('h2','New follow-up'),pick,day,note,needs,save));
  }
  const groups=new Map(['Overdue','Due today','Upcoming','Completed','Snoozed'].map((x)=>[x,[]]));
  for (const f of rows) groups.get(f.status==='Completed'?'Completed':f.status==='Snoozed'&&f.due_date>today?'Snoozed':f.due_date<today?'Overdue':f.due_date===today?'Due today':'Upcoming').push(f);
  for (const [group,items] of groups) {
    const block=add(el('section',null,{class:'tracking-group'}),el('h2',`${group} · ${items.length}`));
    if (!items.length) block.append(el('p','No follow-ups.',{class:'help'}));
    for (const f of items) {
      const card=add(el('article',null,{class:'panel'}),el('h2',f.subject),meta(f.company,f.title,`Due ${f.due_date}`),el('a','View email',{href:`#outreach/${f.outreach_id}`}));
      if (f.application_id) card.append(' · ',el('a','View application',{href:`#application/${f.application_id}`}));
      if (f.note) card.append(el('p',f.note));
      const actions=el('div',null,{class:'buttons tracking-actions'});
      if (f.status!=='Completed') {
        const day=el('input',null,{type:'date','aria-label':'New follow-up date'}); day.value=f.due_date;
        actions.append(day);
        for (const [key,label] of [['complete','Mark completed'],['reschedule','Reschedule'],['snooze','Snooze']]) {
          const button=actionButton(label,()=>void updateFollowup(f.id,{action:key,date:day.value}));button.disabled=disabled;actions.append(button);
        }
      }
      const note=el('input',null,{maxlength:'2000',placeholder:'Add a note','aria-label':'New note'});
      const save=actionButton('Save note',()=>{if(note.value.trim())void updateFollowup(f.id,{action:'note',note:note.value});});save.disabled=disabled;
      const history=add(el('details',null),el('summary','Follow-up history'));
      for(const event of (data.activity??[]).filter((e)=>e.followup_id===f.id)) history.append(el('p',`${dayTime(event.at)} · ${event.kind}${event.detail?` — ${event.detail}`:''}`));
      if(history.childElementCount===1)history.append(el('p','Imported from an existing date. No earlier history was recorded.'));
      card.append(actions,add(el('div',null,{class:'buttons tracking-actions'}),note,save),history);block.append(card);
    }
    view.append(block);
  }
}
function analytics(view) {
  const a=data.analytics;
  if (!a) { view.append(el('p','No analytics available.',{class:'empty'})); return; }
  const replies=a.recordedReplies+a.manualOnlyReplies;
  const metrics=[['Total messages',a.total],['Active drafts',a.drafts],['Marked as sent',a.sent],['Integration-confirmed sends',a.confirmedSent],['Responses recorded',replies],['Reply events confirmed by integration',a.confirmedReplies],['Manual-only responses',a.manualOnlyReplies],['Positive outcomes (manual)',a.positive],['Interviews (manual)',a.interviews],['Follow-ups completed',a.completed],['Recorded response rate',a.confirmedSent?`${(100*a.confirmedCohortResponses/a.confirmedSent).toFixed(1)}%`:'Not available']];
  view.append(el('p','The response rate uses integration-confirmed sends only. A response counts once per message, whether tracked or recorded manually. Missing replies can make it an undercount. Legacy sends are shown separately from confirmed sends and excluded from the rate.',{class:'notice'}));
  const list=el('dl',null,{class:'tracking-metrics'});
  for(const [label,value] of metrics) list.append(add(el('div',null,{class:'panel'}),el('dt',label),el('dd',value)));
  view.append(list);
}
const glyphs={dashboard:'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',briefcase:'M3 7h18v13H3zM8 7V4h8v3M3 12h18',folder:'M3 6h7l2 2h9v12H3z',book:'M12 7v14M3 4h5l4 3 4-3h5v14h-5l-4 3-4-3H3z',mail:'M3 5h18v14H3zM3 6l9 7 9-7',reply:'M9 10H6V6H3v13h18v-5M10 7l4-4m-4 4 4 4m-4-4h6a5 5 0 0 1 5 5',clock:'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 6v6l3 2',chart:'M3 3v18h18M8 16v-4m5 4V8m5 8V5',settings:'M4 7h16M4 17h16M8 5v4m8 6v4',sidebar:'M3 4h18v16H3zM9 4v16',refresh:'M20 8a8 8 0 0 0-14-3L3 8m0-5v5h5m-4 8a8 8 0 0 0 14 3l3-3m0 5v-5h-5'};
for(const host of document.querySelectorAll('[data-icon]')){
  const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg'),path=document.createElementNS(ns,'path');
  for(const [key,value] of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'1.65','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'}))svg.setAttribute(key,value);
  path.setAttribute('d',glyphs[host.dataset.icon]);svg.append(path);host.replaceChildren(svg);
}
function sidebar(collapsed){
  document.body.classList.toggle('sidebar-collapsed',collapsed);
  $('#toggleSidebar').setAttribute('aria-expanded',String(!collapsed));
  try{localStorage.setItem('jobagent-sidebar',String(collapsed));}catch{}
}
try{sidebar(localStorage.getItem('jobagent-sidebar')==='true');}catch{sidebar(false);}
$('#toggleSidebar').onclick=()=>sidebar(!document.body.classList.contains('sidebar-collapsed'));
const internal=(label,href)=>el('a',label,{href});
function statCards(items){
  return add(el('dl',null,{class:'workspace-metrics'}),...items.map(([label,value])=>add(el('div',null,{class:'panel workspace-stat'}),el('dt',label),el('dd',value))));
}
function table(headers,rows){
  const cell=(value)=>add(el('td',null),value instanceof Node?value:String(value??'—'));
  return add(el('div',null,{class:'workspace-table',tabindex:'0','aria-label':'Scrollable data table'}),add(el('table',null),
    add(el('thead',null),add(el('tr',null),...headers.map(h=>el('th',h,{scope:'col'})))),
    add(el('tbody',null),...rows.map(row=>add(el('tr',null),...row.map(cell))))));
}
function applicationRows(){
  return data.applications.map(a=>{
    const linked=data.drafts.filter(d=>d.application_id===a.id);
    const followup=(data.followups??[]).filter(f=>f.application_id===a.id&&f.status!=='Completed').sort((x,y)=>x.due_date.localeCompare(y.due_date))[0];
    const evidence=linked.find(d=>d.outcome==='Interview Scheduled')??linked.find(d=>d.replied_at)??linked.find(d=>d.outcome)??linked.find(d=>d.sent_at);
    const stage=evidence?.outcome??(evidence?.replied_at?'Reply recorded':evidence?.sent_at?'Outreach sent':'Tracking only');
    return {...a,stage,followup,action:followup?'Review follow-up':stage==='Interview Scheduled'?'Prepare for interview':'Review application'};
  });
}
function applications(view){
  const rows=applicationRows(), filters=el('div',null,{class:'controls'}), results=el('div',null);
  const search=el('input',null,{type:'search',placeholder:'Search company or position…','aria-label':'Search applications'});
  const status=el('select',null,{'aria-label':'Application status'});status.add(new Option('All statuses',''));for(const item of new Set(rows.map(r=>r.stage)))status.add(new Option(item,item));
  const sort=el('select',null,{'aria-label':'Sort applications'});sort.add(new Option('Recently tracked','date'));sort.add(new Option('Company A–Z','company'));
  const draw=()=>{
    const filtered=rows.filter(r=>(!status.value||status.value===r.stage)&&`${r.company} ${r.title}`.toLowerCase().includes(search.value.trim().toLowerCase())).sort((a,b)=>sort.value==='company'?a.company.localeCompare(b.company):String(b.created_at).localeCompare(String(a.created_at)));
    results.replaceChildren(el('p',`${filtered.length} of ${rows.length} applications · Submission dates are not tracked.`,{class:'meta'}));
    if(!filtered.length){results.append(el('p',rows.length?'No applications match these filters.':'No applications yet. You can create one from Outreach or build a full prep plan for a posting.',{class:'empty'}));return;}
    results.append(table(['Company','Position','Recorded status','Tracked on','Next action','Follow-up'],filtered.map(r=>[r.company,internal(r.title,`#application/${r.id}`),el('span',r.stage,{class:`badge ${r.stage==='Interview Scheduled'?'workspace-good':'neutral'}`}),r.created_at?date(r.created_at):'—',r.action,r.followup?.due_date])));
  };
  search.oninput=status.onchange=sort.onchange=draw;view.append(add(filters,search,status,sort),results);draw();
}
function dashboard(view){
  const rows=applicationRows(), now=data.today??new Date().toISOString().slice(0,10);
  const tasks=(data.followups??[]).filter(f=>f.status!=='Completed').sort((a,b)=>a.due_date.localeCompare(b.due_date));
  view.append(statCards([['Tracked applications',rows.length],['Submissions recorded','Not tracked'],['Interviews scheduled',rows.filter(r=>r.stage==='Interview Scheduled').length],['Open follow-ups',tasks.length]]));
  const due=add(el('section',null,{class:'panel'}),el('h2','Next actions'),el('p',`${tasks.filter(t=>t.due_date<=now).length} due or overdue`,{class:'meta'}));
  for(const task of tasks.slice(0,6))due.append(add(el('p',null),internal(`${task.company} · ${task.due_date}`,`#followups/${task.outreach_id}`)));
  if(!tasks.length)due.append(el('p','No outstanding follow-ups.',{class:'help'}));
  due.append(internal('Open follow-ups →','#followups'));
  const recent=add(el('section',null,{class:'panel'}),el('h2','Recent activity'));
  for(const event of (data.activity??[]).slice(0,6))recent.append(add(el('p',null),internal(event.kind,`#outreach/${event.outreach_id}`),meta(event.source,dayTime(event.at))));
  if(!data.activity?.length)recent.append(el('p','No activity recorded.',{class:'help'}));
  const learning=add(el('section',null,{class:'panel'}),el('h2','Interview preparation'));
  const totals=data.learningSummary;
  learning.append(el('p',totals?`${totals.plans} saved banks · ${totals.mastered} mastered · ${totals.revision} to revise`:'Learning totals unavailable.' ,{class:'help'}));
  const plan=totals?.latest_job_id;
  learning.append(internal(plan?'Continue preparation →':'Find a posting to practice →',plan?`#learning/${plan}`:'#alerts'));
  view.append(add(el('div',null,{class:'workspace-columns'}),due,recent,learning));
}
let account;
function settings(view){
  const send=data.sendingArmed?'Armed · explicit approval required':'Disarmed · no email can be queued';
  const panel=add(el('section',null,{class:'panel settings-panel'}),el('h2','Workspace settings'),el('p',`Email sending: ${send}`),actionButton('Toggle sidebar density',()=>sidebar(!document.body.classList.contains('sidebar-collapsed'))));
  if(account?.email){
    const signOut=actionButton('Sign out',async()=>{
      signOut.disabled=true;
      try{const result=await fetch('/logout',{method:'POST'});if(!result.ok)throw Error();location.assign('/');}
      catch{notify('Could not sign out. Try again.');signOut.disabled=false;}
    });
    panel.append(el('p',`Signed in as ${account.email}`),signOut);
  }else if(account?.local){panel.append(el('p','Trusted local mode. Account authentication is required in hosted mode.',{class:'help'}));}
  view.append(panel);
}
function render() {
  const current = tab();
  const [title, eyebrow, intro] = sections[current];
  $('#crumb').textContent = title;
  $('#eyebrow').textContent = eyebrow;
  $('#intro').textContent = intro;
  $('#title').replaceChildren(title, el('span', '.'));
  for (const link of document.querySelectorAll('nav a')) {
    if (link.getAttribute('href') === `#${current === 'application' ? 'applications' : current}`) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  if (!data && !['replies', 'learning'].includes(current)) return;
  if (data) $('#draftCount').textContent = data.drafts.filter((draft) => draft.status === 'Needs Review').length;
  const view = $('#view');
  view.replaceChildren();
  ({ dashboard, applications, settings, alerts, outreach: drafts, replies, learning, followups, analytics, application })[current](view);
}
function updateRefreshButton() {
  $('#refresh').disabled = refreshing || acting || (tab() === 'replies' && loadingReplies);
}
async function loadDashboard() {
  const response = await fetch('/api/dashboard');
  if (!response.ok) throw new Error('Dashboard data unavailable');
  data = await response.json();
  // Older dashboard instances can still display their drafts without granting mutation access.
  for (const draft of data.drafts) {
    draft.status ??= draft.approved_at || draft.state === 'AUTO_SEND' ? 'Approved' : 'Needs Review';
    const session = buffers.get(draft.id);
    if (session && !session.editing && session.revision !== draft.revision) buffers.delete(draft.id);
  }
  const ids = new Set(data.drafts.map(({ id }) => id));
  for (const entries of [buffers, trackingBuffers]) for (const id of entries.keys()) if (!ids.has(id)) entries.delete(id);
  staleDashboard = false;
}
async function refresh() {
  if (refreshing || acting) return;
  refreshing = true;
  updateRefreshButton();
  $('#view').setAttribute('aria-busy', 'true');
  if (data) render();
  try {
    await loadDashboard();
    notify();
  } catch {
    notify('Could not load JobAgent data. Check the local server and try Refresh.');
    if (!data && tab() !== 'learning') $('#view').replaceChildren();
  } finally {
    refreshing = false;
    $('#view').setAttribute('aria-busy', 'false');
    updateRefreshButton();
    render();
  }
}
function onTab() {
  updateRefreshButton();
  notify();
  if (tab() === 'outreach' && /^\d+$/.test(route()[1] ?? '')) {
    draftId = Number(route()[1]); mobileOutreach=true;
    draftControls.query = ''; draftControls.status = 'all';
  } else if(tab()==='outreach') mobileOutreach=false;
  render();
  if (tab() === 'replies') void loadReplies();
}
window.addEventListener('hashchange', onTab);
$('#refresh').onclick = () => tab() === 'replies' ? loadReplies() : refresh();
onTab();
void fetch('/api/auth/session').then(r=>r.ok?r.json():null).then(session=>{
  account=session;
  if(session?.email)document.querySelector('.sidebar .local').textContent='Private workspace';
  if(tab()==='settings')render();
}).catch(()=>{});
await refresh();
