import crypto from 'node:crypto';

// ponytail: in-memory maps; switch to PostgreSQL question/question_versions tables when DB pool wired.
const memoryQuestions = new Map(); // questionId -> question
const memoryQuestionVersions = new Map(); // versionId -> version
const memoryQuestionOptions = new Map(); // versionId -> [options]

export function createQuestion({
  organizationId,
  createdBy,
  questionType = 'SINGLE_CHOICE',
  prompt,
  options = [],
  answerKey,
  scoringConfig = { points: 1 }
}, userContext) {
  if (!userContext || (userContext.role !== 'TEACHER' && userContext.role !== 'ADMIN')) {
    throw new Error('FORBIDDEN: Only TEACHER or ADMIN can create questions');
  }

  if (userContext.organization_id !== organizationId) {
    throw new Error('FORBIDDEN: Cross-organization question creation denied');
  }

  if (!prompt || typeof prompt !== 'string') {
    throw new Error('BAD_REQUEST: Prompt text is required');
  }

  if (!Array.isArray(options) || options.length < 2) {
    throw new Error('BAD_REQUEST: At least two options required');
  }

  if (!answerKey) {
    throw new Error('BAD_REQUEST: Answer key required for authoring');
  }

  const questionId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const now = new Date().toISOString();

  const question = {
    id: questionId,
    organization_id: organizationId,
    question_type: questionType,
    status: 'ACTIVE',
    current_version_id: versionId,
    created_by: createdBy,
    created_at: now,
    updated_at: now
  };

  const version = {
    id: versionId,
    question_id: questionId,
    version_number: 1,
    body: { prompt },
    answer_key_restricted: answerKey, // ISOLATED: never sent to participants
    scoring_config: scoringConfig,
    created_at: now
  };

  const formattedOptions = options.map((opt, idx) => ({
    id: crypto.randomUUID(),
    question_version_id: versionId,
    option_key: opt.optionKey || String.fromCharCode(65 + idx), // A, B, C, ...
    content: opt.content,
    position: idx + 1
  }));

  memoryQuestions.set(questionId, question);
  memoryQuestionVersions.set(versionId, version);
  memoryQuestionOptions.set(versionId, formattedOptions);

  return {
    id: questionId,
    version_id: versionId,
    version_number: 1,
    question_type: questionType,
    prompt,
    options: formattedOptions.map(o => ({ option_key: o.option_key, content: o.content })),
    answer_key: answerKey
  };
}

export function listQuestions(organizationId, userContext) {
  if (!userContext || (userContext.role !== 'TEACHER' && userContext.role !== 'ADMIN')) {
    throw new Error('FORBIDDEN: Only TEACHER or ADMIN can list question bank');
  }

  if (userContext.organization_id !== organizationId) {
    throw new Error('FORBIDDEN: Cross-organization access denied');
  }

  const list = [];
  for (const q of memoryQuestions.values()) {
    if (q.organization_id === organizationId && q.status === 'ACTIVE') {
      const ver = memoryQuestionVersions.get(q.current_version_id);
      const opts = memoryQuestionOptions.get(q.current_version_id) || [];
      list.push({
        id: q.id,
        version_id: ver.id,
        version_number: ver.version_number,
        question_type: q.question_type,
        prompt: ver.body.prompt,
        options: opts.map(o => ({ option_key: o.option_key, content: o.content })),
        answer_key: ver.answer_key_restricted // visible only to authorized teachers/admins
      });
    }
  }
  return list;
}

export function getQuestionForAuthor(questionId, userContext) {
  if (!userContext || (userContext.role !== 'TEACHER' && userContext.role !== 'ADMIN')) {
    throw new Error('FORBIDDEN: Only TEACHER or ADMIN can read full question authoring data');
  }

  const q = memoryQuestions.get(questionId);
  if (!q || q.status !== 'ACTIVE') {
    throw new Error('NOT_FOUND: Question not found');
  }

  if (q.organization_id !== userContext.organization_id) {
    throw new Error('FORBIDDEN: Cross-organization access denied');
  }

  const ver = memoryQuestionVersions.get(q.current_version_id);
  const opts = memoryQuestionOptions.get(q.current_version_id) || [];

  return {
    id: q.id,
    version_id: ver.id,
    version_number: ver.version_number,
    question_type: q.question_type,
    prompt: ver.body.prompt,
    options: opts.map(o => ({ option_key: o.option_key, content: o.content })),
    answer_key: ver.answer_key_restricted
  };
}

// Participant delivery: strictly sanitized DTO — zero leak guarantee
export function getQuestionForParticipant(versionId, userContext) {
  if (!userContext || userContext.role !== 'PARTICIPANT') {
    throw new Error('FORBIDDEN: Participant context required');
  }

  const ver = memoryQuestionVersions.get(versionId);
  if (!ver) {
    throw new Error('NOT_FOUND: Question version not found');
  }

  const q = memoryQuestions.get(ver.question_id);
  if (!q || q.organization_id !== userContext.organization_id) {
    throw new Error('FORBIDDEN: Cross-organization access denied');
  }

  const opts = memoryQuestionOptions.get(versionId) || [];

  // Strictly sanitized return object
  return {
    version_id: ver.id,
    prompt: ver.body.prompt,
    options: opts.map(o => ({
      option_key: o.option_key,
      content: o.content,
      position: o.position
    }))
  };
}
