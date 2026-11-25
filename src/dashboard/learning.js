// One built-in curriculum. Opening it never creates an application or calls a model.
const chapters = [
  ['Coding & data structures', [
    ['How do you find two numbers that sum to a target?', 'Scan once, storing previously seen values and their indices. For each value x, look up target − x before inserting x. This avoids reusing the same element and handles repeated values. Expected O(n) time and O(n) space. A sorted two-pointer approach trades that space for sorting time and requires preserving original indices.'],
    ['When does a sliding window work?', 'Use it when the window summarizes a contiguous range and an invalid window can be fixed by advancing the left boundary. For the longest substring without repeats, track each character’s most recent index and move left past repeats. Both pointers only move forward: O(n) time. For sums with negative values, shrinking does not reliably reduce the sum; consider prefix sums instead.'],
    ['What invariant makes binary search correct?', 'Keep the answer inside a shrinking search interval. To find the first true in a monotone predicate, use a half-open range [lo, hi): on true set hi = mid, otherwise set lo = mid + 1. Test an empty range, all false, all true, and a boundary at either end. O(log n) predicate calls.'],
    ['When would you use BFS instead of DFS?', 'BFS explores by distance and finds shortest paths in unweighted graphs. Mark visited when enqueuing so multiple neighbors do not schedule the same node. DFS is useful for cycle detection or backtracking. Both take O(V + E) on adjacency lists; a weighted shortest path needs a different algorithm.'],
    ['How do you maintain the top k elements in a stream?', 'Keep a min-heap of size k. The root is the weakest element retained. Insert until full, then replace the root only if a new value is larger. O(n log k) time and O(k) space for k ≥ 2; for k = 1, just track the maximum. Clarify how ties are handled.'],
    ['How do you explain complexity beyond Big O?', 'Name what n measures, distinguish auxiliary space from input space, and describe worst-case versus expected time. For a hash table, expected lookup is constant under good hashing, but collisions and resizing matter. Measure real latency only after explaining what the asymptotic bound captures.'],
  ]],
  ['SQL, APIs & systems', [
    ['How do you count orders per customer, including zero?', 'Start from customers, LEFT JOIN orders on customer ID, group by customer ID, then COUNT(orders.id). COUNT(*) counts the unmatched placeholder as one. Put an order-side date filter in the ON clause if customers with no matching orders must remain.'],
    ['When does a database index help?', 'Start with the actual query and inspect its plan. An index on (customer_id, created_at) can serve a customer equality filter followed by a date range. Compare plans and measurements before and after. Indexes cost storage and extra writes; not every query benefits.'],
    ['How do transactions prevent a lost update?', 'A read–modify–write can overwrite concurrent changes. Use an atomic update for a simple counter, or a conditional write with a version check when the business logic needs a prior read. Explain what retries do and use a transaction for changes that must commit together.'],
    ['What makes a retry safe after an API timeout?', 'A client timeout doesn’t prove the server stopped. For a create operation, use a client-generated idempotency key, scope it to the caller, store the outcome atomically with the operation, and reject reuse with a different payload. Retry transient failures with a bounded backoff.'],
    ['What can go wrong when caching reads?', 'A cache hit can be stale and a popular key can overload the origin when it expires. Set freshness requirements first, choose TTL and invalidation accordingly, and consider coalescing concurrent misses. Measure hit rate alongside tail latency and correctness.'],
    ['How would you debug an endpoint that suddenly got slow?', 'Confirm the affected endpoint and time range. Compare latency percentiles, error rates, and request volumes before and after the change. Use traces to separate queueing, database, and upstream delays. Form one hypothesis, test it, and compare the same measures after the fix.'],
  ]],
  ['AI & data fundamentals', [
    ['What is data leakage?', 'Leakage is information being available during training or evaluation that wouldn’t be available at prediction time. Split before learning preprocessing parameters, and use a time- or entity-aware split when appropriate. A high validation score can reflect leakage rather than a good model.'],
    ['When would you use precision instead of accuracy?', 'Precision answers how often predicted positives are correct. Recall answers how many actual positives were found. Choose based on error costs and inspect trade-offs across thresholds. For rare positives, accuracy can look high even when the model finds none.'],
    ['How do you diagnose a bad retrieval-augmented answer?', 'Check whether a relevant passage exists, whether it was retrieved at k, and whether the model used it correctly. Compare retrieval recall with answer faithfulness on a labeled set. Fix the stage that failed rather than changing prompts or embeddings blindly.'],
    ['What makes a baseline useful?', 'Use a simple, reproducible comparison on the same split and metric, such as the majority class or a keyword retriever. Compare on meaningful error slices as well as the aggregate. State what improvement would matter in practice before adding complexity.'],
  ]],
  ['Projects & behavioral practice', [
    ['Can you walk through one of your projects end to end?', 'Pick a real request or data item and trace its path. Explain where state lives, what each component owns, and the boundary you personally implemented. Finish with one limitation you observed rather than listing every tool.'],
    ['What trade-off did you make in a project?', 'Name the constraint, compare two plausible designs, and explain what made your choice appropriate then. Distinguish what you tested from what you assumed. Say what new evidence would change your mind.'],
    ['How did you verify a project performance claim?', 'Name the baseline, workload, environment, and metric. Explain what changed and how you controlled variance. If you did not measure an improvement, say so and describe the experiment you would run.'],
    ['Tell me about a failure you debugged.', 'Explain the symptom, your first hypothesis, the evidence that confirmed or contradicted it, and the fix. Describe the regression test or monitoring you added. Use a real example and separate your contribution from the team’s.'],
    ['Tell me about a disagreement or unclear requirement.', 'Explain why the decision mattered, how you clarified goals, which options you compared, and how the team decided. Include an outcome you can substantiate and what you would change next time.'],
  ]],
];
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function card(title) {
  const section = el('section', '', 'panel');
  section.append(el('h2', title));
  return section;
}
function disclosure(title, text) {
  const details = el('details', '', 'learn-disclosure');
  details.append(el('summary', title), el('p', text, 'learn-disclosure-body learn-text'));
  return details;
}
// Specific topics are ranked by explicit posting signals, not invented company history.
const targeted = [
  { name: 'Agent security', pattern: /\b(?:security|secure|prompt injection|permissions)\b/i, related: /\b(?:agents?|llms?|tool calls?)\b/i, questions: [
    ['Where are the trust boundaries in a tool-using AI agent?', 'Separate user intent, untrusted retrieved text, model output, and server-authorized actions. The model can propose a tool call; the server validates its arguments and checks the caller’s scope. Require approval for high-impact actions and log decisions without recording secrets.'],
    ['How would you test that an agent handles untrusted instructions safely?', 'Use synthetic documents and mock tools. Check that untrusted text cannot change permissions, trigger writes, or expose private data. Include positive cases so a guard that blocks everything does not pass. Measure policy violations separately from task completion.'],
    ['An agent requests a write its user did not authorize. What should happen?', 'Deny the action at the tool boundary. Confirm which policy blocked it, log safe metadata, and explain the denial to the user. Do not retry by broadening permissions. Test that genuinely authorized writes still work.'],
  ]},
  { name: 'AI agents', pattern: /\b(?:agents?|llms?|tool calls?|rag|retrieval)\b/i, questions: [
    ['How would you evaluate an agent that calls tools?', 'Use a fixed task set with correct tool choices and expected final states. Measure argument correctness, task completion, unintended actions, latency, and cost. Explain how you diagnose a failure by inspecting the tool trace.'],
    ['When would you use a deterministic workflow instead of an agent?', 'Prefer fixed control flow when requirements and branching are known, especially for consequential actions. Use model decisions only where input variation benefits from them. Keep authorization and validation in deterministic code either way.'],
  ]},
  { name: 'Backend & APIs', pattern: /\b(?:backend|back-end|api|rest|microservices|node\.js|fastapi|spring)\b/i, questions: chapters[1][1].slice(2) },
  { name: 'Data & SQL', pattern: /\b(?:sql|database|postgresql|analytics|data engineer)\b/i, questions: chapters[1][1].slice(0,3) },
  { name: 'Machine learning', pattern: /\b(?:ml|machine learning|data science|pytorch|tensorflow|applied ai)\b/i, questions: chapters[2][1].filter(([question])=>!question.includes('retrieval-augmented')) },
  { name: 'Frontend', pattern: /\b(?:front-end|frontend|react|next\.js|ui engineer)\b/i, questions: [
    ['How do you prevent an older search response from replacing a newer one?', 'Abort obsolete requests or track a request ID and discard stale responses. Test reordered responses, loading and empty states, and keyboard access. A debounce reduces traffic but does not guarantee ordering.'],
    ['How would you diagnose a slow interactive UI?', 'Measure the interaction first, then separate network delay, main-thread work, and unnecessary rendering. Use browser traces and a representative device. Compare the same interaction before and after a targeted change.'],
  ]},
  {name:'Coding fundamentals',pattern:/\b(?:software engineer|swe|algorithms|data structures)\b/i,questions:chapters[0][1].slice(0,4)},
];
export function prepareBrief(job) {
  const description = job.description?.trim() ?? '';
  const title = job.title ?? '';
  const rank = targeted.flatMap((topic) => {
    const inTitle = title.match(topic.pattern);
    const inDescription = description.match(topic.pattern);
    if ((!inTitle && !inDescription) || (topic.related && !topic.related.test(`${title} ${description}`))) return [];
    return [{...topic, score:Number(!!inTitle)+2*Number(!!inDescription), evidence:inDescription?.[0]??inTitle?.[0], source:inDescription?'Posting description':'Job title'}];
  }).sort((a,b)=>b.score-a.score).slice(0,3);
  return {description,rank};
}
const tabs = ['Overview','Question Bank','Practical Exercises','Project Deep Dive','Mock Interview','Progress & Revision'];
const priorities = ['Must Know','High Priority','High Probability','Important','Advanced','Advanced / Bonus'];
const difficulty = ['Easy','Medium','Hard'];
const icons={bookmark:'M6 4h12v17l-6-4-6 4z', back:'M12 19l-7-7 7-7M5 12h14', check:'m5 12 4 4L19 6'}; // Lucide-style line icons
function icon(name) {
  const ns='http://www.w3.org/2000/svg', svg=document.createElementNS(ns,'svg'), path=document.createElementNS(ns,'path');
  for(const [key,value] of Object.entries({viewBox:'0 0 24 24',width:15,height:15,fill:'none',stroke:'currentColor','stroke-width':2,'stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'}))svg.setAttribute(key,value);
  path.setAttribute('d',icons[name]);svg.append(path);return svg;
}
function button(text, fn, glyph) {
  const b=el('button',text);b.type='button';b.onclick=fn;if(glyph)b.prepend(icon(glyph));return b;
}
function field(tag,label) {const node=el(tag);node.setAttribute('aria-label',label);return node;}
function choices(label,values,onchange) {
  const node=field('select',label);for(const [v,t] of values)node.add(new Option(t,v));node.onchange=()=>onchange(node.value);return node;
}
function badge(text){return el('span',text,'badge neutral');}
function put(node,label,value){
  if(!value||Array.isArray(value)&&!value.length)return;
  node.append(el('h3',label));
  if(Array.isArray(value)){const list=el('ul');for(const item of value)list.append(el('li',item));node.append(list);}
  else node.append(el('p',value,'learn-text'));
}
async function api(path,action,body,timeout=7000){
  const res=await fetch(path,{signal:AbortSignal.timeout(timeout),...(action?{method:'POST',headers:{'Content-Type':'application/json','X-JobAgent-Action':action},body:JSON.stringify(body)}:{})});
  const result=await res.json();if(!res.ok)throw Error(result.message||'Request failed.');return result;
}
function starterQuestions(job){
  const {rank}=prepareBrief(job);
  return rank.flatMap((topic,i)=>topic.questions.map(([prompt,explanation],j)=>({
    id:`starter:${topic.name}:${j}`,prompt,explanation,topic:topic.name,category:topic.name,
    priority:i===0?'Must Know':'High Priority',basis:`${topic.source}: ${topic.evidence}`,
  })));
}
function loadLocal(id){try{return JSON.parse(localStorage.getItem(`jobagent-prep-v1:${id}`))??{};}catch{return {};}}
export async function mountLearning(view,id){
  const root=el('div','','learning prep-workspace');view.append(root);
  if(!/^\d+$/.test(id??'')){
    const intro=card('Interview Prep'), link=el('a','Go to job alerts','button');link.href='#alerts';
    intro.append(el('p','Click Prep beside a posting to open its interview workspace.'),link);root.append(intro);return;
  }
  const status=el('p','Loading the saved posting…','learn-status');status.setAttribute('role','status');
  const header=el('header','','prep-header panel'),nav=el('nav','','prep-tabs'),main=el('div','','prep-main');nav.setAttribute('aria-label','Preparation sections');
  root.append(header,status,nav,main);
  let job, data, warning='', active='Question Bank', selected, mobileDetail=false, busy=false, feedback=null;
  let appId, local=loadLocal(id), error='', pending='';
  let query='', category='', level='', priority='', completion='', sort='priority', source='';
  const collapsed=new Set();
  const questions=()=>data?.plan?.questions??starterQuestions(job);
  const localState=(q)=>local[q.id]??{};
  const record=(q)=>q.id.startsWith('starter:')?localState(q):data?.progress?.find((x)=>x.item_id===q.id)??{};
  const bookmarked=(q)=>q.id.startsWith('starter:')?!!localState(q).bookmark:!!data?.bookmarks?.includes(q.id);
  const note=(q)=>q.id.startsWith('starter:')?localState(q).note??'':data?.notes?.find((n)=>n.item_id===q.id)?.note??'';
  const target=()=>`/api/learning/${appId}`;
  const reload=async()=>{if(appId)data=await api(target());};
  const announce=()=>{status.textContent=pending||error||warning;status.classList.toggle('warn',!!error&&!pending);};
  const action=async(name,payload,label,timeout)=>{
    if(busy)return;
    busy=true;pending=label;error='';announce();
    try{
      if(!appId&&name==='generate')appId=(await api('/api/learning/application','application',{jobId:Number(id)})).id;
      const result=await api(`${target()}/${name}`,name,payload,timeout);
      await reload();if(name==='answer')feedback={...result.feedback,questionId:payload.questionId,category:questions().find(q=>q.id===payload.questionId)?.category};
    }catch(e){error=e.name==='TimeoutError'?'This action is taking longer than expected. You can keep studying and reload to check for a saved result.':e.message;}
    finally{busy=false;pending='';announce();if(root.isConnected)draw();}
  };
  function change(q,name,payload){
    if(!q.id.startsWith('starter:'))return action(name,{itemId:q.id,...payload},'Saving…');
    const before=localState(q), next={...before};
    if(name==='bookmark')next.bookmark=payload.bookmarked;
    if(name==='note')next.note=payload.note;
    if(name==='progress')Object.assign(next,{status:payload.status,last_at:new Date().toISOString(),due_at:new Date(Date.now()+86400000*(payload.status==='mastered'?3:1)).toISOString()});
    try{const saved={...local,[q.id]:next};localStorage.setItem(`jobagent-prep-v1:${id}`,JSON.stringify(saved));local=saved;error='';}
    catch{error='Could not save starter progress in this browser.';}
    announce();draw();
  }
  function drawHeader(){
    const qs=questions(), mastered=qs.filter(q=>record(q).status==='mastered').length, revision=qs.filter(q=>record(q).status==='revision').length;
    header.replaceChildren(el('h2',`${job.title} · ${job.company}`));
    const meta=el('div','','prep-meta');meta.append(badge(job.description?.trim()?'Description available':'No description saved'),badge(job.description?.trim()?'Posting-based inference':'Title-only estimate'));
    try{const url=new URL(job.url);if(['http:','https:'].includes(url.protocol)&&!url.username&&!url.password){const link=el('a','Original posting ↗');link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';meta.append(link);}}catch{}
    const stats=el('div','','prep-meta');stats.append(el('span',`${qs.length} questions · ${mastered} mastered · ${revision} to revise`));
    const bar=field('progress','Questions mastered');bar.max=qs.length||1;bar.value=mastered;stats.append(bar,el('span',`${qs.length?Math.round(100*mastered/qs.length):0}% mastered`));
    header.append(meta,stats,el('p',job.description?.trim()?'Practice predictions, not verified company interview questions.':'No job description is saved. These are title-only estimates, not verified company interview questions.','meta'));
  }
  function bank(){
    const filter=el('div','','prep-filter'), split=el('div','','prep-split'), left=el('div','','prep-list'), right=el('article','','prep-detail');
    split.classList.toggle('prep-mobile-detail',mobileDetail);
    const input=field('input','Search questions');input.type='search';input.placeholder='Search questions…';input.value=query;
    const qs=questions();
    const options=(values,all)=>[['',all],...[...new Set(values.filter(Boolean))].map(x=>[x,x])];
    const pick=(label,values,current,fn)=>{const select=choices(label,values,(v)=>{fn(v);renderLists();});select.value=current;const shell=el('div','','prep-select');shell.append(select);return shell;};
    input.oninput=()=>{query=input.value;renderLists();};
    const stateTabs=el('div','','buttons learn-switch');
    for(const [key,label] of [['','All Questions'],['mastered','Solved Questions'],['revision','Revision Questions']]){
      const b=button(label,()=>{completion=key;bankView();});b.setAttribute('aria-pressed',String(completion===key));stateTabs.append(b);
    }
    function bankView(){main.replaceChildren();bank();}
    const progress=el('dl','','workspace-metrics question-statbar');
    for(const label of [...new Set(qs.map(q=>q.difficulty).filter(Boolean))]){
      const items=qs.filter(q=>q.difficulty===label), done=items.filter(q=>record(q).status==='mastered').length;
      const item=el('div','','panel workspace-stat');item.append(el('dt',label),el('dd',`${done} / ${items.length} mastered`));progress.append(item);
    }
    filter.append(input,pick('Category',options(qs.map(q=>q.category),'All categories'),category,v=>category=v),
      pick('Difficulty',options(qs.map(q=>q.difficulty),'All difficulties'),level,v=>level=v),
      pick('Priority',options(qs.map(q=>q.priority),'All priorities'),priority,v=>priority=v),
      pick('Completion',[['','Any status'],['new','Not attempted'],['attempted','Attempted'],['mastered','Mastered'],['revision','Needs revision'],['bookmark','Bookmarked']],completion,v=>completion=v),
      pick('Question source',[['','All sources'],['posting','Posting evidence'],['profile','Project or profile'],['estimate','Role estimate']],source,v=>source=v),
      pick('Sort by',[['priority','Priority'],['difficulty','Difficulty'],['recent','Recently attempted']],sort,v=>sort=v));
    function renderLists(){
      const rank=(list,value)=>list.includes(value)?list.indexOf(value):list.length;
      const basis=q=>/^(?:Posting|Job description)/i.test(q.basis??'')?'posting':q.project||/^profile/i.test(q.basis??'')?'profile':'estimate';
      const filtered=qs.filter(q=>(!source||basis(q)===source)&&(!category||q.category===category)&&(!level||q.difficulty===level)&&(!priority||q.priority===priority)
        &&(!completion||(completion==='bookmark'?bookmarked(q):(record(q).status??'new')===completion))
        &&`${q.prompt} ${q.category} ${q.topic??''}`.toLowerCase().includes(query.trim().toLowerCase())).sort((a,b)=>sort==='recent'?String(record(b).last_at??'').localeCompare(String(record(a).last_at??'')):sort==='difficulty'?rank(difficulty,a.difficulty)-rank(difficulty,b.difficulty):rank(priorities,a.priority)-rank(priorities,b.priority));
      const q=filtered.find(q=>q.id===selected)??filtered[0];selected=q?.id;
      left.replaceChildren(el('p',`${filtered.length} of ${qs.length} questions`,'meta'));right.replaceChildren();
      if(!q){right.append(el('p','No questions match these filters.'));return;}
      const select=(id)=>{selected=id;mobileDetail=true;split.classList.add('prep-mobile-detail');renderLists();right.scrollTop=0;right.focus();};
      const groups=sort==='priority'&&!query&&!category?[...new Set(filtered.map(q=>q.category))]:[''];
      for(const group of groups){
        const items=group?filtered.filter(q=>q.category===group):filtered;
        const section=group?el('details','','prep-category'):left;
        if(group){section.open=!collapsed.has(group);section.addEventListener('toggle',()=>section.open?collapsed.delete(group):collapsed.add(group));section.append(el('summary',`${group} · ${items.length}`));}
        const table=el('table','','question-table'), head=el('thead'), hr=el('tr'), body=el('tbody');
        for(const label of ['Question','Level','Priority','Status']){const th=el('th',label);th.scope='col';hr.append(th);}head.append(hr);table.append(head,body);
        for(const item of items){
          const tr=el('tr'), question=el('td'), row=button(item.prompt,()=>select(item.id));row.className='prep-row';
          row.setAttribute('aria-pressed',String(item.id===q.id));question.append(row);if(!group)question.append(el('span',item.category,'meta'));
          const level=el('td'),priority=el('td'),state=el('td');level.append(item.difficulty?badge(item.difficulty):'—');priority.append(badge(item.priority));
          if(record(item).status==='mastered'){const mark=el('span','Mastered','badge workspace-good');mark.prepend(icon('check'));state.append(mark);}
          else if(record(item).status==='revision')state.append(el('span','Revision','badge workspace-warn'));
          if(bookmarked(item)){const mark=el('span','Bookmarked','question-bookmark');mark.prepend(icon('bookmark'));state.append(mark);}
          if(!state.childNodes.length)state.textContent='—';
          tr.append(question,level,priority,state);body.append(tr);
        }
        const columns=el('colgroup');for(let i=0;i<4;i++)columns.append(el('col'));table.prepend(columns);
        const scroll=el('div','','question-scroll');scroll.tabIndex=0;scroll.setAttribute('role','region');scroll.setAttribute('aria-label',group?`${group} questions`:'Filtered questions');scroll.append(table);section.append(scroll);
        if(group)left.append(section);
      }
      right.tabIndex=-1;
      const back=button('Back to questions',()=>{mobileDetail=false;split.classList.remove('prep-mobile-detail');left.querySelector('[aria-pressed=true]')?.focus();},'back');back.className='prep-back';
      right.append(back,el('h2',q.prompt),el('p',[q.category,q.difficulty,q.priority,q.basis].filter(Boolean).join(' · '),'meta'));
      for(const [label,value] of [['Why it’s asked',q.why],['Strong answer checklist',q.strongAnswer],['Concept explained',q.explanation],['Sample answer',q.sampleAnswer],['Example',q.example],['Common mistakes',q.mistakes],['Follow-up questions',q.followups],['Average vs. excellent',q.rubric],['Related concepts',q.topic]])put(right,label,value);
      const tools=el('div','','buttons prep-actions'), notes=field('textarea','Personal notes');notes.value=note(q);notes.maxLength=10000;notes.rows=3;
      for(const [label,name,payload,glyph] of [['Mark mastered','progress',{status:'mastered'},'check'],['Mark for revision','progress',{status:'revision'}], [bookmarked(q)?'Remove bookmark':'Bookmark','bookmark',{bookmarked:!bookmarked(q)},'bookmark'],['Save note','note',null]]){
        const b=button(label,()=>change(q,name,payload??{note:notes.value}),glyph);b.disabled=busy&&!q.id.startsWith('starter:');tools.append(b);
      }
      const ix=filtered.indexOf(q), prev=button('Previous',()=>select(filtered[ix-1].id)), next=button('Next',()=>select(filtered[ix+1].id));prev.disabled=ix===0;next.disabled=ix===filtered.length-1;
      right.append(el('h3','Personal notes'),notes,tools);tools.append(prev,next);
    }
    split.append(left,right);main.append(stateTabs,progress,filter,split);renderLists();
  }
  function overview(){
    const section=card('Preparation overview');
    put(section,'Study focus',data?.plan?.overview??'Start with the highest-priority questions matched to this posting. Open an answer after you can explain your reasoning aloud.');
    for(const step of data?.plan?.studyPlan??[])put(section,step.title,step.steps);
    if(!data?.plan){
      const generate=button('Build full question bank',()=>{
        if(window.confirm('Generate a full bank with the local model? The starter questions remain available while it runs.'))
          void action('generate',{replace:false},'Generating locally in batches. You can keep browsing the starter questions.',600000);
      });generate.disabled=busy||!job.modelConfigured;
      section.append(el('p','The starter brief opens instantly. A full bank targets 25–40 questions and requires a running local Ollama model.', 'meta'),generate);
    }
    main.append(section);
    const role=choices('Switch tracked role',[['','Current posting']],value=>{if(value)location.hash=`learning/${value}`;});
    role.hidden=true; section.append(role);
    void api('/api/learning').then(({applications})=>{
      if(!role.isConnected)return;
      for(const app of applications??[])if(String(app.job_id)!==id)role.add(new Option(`${app.title} · ${app.company}`,app.job_id));
      role.hidden=role.options.length<2;
    }).catch(()=>{});
  }
  function exercisesTab(){
    const entries=data?.plan?.exercises??[];
    if(!entries.length){main.append(el('p','No saved exercises yet. Build the full question bank from Overview to add role-specific exercises.','empty'));return;}
    for(const exercise of entries){
      const section=card(exercise.title);
      section.append(el('p',exercise.difficulty,'meta'),el('p',exercise.statement));
      put(section,'Examples',exercise.examples);put(section,'Constraints',exercise.constraints);
      const answer=field('textarea','Your exercise attempt');answer.rows=4;answer.maxLength=12000;
      const attempts=(data.attempts??[]).filter(a=>a.item_id===exercise.id);
      section.append(answer,button('Save attempt',()=>{if(answer.value.trim().length<8){error='Enter at least 8 characters for your attempt.';announce();return;}void action('exercise',{itemId:exercise.id,answer:answer.value},'Saving attempt…');}));
      for(const [label,text] of [['Hints',exercise.hints?.join('\n')],['Approach and criteria',[exercise.approach,...(exercise.criteria??[])].join('\n')],['Reveal solution',exercise.solution]])if(text)section.append(disclosure(label,text));
      if(attempts.length)section.append(disclosure(`Saved attempts (${attempts.length})`,attempts.map(a=>a.answer).join('\n\n')));
      main.append(section);
    }
  }
  function projects(){
    const stored=questions().filter(q=>q.project);
    const section=card('Project Deep Dive');
    section.append(el('p','Use implementation details you can support. If you did not measure an improvement, explain how you would measure it.','meta'));
    for(const q of stored){const row=disclosure(`${q.project} · ${q.prompt}`,q.explanation);row.append(button('Open in Question Bank',()=>openQuestion(q)));section.append(row);}
    for(const project of job.projects??[]){
      const row=disclosure(project.name,project.summary);
      put(row,'Architecture & trade-offs',[`Trace one request through ${project.name}. What did you implement and why?`,`What alternative did you reject, and what evidence would change your decision?`]);
      put(row,'Testing & failure modes',['Which boundary would fail first under load? How would you test it?','How did you debug a failure, verify the fix, and prevent a regression?']);
      put(row,'Performance & next steps',['Which performance or security claims can you demonstrate?','What would you change first if rebuilding it?']);section.append(row);
    }
    if(!stored.length&&!job.projects?.length)section.append(el('p','No saved project evidence is available for this posting.'));main.append(section);
  }
  function mocks(){
    const section=card('Mock Interview');main.append(section);
    if(!data?.plan){section.append(el('p','Build a full plan from Overview to start a scored mock.'));return;}
    const session=data.active;
    if(feedback){
      put(section,'Assessment',`Correctness ${feedback.correctness}/10 · Depth ${feedback.depth}/10 · Clarity ${feedback.clarity}/10 · Practical ${feedback.practical}/10`);
      put(section,'Missing concepts',feedback.missing);put(section,'Corrections',feedback.incorrect);put(section,'Model answer',feedback.modelAnswer);put(section,'Follow-up',feedback.followup);
      const related=questions().find(q=>q.id!==feedback.questionId&&q.category===feedback.category);
      if(related)section.append(button('Review a related question',()=>openQuestion(related)));
      section.append(button(session?'Next question':'Finish review',()=>{feedback=null;draw();}));
    }else if(session?.question){
      section.append(el('p',`Question ${session.answered+1} of ${session.total}`,'meta'),el('h3',session.question.prompt));
      const answer=field('textarea','Your interview answer');answer.rows=6;answer.maxLength=12000;
      const submit=button('Submit answer',()=>{
        if(answer.value.trim().length<8){error='Enter at least 8 characters before submitting.';announce();return;}
        void action('answer',{sessionId:session.id,questionId:session.question.id,answer:answer.value},'Evaluating locally…',90000);
      });submit.disabled=!job.modelConfigured||busy;
      section.append(answer,submit,button('End mock',()=>{if(window.confirm('End and save this mock as incomplete?'))void action('abandon',{sessionId:session.id},'Ending mock…');}));
      if(!job.modelConfigured)section.append(el('p','Configure the local model to submit an answer.','meta'));
    }else{
      const start=button('Start mock interview',()=>void action('start',{},'Starting mock…'));start.disabled=!job.modelConfigured||busy;section.append(start);
      if(!job.modelConfigured)section.append(el('p','Configure a local Ollama model to start a scored mock.','meta'));
    }
    for(const past of data.sessions??[]){
      const history=disclosure(`${past.abandoned?'Ended early':'Completed'} · ${past.score===null?'Unscored':`${past.score}/100`}`,new Date(past.created_at).toLocaleString());
      put(history,'Category scores',Object.entries(past.categoryScores??{}).map(([k,v])=>`${k}: ${v}/100`));
      for(const row of past.history??[])put(history,`Answer ${row.position+1}`,[row.answer,row.feedback?.modelAnswer].filter(Boolean));
      section.append(history);
    }
  }
  function openQuestion(q){selected=q.id;query=category=level=priority=completion=source='';mobileDetail=true;active='Question Bank';draw();}
  function revision(){
    const section=card('Progress & Revision');
    const qs=questions(), due=qs.filter(q=>record(q).due_at&&Date.parse(record(q).due_at)<=Date.now()), weak=qs.filter(q=>record(q).status==='revision');
    const queue=[...new Set([...due,...weak])];
    section.append(el('p',`${qs.filter(q=>record(q).status).length} attempted · ${due.length} due for revision · ${qs.filter(bookmarked).length} bookmarked`));
    if(!data?.plan)section.append(el('p','Starter progress is saved in this browser. Full-plan progress is saved in JobAgent.','meta'));
    for(const q of queue)section.append(button(q.prompt,()=>openQuestion(q)));
    if(!queue.length)section.append(el('p','Nothing is due. Try a Must Know question next.','meta'));
    main.append(section);
  }
  function draw(){
    if(!job)return;
    drawHeader();nav.replaceChildren();main.replaceChildren();
    for(const tab of tabs){const b=button(tab,()=>{active=tab;draw();nav.querySelector('[aria-pressed=true]')?.focus();});b.setAttribute('aria-pressed',String(tab===active));nav.append(b);}
    ({Overview:overview,'Question Bank':bank,'Practical Exercises':exercisesTab,'Project Deep Dive':projects,'Mock Interview':mocks,'Progress & Revision':revision})[active]();
  }
  try{
    job=await api(`/api/interview-prep/${id}`);appId=job.application_id;
    warning=job.description?.trim()?'':'Title-only estimate. No company interview questions are verified.';
    if(appId)try{await reload();}catch{error='Could not load the saved plan. Showing starter questions; refresh to retry.';}
    if(root.isConnected)draw();
  }catch(e){error=e.message||'Could not load this posting.';main.append(button('Retry',()=>{root.remove();void mountLearning(view,id);}));}
  announce();
}
