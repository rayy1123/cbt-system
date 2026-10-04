import crypto from 'node:crypto';
import { getQuestionForParticipant } from './questions.js';

// ponytail: in-memory stores; replace with PostgreSQL relational queries when connection pool wired.
const memoryExams = new Map(); // examId -> exam
const memoryExamAssignments = new Map(); // `${examId}:${participantId}` -> assignment
const memoryExamQuestions = new Map(); // examId -> [{ question_version_id, position, points }]
const memoryAttempts = new Map(); // attemptId -> attempt
const memoryAttemptAnswers = new Map(); // `${attemptId}:${questionVersionId}` -> answer
const memoryScores = new Map(); // attemptId -> score

export function createExam({
  organizationId,
  title,
  description = '',
  durationSeconds,
  startsAt,
  endsAt,
  resultReleasePolicy = 'AFTER_EXAM_PERIOD'
}, userContext) {
  if (!userContext || (userContext.role !== 'TEACHER' && userContext.role !== 'ADMIN')) {
    throw new Error('FORBIDDEN: Only TEACHER or ADMIN can create exams');
  }

  if (userContext.organization_id !== organizationId) {
    throw new Error('FORBIDDEN: Cross-organization exam creation denied');
  }

  if (!title || !durationSeconds || durationSeconds <= 0) {
    throw new Error('BAD_REQUEST: Title and positive durationSeconds required');
  }

  const examId = crypto.randomUUID();
  const now = new Date().toISOString();

  const exam = {
    id: examId,
    organization_id: organizationId,
    title,
    description,
    status: 'PUBLISHED',
    duration_seconds: durationSeconds,
    starts_at: startsAt || now,
    ends_at: endsAt || new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    result_release_policy: resultReleasePolicy,
    created_by: userContext.id,
    created_at: now,
    updated_at: now
  };

  memoryExams.set(examId, exam);
  memoryExamQuestions.set(examId, []);

  return exam;
}

export function addQuestionsToExam(examId, questionsWithPoints, userContext) {
  const exam = memoryExams.get(examId);
  if (!exam) throw new Error('NOT_FOUND: Exam not found');

  if (!userContext || (userContext.role !== 'TEACHER' && userContext.role !== 'ADMIN')) {
    throw new Error('FORBIDDEN: Only TEACHER or ADMIN can configure exam questions');
  }

  if (exam.organization_id !== userContext.organization_id) {
    throw new Error('FORBIDDEN: Cross-organization access denied');
  }

  const existing = memoryExamQuestions.get(examId) || [];
  for (const item of questionsWithPoints) {
    existing.push({
      question_version_id: item.questionVersionId,
      position: existing.length + 1,
      points: Number(item.points || 1)
    });
  }
  memoryExamQuestions.set(examId, existing);
  return existing;
}

export function assignParticipant(examId, participantId, userContext) {
  const exam = memoryExams.get(examId);
  if (!exam) throw new Error('NOT_FOUND: Exam not found');

  if (!userContext || (userContext.role !== 'TEACHER' && userContext.role !== 'ADMIN')) {
    throw new Error('FORBIDDEN: Only TEACHER or ADMIN can assign participants');
  }

  const key = `${examId}:${participantId}`;
  const assignment = {
    id: crypto.randomUUID(),
    exam_id: examId,
    participant_id: participantId,
    assigned_at: new Date().toISOString()
  };

  memoryExamAssignments.set(key, assignment);
  return assignment;
}

export function listAssignedExams(userContext) {
  if (!userContext || userContext.role !== 'PARTICIPANT') {
    throw new Error('FORBIDDEN: Participant role required');
  }

  const list = [];
  for (const assignment of memoryExamAssignments.values()) {
    if (assignment.participant_id === userContext.id) {
      const exam = memoryExams.get(assignment.exam_id);
      if (exam && exam.status === 'PUBLISHED') {
        list.push({
          id: exam.id,
          title: exam.title,
          description: exam.description,
          duration_seconds: exam.duration_seconds,
          starts_at: exam.starts_at,
          ends_at: exam.ends_at
        });
      }
    }
  }
  return list;
}

export function startAttempt(examId, userContext) {
  if (!userContext || userContext.role !== 'PARTICIPANT') {
    throw new Error('FORBIDDEN: Only participants can start attempts');
  }

  const exam = memoryExams.get(examId);
  if (!exam) throw new Error('NOT_FOUND: Exam not found');

  // Verify participant is assigned
  const assignKey = `${examId}:${userContext.id}`;
  if (!memoryExamAssignments.has(assignKey)) {
    throw new Error('FORBIDDEN: You are not assigned to this exam');
  }

  // Check for active attempt (resumption)
  for (const att of memoryAttempts.values()) {
    if (att.exam_id === examId && att.participant_id === userContext.id && att.state === 'IN_PROGRESS') {
      return att;
    }
  }

  const now = Date.now();
  const startsAtMs = new Date(exam.starts_at).getTime();
  const endsAtMs = new Date(exam.ends_at).getTime();

  if (now < startsAtMs || now > endsAtMs) {
    throw new Error('BAD_REQUEST: Exam is not currently active');
  }

  // Server-authoritative timing deadline
  const calculatedDeadline = Math.min(now + exam.duration_seconds * 1000, endsAtMs);
  const attemptId = crypto.randomUUID();

  const attempt = {
    id: attemptId,
    exam_id: examId,
    participant_id: userContext.id,
    attempt_number: 1,
    state: 'IN_PROGRESS',
    started_at: new Date(now).toISOString(),
    deadline_at: calculatedDeadline,
    submitted_at: null,
    created_at: new Date(now).toISOString()
  };

  memoryAttempts.set(attemptId, attempt);
  return attempt;
}

export function getAttempt(attemptId, userContext) {
  const attempt = memoryAttempts.get(attemptId);
  if (!attempt) throw new Error('NOT_FOUND: Attempt not found');

  // Strict Anti-BOLA: Caller must own the attempt
  if (attempt.participant_id !== userContext.id && userContext.role !== 'ADMIN' && userContext.role !== 'PROCTOR') {
    throw new Error('FORBIDDEN: You are not authorized to access this attempt');
  }

  const examQuestions = memoryExamQuestions.get(attempt.exam_id) || [];
  const sanitizedQuestions = [];

  for (const eq of examQuestions) {
    try {
      const qDto = getQuestionForParticipant(eq.question_version_id, userContext);
      sanitizedQuestions.push({
        position: eq.position,
        points: eq.points,
        question: qDto
      });
    } catch (e) {
      // If caller is staff, allow without participant DTO
    }
  }

  // Collect answers already submitted by this participant
  const answers = [];
  for (const eq of examQuestions) {
    const ansKey = `${attemptId}:${eq.question_version_id}`;
    const saved = memoryAttemptAnswers.get(ansKey);
    if (saved) {
      answers.push({
        question_version_id: eq.question_version_id,
        answer: saved.answer_payload,
        answered_at: saved.answered_at
      });
    }
  }

  return {
    attempt: {
      id: attempt.id,
      exam_id: attempt.exam_id,
      state: attempt.state,
      started_at: attempt.started_at,
      deadline_at: attempt.deadline_at,
      submitted_at: attempt.submitted_at
    },
    questions: sanitizedQuestions,
    answers
  };
}

export function saveAnswer(attemptId, questionVersionId, answerPayload, userContext) {
  const attempt = memoryAttempts.get(attemptId);
  if (!attempt) throw new Error('NOT_FOUND: Attempt not found');

  // Strict Anti-BOLA: participant ownership check
  if (attempt.participant_id !== userContext.id) {
    throw new Error('FORBIDDEN: You do not own this attempt');
  }

  // State check: Must be IN_PROGRESS
  if (attempt.state !== 'IN_PROGRESS') {
    throw new Error(`BAD_REQUEST: Cannot answer attempt in state: ${attempt.state}`);
  }

  // Server-authoritative timing deadline check
  if (Date.now() > attempt.deadline_at) {
    throw new Error('BAD_REQUEST: Exam deadline has expired');
  }

  const key = `${attemptId}:${questionVersionId}`;
  const answerRecord = {
    id: crypto.randomUUID(),
    attempt_id: attemptId,
    question_version_id: questionVersionId,
    answer_payload: answerPayload,
    answered_at: new Date().toISOString()
  };

  memoryAttemptAnswers.set(key, answerRecord);
  return { status: 'saved', answered_at: answerRecord.answered_at };
}

export function submitAttempt(attemptId, userContext) {
  const attempt = memoryAttempts.get(attemptId);
  if (!attempt) throw new Error('NOT_FOUND: Attempt not found');

  // Strict Anti-BOLA: participant ownership check
  if (attempt.participant_id !== userContext.id) {
    throw new Error('FORBIDDEN: You do not own this attempt');
  }

  // Idempotent submit: if already submitted, return status
  if (attempt.state === 'SUBMITTED' || attempt.state === 'FINALIZED') {
    return { status: attempt.state, submitted_at: attempt.submitted_at };
  }

  attempt.state = 'SUBMITTED';
  attempt.submitted_at = new Date().toISOString();

  // Internal scoring engine calculation
  const examQuestions = memoryExamQuestions.get(attempt.exam_id) || [];
  let rawScore = 0;
  let maxScore = 0;

  for (const eq of examQuestions) {
    maxScore += eq.points;
    const ansKey = `${attemptId}:${eq.question_version_id}`;
    const ans = memoryAttemptAnswers.get(ansKey);
    // ponytail: Scoring logic reads isolated question version in memory/db.
    // In next phase, question_versions module handles complex rubric scoring.
    if (ans && ans.answer_payload) {
      // Check answer payload vs answer key
      rawScore += eq.points; // Sample scoring stub
    }
  }

  const scoreRecord = {
    id: crypto.randomUUID(),
    attempt_id: attemptId,
    raw_score: rawScore,
    max_score: maxScore,
    percentage: maxScore > 0 ? (rawScore / maxScore) * 100 : 0,
    calculated_at: new Date().toISOString()
  };

  memoryScores.set(attemptId, scoreRecord);

  return {
    status: 'SUBMITTED',
    submitted_at: attempt.submitted_at
  };
}
