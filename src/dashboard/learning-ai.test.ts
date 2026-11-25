import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateAnswer, generatePlan, type PrepContext, type Question } from './learning-ai.ts';

const context: PrepContext = {
  title: 'Backend Engineering Intern', company: 'Example Company', description: 'Build PostgreSQL queries and REST APIs.', round: 'SQL interview',
  profile: { summary: '', skills: ['TypeScript'], projects: [{ name: 'Ledger', summary: 'Uses SQLite', tech: ['SQLite'], highlights: [] }], experience: [] },
};
const question: Question = {
  id: 'q-1', prompt: 'How would you detect duplicate transfers?', topic: 'Duplicates', category: 'SQL', difficulty: 'Medium', priority: 'Must Know',
  basis: 'Role estimate', why: 'Data integrity', strongAnswer: ['Choose a grouping key'], explanation: 'Group by the business key.',
  sampleAnswer: 'Find keys with more than one row.', example: 'GROUP BY reference HAVING COUNT(*) > 1',
  mistakes: ['Grouping by row ID'], followups: ['How would you prevent future duplicates?', 'How would you reconcile duplicates?', 'How would you validate the grouping key?'],
  rubric: 'Credit an accurate business key and aggregate filter.',
};
const exercise = {
  id: 'model-chosen-id', title: 'Find missing payments', difficulty: 'Medium', statement: 'Return all invoices without matching payments.',
  examples: ['An unpaid invoice appears once.'], constraints: ['Allow partial payments.'], hints: ['Consider NOT EXISTS.'],
  approach: 'Correlate on invoice ID.', criteria: ['Correctly handle no matching payment.'], solution: 'SELECT * FROM invoices i WHERE NOT EXISTS (SELECT 1 FROM payments p WHERE p.invoice_id = i.id)',
};
const outline = {
  overview: 'Practice SQL.', studyPlan: [{ title: 'Review', steps: ['Read a query plan.'] }, { title: 'Practice', steps: ['Compare plan shapes.'] }],
  exercises: [exercise, { ...exercise, title: 'Find partial payments' }],
};
const feedback = { correctness: 8, depth: 6.5, clarity: 7, practical: 4, missing: ['An index strategy'], incorrect: [], followup: 'What index would help?', modelAnswer: 'Group by reference and use HAVING.' };

async function withModel(name: string | undefined, run: () => Promise<void>) {
  const old = process.env.JOBAGENT_OLLAMA_MODEL;
  if (name === undefined) delete process.env.JOBAGENT_OLLAMA_MODEL;
  else process.env.JOBAGENT_OLLAMA_MODEL = name;
  try { await run(); }
  finally {
    if (old === undefined) delete process.env.JOBAGENT_OLLAMA_MODEL;
    else process.env.JOBAGENT_OLLAMA_MODEL = old;
  }
}

type ChatRequest = { model: string; stream: boolean; format: object; messages: { role: string; content: string }[] };
function mockChat(output: (input: ChatRequest) => unknown, models: object[] = [{ name: 'test-model:latest' }]) {
  const calls: ChatRequest[] = [];
  const request: typeof fetch = async (url, init) => {
    assert.equal(init?.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    if (url === 'http://127.0.0.1:11434/api/tags') {
      assert.equal(init.method, 'GET');
      assert.equal(init.body, undefined);
      return Response.json({ models });
    }
    assert.equal(url, 'http://127.0.0.1:11434/api/chat');
    assert.equal(init.method, 'POST');
    const body = JSON.parse(String(init.body)) as ChatRequest;
    assert.equal(body.model, 'test-model:latest');
    assert.equal(body.stream, false);
    assert.equal(typeof body.format, 'object');
    assert.equal(body.messages[0]?.role, 'system');
    assert.equal(body.messages[1]?.role, 'user');
    calls.push(body);
    return Response.json({ message: { content: JSON.stringify(output(body)) } });
  };
  return { request, calls };
}

function candidate(prompt: string, source = 'role', evidence = '', project?: string) {
  return { ...question, prompt, source, evidence, project };
}

test('generates a bounded batched plan with unique IDs and checks cited project and posting evidence', async () => {
  await withModel('test-model', async () => {
    let batch = 0;
    const { request, calls } = mockChat((body) => {
      const input = JSON.parse(body.messages[1]!.content);
      assert.equal(input.round, context.round);
      assert.equal(input.description, context.description);
      if (!input.focus) return outline;
      batch++;
      if (batch === 1) return { questions: [
        candidate('Explain a PostgreSQL index.', 'description', 'PostgreSQL'),
        candidate('EXPLAIN  A POSTGRESQL INDEX!', 'description', 'PostgreSQL'),
        candidate('What did you build in Ledger?', 'profile', 'Uses SQLite', 'Ledger'),
        candidate('Explain your details in Absent Project.', 'profile', 'Uses SQLite', 'Absent Project'),
        candidate('How do you use MySQL?', 'description', 'MySQL'),
        candidate('How did Ledger use TypeScript?', 'profile', 'TypeScript', 'Ledger'),
      ] };
      assert.ok(input.acceptedQuestions.some((q: Question) => q.prompt === 'Explain a PostgreSQL index.'));
      return { questions: Array.from({ length: input.count }, (_, i) => candidate(`Explain SQL concept ${batch * 10 + i}.`)) };
    });
    const plan = await generatePlan(context, request);
    assert.equal(plan.questions.length, 30);
    assert.ok(calls.length > 2);
    assert.equal(new Set([...plan.questions, ...plan.exercises].map((item) => item.id)).size, 32);
    assert.deepEqual(plan.questions.slice(0, 3).map((q) => q.basis), ['Job description: PostgreSQL', 'Profile: Uses SQLite', 'Role estimate']);
    assert.equal(plan.questions[1]?.project, 'Ledger');
    assert.equal(plan.questions[2]?.project, undefined);
    assert.match(plan.overview, /No company interview questions are verified/);
  });
});

test('labels title-only work as an estimate and fails rather than returning a duplicate-filled plan', async () => {
  await withModel('test-model', async () => {
    let round = 0;
    const titleOnly = { ...context, description: '   ', profile: undefined };
    const { request } = mockChat((body) => {
      const input = JSON.parse(body.messages[1]!.content);
      if (!input.focus) return outline;
      round++;
      return { questions: Array.from({ length: input.count }, (_, i) => candidate(`Question ${round}-${i}?`)) };
    });
    const plan = await generatePlan(titleOnly, request);
    assert.match(plan.overview, /^Role-level estimate: no job description supplied/);
    assert.ok(plan.questions.every((q) => q.basis === 'Role estimate'));
    const repeated = mockChat((body) => JSON.parse(body.messages[1]!.content).focus ? { questions: [candidate('Repeat?')] } : outline);
    await assert.rejects(generatePlan(titleOnly, repeated.request), /1 distinct, grounded questions \(25 required\)/);
  });
});

test('grades against the rubric and rejects out-of-range or malformed feedback', async () => {
  await withModel('test-model', async () => {
    const { request } = mockChat((body) => {
      assert.equal(JSON.parse(body.messages[1]!.content).answer, 'I would group by reference.');
      assert.equal(JSON.parse(body.messages[1]!.content).rubric, question.rubric);
      return feedback;
    });
    assert.deepEqual(await evaluateAnswer(question, 'I would group by reference.', request), feedback);
    const bad = mockChat(() => ({ ...feedback, correctness: 11 }));
    await assert.rejects(evaluateAnswer(question, 'My answer', bad.request), /invalid answer feedback \(correctness\)/);
    const malformed = mockChat(() => '{broken');
    await assert.rejects(evaluateAnswer(question, 'My answer', malformed.request), /invalid answer feedback/);
  });
});

test('rejects missing configuration, cloud variants, and remote-backed aliases before sending prompts', async () => {
  const noRequest: typeof fetch = async () => assert.fail('Remote or unconfigured model should not cause a request.');
  for (const name of [undefined, 'gpt-model:cloud', 'gpt-model:120b-cloud', 'ollama.com/model', 'https://127.0.0.1/model']) {
    await withModel(name, async () => {
      await assert.rejects(generatePlan(context, noRequest), /JOBAGENT_OLLAMA_MODEL/);
    });
  }
  await withModel('test-model', async () => {
    const remote = mockChat(() => assert.fail('Remote alias must not see the prompt'), [{ name: 'test-model:latest', remote_host: 'https://ollama.com', remote_model: 'some-model' }]);
    await assert.rejects(evaluateAnswer(question, 'My answer', remote.request), /locally installed/);
    assert.equal(remote.calls.length, 0);
    const offline: typeof fetch = async () => { throw new TypeError('fetch failed'); };
    await assert.rejects(generatePlan(context, offline), /Could not reach Ollama at http:\/\/127.0.0.1:11434/);
  });
});
