// Optional browser smoke (Playwright is not a JobAgent runtime dependency):
// JOBAGENT_PLAYWRIGHT=/absolute/path/to/playwright [CHROME_BIN=/path/to/chrome] node src/dashboard/frontend.smoke.cjs
// Every request is intercepted by the test; never points at a running dashboard or Gmail.
const { chromium } = require(process.env.JOBAGENT_PLAYWRIGHT ?? 'playwright');
const fs = require('node:fs');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN, headless: true });
  try {
    const page = await browser.newPage({ colorScheme: 'dark' });
    page.setDefaultTimeout(6000);
    const errors = [], requests = [];
    await page.route('**/*', (route) => route.abort());
    page.on('pageerror', (error) => errors.push(error.message));
    const time = '2026-11-24T01:00:00.000Z';
    const draft = { id: 1, job_id: 1, company: 'Example Co', title:'Engineer', subject: 'First outreach', body:'Original saved message', email:'review@example.test', status:'Needs Review', revision:3, contact_active:1, editable:1, deletable:1, state:'PENDING_APPROVAL', local_only:0, drafted_at:time };
    const sent = { ...draft, id:2, status:'Sent', subject:'Completed outreach', sent_at:time, company:'Other Co', editable:0, deletable:0 };
    const toArchive = { ...draft, id:3, subject:'Archive candidate' };
    const app = { id:7, job_id:1, title:'Engineer posting', company:'Example Co', url:'https://example.test/role' };
    const dashboard = { jobs:[{id:1,title:'Engineer posting',company:'Example Co',location:'Remote',source:'gmail-alert',state:'SCORED',first_seen_at:time,fit_score:90}], drafts:[draft,sent,toArchive], applications:[app], matchThreshold:80, sendingArmed:true, today:'2026-11-24', activity:[], followups:[], analytics:{total:3,drafts:2,sent:1,confirmedSent:0,recordedReplies:0,confirmedReplies:0,manualOnlyReplies:0,positive:0,interviews:0,completed:0} };
    const learningRequests = [];
    await page.route('http://jobagent.test/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/dashboard') return route.fulfill({ json: dashboard });
      if (path === '/api/interview-prep/1') return route.fulfill({json:{title:'Engineer posting',company:'Example Co',url:app.url,description:'Develop REST APIs backed by PostgreSQL.'}});
      if (path.startsWith('/api/learning')) {
        learningRequests.push(path);
        return route.abort();
      }
      if(path==='/api/followups/9') {
        const f=dashboard.followups[0];
        f.status='Completed'; dashboard.analytics.completed=1;
        return route.fulfill({json:{message:'Follow-up updated.'}});
      }
      const match = path.match(/^\/api\/drafts\/(\d+)\/([a-z]+)$/);
      if (match) {
        const target = dashboard.drafts.find((d)=>d.id===Number(match[1])), action=match[2], req=route.request();
        assert.equal(req.headers()['x-jobagent-action'], action);
        const payload = req.postDataJSON();
        requests.push({ action, payload });
        if (action === 'followup') dashboard.followups.push({id:9,outreach_id:target.id,due_date:payload.date,status:'Open',note:payload.note,subject:target.subject,company:target.company,title:target.title});
        if (action === 'quality') return route.fulfill({ json:{warnings:[{code:'test',message:'Check this warning'}],mode:payload.ai?'ai':'local'} });
        if (action === 'regenerate') return route.fulfill({ json:{subject:'Alternate subject',body:'Alternate body'} });
        if (action === 'edit') Object.assign(target,{...payload,revision:payload.revision+1,local_only:1});
        if (action === 'application') Object.assign(target,{application_id:payload.applicationId,application_title:app.title,application_url:app.url,follow_up_at:payload.followUpAt});
        if (action === 'archive') Object.assign(target,{status:payload.archived?'Archived':'Needs Review',archived_at:payload.archived?time:null,editable:payload.archived?0:1});
        if (action === 'send') Object.assign(target,{status:'Approved',approved_at:time,editable:0,deletable:0});
        return route.fulfill({ json:{message:'Saved test result'} });
      }
      const names = { '/':'index.html', '/app.js':'app.js', '/style.css':'style.css', '/learning.js':'learning.js', '/learning.css':'learning.css' };
      if (!names[path]) return route.abort();
      const types = { '/':'text/html', '/app.js':'text/javascript', '/style.css':'text/css', '/learning.js':'text/javascript', '/learning.css':'text/css' };
      return route.fulfill({ body:fs.readFileSync(require('node:path').join(__dirname, names[path])), contentType:types[path], headers:{'content-security-policy':"default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"} });
    });
    await page.goto('http://jobagent.test/#drafts');
    await page.locator('[data-draft="1"]').click();
    await page.getByRole('button',{name:'Check quality',exact:true}).click();
    await page.getByText('Check this warning').waitFor();
    assert.equal(requests.at(-1).payload.ai,undefined);
    await page.getByRole('button',{name:'Regenerate',exact:true}).click();
    await page.getByRole('heading',{name:'Regenerated preview'}).waitFor();
    assert.equal(draft.body,'Original saved message');
    await page.getByRole('button',{name:'Use in editor'}).click();
    await page.getByLabel('Message',{exact:true}).fill('Edited in test');
    assert.equal(await page.getByRole('button',{name:'Review & queue'}).isDisabled(),true);
    await page.getByRole('button',{name:'Save changes'}).click();
    await page.getByText('Saved locally only.',{exact:false}).waitFor();
    assert.deepEqual(requests.at(-1).payload,{revision:3,subject:'Alternate subject',body:'Edited in test',email:'review@example.test'});
    assert.equal(await page.getByRole('button',{name:'Review & queue'}).isDisabled(),true);
    await page.getByLabel('Application',{exact:true}).selectOption('7');
    await page.getByLabel('Follow-up date').fill('2026-12-04');
    await page.getByText('Allow reminder for this unsent message').click();
    await page.getByRole('button',{name:'Save tracking'}).click();
    await page.getByRole('link',{name:'Engineer posting'}).waitFor();
    assert.equal(requests.at(-1).payload.followUpAt,'2026-12-04T00:00:00.000Z');
    await page.getByLabel('Group drafts').selectOption('application');
    await page.getByRole('heading',{name:'Engineer posting · Example Co · 1'}).waitFor();
    await page.getByLabel('Search messages').fill('Archive candidate');
    assert.equal(await page.locator('[data-draft]').count(),1);
    await page.getByRole('button',{name:'Archive draft'}).click();
    await page.getByRole('button',{name:'Restore draft'}).click();
    await page.getByRole('button',{name:'Review & queue'}).click();
    assert.equal(await page.getByRole('button',{name:'Confirm and queue'}).isDisabled(),true);
    await page.getByRole('button',{name:'Cancel',exact:true}).click();
    assert(!requests.some((r)=>r.action==='send'));
    await page.getByRole('button',{name:'Review & queue'}).click();
    await page.locator('#confirmReview').check();
    await page.getByRole('button',{name:'Confirm and queue'}).click();
    await page.getByText('Approved for the scheduled sender').waitFor();
    assert.deepEqual(requests.at(-1),{action:'send',payload:{revision:3,reviewed:true}});
    assert.equal(await page.getByRole('button',{name:'Delete draft'}).count(),0);
    await page.getByLabel('Search messages').fill('');
    await page.getByRole('button', { name: '1 Sent', exact: true }).click();
    assert.equal(await page.locator('[data-draft]').count(), 1);
    assert.equal(await page.locator('[data-draft]').first().getAttribute('data-draft'), '2');
    await page.getByRole('button', { name: '3 All Messages', exact: true }).click();
    await page.getByLabel('Group drafts').selectOption('none');
    await page.getByLabel('Sort drafts').selectOption('oldest');
    assert.deepEqual(await page.locator('[data-draft]').evaluateAll((rows) => rows.map((row) => row.dataset.draft)), ['1', '2', '3']);
    for (const width of [320,390,720,900,1200]) {
      await page.setViewportSize({width,height:820});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width);
    }
    await page.getByRole('link',{name:'Follow-ups',exact:true}).click();
    await page.getByLabel('Due date',{exact:true}).fill('2026-11-24');
    assert.equal(await page.getByRole('button',{name:'Add follow-up'}).isDisabled(),true);
    await page.getByLabel('Associated message').selectOption('2');
    await page.getByRole('button',{name:'Add follow-up'}).click();
    await page.getByRole('heading',{name:'Due today · 1'}).waitFor();
    await page.getByRole('button',{name:'Mark completed'}).click();
    await page.getByRole('heading',{name:'Completed · 1',exact:true}).waitFor();
    await page.getByRole('link',{name:'View email'}).click();
    await page.getByRole('heading',{name:'Completed outreach'}).waitFor();
    await page.getByRole('link',{name:'Analytics',exact:true}).click();
    await page.getByText('Recorded response rate',{exact:true}).waitFor();
    await page.getByRole('link',{name:'Learning',exact:true}).click();
    await page.getByRole('heading',{name:'Interview Prep',exact:true}).waitFor();
    assert.equal(await page.locator('#view select').count(),0);
    await page.getByRole('link',{name:'Job alerts',exact:true}).click();
    await page.getByRole('button',{name:'Prepare for Engineer posting'}).click();
    await page.getByRole('heading',{name:'Engineer posting · Example Co'}).waitFor();
    const bank=page.getByRole('button',{name:'Question Bank',exact:true});
    await bank.waitFor();
    await page.getByLabel('Search questions').fill('retry safe');
    assert.equal(await page.locator('.prep-row').count(),1);
    const row=page.locator('.prep-row').first();
    await row.click();
    await page.getByText('A client timeout doesn’t prove the server stopped.',{exact:false}).waitFor();
    await page.getByRole('button',{name:'Mark mastered'}).click();
    await page.getByRole('button',{name:'Bookmark',exact:true}).click();
    await page.getByLabel('Personal notes').fill('Explain atomic deduplication.');
    await page.getByRole('button',{name:'Save note'}).click();
    await page.reload();
    await page.getByRole('heading',{name:'Engineer posting · Example Co'}).waitFor();
    await page.getByLabel('Completion').selectOption('bookmark');
    assert.equal(await page.locator('.prep-row').count(),1);
    assert.equal(await page.getByLabel('Personal notes').inputValue(),'Explain atomic deduplication.');
    await page.getByRole('button',{name:'Project Deep Dive',exact:true}).click();
    await page.getByRole('heading',{name:'Project Deep Dive',exact:true}).waitFor();
    await bank.click();
    for (const width of [320,390,720,900,1200]) {
      await page.setViewportSize({width,height:820});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width);
    }
    await page.setViewportSize({width:390,height:820});
    await page.locator('.prep-row').first().click();
    assert.equal(await page.locator('.prep-list').isVisible(),false);
    await page.getByRole('button',{name:'Back to questions'}).click();
    assert.equal(await page.locator('.prep-list').isVisible(),true);
    assert.deepEqual(learningRequests,[]);
    assert.deepEqual(errors,[]);
    console.log('Mock-browser smoke passed (local quality, regeneration preview, revisioned edit, tracking, filters, archive/restore, reviewed queue, posting-specific interview prep without a model, responsive widths).');
  } finally { await browser.close(); }
})().catch((error)=>{console.error(error);process.exitCode=1});
