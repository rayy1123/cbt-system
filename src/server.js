import http from 'node:http';
import { login, logout, authenticate } from './auth.js';
import { createQuestion, listQuestions, getQuestionForAuthor } from './questions.js';
import {
  createExam,
  addQuestionsToExam,
  assignParticipant,
  listAssignedExams,
  startAttempt,
  getAttempt,
  saveAnswer,
  submitAttempt
} from './exams.js';

const PORT = process.env.PORT || 3000;

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1e6) { // 1MB limit
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function extractBearerToken(req) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  return authHeader.slice(7).trim();
}

function handleServiceError(res, err) {
  const msg = err.message || '';
  if (msg.startsWith('FORBIDDEN')) {
    res.writeHead(403);
    return res.end(JSON.stringify({ error: { code: 'FORBIDDEN', message: msg } }));
  }
  if (msg.startsWith('NOT_FOUND')) {
    res.writeHead(404);
    return res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: msg } }));
  }
  if (msg.startsWith('BAD_REQUEST')) {
    res.writeHead(400);
    return res.end(JSON.stringify({ error: { code: 'BAD_REQUEST', message: msg } }));
  }
  res.writeHead(500);
  res.end(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }));
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const method = req.method;

    res.setHeader('Content-Type', 'application/json');

    // Health check
    if (url.pathname === '/health' && method === 'GET') {
      res.writeHead(200);
      return res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
    }

    // POST /api/v1/auth/login
    if (url.pathname === '/api/v1/auth/login' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        if (!body.username || !body.password) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: 'Username and password required' }));
        }

        const result = login(body.username, body.password);
        if (!result.success) {
          res.writeHead(401);
          return res.end(JSON.stringify({ error: result.error }));
        }

        res.writeHead(200);
        return res.end(JSON.stringify({
          token: result.token,
          user: result.user
        }));
      } catch (err) {
        res.writeHead(400);
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // POST /api/v1/auth/logout
    if (url.pathname === '/api/v1/auth/logout' && method === 'POST') {
      const token = extractBearerToken(req);
      if (!token) {
        res.writeHead(401);
        return res.end(JSON.stringify({ error: 'Missing authorization token' }));
      }

      logout(token);
      res.writeHead(200);
      return res.end(JSON.stringify({ status: 'logged_out' }));
    }

    // GET /api/v1/auth/me
    if (url.pathname === '/api/v1/auth/me' && method === 'GET') {
      const token = extractBearerToken(req);
      if (!token) {
        res.writeHead(401);
        return res.end(JSON.stringify({ error: 'Unauthorized: missing session token' }));
      }

      const user = authenticate(token);
      if (!user) {
        res.writeHead(401);
        return res.end(JSON.stringify({ error: 'Unauthorized: invalid or expired session' }));
      }

      res.writeHead(200);
      return res.end(JSON.stringify({ user }));
    }

    // Questions API (Authoring: TEACHER or ADMIN)
    if (url.pathname === '/api/v1/questions') {
      const token = extractBearerToken(req);
      const user = authenticate(token);
      if (!user) {
        res.writeHead(401);
        return res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Invalid session' } }));
      }

      if (method === 'GET') {
        try {
          const questions = listQuestions(user.organization_id, user);
          res.writeHead(200);
          return res.end(JSON.stringify({ questions }));
        } catch (err) {
          return handleServiceError(res, err);
        }
      }

      if (method === 'POST') {
        try {
          const body = await parseJsonBody(req);
          const question = createQuestion({
            organizationId: user.organization_id,
            createdBy: user.id,
            questionType: body.questionType,
            prompt: body.prompt,
            options: body.options,
            answerKey: body.answerKey,
            scoringConfig: body.scoringConfig
          }, user);

          res.writeHead(201);
          return res.end(JSON.stringify({ question }));
        } catch (err) {
          return handleServiceError(res, err);
        }
      }
    }

    // GET /api/v1/questions/:id
    if (url.pathname.startsWith('/api/v1/questions/') && method === 'GET') {
      const token = extractBearerToken(req);
      const user = authenticate(token);
      if (!user) {
        res.writeHead(401);
        return res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Invalid session' } }));
      }

      const questionId = url.pathname.slice('/api/v1/questions/'.length);
      try {
        const question = getQuestionForAuthor(questionId, user);
        res.writeHead(200);
        return res.end(JSON.stringify({ question }));
      } catch (err) {
        return handleServiceError(res, err);
      }
    }

    // POST /api/v1/exams (Teacher / Admin creates exam)
    if (url.pathname === '/api/v1/exams' && method === 'POST') {
      const token = extractBearerToken(req);
      const user = authenticate(token);
      if (!user) {
        res.writeHead(401);
        return res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Invalid session' } }));
      }

      try {
        const body = await parseJsonBody(req);
        const exam = createExam({
          organizationId: user.organization_id,
          title: body.title,
          description: body.description,
          durationSeconds: body.durationSeconds,
          startsAt: body.startsAt,
          endsAt: body.endsAt,
          resultReleasePolicy: body.resultReleasePolicy
        }, user);

        res.writeHead(201);
        return res.end(JSON.stringify({ exam }));
      } catch (err) {
        return handleServiceError(res, err);
      }
    }

    // POST /api/v1/exams/:id/questions (Attach questions)
    if (url.pathname.startsWith('/api/v1/exams/') && url.pathname.endsWith('/questions') && method === 'POST') {
      const token = extractBearerToken(req);
      const user = authenticate(token);
      if (!user) {
        res.writeHead(401);
        return res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Invalid session' } }));
      }

      const examId = url.pathname.split('/')[4];
      try {
        const body = await parseJsonBody(req);
        const questions = addQuestionsToExam(examId, body.questions || [], user);
        res.writeHead(200);
        return res.end(JSON.stringify({ questions }));
      } catch (err) {
        return handleServiceError(res, err);
      }
    }

    // POST /api/v1/exams/:id/assign (Assign participant)
    if (url.pathname.startsWith('/api/v1/exams/') && url.pathname.endsWith('/assign') && method === 'POST') {
      const token = extractBearerToken(req);
      const user = authenticate(token);
      if (!user) {
        res.writeHead(401);
        return res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Invalid session' } }));
      }

      const examId = url.pathname.split('/')[4];
      try {
        const body = await parseJsonBody(req);
        const assignment = assignParticipant(examId, body.participantId, user);
        res.writeHead(200);
        return res.end(JSON.stringify({ assignment }));
      } catch (err) {
        return handleServiceError(res, err);
      }
    }

    // GET /api/v1/participant/exams (List assigned exams)
    if (url.pathname === '/api/v1/participant/exams' && method === 'GET') {
      const token = extractBearerToken(req);
      const user = authenticate(token);
      if (!user) {
        res.writeHead(401);
        return res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Invalid session' } }));
      }

      try {
        const exams = listAssignedExams(user);
        res.writeHead(200);
        return res.end(JSON.stringify({ exams }));
      } catch (err) {
        return handleServiceError(res, err);
      }
    }

    // POST /api/v1/participant/exams/:examId/attempts (Start attempt)
    if (url.pathname.startsWith('/api/v1/participant/exams/') && url.pathname.endsWith('/attempts') && method === 'POST') {
      const token = extractBearerToken(req);
      const user = authenticate(token);
      if (!user) {
        res.writeHead(401);
        return res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Invalid session' } }));
      }

      const examId = url.pathname.split('/')[5];
      try {
        const attempt = startAttempt(examId, user);
        res.writeHead(201);
        return res.end(JSON.stringify({ attempt }));
      } catch (err) {
        return handleServiceError(res, err);
      }
    }

    // GET /api/v1/participant/attempts/:attemptId (Get attempt + sanitized questions)
    const getAttemptMatch = url.pathname.match(/^\/api\/v1\/participant\/attempts\/([a-zA-Z0-9_-]+)$/);
    if (getAttemptMatch && method === 'GET') {
      const token = extractBearerToken(req);
      const user = authenticate(token);
      if (!user) {
        res.writeHead(401);
        return res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Invalid session' } }));
      }

      const attemptId = getAttemptMatch[1];
      try {
        const data = getAttempt(attemptId, user);
        res.writeHead(200);
        return res.end(JSON.stringify(data));
      } catch (err) {
        return handleServiceError(res, err);
      }
    }

    // PUT /api/v1/participant/attempts/:attemptId/answers/:questionVersionId (Save answer)
    const saveAnswerMatch = url.pathname.match(/^\/api\/v1\/participant\/attempts\/([a-zA-Z0-9_-]+)\/answers\/([a-zA-Z0-9_-]+)$/);
    if (saveAnswerMatch && method === 'PUT') {
      const token = extractBearerToken(req);
      const user = authenticate(token);
      if (!user) {
        res.writeHead(401);
        return res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Invalid session' } }));
      }

      const attemptId = saveAnswerMatch[1];
      const questionVersionId = saveAnswerMatch[2];
      try {
        const body = await parseJsonBody(req);
        const result = saveAnswer(attemptId, questionVersionId, body, user);
        res.writeHead(200);
        return res.end(JSON.stringify(result));
      } catch (err) {
        return handleServiceError(res, err);
      }
    }

    // POST /api/v1/participant/attempts/:attemptId/submit (Submit attempt)
    const submitMatch = url.pathname.match(/^\/api\/v1\/participant\/attempts\/([a-zA-Z0-9_-]+)\/submit$/);
    if (submitMatch && method === 'POST') {
      const token = extractBearerToken(req);
      const user = authenticate(token);
      if (!user) {
        res.writeHead(401);
        return res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Invalid session' } }));
      }

      const attemptId = submitMatch[1];
      try {
        const result = submitAttempt(attemptId, user);
        res.writeHead(200);
        return res.end(JSON.stringify(result));
      } catch (err) {
        return handleServiceError(res, err);
      }
    }

    // 404 handler
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Endpoint not found' }));
  });
}

// ponytail: basic http runner without framework ceiling; upgrade to Fastify/NestJS when route complexity exceeds 20 endpoints.
if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  const server = createServer();
  server.listen(PORT, () => {
    console.log(`CBT Server running on http://localhost:${PORT}`);
  });
}
