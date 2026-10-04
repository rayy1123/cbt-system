import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
import { login, seedUser } from '../src/auth.js';
import { getQuestionForParticipant } from '../src/questions.js';

test('Question Bank RBAC: Teacher authorized, Participant blocked (BFLA check)', async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}/api/v1`;

  try {
    // 1. Login as teacher and participant
    const teacherLogin = login('teacher01', 'Password123!');
    const participantLogin = login('participant01', 'Password123!');
    assert.equal(teacherLogin.success, true);
    assert.equal(participantLogin.success, true);

    const teacherToken = teacherLogin.token;
    const participantToken = participantLogin.token;

    // 2. BFLA Check: Participant attempting POST /questions -> MUST BE 403
    const forbiddenCreateRes = await fetch(`${baseUrl}/questions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${participantToken}`
      },
      body: JSON.stringify({
        prompt: 'Apakah 2 + 2 = 4?',
        options: [{ optionKey: 'A', content: 'Benar' }, { optionKey: 'B', content: 'Salah' }],
        answerKey: 'A'
      })
    });
    assert.equal(forbiddenCreateRes.status, 403);

    // 3. BFLA Check: Participant attempting GET /questions -> MUST BE 403
    const forbiddenListRes = await fetch(`${baseUrl}/questions`, {
      headers: { Authorization: `Bearer ${participantToken}` }
    });
    assert.equal(forbiddenListRes.status, 403);

    // 4. Authorized Create: Teacher creates question -> 201
    const createRes = await fetch(`${baseUrl}/questions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${teacherToken}`
      },
      body: JSON.stringify({
        prompt: 'Ibukota Indonesia sebelum Nusantara adalah?',
        options: [
          { optionKey: 'A', content: 'Bandung' },
          { optionKey: 'B', content: 'Jakarta' },
          { optionKey: 'C', content: 'Surabaya' }
        ],
        answerKey: 'B'
      })
    });
    assert.equal(createRes.status, 201);
    const createdData = await createRes.json();
    assert.ok(createdData.question.id);
    assert.equal(createdData.question.answer_key, 'B');

    const questionId = createdData.question.id;
    const versionId = createdData.question.version_id;

    // 5. Authorized Read: Teacher reads question -> 200 with answer_key
    const readRes = await fetch(`${baseUrl}/questions/${questionId}`, {
      headers: { Authorization: `Bearer ${teacherToken}` }
    });
    assert.equal(readRes.status, 200);
    const readData = await readRes.json();
    assert.equal(readData.question.answer_key, 'B');

    // 6. Security Check: Participant delivery DTO guarantees zero answer key leak
    const participantContext = { role: 'PARTICIPANT', organization_id: 'org_default' };
    const participantDTO = getQuestionForParticipant(versionId, participantContext);

    assert.equal(participantDTO.prompt, 'Ibukota Indonesia sebelum Nusantara adalah?');
    assert.equal(participantDTO.options.length, 3);
    assert.equal(participantDTO.answer_key, undefined);
    assert.equal(participantDTO.answerKey, undefined);
    assert.equal(participantDTO.isCorrect, undefined);
    assert.equal(participantDTO.correctAnswer, undefined);

    // Ensure options don't leak correctness flag
    for (const opt of participantDTO.options) {
      assert.equal(opt.isCorrect, undefined);
      assert.equal(opt.correct, undefined);
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
