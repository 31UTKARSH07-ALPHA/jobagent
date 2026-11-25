import { z } from 'zod';
import { transaction, type Db } from '../store/db.ts';
import { nowIso } from '../store/schema.ts';
import { loadProfile } from '../match/profile.ts';
import type { PlanContent, Question, PrepContext } from './learning-ai.ts';

const id=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const itemId=z.string().trim().min(1).max(128);
const response=z.string().trim().min(8).max(12_000);
const Progress=z.enum(['attempted','revision','mastered']);
export const learningInputs={
 application:z.object({jobId:id}),generate:z.object({round:z.string().trim().max(100).default(''),replace:z.boolean().default(false)}),
 bookmark:z.object({itemId,bookmarked:z.boolean()}),
 progress:z.object({itemId,status:Progress}),note:z.object({itemId,note:z.string().max(10_000)}),
 exercise:z.object({itemId,answer:response}),start:z.object({}),abandon:z.object({sessionId:id}),answer:z.object({sessionId:id,questionId:itemId,answer:response}),
};
export class LearningError extends Error {
 status:number;
 constructor(status:number,message:string){super(message);this.status=status;}
}
const conflict=(message:string):never=>{throw new LearningError(409,message);};
export function learningApplication(db:Db,appId:number) {
 const row=db.prepare(`SELECT a.id,j.id AS job_id,j.title,c.name AS company,j.description,
   length(trim(j.description))>0 AS has_description FROM applications a JOIN jobs j ON j.id=a.job_id
   JOIN companies c ON c.id=j.company_id WHERE a.id=?`).get(appId) as
   {id:number;job_id:number;title:string;company:string;description:string;has_description:number}|undefined;
 if(!row) throw new LearningError(404,'Application not found.');
 const {description,...summary}=row;
 return {description,summary:{...summary,round:String(db.prepare('SELECT round FROM learning_plans WHERE application_id=? ORDER BY id DESC LIMIT 1').get(appId)?.round??'')}};
}
export function learningIndex(db:Db, allowModel=true) {
 const applications=db.prepare(`SELECT a.id,a.job_id,j.title,c.name AS company,length(trim(j.description))>0 AS has_description,
  COALESCE((SELECT p.round FROM learning_plans p WHERE p.application_id=a.id ORDER BY id DESC LIMIT 1),'') AS round
  FROM applications a JOIN jobs j ON j.id=a.job_id JOIN companies c ON c.id=j.company_id ORDER BY a.id DESC`).all();
 return {applications,modelConfigured:allowModel && !!process.env.JOBAGENT_OLLAMA_MODEL};
}
export function addLearningApplication(db:Db,jobId:number) {
 if(!db.prepare('SELECT id FROM jobs WHERE id=?').get(jobId)) throw new LearningError(404,'Job not found.');
 db.prepare('INSERT INTO applications(job_id,created_at) VALUES(?,?) ON CONFLICT(job_id) DO NOTHING').run(jobId,nowIso());
 return {id:Number(db.prepare('SELECT id FROM applications WHERE job_id=?').get(jobId)!.id)};
}
function currentPlan(db:Db,appId:number) {
 const row=db.prepare('SELECT id,created_at,round,basis,content FROM learning_plans WHERE application_id=? ORDER BY id DESC LIMIT 1').get(appId) as
  {id:number;created_at:string;round:string;basis:string;content:string}|undefined;
 if(!row)return null;
 const {content,...meta}=row;
 return {...meta,...JSON.parse(content) as PlanContent};
}
type Plan=NonNullable<ReturnType<typeof currentPlan>>;
function requirePlan(db:Db,appId:number):Plan {const plan=currentPlan(db,appId);return plan??conflict('Generate a preparation plan first.');}
function ensureItem(plan:Plan,value:string,which:'question'|'exercise'|'either') {
 const found=(which!=='exercise'&&plan.questions.some((q)=>q.id===value))||(which!=='question'&&plan.exercises.some((e)=>e.id===value));
 if(!found)throw new LearningError(404,'Item does not belong to the active plan.');
}
const generation=new Set<number>();
export async function savePlan(db:Db,appId:number,input:z.infer<typeof learningInputs.generate>,generator?: (context:PrepContext)=>Promise<PlanContent>) {
 const {description,summary}=learningApplication(db,appId);
 const existing=currentPlan(db,appId);
 if(existing&&!input.replace)return {plan:existing};
 if(generation.has(appId))return conflict('A plan is already being generated.');
 if(existing&&activeSession(db,existing))return conflict('Finish the active mock before regenerating.');
 generation.add(appId);
 try {
  let profile:PrepContext['profile'];
  try {
   const p=loadProfile(process.env.JOBAGENT_PROFILE);
   profile={summary:p.summary,skills:p.skills.flatMap((group)=>group.items),projects:p.projects,
    experience:p.experience.map((entry)=>`${entry.role}: ${entry.summary}`)};
  } catch { /* Plan can still be grounded in the posting. */ }
  const make=generator??(await import('./learning-ai.ts')).generatePlan;
  const content=await make({title:summary.title,company:summary.company,description,round:input.round,profile});
  return transaction(db,()=>{
   if((currentPlan(db,appId)?.id??null)!==(existing?.id??null)||existing&&activeSession(db,existing))return conflict('The plan changed during generation. Reload and retry.');
   const basis=description.trim()?'Job description · inferred, not verified company questions':'Role-level estimate · no job description';
   db.prepare('INSERT INTO learning_plans(application_id,created_at,round,basis,content) VALUES(?,?,?,?,?)').run(appId,nowIso(),input.round,basis,JSON.stringify(content));
   return {plan:currentPlan(db,appId)};
  });
 } finally {generation.delete(appId);}
}
export function recordProgress(db:Db,plan:Plan,item:string,status:z.infer<typeof Progress>,now=new Date()) {
 ensureItem(plan,item,'either');
 const previous=db.prepare('SELECT streak FROM learning_progress WHERE plan_id=? AND item_id=?').get(plan.id,item);
 const streak=status==='mastered'?Math.min(5,Number(previous?.streak??0)+1):0;
 const days=status==='mastered'?[0,3,7,14,30,60][streak]!:1;
 const at=now.toISOString(),due=new Date(now.getTime()+days*86400_000).toISOString();
 db.prepare(`INSERT INTO learning_progress VALUES(?,?,?,1,?,?,?) ON CONFLICT(plan_id,item_id) DO UPDATE SET
 status=excluded.status,attempts=attempts+1,streak=excluded.streak,due_at=excluded.due_at,last_at=excluded.last_at`).run(plan.id,item,status,streak,due,at);
}
type Session={id:number;plan_id:number;created_at:string;finished_at:string|null;abandoned:number;question_ids:string};
function activeSession(db:Db,plan:Plan) {return db.prepare('SELECT * FROM learning_sessions WHERE plan_id=? AND finished_at IS NULL').get(plan.id) as Session|undefined;}
function compactQuestion(question:Question){const {id,prompt,category}=question;return {id,prompt,category};}
function answers(db:Db,session:number) {return db.prepare('SELECT * FROM learning_answers WHERE session_id=? ORDER BY position').all(session).map((r)=>({...r,item_id:String(r.item_id),feedback:JSON.parse(String(r.feedback)) as {correctness:number;depth:number;clarity:number;practical:number}}));}
function sessionSummary(db:Db,session:Session,plan:Plan) {
 const rows=answers(db,session.id), ids=JSON.parse(session.question_ids) as string[];
 const metrics=['correctness','depth','clarity','practical'] as const;
 const scoreOf=(row:typeof rows[number])=>metrics.reduce((sum,key)=>sum+row.feedback[key],0)/metrics.length;
 const categories=Object.fromEntries([...new Set(rows.map((r)=>plan.questions.find((q)=>q.id===r.item_id)?.category??'Other'))].map((category)=>{
  const items=rows.filter((r)=>plan.questions.find((q)=>q.id===r.item_id)?.category===category);
  return [category,Math.round(10*items.reduce((sum,row)=>sum+scoreOf(row),0)/items.length)];
 }));
 const next=session.finished_at?null:plan.questions.find((q)=>q.id===ids[rows.length]);
 return {id:session.id,created_at:session.created_at,finished_at:session.finished_at,abandoned:!!session.abandoned,answered:rows.length,total:ids.length,
  score:rows.length?Math.round(10*rows.reduce((sum,row)=>sum+scoreOf(row),0)/rows.length):null,categoryScores:categories,
  question:next?compactQuestion(next):null,history:rows};
}
export function learningData(db:Db,appId:number) {
 const application=learningApplication(db,appId).summary, plan=currentPlan(db,appId);
 if(!plan)return {application,plan,progress:[],bookmarks:[],notes:[],sessions:[],active:null,attempts:[]};
 const active=activeSession(db,plan);
 const sessions=(db.prepare(`SELECT s.* FROM learning_sessions s JOIN learning_plans p ON p.id=s.plan_id
  WHERE p.application_id=? AND s.finished_at IS NOT NULL ORDER BY s.id DESC`).all(appId) as unknown as Session[]).map((s)=>{
   const content=JSON.parse(String(db.prepare('SELECT content FROM learning_plans WHERE id=?').get(s.plan_id)!.content)) as PlanContent;
   return sessionSummary(db,s,{...plan,...content});
  });
 return {application,plan,active:active?sessionSummary(db,active,plan):null,sessions,
  bookmarks:db.prepare('SELECT item_id FROM learning_bookmarks WHERE plan_id=?').all(plan.id).map(row=>row.item_id),
  progress:db.prepare('SELECT * FROM learning_progress WHERE plan_id=?').all(plan.id),notes:db.prepare('SELECT item_id,note FROM learning_notes WHERE plan_id=?').all(plan.id),
  attempts:db.prepare('SELECT item_id,answer,created_at FROM learning_exercises WHERE plan_id=? ORDER BY id DESC').all(plan.id)};
}

const pendingAnswers=new Set<number>();
export async function learningAction(db:Db,appId:number,action:string,input:unknown) {
 if(action==='generate')return savePlan(db,appId,parse(learningInputs.generate,input));
 learningApplication(db,appId);
 const plan=requirePlan(db,appId);
 switch(action){
  case 'bookmark': {
   const {itemId,bookmarked}=parse(learningInputs.bookmark,input);ensureItem(plan,itemId,'question');
   if(bookmarked)db.prepare('INSERT OR IGNORE INTO learning_bookmarks VALUES(?,?)').run(plan.id,itemId);
   else db.prepare('DELETE FROM learning_bookmarks WHERE plan_id=? AND item_id=?').run(plan.id,itemId);
   break;
  }
  case 'progress': {
   const {itemId,status}=parse(learningInputs.progress,input); recordProgress(db,plan,itemId,status); break;
  }
  case 'note': {
   const {itemId,note}=parse(learningInputs.note,input);ensureItem(plan,itemId,'either');
   db.prepare(`INSERT INTO learning_notes VALUES(?,?,?) ON CONFLICT(plan_id,item_id) DO UPDATE SET note=excluded.note`).run(plan.id,itemId,note);break;
  }
  case 'exercise': {
   const {itemId,answer}=parse(learningInputs.exercise,input);ensureItem(plan,itemId,'exercise');
   db.prepare('INSERT INTO learning_exercises(plan_id,item_id,answer,created_at) VALUES(?,?,?,?)').run(plan.id,itemId,answer,nowIso());break;
  }
  case 'start': {
   parse(learningInputs.start,input);
   return transaction(db,()=>{
    const active=activeSession(db,plan);
    if(active)return {session:sessionSummary(db,active,plan)};
    const order=['Must Know','High Probability','Important','Advanced / Bonus'];
    const rank=(q:Question)=>{const i=order.findIndex((value)=>value.toLowerCase()===q.priority.toLowerCase());return i<0?order.length:i;};
    const ordered=[...plan.questions].sort((a,b)=>rank(a)-rank(b));
    const seen=new Set<string>();
    const first=ordered.filter(q=>{if(seen.has(q.category))return false;seen.add(q.category);return true;});
    const ids=[...new Set([...first,...ordered].map(q=>q.id))].slice(0,5);
    if(!ids.length)return conflict('This plan has no questions.');
    db.prepare('INSERT INTO learning_sessions(plan_id,created_at,question_ids) VALUES(?,?,?)').run(plan.id,nowIso(),JSON.stringify(ids));
    return {session:sessionSummary(db,activeSession(db,plan)!,plan)};
   });
  }
  case 'abandon': {
   const {sessionId}=parse(learningInputs.abandon,input);
   if(pendingAnswers.has(sessionId))return conflict('Wait for the current evaluation to finish.');
   const {changes}=db.prepare('UPDATE learning_sessions SET finished_at=?,abandoned=1 WHERE id=? AND plan_id=? AND finished_at IS NULL').run(nowIso(),sessionId,plan.id);
   if(!changes)return conflict('This mock interview is no longer active.');
   break;
  }
  case 'answer': {
   const {sessionId,questionId,answer}=parse(learningInputs.answer,input);
   return submitAnswer(db,plan,sessionId,questionId,answer);
  }
  default:throw new LearningError(404,'Unknown learning action.');
 }
 return {saved:true};
}
export function parse<T>(schema:z.ZodType<T>,input:unknown):T {
 const result=schema.safeParse(input);
 if(!result.success)throw new LearningError(400,result.error.issues[0]?.message??'Check your input.');
 return result.data;
}
export async function submitAnswer(db:Db,plan:Plan,sessionId:number,questionId:string,answer:string,evaluator?:typeof import('./learning-ai.ts').evaluateAnswer) {
 if(pendingAnswers.has(sessionId))return conflict('An answer is already being evaluated.');
 const session=activeSession(db,plan);
 if(!session||session.id!==sessionId)return conflict('This mock interview is no longer active.');
 const ids=JSON.parse(session.question_ids) as string[],position=answers(db,sessionId).length;
 const question=plan.questions.find((q)=>q.id===ids[position]);
 if(!question||question.id!==questionId)return conflict('Answer the current mock interview question.');
 pendingAnswers.add(sessionId);
 try {
  const evaluate=evaluator??(await import('./learning-ai.ts')).evaluateAnswer;
  const feedback=await evaluate(question,answer);
  return transaction(db,()=>{
   if(activeSession(db,plan)?.id!==sessionId||answers(db,sessionId).length!==position)return conflict('This question was already answered.');
   const at=nowIso();
   db.prepare('INSERT INTO learning_answers VALUES(?,?,?,?,?,?)').run(sessionId,position,questionId,answer,JSON.stringify(feedback),at);
   recordProgress(db,plan,questionId,feedback.correctness<7?'revision':'attempted');
   if(position+1===ids.length){db.prepare('UPDATE learning_sessions SET finished_at=? WHERE id=?').run(at,sessionId);session.finished_at=at;}
   return {feedback,session:sessionSummary(db,session,plan)};
  });
 } finally {pendingAnswers.delete(sessionId);}
}
