import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../store/db.ts';
import { addLearningApplication, learningAction, learningData, savePlan, submitAnswer } from './learning.ts';
import type { PlanContent } from './learning-ai.ts';

const content: PlanContent = {
 overview:'Build evidence-based answers',studyPlan:[{title:'Core practice',steps:['Practice explaining trade-offs']}],
 questions:[{id:'q1',prompt:'How do you reason about an API timeout?',topic:'Timeouts',category:'Practical engineering',difficulty:'Intermediate',priority:'Must Know',basis:'Role estimate',why:'Tests debugging',strongAnswer:['Distinguish connect and read timeouts'],explanation:'Timeouts bound waiting, not the remote operation.',sampleAnswer:'I identify which dependency exceeded its deadline.',example:'An API waiting on a database.',mistakes:['Blindly retrying all requests.'],followups:['When can you retry?','How do you observe retries?','What changes under load?'],rubric:'An excellent answer explains uncertainty and retry limits.'}],
 exercises:[{id:'e1',title:'Debug a slow request',difficulty:'Intermediate',statement:'Find the bottleneck.',examples:['A request waits on a dependency.'],constraints:['Keep the deadline.'],hints:['Inspect timings.'],approach:'Measure before optimizing.',criteria:['Explains evidence.'],solution:'Separate connection and execution time.'}],
};
function seed(){
 const db=openDb(':memory:');
 db.exec(`INSERT INTO companies(id,name,domain,created_at,updated_at) VALUES(1,'Example','example.com','2026-11-01','2026-11-01');
 INSERT INTO jobs(id,company_id,dedup_key,source,url,title,description,state_changed_at,first_seen_at,last_seen_at) VALUES
 (1,1,'a','manual','https://example.com/a','Backend Intern','Own a Python API','2026-11-01','2026-11-01','2026-11-01'),
 (2,1,'b','manual','https://example.com/b','Other Intern','','2026-11-01','2026-11-01','2026-11-01');`);
 return db;
}

test('learning uses one application per job, persists plans, and never regenerates on reads',async()=>{
 const db=seed();try{
  const {id}=addLearningApplication(db,1);assert.equal(addLearningApplication(db,1).id,id);
  assert.equal(learningData(db,id).plan,null);
  let calls=0;
  const generate=async(context:{description:string;round:string})=>{calls++;assert.equal(context.description,'Own a Python API');assert.equal(context.round,'Technical');return content;};
  const first=await savePlan(db,id,{round:'Technical',replace:false},generate);
  assert.match(first.plan!.basis,/Job description/);
  await savePlan(db,id,{round:'Technical',replace:false},generate);
  assert.equal(learningData(db,id).plan?.id,first.plan?.id);assert.equal(calls,1);
  await savePlan(db,id,{round:'Technical',replace:true},generate);
  assert.equal(db.prepare('SELECT count(*) AS n FROM learning_plans').get()?.n,2);
  const other=addLearningApplication(db,2).id;
  assert.match((await savePlan(db,other,{round:'',replace:false},async()=>content)).plan!.basis,/Role-level estimate/);
 }finally{db.close();}
});

test('progress, notes, and exercise answers stay separate and are scoped to the plan',async()=>{
 const db=seed();try{
  const {id}=addLearningApplication(db,1);await savePlan(db,id,{round:'',replace:false},async()=>content);
  await assert.rejects(learningAction(db,id,'progress',{itemId:'wrong',status:'mastered'}),/does not belong/);
  await learningAction(db,id,'progress',{itemId:'q1',status:'mastered'});
  const first=learningData(db,id).progress[0]!;
  assert.ok(Date.parse(String(first.due_at))-Date.parse(String(first.last_at))>=3*86400000);
  await learningAction(db,id,'progress',{itemId:'q1',status:'revision'});
  await learningAction(db,id,'note',{itemId:'q1',note:'My own notes'});
  await learningAction(db,id,'bookmark',{itemId:'q1',bookmarked:true});
  await assert.rejects(learningAction(db,id,'bookmark',{itemId:'e1',bookmarked:true}),/does not belong/);
  await learningAction(db,id,'exercise',{itemId:'e1',answer:'I would measure both calls.'});
  const state=learningData(db,id);
  assert.deepEqual([state.progress[0]?.attempts,state.progress[0]?.status],[2,'revision']);
  assert.deepEqual(state.bookmarks,['q1']);assert.equal(state.notes[0]?.note,'My own notes');assert.equal(state.attempts.length,1);
  assert.equal(state.plan?.questions[0]?.sampleAnswer,content.questions[0]?.sampleAnswer);
 }finally{db.close();}
});

test('mocks hide answers until submission, reject out-of-order answers and preserve feedback',async()=>{
 const db=seed();try{
  const {id}=addLearningApplication(db,1),{plan}=await savePlan(db,id,{round:'',replace:false},async()=>content);
  await learningAction(db,id,'start',{});
  const active=learningData(db,id).active!;
  assert.deepEqual(Object.keys(active.question!),['id','prompt','category']);assert.deepEqual(active.history,[]);
  await assert.rejects(savePlan(db,id,{round:'',replace:true},async()=>content),/Finish the active/);
  const feedback={correctness:5,depth:6,clarity:8,practical:5,missing:['Timeout scope'],incorrect:[],followup:'Can a timeout leave a write applied?',modelAnswer:'A timeout does not cancel remote execution.'};
  const evaluator=async()=>feedback;
  await assert.rejects(submitAnswer(db,plan!,active.id,'wrong','My answer about deadlines.',evaluator),/current/);
  const saved=await submitAnswer(db,plan!,active.id,'q1','My answer about deadlines.',evaluator);
  assert.equal(saved.session.score,60);assert.equal(saved.session.finished_at!==null,true);
  assert.equal(learningData(db,id).sessions[0]?.history.length,1);
  assert.equal(learningData(db,id).progress[0]?.status,'revision');
  await assert.rejects(submitAnswer(db,plan!,active.id,'q1','Trying to submit twice.',evaluator),/no longer active/);
 }finally{db.close();}
});
