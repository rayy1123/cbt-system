import http from 'node:http';
import { login, logout, authenticate } from './auth.js';
import { createQuestion, listQuestions, getQuestionForAuthor } from './questions.js';

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
      if (!token) {
        res.writeHead(401);
        return res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Missing token' } }));
      }

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
      if (!token) {
        res.writeHead(401);
        return res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Missing token' } }));
      }

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
